import { NextResponse } from 'next/server';
import { playerFromRequest } from './player-auth';
import { DreamError } from './dream-validation';

export const dreamHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, idempotency-key', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Cache-Control': 'private, no-store', Vary: 'Authorization' };
export function dreamOptions() { return new NextResponse(null, { status: 204, headers: dreamHeaders }); }
export function dreamEnabled(viewerId: string | null) {
  if (process.env.AMBATUPOST_ENABLED !== 'true') return false;
  const allowed = (process.env.AMBATUPOST_ALLOWED_PLAYER_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
  return !allowed.length || Boolean(viewerId && allowed.includes(viewerId));
}
export async function dreamViewer(request: Request, required = false) {
  if (process.env.AMBATUPOST_ENABLED !== 'true') throw new DreamError('MODULE_UNAVAILABLE', 404);
  let viewer;
  try { viewer = await playerFromRequest(request); } catch { throw new DreamError('UNAUTHORIZED', 401); }
  if (request.headers.has('authorization') && !viewer) throw new DreamError('UNAUTHORIZED', 401);
  if (!dreamEnabled(viewer?.id ?? null)) throw new DreamError('MODULE_UNAVAILABLE', 404);
  if (required && !viewer) throw new DreamError('UNAUTHORIZED', 401);
  return viewer?.id ?? null;
}
export async function readDreamBody(request: Request) {
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new DreamError('INVALID_CONTENT_TYPE', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new DreamError('INVALID_DREAM', 422);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16_384) { await reader.cancel(); throw new DreamError('BODY_TOO_LARGE', 413); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof DreamError) throw error;
    throw new DreamError('INVALID_DREAM', 422);
  } finally { reader.releaseLock(); }
}
export function dreamResponse(body: unknown, status = 200) { return NextResponse.json(body, { status, headers: dreamHeaders }); }
export function dreamFailure(error: unknown) {
  return dreamResponse({ error: error instanceof DreamError ? error.code : 'DREAM_SERVICE_UNAVAILABLE' }, error instanceof DreamError ? error.status : 503);
}
