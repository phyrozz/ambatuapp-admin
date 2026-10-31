import { NextResponse } from 'next/server';
import { healthRateLimit } from '../../../lib/health-rate-limit';
import { isDevContentSnapshot, withDevContentDb } from '../../../lib/dev-content-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store' };

export async function GET() {
  const retryAfter = healthRateLimit();
  if (retryAfter !== null) {
    return NextResponse.json(
      { status: 'rate_limited' },
      { status: 429, headers: { ...headers, 'Retry-After': String(retryAfter) } },
    );
  }
  try {
    const postgres = isDevContentSnapshot();
    if (postgres) {
      // The connection helper checks the expected import marker without writing.
      await withDevContentDb(async () => {});
    } else {
      const { adminDb } = await import('../../../lib/firebase-admin');
      if (!adminDb) throw new Error('Firestore is not configured');
      await adminDb.collection('_health').doc('check').get();
    }
    return NextResponse.json({ status: 'ok', api: 'ok', database: 'ok', database_backend: postgres ? 'postgres' : 'firestore' }, { headers });
  } catch {
    return NextResponse.json(
      { status: 'unavailable', api: 'ok', database: 'unavailable' },
      { status: 503, headers },
    );
  }
}
