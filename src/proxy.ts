import { NextResponse, type NextRequest } from 'next/server';
import { apiLimitFor, clientIpHeader, createLocalApiLimiter, trustedClientIp } from './lib/api-rate-limit';
import { readApiRateLimitSettings } from './lib/api-rate-limit-settings';
import { requireStudioIdentity } from './lib/api-auth';
import { adminDb } from './lib/firebase-admin';
import { playerFromRequest } from './lib/player-auth';
import { allowPlayerWrite } from './lib/public-write-limits';

const localApiLimit = createLocalApiLimiter();

async function identityFor(request: NextRequest): Promise<string | null> {
  if (request.headers.has('authorization')) {
    // Only verified claims may select an account budget. Invalid credentials
    // still use the anonymous budget before the route rejects them.
    const player = await playerFromRequest(request).catch(() => null);
    if (player) return `api:player:${player.id}`;
    const studio = await requireStudioIdentity(request).catch(() => null);
    if (studio) return `api:studio:${studio.sub}`;
  }
  const header = clientIpHeader(process.env.API_RATE_LIMIT_TRUSTED_IP_HEADER, process.env.VERCEL);
  const ip = trustedClientIp(request.headers, header);
  return ip ? `api:ip:${ip}` : null;
}

function responseHeaders(request: NextRequest): Record<string, string> {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (request.nextUrl.pathname.startsWith('/api/public/')) {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Expose-Headers'] = 'Retry-After';
  }
  return headers;
}

export async function proxy(request: NextRequest) {
  // Preflight requests do not invoke an API handler. Health has its own limit.
  if (request.method === 'OPTIONS' || request.nextUrl.pathname === '/api/health') {
    return NextResponse.next();
  }

  const headers = responseHeaders(request);
  try {
    if (!(await readApiRateLimitSettings(adminDb)).enabled) return NextResponse.next();
    const identity = await identityFor(request);
    const limit = apiLimitFor(request.method, request.nextUrl.pathname);
    const localFallback = !identity && process.env.NODE_ENV === 'development'
      && !process.env.API_RATE_LIMIT_TRUSTED_IP_HEADER && process.env.VERCEL !== '1';
    if (!identity && !localFallback) return NextResponse.json({ error: 'RATE_LIMIT_UNAVAILABLE' }, { status: 503, headers });
    const allowed = localFallback
      ? localApiLimit(limit)
      : await allowPlayerWrite(adminDb, identity!, limit.action, [{ key: 'minute', max: limit.max, windowMs: limit.windowMs }]);
    if (allowed) {
      return NextResponse.next();
    }
    return NextResponse.json({ error: 'RATE_LIMITED' }, {
      status: 429,
      headers: { ...headers, 'Retry-After': String(limit.windowMs / 1000) },
    });
  } catch {
    return NextResponse.json({ error: 'RATE_LIMIT_UNAVAILABLE' }, { status: 503, headers });
  }
}

export const config = { matcher: '/api/:path*' };
