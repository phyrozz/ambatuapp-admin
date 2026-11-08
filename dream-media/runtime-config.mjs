import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { database } from "./db.mjs";
let pending;
export async function runtime(role) {
  if (!pending)
    pending = (async () => {
      const parameter = await new SSMClient({ maxAttempts: 1 }).send(
        new GetParameterCommand({
          Name: process.env.DATABASE_PARAMETER,
          WithDecryption: true,
        }),
        { abortSignal: AbortSignal.timeout(2000) },
      );
      process.env.DATABASE_CONFIG = parameter.Parameter?.Value ?? "";
      process.env.DATABASE_POOL_MAX = "1";
      process.env.DATABASE_TIMEOUT_MS = "3000";
      const connection = database(role);
      try {
        await connection.verify();
        return connection;
      } catch (error) {
        await connection.pool.end();
        throw error;
      }
    })().catch((error) => {
      pending = null;
      throw error;
    });
  return pending;
}
