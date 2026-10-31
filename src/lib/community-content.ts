import { NextResponse } from "next/server";
import { adminDb } from "./firebase-admin";
import { requirePlayer } from "./player-auth";
import { allowPlayerWrite } from "./public-write-limits";
import { isDevContentSnapshot, isDevRateLimitWriter } from "./dev-content-db";

export const contributionHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Cache-Control": "no-store",
};

export class ContributionError extends Error {
  constructor(public status: number) {
    super("Contribution request failed.");
  }
}

export function contributionStatus(value: unknown, fallback: 'Draft' | 'Published' = 'Published'): 'Draft' | 'Published' {
  if (value === undefined) return fallback;
  if (value !== 'Draft' && value !== 'Published') throw new ContributionError(400);
  return value;
}

export async function contributionPlayer(request: Request) {
  if (!adminDb && !isDevContentSnapshot()) throw new ContributionError(503);
  try {
    return await requirePlayer(request);
  } catch {
    throw new ContributionError(401);
  }
}

export function requireContributionFirestore() {
  if (!adminDb) throw new ContributionError(503);
  return adminDb;
}

export async function contributionBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new ContributionError(400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw new ContributionError(413);
      }
      chunks.push(chunk.value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ContributionError(400);
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ContributionError) throw error;
    throw new ContributionError(400);
  } finally {
    reader.releaseLock();
  }
}

export async function limitContribution(
  playerId: string,
  action: string,
  daily: number,
) {
  if (!adminDb && !isDevRateLimitWriter()) throw new ContributionError(503);
  if (
    !(await allowPlayerWrite(adminDb, playerId, action, [
      { key: "minute", max: 3, windowMs: 60_000 },
      { key: "day", max: daily, windowMs: 86_400_000 },
    ]))
  )
    throw new ContributionError(429);
}

export function contributionError(error: unknown) {
  const status = error instanceof ContributionError ? error.status : 400;
  return NextResponse.json(
    { error: "Contribution request failed." },
    { status, headers: contributionHeaders },
  );
}
