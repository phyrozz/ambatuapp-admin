import { NextResponse } from 'next/server';
import { healthRateLimit } from '../../../lib/health-rate-limit';

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
    const { adminDb } = await import('../../../lib/firebase-admin');
    if (!adminDb) throw new Error('Firestore is not configured');

    // A missing document is still a successful read and needs no setup or writes.
    await adminDb.collection('_health').doc('check').get();
    return NextResponse.json({ status: 'ok', api: 'ok', database: 'ok' }, { headers });
  } catch {
    return NextResponse.json(
      { status: 'unavailable', api: 'ok', database: 'unavailable' },
      { status: 503, headers },
    );
  }
}
