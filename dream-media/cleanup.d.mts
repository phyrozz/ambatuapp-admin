import type { PoolClient } from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
export function sweepCleanup(
  db: PoolClient,
  s3: S3Client,
  bucket: string,
  namespace: string,
  id: string,
): Promise<void>;
