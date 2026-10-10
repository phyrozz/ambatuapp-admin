import { createHash } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';

export type PlayerWriteLimit = {
  key: string;
  max: number;
  windowMs: number;
};

/** Enforce per-player write caps in one stable, server-only Firestore document. */
export async function allowPlayerWrite(
  db: Firestore,
  playerId: string,
  action: string,
  limits: PlayerWriteLimit[],
): Promise<boolean> {
  const playerKey = createHash('sha256').update(playerId).digest('hex');
  const ref = db.collection('publicApiRateLimits').doc(playerKey);
  const now = Date.now();

  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const stored = snapshot.data()?.rates;
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
      if (active && (current?.count ?? 0) >= limit.max) return false;
      next[key] = active
        ? { startedAt: current?.startedAt ?? now, count: (current?.count ?? 0) + 1 }
        : { startedAt: now, count: 1 };
    }

    transaction.set(ref, { rates: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
}
