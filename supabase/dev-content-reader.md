# Dev snapshot content reads

This is an opt-in **local development test** of the imported Firestore snapshot. The list and detail GET endpoints for characters, lore, sounds, and videos can read `app` tables. Other endpoints, including sound audio, comments, uploads, votes, deletes, and all writes, still use Firestore or the existing AWS services. There is no synchronization: a Firestore update, deletion, vote, or change from Published to Draft after the export will not appear in the snapshot. Do not use this mode for a shared or production site. It cannot be enabled with `NODE_ENV=production` or a Firebase project other than `ambatuapp-dev`.

The sound migration records whether status was missing, so old sounds without a status remain public while explicitly null statuses remain private. Reloading cursors from Firestore into the SQL mode is unsupported; restart lists after switching. SQL keyset cursors include the filter, sort, limit, and a stable ID. Lists return bounded batches, including requests without an explicit limit. Lore facet counts are separate aggregate queries. Postgres collation and search can differ from Firestore's/JavaScript's for some non-ASCII names. Signatures on S3 URLs naturally change between requests.

## Set up the Supabase dev database

In the existing `psql` connection to **ambatu-db-dev**, after the 001 and 002 import steps have succeeded, run these one at a time:

```text
\set ON_ERROR_STOP on
\i 'C:/Users/joshu/github/ambatuapp/admin/supabase/migrations/003_dev_content_metadata.sql'
\i 'C:/Users/joshu/github/ambatuapp/admin/supabase/migrations/004_dev_content_reader.sql'
\password ambatu_dev_content_reader
```

Enter a new strong database-role password at the hidden prompts. Do not paste it into chat. The metadata migration and role migration are each atomic and run once; if one fails, stop, run `ROLLBACK;` if needed, and inspect the error before trying again. The schema and staging data already created by 001/002 are required. The role has read-only column/table grants and row policies for published content and the legacy public sounds. It cannot read private profile columns or Studio data. Do not expose the `app` schema through the Supabase Data API. Run SQL as the privileged owner only for this setup, not for the application.

## Configure the local admin API

Find the Supabase **Connect → Session pooler** host and project reference. Add the following to the existing ignored `admin/.env.local`, replacing the three placeholders locally:

```text
CONTENT_READ_BACKEND=postgres-dev-snapshot
DEV_CONTENT_PG_HOST=YOUR_SESSION_POOLER_HOST
DEV_CONTENT_PG_PORT=5432
DEV_CONTENT_PG_USER=ambatu_dev_content_reader.YOUR_PROJECT_REF
DEV_CONTENT_PG_PASSWORD=YOUR_NEW_READER_ROLE_PASSWORD
DEV_CONTENT_PG_CA_FILE=C:/Users/joshu/Downloads/YOUR_SUPABASE_CA_FILE.crt
```

For example, if Connect shows a user named `postgres.abc123`, use `ambatu_dev_content_reader.abc123` for the reader. The host and project reference come from your **dev** project. The existing `FIREBASE_PROJECT_ID` must be `ambatuapp-dev`. Next.js expands `$` in `.env` values, so either escape dollar signs as `\$` or use a strong randomly generated alphanumeric password. Download the server root certificate from the dev project's **Database Settings → SSL Configuration** and set `DEV_CONTENT_PG_CA_FILE` to its local path. Use forward slashes in the path. The app verifies the certificate and hostname and checks the dev import marker for each request. It does not fall back to Firestore if the snapshot connection fails.

Restart the admin development server bound to loopback, then access it locally:

```powershell
npm run dev -- -H 127.0.0.1 -p 3000
```

Try `/api/public/characters?limit=2`, `/api/public/lores?limit=2`, `/api/public/sounds?limit=2`, and `/api/public/videos?limit=2`. The list response contains a `nextCursor` when more rows exist. Normal Firestore mode is restored by removing `CONTENT_READ_BACKEND` or setting it to `firestore` and restarting. The Firestore copy continues changing independently throughout this experiment.

## Local tests

`node --test supabase/tests/content-config.test.mjs` checks the mode guard with Node 24. `content-read.test.mjs` is an integration test: configure `CONTENT_TEST_PORT`, `CONTENT_TEST_BASE_URL` (must be loopback), and optionally `CONTENT_TEST_EXPORT` to the dev CSV while a disposable local Postgres and dev server are running. It creates and removes only `zz_dev_read_fixture_` rows in that local database. Never point its database port at a server containing user data. It tests permissions, draft and sound visibility, filtering, detail routes, continuation cursors, and compares public fields and IDs to the export without printing the source data.

These checks do not replace a live Firestore comparison or a production cutover rehearsal. Before migrating writes, implement atomic Postgres transactions for votes, profile claims, friendships, and Studio access, and decide how the two databases stay synchronized during the transition.
