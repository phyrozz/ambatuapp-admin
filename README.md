# Ambatu Admin

## Chat reports and username search

The chat report queue is at `/chat-reports`. Set server-only `CHAT_TABLE` and `CHAT_BUCKET` to the outputs of the chat-service CloudFormation stack, and grant the admin runtime `dynamodb:Scan`, `dynamodb:UpdateItem`, and `s3:GetObject` for that table and bucket's `chat/*` objects. Admins can restrict a reported player from chat and later unrestrict them from the separate restricted-users list. This changes only chat write access; it does not delete messages, affect other modules, or automatically resolve reports. Redeploy the chat-service Lambda to enforce restrictions. Username search uses `usernameLower` on player profiles. Run `npm run backfill:player-search` once to index existing profiles; new profile saves keep the field current.

The soundboard catalog is managed at `/sounds`. Audio is stored under `soundboard/` in `AWS_S3_CHARACTER_IMAGES_BUCKET`; grant the admin runtime S3 `PutObject` and `GetObject` permissions for that prefix, and allow `PUT` from the admin app origin in the bucket CORS policy. The public API exposes catalog metadata and redirects playback through short lived S3 URLs. Point the revamp app's `NEXT_PUBLIC_CHARACTER_API_URL` to the admin public API base ending in `/api/public` so the same catalog is available in AmbatuChat and Soundboard. To move the 26 bundled legacy clips into Firestore and S3 while keeping their current IDs for old chat messages, run `npm run seed:sounds` once from this directory after configuring `.env.local`. The script skips IDs already in `soundboardSounds`, so it can be safely rerun after a partial import.

Profile saves also reserve case-insensitive usernames in the `playerUsernameClaims` Firestore collection. Run the player search backfill before enabling this check so previously saved usernames have `usernameLower`; the save route checks those profiles and claims new names atomically. Existing duplicate usernames must be changed to unique names when those users next save their profiles.

The standalone Next.js admin console for managing Ambaverse characters. Run it with:

```bash
cp .env.example .env.local
npm install
npm run dev
```

Until Cognito variables are set, authentication runs in a clearly labelled local preview mode so the interface can be explored. Once configured, the sign-in/sign-up actions use the Cognito user pool directly.

## AWS setup checklist

1. Create a Cognito **User Pool** for administrators, using email as a sign-in attribute. Create a public app client with no client secret and place its pool ID and client ID in `.env.local`.
2. Create a private S3 bucket for character imagery and audio. Configure CORS for the presigned PUT upload flow, restricted to the admin app origin.
3. The included protected `/api/character-images/presign` route generates a five-minute S3 PUT URL, while `/api/characters` generates one-hour signed image reads. Give its hosting environment an IAM role with `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` limited to `arn:aws:s3:::YOUR_BUCKET/characters/*` (or use server-only AWS credentials locally). Configure the bucket CORS to allow `PUT` from your admin site origin. Never put AWS access keys in browser environment variables.
4. Create a Firebase service-account key and copy its project ID, client email, and private key into the server-only `FIREBASE_*` variables. The built-in `/api/characters` routes persist character records in the `characters` Firestore collection. Cognito ID tokens are verified by those routes when the Cognito variables are configured.

Recommended Firestore fields: `name`, `title`, `bio`, `tags`, `status`, `image`, `createdAt`, and `updatedAt`.
