# Ambatu Admin

The standalone Next.js admin console for managing Ambaverse characters. Run it with:

```bash
cp .env.example .env.local
npm install
npm run dev
```

Until Cognito variables are set, authentication runs in a clearly labelled local preview mode so the interface can be explored. Once configured, the sign-in/sign-up actions use the Cognito user pool directly.

## AWS setup checklist

1. Create a Cognito **User Pool** for administrators, using email as a sign-in attribute. Create a public app client with no client secret and place its pool ID and client ID in `.env.local`.
2. Create a private S3 bucket for character imagery. Configure CORS only for the eventual presigned PUT upload flow, restricted to the admin app origin.
3. The included protected `/api/character-images/presign` route generates a five-minute S3 PUT URL, while `/api/characters` generates one-hour signed image reads. Give its hosting environment an IAM role with `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` limited to `arn:aws:s3:::YOUR_BUCKET/characters/*` (or use server-only AWS credentials locally). Configure the bucket CORS to allow `PUT` from your admin site origin. Never put AWS access keys in browser environment variables.
4. Create a Firebase service-account key and copy its project ID, client email, and private key into the server-only `FIREBASE_*` variables. The built-in `/api/characters` routes persist character records in the `characters` Firestore collection. Cognito ID tokens are verified by those routes when the Cognito variables are configured.

Recommended Firestore fields: `name`, `title`, `bio`, `tags`, `status`, `image`, `createdAt`, and `updatedAt`.
