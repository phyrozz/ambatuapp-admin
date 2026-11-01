import type { Firestore } from 'firebase-admin/firestore';
import { isDevRateLimitWriter, withDevRateLimitDb } from './dev-content-db';

// Normal rate-limit records are SHA-256 hashes, so this key cannot collide.
const key = '__api_rate_limit_settings__';
type Settings = { enabled: boolean; version: number };

function parseSettings(value: unknown): Settings {
  if (value == null) return { enabled: true, version: 0 };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('studio.errors.rateLimitSettingsUnavailable');
  const data = value as Record<string, unknown>;
  if (typeof data.enabled !== 'boolean' || !Number.isSafeInteger(data.version) || Number(data.version) < 1) {
    throw new Error('studio.errors.rateLimitSettingsUnavailable');
  }
  return { enabled: data.enabled, version: Number(data.version) };
}

export async function readApiRateLimitSettings(db: Firestore | null): Promise<Settings> {
  if (isDevRateLimitWriter()) {
    return withDevRateLimitDb(async client => {
      const result = await client.query<{ rates: unknown }>('SELECT rates FROM app.public_api_rate_limits WHERE player_hash=$1', [key]);
      return parseSettings(result.rows[0]?.rates);
    });
  }
  if (!db) {
    if (process.env.NODE_ENV === 'development' && process.env.VERCEL !== '1') return { enabled: true, version: 0 };
    throw new Error('studio.errors.rateLimitSettingsUnavailable');
  }
  const snapshot = await db.collection('publicApiRateLimits').doc(key).get();
  return parseSettings(snapshot.exists ? snapshot.data()?.rates : null);
}

export async function saveApiRateLimitSettings(db: Firestore | null, enabled: boolean, version: number, actor: string): Promise<Settings> {
  if (typeof enabled !== 'boolean' || !Number.isSafeInteger(version) || version < 0) throw new Error('studio.errors.rateLimitSettingsInvalid');
  const next = { enabled, version: version + 1 };
  if (isDevRateLimitWriter()) {
    return withDevRateLimitDb(async client => {
      await client.query("INSERT INTO app.public_api_rate_limits (player_hash,rates) VALUES ($1,'{}') ON CONFLICT DO NOTHING", [key]);
      const result = await client.query<{ rates: unknown }>('SELECT rates FROM app.public_api_rate_limits WHERE player_hash=$1 FOR UPDATE', [key]);
      const raw = result.rows[0].rates as Record<string, unknown>;
      const current = Object.keys(raw).length ? parseSettings(raw) : { enabled: true, version: 0 };
      if (current.version !== version) throw new Error('studio.errors.rateLimitSettingsConflict');
      await client.query('UPDATE app.public_api_rate_limits SET rates=$2::jsonb, updated_at=now(), extra=$3::jsonb WHERE player_hash=$1', [key, JSON.stringify(next), JSON.stringify({ updatedBy: actor })]);
      return next;
    });
  }
  if (!db) throw new Error('studio.errors.rateLimitSettingsUnavailable');
  const ref = db.collection('publicApiRateLimits').doc(key);
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const current = parseSettings(snapshot.exists ? snapshot.data()?.rates : null);
    if (current.version !== version) throw new Error('studio.errors.rateLimitSettingsConflict');
    transaction.set(ref, { rates: next, updatedAt: new Date(), updatedBy: actor });
    return next;
  });
}
