// Explicit deployment helper. Defaults to a read-only preview; --apply merges
// the stage notification/CORS additions without replacing other integrations.
import {
  S3Client,
  GetBucketNotificationConfigurationCommand,
  PutBucketNotificationConfigurationCommand,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
} from "@aws-sdk/client-s3";
const [bucket, stage, queueArn, ...origins] = process.argv
  .slice(2)
  .filter((arg) => arg !== "--apply");
if (
  !bucket ||
  !["dev", "prod"].includes(stage) ||
  !/^arn:aws[a-z-]*:sqs:[a-z0-9-]+:\d{12}:[\w-]+$/.test(queueArn ?? "") ||
  !origins.length
)
  throw new Error(
    "Usage: configure-bucket.mjs <bucket> <dev|prod> <queue-arn> <origins...> [--apply]",
  );
for (const origin of origins)
  if (origin !== "capacitor://localhost" && !/^https?:\/\/[^/]+$/.test(origin))
    throw new Error("Use explicit web/native origins.");
const client = new S3Client({});
const version = await client.send(
  new GetBucketVersioningCommand({ Bucket: bucket }),
);
const access = (
  await client.send(new GetPublicAccessBlockCommand({ Bucket: bucket }))
).PublicAccessBlockConfiguration;
if (version.Status || !access || !Object.values(access).every(Boolean))
  throw new Error(
    "Bucket must have no retained versions and all public access blocked. Review bucket configuration separately.",
  );
const current = await client.send(
  new GetBucketNotificationConfigurationCommand({ Bucket: bucket }),
);
const notification = { ...current };
delete notification.$metadata;
const id = `ambatupost-${stage}-inputs`;
const entry = {
  Id: id,
  QueueArn: queueArn,
  Events: ["s3:ObjectCreated:*"],
  Filter: {
    Key: {
      FilterRules: [{ Name: "prefix", Value: `ambatupost/${stage}/input/` }],
    },
  },
};
const outputId = `ambatupost-${stage}-outputs`;
const outputEntry = {
  ...entry,
  Id: outputId,
  Filter: {
    Key: {
      FilterRules: [{ Name: "prefix", Value: `ambatupost/${stage}/media/` }],
    },
  },
};
notification.QueueConfigurations = [
  ...(notification.QueueConfigurations ?? []).filter(
    (row) => ![id, outputId].includes(row.Id),
  ),
  entry,
  outputEntry,
];
let rules = [];
try {
  rules =
    (await client.send(new GetBucketCorsCommand({ Bucket: bucket })))
      .CORSRules ?? [];
} catch (error) {
  if (error.name !== "NoSuchCORSConfiguration") throw error;
}
const cors = {
  ID: `ambatupost-${stage}-uploads`,
  AllowedOrigins: origins,
  AllowedMethods: ["PUT"],
  AllowedHeaders: ["content-type", "if-none-match", "x-amz-*"],
  ExposeHeaders: ["ETag"],
  MaxAgeSeconds: 300,
};
const merged = [...rules.filter((row) => row.ID !== cors.ID), cors];
let lifecycle = [];
try {
  lifecycle =
    (
      await client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
      )
    ).Rules ?? [];
} catch (error) {
  if (error.name !== "NoSuchLifecycleConfiguration") throw error;
}
const expiration = {
  ID: id,
  Status: "Enabled",
  Filter: { Prefix: `ambatupost/${stage}/input/` },
  Expiration: { Days: 1 },
  AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
};
const lifecycleRules = [
  ...lifecycle.filter((row) => row.ID !== id),
  expiration,
];
console.log(
  JSON.stringify({
    mode: process.argv.includes("--apply") ? "apply" : "preview",
    stage,
    notificationIds: [id, outputId],
    origins,
    preservedNotificationCount:
      (current.QueueConfigurations?.filter(
        (row) => ![id, outputId].includes(row.Id),
      ).length ?? 0) +
      (current.LambdaFunctionConfigurations?.length ?? 0) +
      (current.TopicConfigurations?.length ?? 0),
    preservedCorsCount: merged.length - 1,
    preservedLifecycleCount: lifecycleRules.length - 1,
  }),
);
if (process.argv.includes("--apply")) {
  await client.send(
    new PutBucketNotificationConfigurationCommand({
      Bucket: bucket,
      NotificationConfiguration: notification,
    }),
  );
  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: { CORSRules: merged },
    }),
  );
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: lifecycleRules },
    }),
  );
}
