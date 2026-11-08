import { randomUUID } from "node:crypto";
import {
  RunTaskCommand,
  DescribeTasksCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
export const LIMITS = {
  workerSeconds: 21600,
  workerStarts: 100,
  uploadBytes: 1073741824,
  retainedBytes: 5368709120,
  deliveryBytes: 10737418240,
  requests: 50000,
  gatewaySeconds: 100000,
};
export const monthOf = (date) =>
  new Date(date).toISOString().slice(0, 7) + "-01";
export function splitRuntime(start, end) {
  let cursor = Math.floor(new Date(start).getTime() / 1000),
    last = Math.floor(new Date(end).getTime() / 1000);
  const chunks = [];
  while (cursor < last) {
    const date = new Date(cursor * 1000),
      boundary =
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000,
      next = Math.min(last, boundary);
    chunks.push({ month: monthOf(date), seconds: next - cursor });
    cursor = next;
  }
  return chunks;
}
export async function currentBudget(db) {
  const month = monthOf(new Date());
  await db.query(
    "INSERT INTO app.dream_media_costs(month) VALUES($1) ON CONFLICT DO NOTHING",
    [month],
  );
  return (
    await db.query("SELECT * FROM app.dream_media_costs WHERE month=$1", [
      month,
    ])
  ).rows[0];
}
export async function settleWorker({
  transaction,
  ecs,
  now = () => new Date(),
}) {
  const control = await transaction(
    async (db) =>
      (await db.query("SELECT * FROM app.dream_worker_control")).rows[0],
  );
  if (!control?.lease_id) return;
  if (!control.task_arn) return; // A persisted RunTask request is retried with the same client token.
  const result = await ecs.send(
    new DescribeTasksCommand({
      cluster: process.env.WORKER_CLUSTER,
      tasks: [control.task_arn],
    }),
    { abortSignal: AbortSignal.timeout(3000) },
  );
  const task = result.tasks?.[0];
  if (!task && result.failures?.some((failure) => failure.reason !== "MISSING"))
    throw new Error("WORKER_STATUS_UNAVAILABLE");
  const stopped = !task || task.lastStatus === "STOPPED",
    until = task?.stoppedAt ?? now();
  await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "dream-worker-control",
    ]);
    const live = (
      await db.query("SELECT * FROM app.dream_worker_control FOR UPDATE")
    ).rows[0];
    if (live.lease_id !== control.lease_id) return;
    const charges = splitRuntime(live.charged_until ?? live.started_at, until);
    if (stopped && new Date(until) - new Date(live.started_at) < 60000)
      charges.push({
        month: monthOf(until),
        seconds:
          60 -
          Math.max(
            0,
            Math.floor((new Date(until) - new Date(live.started_at)) / 1000),
          ),
      });
    for (const charge of charges)
      await db.query(
        `INSERT INTO app.dream_media_costs(month,worker_seconds) VALUES($1,$2)
      ON CONFLICT(month) DO UPDATE SET worker_seconds=dream_media_costs.worker_seconds+$2`,
        [charge.month, charge.seconds],
      );
    if (stopped)
      await db.query(
        "UPDATE app.dream_worker_control SET lease_id=NULL,task_arn=NULL,request_json=NULL,started_at=NULL,charged_until=NULL,deadline=NULL",
      );
    else
      await db.query("UPDATE app.dream_worker_control SET charged_until=$1", [
        new Date(Math.floor(new Date(until).getTime() / 1000) * 1000),
      ]);
  });
  if (!stopped) {
    const budget = await transaction(currentBudget);
    if (
      new Date(control.deadline) <= now() ||
      budget.worker_seconds >= LIMITS.workerSeconds
    )
      await ecs.send(
        new StopTaskCommand({
          cluster: process.env.WORKER_CLUSTER,
          task: control.task_arn,
          reason: "Ambatupost processing budget/deadline",
        }),
      );
  }
}
export async function startWorker({ transaction, ecs }) {
  const request = await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "dream-worker-control",
    ]);
    const control = (
      await db.query("SELECT * FROM app.dream_worker_control FOR UPDATE")
    ).rows[0];
    if (control.task_arn) return null;
    // A timed-out RunTask may already have started. Never replace its token.
    if (control.lease_id) return control.request_json;
    const work = (
      await db.query(
        "SELECT 1 FROM app.dream_attachments WHERE (state='awaiting_upload' AND input_received) OR (state='processing' AND lease_until<now()) LIMIT 1",
      )
    ).rowCount;
    if (!work) return null;
    const budget = await currentBudget(db),
      remaining = LIMITS.workerSeconds - budget.worker_seconds;
    if (remaining < 60 || budget.worker_starts >= LIMITS.workerStarts)
      return null;
    const lease = randomUUID(),
      started = new Date(),
      deadline = new Date(started.getTime() + Math.min(7200, remaining) * 1000);
    const payload = {
      cluster: process.env.WORKER_CLUSTER,
      taskDefinition: process.env.WORKER_TASK_DEFINITION,
      launchType: "FARGATE",
      count: 1,
      clientToken: lease,
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: "ENABLED",
          subnets: process.env.WORKER_SUBNETS.split(","),
          securityGroups: [process.env.WORKER_SECURITY_GROUP],
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: "worker",
            environment: [
              { name: "WORKER_LEASE_ID", value: lease },
              { name: "WORKER_DEADLINE", value: deadline.toISOString() },
            ],
          },
        ],
      },
    };
    await db.query(
      "UPDATE app.dream_worker_control SET lease_id=$1,started_at=$2,charged_until=$2,deadline=$3,request_json=$4",
      [lease, started, deadline, payload],
    );
    await db.query(
      "UPDATE app.dream_media_costs SET worker_starts=worker_starts+1 WHERE month=$1",
      [monthOf(started)],
    );
    return payload;
  });
  if (!request) return null;
  const result = await ecs.send(new RunTaskCommand(request), {
    abortSignal: AbortSignal.timeout(5000),
  });
  const arn = result.tasks?.[0]?.taskArn;
  if (!arn) {
    // An explicit no-task response is safe to replace. Transport timeouts above
    // leave the intent intact because the acceptance outcome is unknown.
    await transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "dream-worker-control",
      ]);
      await db.query(
        "UPDATE app.dream_worker_control SET lease_id=NULL,request_json=NULL,started_at=NULL,charged_until=NULL,deadline=NULL WHERE lease_id=$1 AND task_arn IS NULL",
        [request.clientToken],
      );
    });
    throw new Error("WORKER_START_RETRY");
  }
  await transaction((db) =>
    db.query(
      "UPDATE app.dream_worker_control SET task_arn=$1 WHERE lease_id=$2",
      [arn, request.clientToken],
    ),
  );
  return arn;
}
