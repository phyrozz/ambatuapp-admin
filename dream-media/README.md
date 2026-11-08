# Ambatupost media

See [Phase 4 behavior, budget, dev deployment and tests](../../docs/ambatupost-phase-4.md).

- `worker.mjs`: finite RunTask compression batch; requires a persisted worker lease and absolute deadline. Never run as an always-on ECS service.
- `lambda-gateway.mjs`: private-authorized Lambda Function URL response streaming.
- `lambda-dispatcher.mjs`: SQS intake and minute deletion/recovery/budget maintenance. Remains available when uploads/reads are disabled.
- `package-lambda.mjs`: explicit public runtime packaging; excludes project env and native codecs.
- `configure-bucket.mjs`: defaults to preview, merges only stage additions with `--apply`.

Worker database config comes from an SSM SecureString task secret; Lambda reads its own role's parameter. Never include credentials in image layers, source, deploy artifacts or logs. The original ALB/services topology is retired. Default dev media is disabled pending migration 019 and replacement cloud smoke tests.

The gateway and dispatcher use existing shared Lambda capacity. No positive concurrency reservations or Service Quotas request are required. Budget shutdown sets gateway concurrency to zero; recovery removes that setting. Migration 019 is reused unchanged.
