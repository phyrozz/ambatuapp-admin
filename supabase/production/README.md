# Production Firestore migration preparation

These scripts prepare a **private** Postgres schema and import a complete export of the production Firestore `(default)` database `ambatuapp-bcebb`. They do not perform a live cutover. A separate production Postgres configuration and server-role migration have been prepared, but must not be enabled or applied to the live application until the full cutover rehearsal and checks below are complete.

## Confirm the destination first

The SQL cannot prove which Supabase project the connection belongs to. In Supabase, select **ambatu-db-prod**, check its project reference and connection details, and independently compare them to the active `psql` connection using `\conninfo`. A pooled connection identifies its project through its project-specific username; a direct connection uses the project-specific host. Stop if either is unclear. Never paste a password or service-account key into chat. Keep both `app` and `migration_staging` out of the Supabase Data API exposed schemas.

The project owner may prepare an empty schema once, without changing the live app:

```sql
\set ON_ERROR_STOP on
\i 'C:/Users/joshu/github/ambatuapp/admin/supabase/production/000_staging.sql'
\i 'C:/Users/joshu/github/ambatuapp/admin/supabase/production/001_schema.sql'
```

These scripts create schemas, tables, constraints, and RLS, but do not load data or create an application login. Do not re-run them over existing objects. Inspect errors instead of continuing. `migration_staging.firestore_documents` and `app.firestore_orphan_documents` contain private source documents; they are not client-readable.

## Rehearsal and eventual cutover

The older `firestore-prod.csv` was used for a **local-only** rehearsal. It is not suitable for the live cutover. Do not run the import against production yet. A complete cutover plan must first cover:

1. Review `005_server_roles.sql` and the production connection configuration below; the dev roles and dev-only environment switches cannot be used unchanged. The migration requires a verified import, metadata, and at least one enabled registered Studio root. It creates the server login without a password. Set a strong separate password interactively with `\password ambatu_prod_content_reader` after it runs; never put it in SQL or chat.
2. Rehearse the app against an isolated database loaded with a recent production-shaped export. Validate authentication, authorization, every API, monitoring, data privacy, and recovery.
3. Plan a maintenance window that pauses **all production Firestore writers**, including older or parallel deployments, and prevent local game-score synchronization and background activity from writing during the freeze. Confirm the write pause before the final export.
4. Take and securely retain a fresh complete export from `ambatuapp-bcebb/(default)`. Check source identity and counts and import it into the empty private staging table. Sensitive exports and credentials must not be committed.
5. Execute `002_import.sql`, then `003_content_metadata.sql`, then `004_verify.sql` with `ON_ERROR_STOP`. Each script is atomic, but the sequence is not a single transaction; stop on any failure and investigate. The import verifies source project, document coverage, fingerprint, empty destination and relational constraints. Review every diagnostic and reconcile failures rather than silently dropping records. After verification, apply `005_server_roles.sql` and set the role password.
6. Only after verification, explicitly coordinate the live application deployment and smoke tests. The Firestore and Postgres databases do not synchronize. Once writes resume on Supabase, reverting to Firestore requires reconciliation of all intervening changes; a configuration flip alone is not a safe rollback.

## Production API configuration

Prepare these values in the deployment's server-side secret store; **do not set the cutover switches on the live service yet**. Use the exact host and project reference from the production project's Connect dialog and the downloaded production database CA file. For the shared session pooler, use port 5432 and the custom role username `ambatu_prod_content_reader.<project-ref>`; for a direct connection, use `db.<project-ref>.supabase.co` and `ambatu_prod_content_reader`. The API validates the project reference, role, host, port, TLS certificate, production source marker, `NODE_ENV`, and project ID.

```text
CONTENT_READ_BACKEND=postgres-prod
PRODUCTION_POSTGRES_CUTOVER=enabled
FIREBASE_PROJECT_ID=ambatuapp-bcebb
PROD_SUPABASE_PROJECT_REF=<production-project-ref>
PROD_CONTENT_PG_HOST=<production-direct-or-session-pooler-host>
PROD_CONTENT_PG_PORT=5432
PROD_CONTENT_PG_USER=<production-server-role-username>
PROD_CONTENT_PG_PASSWORD=<secret>
PROD_CONTENT_PG_CA=<contents-of-production-database-ca-pem>
```

For Vercel, set the full PEM certificate, including its BEGIN and END lines, as `PROD_CONTENT_PG_CA` in the project's Production environment. For a server with a certificate file instead, `PROD_CONTENT_PG_CA_FILE` may hold its path. If both are set, the PEM environment variable takes precedence. Store the database password as a Vercel Secret. Environment variable changes apply to new deployments, so coordinate the deployment with the cutover; do not set the cutover switches yet.

`NODE_ENV` must be `production`. Remove the individual dev backend flags from the production environment. A production Postgres switch activates all migrated database-backed APIs together and rejects conflicting per-feature settings; it does not enable a partial, unsynchronized cutover. This trusted server login can assume all application writer roles, including Studio and profile writers: a leaked server credential has broad impact even though the login has restricted direct grants. Keep it out of browser bundles, version control, logs, and the Supabase Data API. Keep separate Cognito, S3, chat, and FCM configuration in their existing secret stores.

## Historical rehearsal findings

The historical production export had 724 documents. Ten legacy `createdAt` values were stored as `{_seconds, _nanoseconds}` objects; the importer converts them to Postgres timestamps, truncating sub-microsecond precision, and keeps the originals in staging. Five lore comments or votes belonged to deleted parent lore documents. They are retained verbatim in `app.firestore_orphan_documents` and the migration ledger, but are not presented as live app content. Review them privately and decide whether restoration is wanted. Other missing parents and unmapped document paths fail the import rather than being silently discarded.

The local rehearsal reported zero duplicate usernames, username-claim mismatches, Studio role-count mismatches, and live content comment-count mismatches. These results describe the older snapshot only; repeat all checks on the final export.

For a repeatable **local-only** application-role rehearsal, use a disposable local PostgreSQL cluster and create an empty database named `prod_role_rehearsal`. Apply `000_staging.sql`, load the historical export, and apply `001_schema.sql` through `005_server_roles.sql` in order. Then run, from the `admin` directory:

```powershell
$env:PGTEST_PORT = '<disposable-local-postgres-port>'
node supabase/tests/run-production-rehearsal.mjs
node --test supabase/tests/production-config.test.mjs supabase/tests/production-permissions.test.mjs
```

These tests connect only to `127.0.0.1`, create and delete fixture data, and temporarily disable root accounts in the local rehearsal database. They must never point at a server containing live or user-maintained data. These checks do not replace deployment-level testing with the real production TLS endpoint, Cognito, AWS media services, and application clients.
