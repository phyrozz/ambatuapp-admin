import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type ChatReport = { id: string; conversationId: string; messageId: string; reporterId: string; reason: string; status: 'open' | 'resolved'; createdAt: number; resolvedAt?: number; senderId?: string; members: string[]; names: Record<string, string>; messageKind?: string; messageText?: string; mediaKey?: string; mediaUrl?: string };
export type ChatRestriction = { userId: string; updatedAt: number; sourceReportId?: string };
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ap-southeast-1' }));
const table = process.env.CHAT_TABLE;

export async function listChatReports() {
  if (!table) throw new Error('Chat reports are not configured.');
  const reports: ChatReport[] = [];
  const restrictedUsers: ChatRestriction[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({ TableName: table, FilterExpression: 'begins_with(pk, :report) OR begins_with(pk, :restriction)', ExpressionAttributeValues: { ':report': 'REPORT#', ':restriction': 'CHAT_RESTRICTION#' }, ExclusiveStartKey: cursor, Limit: 100 }));
    for (const item of result.Items ?? []) {
      if (String(item.pk).startsWith('REPORT#')) reports.push({ id: String(item.id), conversationId: String(item.conversationId), messageId: String(item.messageId ?? ''), reporterId: String(item.reporterId), reason: String(item.reason), status: item.status === 'resolved' ? 'resolved' : 'open', createdAt: Number(item.createdAt), resolvedAt: item.resolvedAt ? Number(item.resolvedAt) : undefined, senderId: item.senderId ? String(item.senderId) : undefined, members: Array.isArray(item.members) ? item.members.map(String) : [], names: item.names && typeof item.names === 'object' ? item.names as Record<string, string> : {}, messageKind: item.messageKind ? String(item.messageKind) : undefined, messageText: item.messageText ? String(item.messageText) : undefined, mediaKey: item.mediaKey ? String(item.mediaKey) : undefined });
      else if (item.restricted === true) restrictedUsers.push({ userId: String(item.userId), updatedAt: Number(item.updatedAt), sourceReportId: item.sourceReportId ? String(item.sourceReportId) : undefined });
    }
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  const recent = reports.sort((a, b) => b.createdAt - a.createdAt);
  if (process.env.CHAT_BUCKET) {
    const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-southeast-1' });
    await Promise.all(recent.map(async report => {
      if (report.mediaKey?.startsWith('chat/')) report.mediaUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.CHAT_BUCKET, Key: report.mediaKey }), { expiresIn: 600 });
    }));
  }
  return { reports: recent, restrictedUsers: restrictedUsers.sort((a, b) => b.updatedAt - a.updatedAt) };
}

export async function setChatRestriction(userId: string, restricted: boolean, reportId?: string) {
  if (!table) throw new Error('Chat reports are not configured.');
  if (!/^[a-f0-9-]{36}$/i.test(userId)) throw new Error('Invalid user.');
  if (reportId && !/^[a-f0-9]{32}$/.test(reportId)) throw new Error('Invalid report.');
  const timestamp = Date.now();
  await client.send(new UpdateCommand({ TableName: table, Key: { pk: `CHAT_RESTRICTION#${userId}`, sk: 'META' }, UpdateExpression: 'SET userId=:user, restricted=:restricted, updatedAt=:time, sourceReportId=:report', ExpressionAttributeValues: { ':user': userId, ':restricted': restricted, ':time': timestamp, ':report': reportId ?? '' } }));
  return { userId, restricted, updatedAt: timestamp, sourceReportId: reportId ?? '' };
}

export async function resolveChatReport(id: string) {
  if (!table) throw new Error('Chat reports are not configured.');
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid report.');
  await client.send(new UpdateCommand({ TableName: table, Key: { pk: `REPORT#${id}`, sk: 'META' }, UpdateExpression: 'SET #status=:status, resolvedAt=:time', ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':status': 'resolved', ':time': Date.now() } }));
}
