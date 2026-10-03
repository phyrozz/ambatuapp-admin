# AmbatuApp Studio

Friend request push alerts use the chat service's push Lambda. Set server-only `CHAT_PUSH_FUNCTION_NAME` to `ambatu-chat-<stage>-push` (for example, `ambatu-chat-prod-push`) and grant the admin runtime `lambda:InvokeFunction` on it. Deploy the matching chat-service stage first. The friend-request count badge remains available without this optional push configuration.

## Chat reports and username search

The chat report queue is at `/chat-reports`. Set server-only `CHAT_TABLE` and `CHAT_BUCKET` to the outputs of the chat-service CloudFormation stack, and grant the admin runtime `dynamodb:Scan`, `dynamodb:UpdateItem`, and `s3:GetObject` for that table and bucket's `chat/*` objects. Admins can restrict a reported player from chat and later unrestrict them from the separate restricted-users list. This changes only chat write access; it does not delete messages, affect other modules, or automatically resolve reports. Redeploy the chat-service Lambda to enforce restrictions. Username search uses `usernameLower` on player profiles. Run `npm run backfill:player-search` once to index existing profiles; new profile saves keep the field current.

The soundboard catalog is managed at `/sounds`. Audio is stored under `soundboard/` in `AWS_S3_CHARACTER_IMAGES_BUCKET`; grant the admin runtime S3 `PutObject` and `GetObject` permissions for that prefix, and allow `PUT` from the admin app origin in the bucket CORS policy. The public API exposes catalog metadata and redirects playback through short lived S3 URLs. Point the revamp app's `NEXT_PUBLIC_CHARACTER_API_URL` to the admin public API base ending in `/api/public` so the same catalog is available in AmbatuChat and Soundboard. To move the 26 bundled legacy clips into Firestore and S3 while keeping their current IDs for old chat messages, run `npm run seed:sounds` once from this directory after configuring `.env.local`. The script skips IDs already in `soundboardSounds`, so it can be safely rerun after a partial import.

## AmbatuWatch video compression

AmbatuWatch's Relevance sort gives a video uploaded in the last seven days a freshness bonus of up to five points, fading to zero over the week. Each batch compares its newest eligible upload with the highest-engagement video, then fills remaining positions by engagement. Deploy its Firestore indexes from this directory with `firebase deploy --only firestore:indexes --project YOUR_FIREBASE_PROJECT_ID` before enabling the sort in production.

Both the AmbatuWatch uploader and the admin video editor keep the 200 MB source-file limit. They upload the original into the private `video-upload-staging/` prefix, then use AWS Elemental MediaConvert to write an H.264/AAC MP4 capped at 1280×720 into `videos/`. The API only saves video records after MediaConvert succeeds; original staging files and temporary outputs are deleted after finalization. `infra/ambatuwatch-mediaconvert.yaml` creates the MediaConvert service role and a managed policy for the admin runtime and migration command. Deploy it with the bucket name:

```powershell
aws cloudformation deploy --template-file infra/ambatuwatch-mediaconvert.yaml --stack-name ambatuwatch-mediaconvert --parameter-overrides "VideoBucketName=YOUR_BUCKET_NAME" --capabilities CAPABILITY_NAMED_IAM
```

Deploy the stack in the S3 bucket's region, and keep `AWS_REGION` or `NEXT_PUBLIC_AWS_REGION` set to that same region. Attach the stack's `AppVideoPolicyArn` output to the admin runtime role and to the AWS identity used for the migration. Set the `MediaConvertRoleArn` output as `AWS_MEDIACONVERT_ROLE_ARN` in the admin environment and in `admin/.env.local`. The policy includes `mediaconvert:CreateJob`, `mediaconvert:GetJob`, endpoint discovery, `iam:PassRole` limited to the MediaConvert role, and the S3 access used by uploads and migration. `AWS_MEDIACONVERT_ENDPOINT` is optional; without it, the runtime discovers the account endpoint. `AWS_MEDIACONVERT_QUEUE_ARN` can select a non-default queue.

Add S3 lifecycle expiration after seven days for `video-upload-staging/` and `video-processing/` to clean up abandoned uploads and failed jobs. The bucket CORS policy must allow `PUT` from both the player app and admin origins. If the bucket uses a customer-managed KMS key for default encryption, grant the MediaConvert role the matching KMS decrypt/data-key permissions.

To convert the existing video objects, configure `.env.local` with the bucket, AWS credentials/region, MediaConvert role, and Firebase service-account values. Run `npm run compress:videos` for a read-only inventory first. Run `npm run compress:videos -- --apply` to transcode each unconverted object, update every matching document in Firestore's `videos` collection, and remove the original after its references point to the MP4. The command is resumable: it skips MP4s marked with the `ambatu-compression` metadata and can finish a partially completed migration on a later run. It scans video content types and common video extensions under `videos/`. MediaConvert charges for output duration and encoding settings; check [AWS MediaConvert pricing](https://aws.amazon.com/mediaconvert/pricing/) before applying the migration.

Profile saves also reserve case-insensitive usernames in the `playerUsernameClaims` Firestore collection. Run the player search backfill before enabling this check so previously saved usernames have `usernameLower`; the save route checks those profiles and claims new names atomically. Existing duplicate usernames must be changed to unique names when those users next save their profiles.

The standalone Next.js admin console for managing Ambaverse characters. Run it with:

```bash
npm install
# Create .env.local with the Cognito and Firebase values described below.
npm run dev
```

Until Cognito variables are set, authentication runs in local preview mode. Production fails closed when authentication is missing. Studio sign-in uses the existing admin Cognito pool and its `Admins` group, plus an enabled Firestore studio profile and its assigned role. The Users module is at `/users`; `/admins` redirects there. Registration is available from sign-in. Users verify their email, sign in, complete their profile, and receive no module access until a studio administrator assigns a role. Removing studio access disables the Firestore profile and removes group membership while preserving the Cognito account.

Set `NEXT_PUBLIC_COGNITO_USER_POOL_ID`, `NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID`, and `COGNITO_ADMIN_USER_POOL_ID` in the admin environment. The server uses its AWS role or local AWS credentials for Cognito user administration; never expose AWS credentials through `NEXT_PUBLIC_*` variables.

## AWS setup checklist

1. Use the existing admin Cognito **User Pool**, using email as a sign-in attribute. Keep the `Admins` group. Enable self-service sign-up and email verification for registration. Use a public app client with no client secret and set its pool ID and client ID as `NEXT_PUBLIC_COGNITO_USER_POOL_ID` and `NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID`; set the same pool ID server-side as `COGNITO_ADMIN_USER_POOL_ID`. Do not add pool attributes: personal details and roles live only in Firestore.
2. Create a private S3 bucket for character imagery and audio. Configure CORS for the presigned PUT upload flow, restricted to the admin app origin.
3. The included protected `/api/character-images/presign` route generates a five-minute S3 PUT URL, while `/api/characters` generates one-hour signed image reads. Give its hosting environment an IAM role with `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` limited to `arn:aws:s3:::YOUR_BUCKET/characters/*` (or use server-only AWS credentials locally). Configure the bucket CORS to allow `PUT` from your admin site origin. Never put AWS access keys in browser environment variables.
4. Give the admin runtime `cognito-idp:AdminListGroupsForUser`, `cognito-idp:AdminCreateUser`, `cognito-idp:AdminSetUserPassword`, `cognito-idp:AdminAddUserToGroup`, `cognito-idp:AdminRemoveUserFromGroup`, and `cognito-idp:AdminDeleteUser` on the admin pool ARN. The seed identity additionally needs `cognito-idp:ListUsersInGroup`; optional `cognito-idp:DescribeUserPool` lets the seed report the sign-up setting. `AdminDeleteUser` cleans up a newly created account if setup fails. Manual creation supplies a permanent initial password with a matching confirmation; no invitation email is sent. Existing temporary-password invitations remain supported. API requests check live group membership and Firestore permissions. Users cannot change their own role or remove their own access, only Root can grant or remove Root, and at least one enabled Root must remain.
5. Create a Firebase service-account key and copy its project ID, client email, and private key into the server-only `FIREBASE_*` variables. The built-in `/api/characters` routes persist character records in the `characters` Firestore collection. Cognito ID tokens are verified by those routes, and all admin APIs require the `Admins` group.

Recommended Firestore fields: `name`, `title`, `bio`, `tags`, `status`, `image`, `createdAt`, and `updatedAt`.

## Studio roles and migration

Run `npm run seed:access -- --dry-run` to inspect the migration, then `npm run seed:access` with the authorized Cognito and Firebase credentials **before deploying this change**. Authentication intentionally does not grant Root to an unseeded account. The idempotent seed creates eight `studioModules` documents, six `studioRoleTypes` documents (View, Add, Edit, Delete, Upload, Download), and the protected `studioRoles/root` role. It adds a `studioUsers/{cognitoSub}` profile for each existing Admins-group user, assigning Root without changing Cognito attributes. `studioSettings/accessSeed` records the initial cutoff; reruns preserve existing profiles/assignments and do not promote later registrations. Role documents track active assignments atomically with user changes, preventing deletion of assigned roles and removal of the final Root.

For this workspace's development AWS profile, run `node --env-file=.env.development.local --env-file=.env.local scripts/seed-studio-access.mjs`. The static credentials in `.env.local` do not have the required Cognito admin permissions. The deployed runtime also needs the Cognito permissions listed above; use an authorized runtime IAM role instead of those limited static credentials.

If self-sign-up is disabled, `npm run setup:registration` previews the setting change and `npm run setup:registration -- --apply` applies it with an identity that has `cognito-idp:DescribeUserPool` and `cognito-idp:UpdateUserPool`. Use the development profile by running `node --env-file=.env.development.local --env-file=.env.local scripts/enable-studio-registration.mjs --apply`. The script copies existing mutable settings, enables self-registration and email verification, and verifies the attribute schema is unchanged. It does not add Cognito profile or role attributes.

The `/roles` module creates, edits, and deletes custom roles. Each module has all six permission types, including Upload and Download for future bulk tools. Current media uploads require Upload independently from Add/Edit. Role and user lists request bounded batches of 30 documents with Firestore document-ID cursors and scroll sentinels. All authorization checks use Firestore records on each request, so a role change takes effect on the next request; the interface refreshes access every 30 seconds and on focus.

Registration and manual user creation share first name, last name, display name, country/region, optional bio, email, password, and confirm password. Manual creation adds the role dropdown. Passwords are sent only to Cognito and never stored in Firestore or browser storage. In-progress registration stores only email and personal details in session storage until completion. Email remains the sign-in identity; edits in Users change personal details and the assigned role.

The deployed Firestore rules deny all Firebase client SDK reads and writes, covering `studioUsers`, `studioRoles`, `studioModules`, `studioRoleTypes`, and `studioSettings`. Their only access path is the server's Firebase Admin SDK. Preserve that protection if rules change. `node --env-file=.env.local scripts/verify-studio-access.mjs --inspect-rules` verifies seeded modules, permission types, Root permissions and assignment count, and reads the deployed rules.

Run `npm run test:access`, `npm run typecheck`, `npm run lint`, and `npm run build` to validate the change. Admin text is stored locally in `src/lib/studio-messages.json`; the revamp translation workbook is not used for studio text.

For browser checks, install the revamp project's Playwright dependencies and use Microsoft Edge on Windows. Start `npm run dev:studio-test` in one terminal and run `npm run test:studio-ui` in another. The test server uses dummy Cognito settings and disables Firestore credentials. The browser intercepts Cognito and studio API requests with fixtures, checking role creation, cursor appends, user creation, restricted and pending-role access, registration, email confirmation, profile completion, password matching, and mobile layout without changing live accounts or content.
