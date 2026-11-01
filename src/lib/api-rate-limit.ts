import { isIP } from 'node:net';

export type ApiLimit = { action: string; max: number; windowMs: number };

export function clientIpHeader(configured: string | undefined, vercel: string | undefined): string | undefined {
  return configured || (vercel === '1' ? 'x-vercel-forwarded-for' : undefined);
}

export function apiLimitFor(method: string, pathname: string): ApiLimit {
  const read = method === 'GET' || method === 'HEAD';
  const expensive = !read && /\/(presign|transcode)(?:\/|$)/.test(pathname);
  return {
    action: expensive ? 'apiExpensiveWrite' : read ? 'apiRead' : 'apiWrite',
    max: expensive ? 20 : read ? 300 : 60,
    windowMs: 60_000,
  };
}

// Development-only fallback for a local server without a trusted ingress.
export function createLocalApiLimiter() {
  const buckets = new Map<string, { startedAt: number; count: number }>();
  return (limit: ApiLimit, now = Date.now()): boolean => {
    let bucket = buckets.get(limit.action);
    if (!bucket || now < bucket.startedAt || now - bucket.startedAt >= limit.windowMs) {
      bucket = { startedAt: now, count: 0 };
      buckets.set(limit.action, bucket);
    }
    if (bucket.count >= limit.max) return false;
    bucket.count++;
    return true;
  };
}

// The configured header must be overwritten by a trusted ingress, and direct
// access to the application must be blocked. Never accept an address list.
export function trustedClientIp(headers: Headers, headerName: string | undefined): string | null {
  if (!headerName || !/^[a-z0-9-]+$/i.test(headerName)) return null;
  const value = headers.get(headerName)?.trim();
  if (!value) return null;
  const version = isIP(value);
  if (version === 4) return value;
  if (version === 6) return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  return null;
}
