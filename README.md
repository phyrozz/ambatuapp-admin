# Ambatu Admin

## Chat reports and username search

The chat report queue is at `/chat-reports`. Set server-only `CHAT_TABLE` and `CHAT_BUCKET` to the outputs of the chat-service CloudFormation stack, and grant the admin runtime `dynamodb:Scan`, `dynamodb:UpdateItem`, and `s3:GetObject` for that table and bucket's `chat/*` objects. Admins can restrict a reported player from chat and later unrestrict them from the separate restricted-users list. This changes only chat write access; it does not delete messages, affect other modules, or automatically resolve reports. Redeploy the chat-service Lambda to enforce restrictions. Username search uses `usernameLower` on player profiles. Run `npm run backfill:player-search` once to index existing profiles; new profile saves keep the field current.

The soundboard catalog is managed at `/sounds`. Audio is stored under `soundboard/` in `AWS_S3_CHARACTER_IMAGES_BUCKET`; grant the admin runtime S3 `PutObject` and `GetObject` permissions for that prefix, and allow `PUT` from the admin app origin in the bucket CORS policy. The public API exposes catalog metadata and redirects playback through short lived S3 URLs. Point the revamp app's `NEXT_PUBLIC_CHARACTER_API_URL` to the admin public API base ending in `/api/public` so the same catalog is available in AmbatuChat and Soundboard. To move the 26 bundled legacy clips into Firestore and S3 while keeping their current IDs for old chat messages, run `npm run seed:sounds` once from this directory after configuring `.env.local`. The script skips IDs already in `soundboardSounds`, so it can be safely rerun after a partial import.

Profile saves also reserve case-insensitive usernames in the `playerUsernameClaims` Firestore collection. Run the player search backfill before enabling this check so previously saved usernames have `usernameLower`; the save route checks those profiles and claims new names atomically. Existing duplicate usernames must be changed to unique names when those users next save their profiles.

The standalone Next.js admin console for managing Ambaverse characters. Run it with:

```bash
npm install
# Create .env.local with the Cognito and Firebase values described below.
npm run dev
```

Until Cognito variables are set, authentication runs in a clearly labelled local preview mode so the interface can be explored. Once configured, sign-in uses the Cognito user pool and requires membership in its `Admins` group. Public sign-up is not offered; administrators can invite new accounts or grant admin access to an existing account from `/admins`. Removing someone removes their `Admins` group membership while preserving their Cognito account.

Set `NEXT_PUBLIC_COGNITO_USER_POOL_ID`, `NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID`, and `COGNITO_ADMIN_USER_POOL_ID` in the admin environment. The server uses its AWS role or local AWS credentials for Cognito user administration; never expose AWS credentials through `NEXT_PUBLIC_*` variables.

## AWS setup checklist

1. Create a Cognito **User Pool** for administrators, using email as a sign-in attribute. Create an `Admins` group and add at least one initial administrator before deploying this update. Disable self-service sign-up and enable **Only allow administrators to create users**. Create a public app client with no client secret and set its pool ID and client ID as `NEXT_PUBLIC_COGNITO_USER_POOL_ID` and `NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID`; set the same pool ID server-side as `COGNITO_ADMIN_USER_POOL_ID`.
2. Create a private S3 bucket for character imagery and audio. Configure CORS for the presigned PUT upload flow, restricted to the admin app origin.
3. The included protected `/api/character-images/presign` route generates a five-minute S3 PUT URL, while `/api/characters` generates one-hour signed image reads. Give its hosting environment an IAM role with `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` limited to `arn:aws:s3:::YOUR_BUCKET/characters/*` (or use server-only AWS credentials locally). Configure the bucket CORS to allow `PUT` from your admin site origin. Never put AWS access keys in browser environment variables.
4. Give the admin runtime `cognito-idp:ListUsersInGroup`, `cognito-idp:AdminListGroupsForUser`, `cognito-idp:AdminGetUser`, `cognito-idp:AdminCreateUser`, `cognito-idp:AdminAddUserToGroup`, `cognito-idp:AdminRemoveUserFromGroup`, and `cognito-idp:AdminDeleteUser` on the administrator user pool ARN. `AdminDeleteUser` is used only to clean up a newly created account if group assignment fails. API requests check current group membership so removed admins lose access immediately. Configure the Cognito invitation email template to include `{username}` and `{####}` so new admins receive their temporary password. The manager prevents removing your own access or the final admin.
5. Create a Firebase service-account key and copy its project ID, client email, and private key into the server-only `FIREBASE_*` variables. The built-in `/api/characters` routes persist character records in the `characters` Firestore collection. Cognito ID tokens are verified by those routes, and all admin APIs require the `Admins` group.

Recommended Firestore fields: `name`, `title`, `bio`, `tags`, `status`, `image`, `createdAt`, and `updatedAt`.
