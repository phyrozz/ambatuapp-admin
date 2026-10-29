import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CHAT_LIMIT_DEFAULTS, type ChatLimits } from './chat-settings-schema';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ap-southeast-1' }));
const key = { pk: 'SETTINGS#chat', sk: 'RATE_LIMITS' };
function table() {
  if (!process.env.CHAT_TABLE) throw new Error('studio.errors.chatSettingsUnavailable');
  return process.env.CHAT_TABLE;
}
function validLimit(value: unknown): value is { limit: number; seconds: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Number.isInteger(item.limit) && Number(item.limit) >= 1 && Number(item.limit) <= 10000
    && Number.isInteger(item.seconds) && Number(item.seconds) >= 10 && Number(item.seconds) <= 86400;
}
export function validateLimits(value: unknown): ChatLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('studio.errors.chatSettingsInvalid');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== Object.keys(CHAT_LIMIT_DEFAULTS).length || Object.keys(input).some(name => !(name in CHAT_LIMIT_DEFAULTS))) throw new Error('studio.errors.chatSettingsInvalid');
  return Object.fromEntries(Object.keys(CHAT_LIMIT_DEFAULTS).map(name => {
    if (!validLimit(input[name])) throw new Error('studio.errors.chatSettingsInvalid');
    const item = input[name];
    return [name, { limit: item.limit, seconds: item.seconds }];
  })) as ChatLimits;
}
export async function readChatSettings() {
  const result = await client.send(new GetCommand({ TableName: table(), Key: key, ConsistentRead: true }));
  const stored = result.Item?.limits ?? {};
  const limits = Object.fromEntries(Object.entries(CHAT_LIMIT_DEFAULTS).map(([name, fallback]) => [name, validLimit(stored[name]) ? stored[name] : fallback])) as ChatLimits;
  return { limits, version: typeof result.Item?.version === 'number' ? result.Item.version : 0 };
}
export async function saveChatSettings(limits: ChatLimits, version: number, actor: string) {
  try {
    await client.send(new UpdateCommand({
      TableName: table(), Key: key,
      UpdateExpression: 'SET limits = :limits, #version = :next, updatedAt = :updated, updatedBy = :actor',
      ConditionExpression: version === 0 ? 'attribute_not_exists(#version)' : '#version = :version',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':limits': limits, ':next': version + 1, ':updated': Date.now(), ':actor': actor, ...(version ? { ':version': version } : {}) },
    }));
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') throw new Error('studio.errors.chatSettingsConflict');
    throw error;
  }
  return { limits, version: version + 1 };
}
