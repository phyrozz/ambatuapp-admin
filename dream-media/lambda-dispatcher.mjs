import {
  ECSClient,
  ListTasksCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
import {
  LambdaClient,
  PutFunctionConcurrencyCommand,
  DeleteFunctionConcurrencyCommand,
} from "@aws-sdk/client-lambda";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { runtime } from "./runtime-config.mjs";
import { inputKeys, noteObject } from "./objects.mjs";
import { maintain } from "./maintenance.mjs";
import { LIMITS, currentBudget, settleWorker, startWorker } from "./budget.mjs";

export function dispatcher({
  connect = () => runtime("worker"),
  ecs = new ECSClient({ maxAttempts: 1 }),
  lambda = new LambdaClient({ maxAttempts: 1 }),
  s3 = new S3Client({ maxAttempts: 1 }),
} = {}) {
  const serving = (enabled) =>
    lambda.send(
      enabled
        ? new DeleteFunctionConcurrencyCommand({
            FunctionName: process.env.GATEWAY_FUNCTION,
          })
        : new PutFunctionConcurrencyCommand({
            FunctionName: process.env.GATEWAY_FUNCTION,
            ReservedConcurrentExecutions: 0,
          }),
      { abortSignal: AbortSignal.timeout(3000) },
    );
  const failClosed = async () => {
    await serving(false);
    const response = await ecs.send(
      new ListTasksCommand({
        cluster: process.env.WORKER_CLUSTER,
        desiredStatus: "RUNNING",
      }),
      { abortSignal: AbortSignal.timeout(3000) },
    );
    for (const task of response.taskArns ?? [])
      await ecs.send(
        new StopTaskCommand({
          cluster: process.env.WORKER_CLUSTER,
          task,
          reason: "Ambatupost budget database unavailable",
        }),
        { abortSignal: AbortSignal.timeout(3000) },
      );
  };
  return async (event, context) => {
    if (context) context.callbackWaitsForEmptyEventLoop = false;
    let connection;
    try {
      connection = await connect();
    } catch {
      await failClosed();
      throw new Error("MEDIA_DATABASE_UNAVAILABLE");
    }
    const { pool, transaction } = connection;
    const bucket = process.env.MEDIA_BUCKET,
      namespace = `ambatupost/${process.env.STAGE}`;
    const dependencies = { transaction, s3, bucket, namespace };
    const failures = [];
    try {
      for (const record of event.Records ?? []) {
        try {
          for (const key of inputKeys(record.body, bucket))
            await noteObject(dependencies, key);
        } catch {
          failures.push({ itemIdentifier: record.messageId });
        }
      }
      // Recover missed notifications without starting a task for absent bytes.
      if (!event.Records) {
        await maintain(dependencies);
        await pool.query(
          "DELETE FROM app.dream_gateway_leases WHERE started_at<now()-interval '1 day'",
        );
        const missing = (
          await pool.query(
            "SELECT id,input_key FROM app.dream_attachments WHERE state='awaiting_upload' AND NOT input_received AND created_at<now()-interval '30 seconds' ORDER BY updated_at LIMIT 10",
          )
        ).rows;
        for (const row of missing) {
          try {
            await s3.send(
              new HeadObjectCommand({ Bucket: bucket, Key: row.input_key }),
              { abortSignal: AbortSignal.timeout(2000) },
            );
            await noteObject(dependencies, row.input_key);
          } catch (error) {
            if (
              error.name !== "NotFound" &&
              error.$metadata?.httpStatusCode !== 404
            )
              throw error;
            await pool.query(
              "UPDATE app.dream_attachments SET updated_at=now(),state=CASE WHEN upload_expires_at<now()-interval '10 minutes' THEN 'failed' ELSE state END,error_code=CASE WHEN upload_expires_at<now()-interval '10 minutes' THEN 'UPLOAD_EXPIRED' ELSE error_code END WHERE id=$1 AND state='awaiting_upload'",
              [row.id],
            );
          }
        }
      }
      await settleWorker({ transaction, ecs });
      await startWorker({ transaction, ecs });
      const budget = await transaction(currentBudget);
      await serving(
        process.env.GATEWAY_ENABLED === "true" &&
          budget.requests < LIMITS.requests &&
          Number(budget.delivery_bytes) < LIMITS.deliveryBytes &&
          budget.gateway_seconds + 180 <= LIMITS.gatewaySeconds,
      );
      return { batchItemFailures: failures };
    } catch {
      await failClosed();
      throw new Error("MEDIA_DISPATCH_RETRY");
    }
  };
}
export const handler = dispatcher();
