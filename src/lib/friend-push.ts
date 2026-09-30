import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

let client: LambdaClient | null = null;

export async function notifyFriendRequest(recipientId: string, senderName: string) {
  const functionName = process.env.CHAT_PUSH_FUNCTION_NAME;
  if (!functionName) return;
  client ??= new LambdaClient({ region: process.env.AWS_REGION ?? 'ap-southeast-1' });
  await client.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ type: 'friendRequest', users: [recipientId], senderName })),
  }));
}
