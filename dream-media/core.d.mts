import type { PoolClient } from "pg";
export const eligibleDream: string;
export function attachmentDto(row: Record<string, any>): {
  id: string;
  kind: "image" | "video";
  state: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  error: string | null;
};
export function cleanupJob(
  db: PoolClient,
  owner: string,
  rows: Record<string, any>[],
  mode?: "all" | "input" | "output",
  parentId?: string,
): Promise<string | null>;
export function reconcileDream(db: PoolClient, id: string): Promise<any>;
export function stageContent(
  db: PoolClient,
  dream: Record<string, any>,
  body: Record<string, any>,
): Promise<string | null>;
