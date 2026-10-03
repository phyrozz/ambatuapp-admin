import { NextResponse } from 'next/server';
export function adminErrorStatus(error: unknown, fallback: number) {
  const key = error instanceof Error ? error.message : '';
  return key === 'studio.errors.unauthorized' ? 401 : key === 'studio.errors.forbidden' ? 403
    : ['studio.errors.firestore', 'studio.errors.authConfiguration'].includes(key) ? 503 : fallback;
}
export function studioError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const key = message.startsWith('studio.errors.') ? message : 'studio.errors.request';
  const status = key === 'studio.errors.unauthorized' ? 401 : key === 'studio.errors.forbidden' ? 403
    : ['studio.errors.firestore', 'studio.errors.authConfiguration'].includes(key) ? 503
      : ['studio.errors.roleInUse', 'studio.errors.userExists'].includes(key) ? 409 : 400;
  return NextResponse.json({ error: key }, { status, headers: { 'Cache-Control': 'no-store' } });
}
