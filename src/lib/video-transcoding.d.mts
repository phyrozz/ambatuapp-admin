import type { Job } from '@aws-sdk/client-mediaconvert';

export declare const VIDEO_UPLOAD_LIMIT: number;
export declare const VIDEO_COMPRESSION_VERSION: string;
export declare function headVideoObject(key: string): Promise<{ ContentLength?: number; ETag?: string; ContentType?: string; Metadata?: Record<string, string | undefined> }>;
export declare function createVideoTranscodeJob(input: { sourceKey: string; videoKey: string; owner: string; sourceEtag?: string }): Promise<{ jobId: string; sourceKey: string; videoKey: string; stageKey: string; owner: string }>;
export declare function getVideoTranscodeJob(jobId: string): Promise<Job>;
export declare function finalizeVideoTranscode(input: { sourceKey: string; videoKey: string; stageKey: string; deleteSource?: boolean }): Promise<{ videoKey: string; size: number }>;
