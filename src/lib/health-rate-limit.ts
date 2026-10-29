const MAX_REQUESTS = 60;
const WINDOW_MS = 60_000;

// This shared budget bounds health-check reads within each running instance.
let windowStartedAt = 0;
let requests = 0;

export function healthRateLimit(now = Date.now()): number | null {
  if (requests === 0 || now < windowStartedAt || now - windowStartedAt >= WINDOW_MS) {
    windowStartedAt = now;
    requests = 0;
  }
  if (requests >= MAX_REQUESTS) {
    return Math.max(1, Math.ceil((windowStartedAt + WINDOW_MS - now) / 1000));
  }
  requests += 1;
  return null;
}
