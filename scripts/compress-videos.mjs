import { DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createVideoTranscodeJob, finalizeVideoTranscode, getVideoTranscodeJob, VIDEO_COMPRESSION_VERSION, VIDEO_UPLOAD_LIMIT } from '../src/lib/video-transcoding.mjs';

const apply = process.argv.includes('--apply');
const bucket = process.env.AWS_S3_CHARACTER_IMAGES_BUCKET;
const region = process.env.NEXT_PUBLIC_AWS_REGION || process.env.AWS_REGION || 'ap-southeast-1';
const supportedVideo = /\.(mp4|webm|mov|m4v|avi|mkv|mpeg|mpg|3gp|m2v|ts)$/i;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function firestore() {
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
    throw new Error('Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in admin/.env.local.');
  }
  const app = getApps()[0] ?? initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
  return getFirestore(app);
}

async function listVideos(client) {
  const objects = [];
  let ContinuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'videos/', ContinuationToken }));
    objects.push(...(page.Contents ?? []).filter(item => item.Key && !item.Key.endsWith('/')));
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);
  const videos = [];
  for (let offset = 0; offset < objects.length; offset += 20) {
    const page = await Promise.all(objects.slice(offset, offset + 20).map(async item => ({ key: item.Key, info: await objectInfo(client, item.Key) })));
    for (const item of page) {
      if (item.info && (item.info.ContentType?.startsWith('video/') || supportedVideo.test(item.key))) videos.push(item);
    }
  }
  return videos;
}

async function readVideoReferences(db) {
  const snapshot = await db.collection('videos').get();
  const byKey = new Map();
  for (const doc of snapshot.docs) {
    const key = doc.get('videoKey');
    if (typeof key !== 'string') continue;
    const refs = byKey.get(key) ?? [];
    refs.push(doc);
    byKey.set(key, refs);
  }
  return byKey;
}

function migratedKey(sourceKey) {
  if (/\.mp4$/i.test(sourceKey)) return sourceKey;
  const stem = sourceKey.replace(/\.[^./]+$/, '');
  return `${stem}.compressed.mp4`;
}

async function objectInfo(client, key) {
  try {
    return await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') return null;
    throw error;
  }
}

async function waitForJob(jobId) {
  while (true) {
    const job = await getVideoTranscodeJob(jobId);
    if (job.Status === 'COMPLETE') return;
    if (job.Status === 'ERROR' || job.Status === 'CANCELED') throw new Error(`MediaConvert ${job.Status.toLowerCase()}: ${job.ErrorMessage ?? 'no details returned'}`);
    process.stdout.write(`  MediaConvert ${job.Status ?? 'pending'}…\n`);
    await wait(10_000);
  }
}

async function updateReferences(db, refs, sourceKey, outputKey) {
  const matching = refs.get(sourceKey) ?? [];
  for (let offset = 0; offset < matching.length; offset += 450) {
    const batch = db.batch();
    for (const doc of matching.slice(offset, offset + 450)) batch.update(doc.ref, { videoKey: outputKey });
    await batch.commit();
  }
  return matching.length;
}

async function main() {
  if (!bucket) throw new Error('Set AWS_S3_CHARACTER_IMAGES_BUCKET in admin/.env.local.');
  const db = firestore();
  const client = new S3Client({ region });
  const [objects, refs] = await Promise.all([listVideos(client), readVideoReferences(db)]);
  process.stdout.write(`${apply ? 'APPLY MODE' : 'DRY RUN'} — ${objects.length} video objects found in s3://${bucket}/videos/\n`);
  process.stdout.write(`Transcode profile: H.264 MP4, maximum 1280×720, QVBR quality 7, AAC audio.\n`);
  if (!apply) process.stdout.write('No changes made. Add --apply to convert objects, update Firestore, and remove replaced originals.\n');

  for (const [index, item] of objects.entries()) {
    const sourceKey = item.key;
    const source = item.info;
    if (source.Metadata?.['ambatu-compression'] === VIDEO_COMPRESSION_VERSION && /\.mp4$/i.test(sourceKey)) {
      process.stdout.write(`[${index + 1}/${objects.length}] already compressed: ${sourceKey}\n`);
      continue;
    }
    const outputKey = migratedKey(sourceKey);
    const references = refs.get(sourceKey)?.length ?? 0;
    process.stdout.write(`[${index + 1}/${objects.length}] ${sourceKey} → ${outputKey} (${references} Firestore references)\n`);
    if (!apply) continue;

    const existingOutput = outputKey === sourceKey ? null : await objectInfo(client, outputKey);
    if (existingOutput && existingOutput.Metadata?.['ambatu-compression'] !== VIDEO_COMPRESSION_VERSION) {
      throw new Error(`Refusing to overwrite existing uncompressed object s3://${bucket}/${outputKey}.`);
    }
    if (existingOutput && (existingOutput.ContentType !== 'video/mp4' || !existingOutput.ContentLength || existingOutput.ContentLength > VIDEO_UPLOAD_LIMIT)) {
      throw new Error(`Compressed output is invalid or exceeds the 200 MB limit: s3://${bucket}/${outputKey}.`);
    }
    if (!existingOutput) {
      const created = await createVideoTranscodeJob({ sourceKey, videoKey: outputKey, owner: 'migration', sourceEtag: source.ETag });
      process.stdout.write(`  MediaConvert job ${created.jobId}\n`);
      await waitForJob(created.jobId);
      await finalizeVideoTranscode({ sourceKey, videoKey: outputKey, stageKey: created.stageKey, deleteSource: false });
    }

    const updated = await updateReferences(db, refs, sourceKey, outputKey);
    if (outputKey !== sourceKey) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: sourceKey }));
    process.stdout.write(`  saved MP4; updated ${updated} Firestore record(s); ${outputKey === sourceKey ? 'replaced' : 'removed original'}\n`);
  }
  process.stdout.write(apply ? 'Video compression migration complete.\n' : 'Dry run complete.\n');
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
