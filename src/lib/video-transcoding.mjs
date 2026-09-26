import {
  CreateJobCommand,
  DescribeEndpointsCommand,
  GetJobCommand,
  MediaConvertClient,
} from '@aws-sdk/client-mediaconvert';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { basename, parse } from 'node:path';

export const VIDEO_UPLOAD_LIMIT = 200 * 1024 * 1024;
export const VIDEO_COMPRESSION_VERSION = 'h264-mp4-v1';

const region = () => process.env.NEXT_PUBLIC_AWS_REGION || process.env.AWS_REGION || 'ap-southeast-1';
const bucket = () => process.env.AWS_S3_CHARACTER_IMAGES_BUCKET;
const s3 = () => new S3Client({ region: region() });
let mediaClientPromise;

async function mediaClient() {
  if (!mediaClientPromise) {
    mediaClientPromise = (async () => {
      const endpoint = process.env.AWS_MEDIACONVERT_ENDPOINT;
      if (endpoint) return new MediaConvertClient({ region: region(), endpoint });
      const discovery = new MediaConvertClient({ region: region() });
      const result = await discovery.send(new DescribeEndpointsCommand({ MaxResults: 1 }));
      const accountEndpoint = result.Endpoints?.[0]?.Url;
      if (!accountEndpoint) throw new Error('MediaConvert endpoint is unavailable.');
      return new MediaConvertClient({ region: region(), endpoint: accountEndpoint });
    })();
  }
  return mediaClientPromise;
}

export async function headVideoObject(key) {
  const name = bucket();
  if (!name) throw new Error('Video storage is not configured.');
  return s3().send(new HeadObjectCommand({ Bucket: name, Key: key }));
}

export async function createVideoTranscodeJob({ sourceKey, videoKey, owner, sourceEtag = '' }) {
  const name = bucket();
  const roleArn = process.env.AWS_MEDIACONVERT_ROLE_ARN;
  if (!name) throw new Error('Video storage is not configured.');
  if (!roleArn) throw new Error('MediaConvert is not configured.');
  const id = videoKey.split('/').at(-1)?.replace(/\.mp4$/i, '');
  if (!id) throw new Error('Invalid video output key.');
  const stagePrefix = `video-processing/${owner}/${id}/`;
  const stageKey = `${stagePrefix}${parse(basename(sourceKey)).name}.mp4`;
  const sourceUri = `s3://${name}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`;
  const endpoint = await mediaClient();
  const requestToken = createHash('sha256').update(`${sourceKey}:${sourceEtag}`).digest('hex');
  const response = await endpoint.send(new CreateJobCommand({
    ClientRequestToken: requestToken,
    Role: roleArn,
    ...(process.env.AWS_MEDIACONVERT_QUEUE_ARN ? { Queue: process.env.AWS_MEDIACONVERT_QUEUE_ARN } : {}),
    UserMetadata: { ambatuOwner: owner, ambatuSourceKey: sourceKey, ambatuVideoKey: videoKey, ambatuStageKey: stageKey },
    Settings: {
      TimecodeConfig: { Source: 'ZEROBASED' },
      Inputs: [{
        FileInput: sourceUri,
        AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
        VideoSelector: { ColorSpace: 'FOLLOW' },
      }],
      OutputGroups: [{
        Name: 'AmbatuWatch compressed MP4',
        OutputGroupSettings: {
          Type: 'FILE_GROUP_SETTINGS',
          FileGroupSettings: { Destination: `s3://${name}/${stagePrefix}` },
        },
        Outputs: [{
          ContainerSettings: { Container: 'MP4', Mp4Settings: { MoovPlacement: 'PROGRESSIVE_DOWNLOAD' } },
          VideoDescription: {
            Width: 1280,
            Height: 720,
            ScalingBehavior: 'FIT_NO_UPSCALE',
            CodecSettings: {
              Codec: 'H_264',
              H264Settings: {
                RateControlMode: 'QVBR',
                QvbrSettings: { QvbrQualityLevel: 7 },
                MaxBitrate: 4_000_000,
                FramerateControl: 'INITIALIZE_FROM_SOURCE',
                CodecProfile: 'MAIN',
                CodecLevel: 'AUTO',
                GopSizeUnits: 'SECONDS',
                GopSize: 2,
                QualityTuningLevel: 'SINGLE_PASS_HQ',
              },
            },
          },
          AudioDescriptions: [{
            AudioSourceName: 'Audio Selector 1',
            CodecSettings: {
              Codec: 'AAC',
              AacSettings: { Bitrate: 128_000, CodingMode: 'CODING_MODE_2_0', SampleRate: 48_000 },
            },
          }],
        }],
      }],
    },
  }));
  if (!response.Job?.Id) throw new Error('MediaConvert did not return a job ID.');
  return { jobId: response.Job.Id, sourceKey, videoKey, stageKey, owner };
}

export async function getVideoTranscodeJob(jobId) {
  const client = await mediaClient();
  const response = await client.send(new GetJobCommand({ Id: jobId }));
  if (!response.Job) throw new Error('MediaConvert job was not found.');
  return response.Job;
}

export async function finalizeVideoTranscode({ sourceKey, videoKey, stageKey, deleteSource = true }) {
  const name = bucket();
  if (!name) throw new Error('Video storage is not configured.');
  const client = s3();
  let output;
  try {
    output = await client.send(new HeadObjectCommand({ Bucket: name, Key: videoKey }));
  } catch (error) {
    if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== 'NotFound') throw error;
  }
  if (output?.Metadata?.['ambatu-compression'] !== VIDEO_COMPRESSION_VERSION) {
    const staged = await client.send(new HeadObjectCommand({ Bucket: name, Key: stageKey }));
    if (!staged.ContentLength || staged.ContentLength > VIDEO_UPLOAD_LIMIT) throw new Error('Compressed video exceeds the 200 MB limit.');
    const copySource = `${name}/${stageKey.split('/').map(encodeURIComponent).join('/')}`;
    await client.send(new CopyObjectCommand({
      Bucket: name,
      Key: videoKey,
      CopySource: copySource,
      MetadataDirective: 'REPLACE',
      ContentType: 'video/mp4',
      Metadata: { 'ambatu-compression': VIDEO_COMPRESSION_VERSION },
    }));
    output = { ...staged, Metadata: { 'ambatu-compression': VIDEO_COMPRESSION_VERSION } };
  }
  if (!output?.ContentLength || output.ContentLength > VIDEO_UPLOAD_LIMIT) throw new Error('Compressed video exceeds the 200 MB limit.');
  await client.send(new DeleteObjectCommand({ Bucket: name, Key: stageKey }));
  if (deleteSource && sourceKey !== videoKey) await client.send(new DeleteObjectCommand({ Bucket: name, Key: sourceKey }));
  return { videoKey, size: output.ContentLength };
}
