import { createHash } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { isDevRateLimitWriter, withDevRateLimitDb } from './dev-content-db';

export type PlayerWriteLimit = {
  key: string;
  max: number;
  windowMs: number;
};

/** Enforce per-player write caps in one stable, server-only record. */
export async function allowPlayerWrite(
  db: Firestore,
  playerId: string,
  action: string,
  limits: PlayerWriteLimit[],
): Promise<boolean> {
  const playerKey = createHash('sha256').update(playerId).digest('hex');
  const now = Date.now();
  if (isDevRateLimitWriter()) {
    return withDevRateLimitDb(async client => {
      await client.query("INSERT INTO app.public_api_rate_limits (player_hash,rates) VALUES ($1,'{}') ON CONFLICT DO NOTHING", [playerKey]);
      const row = (await client.query<{ rates: unknown }>('SELECT rates FROM app.public_api_rate_limits WHERE player_hash=$1 FOR UPDATE', [playerKey])).rows[0];
      const next = updateRates(row.rates, action, limits, now);
      if (!next) return false;
      await client.query('UPDATE app.public_api_rate_limits SET rates=$2::jsonb,updated_at=now() WHERE player_hash=$1', [playerKey, JSON.stringify(next)]);
      return true;
    });
  }
  const ref = db.collection('publicApiRateLimits').doc(playerKey);

  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const next = updateRates(snapshot.data()?.rates, action, limits, now);
    if (!next) return false;
    transaction.set(ref, { rates: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
}

function updateRates(stored: unknown, action: string, limits: PlayerWriteLimit[], now: number) {
    const rates: Record<string, { startedAt: number; count: number }> =
      stored && typeof stored === 'object' && !Array.isArray(stored)
        ? { ...stored } as Record<string, { startedAt: number; count: number }>
        : {};
    const next = { ...rates };

    for (const limit of limits) {
      const key = `${action}.${limit.key}`;
      const current = rates[key];
      const active = Boolean(current
        && Number.isSafeInteger(current.startedAt)
        && Number.isSafeInteger(current.count)
        && now - current.startedAt < limit.windowMs);
      if (active && (current?.count ?? 0) >= limit.max) return null;
      next[key] = active
        ? { startedAt: current?.startedAt ?? now, count: (current?.count ?? 0) + 1 }
        : { startedAt: now, count: 1 };
    }

    return next;
}
