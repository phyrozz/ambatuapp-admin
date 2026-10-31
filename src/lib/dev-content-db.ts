import { Pool, type PoolClient } from 'pg';
import { readFileSync } from 'node:fs';

let pool: Pool | undefined;
let poolMode: 'dev' | 'prod' | undefined;

const backendFlags = ['CHARACTER_WRITE_BACKEND', 'LORE_WRITE_BACKEND', 'SOUND_WRITE_BACKEND', 'VIDEO_WRITE_BACKEND',
  'SOCIAL_WRITE_BACKEND', 'PROFILE_WRITE_BACKEND', 'LEADERBOARD_WRITE_BACKEND', 'RATE_LIMIT_BACKEND', 'STUDIO_ACCESS_BACKEND'] as const;

export function isProductionPostgres() {
  if (process.env.CONTENT_READ_BACKEND !== 'postgres-prod') return false;
  if (process.env.NODE_ENV !== 'production' || process.env.FIREBASE_PROJECT_ID !== 'ambatuapp-bcebb'
    || process.env.PRODUCTION_POSTGRES_CUTOVER !== 'enabled'
    || backendFlags.some(key => process.env[key] && process.env[key] !== 'postgres-prod')) {
    throw new Error('Invalid production database configuration');
  }
  return true;
}

export function isDevContentSnapshot() {
  if (isProductionPostgres()) return true;
  const mode = process.env.CONTENT_READ_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev-snapshot' || process.env.NODE_ENV !== 'development' || process.env.FIREBASE_PROJECT_ID !== 'ambatuapp-dev') {
    throw new Error('Invalid content database configuration');
  }
  return true;
}

export function isDevCharacterWriter() {
  if (isProductionPostgres()) return true;
  const mode = process.env.CHARACTER_WRITE_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev' || !isDevContentSnapshot()) throw new Error('Invalid character database configuration');
  return true;
}

export function isDevLoreWriter() {
  if (isProductionPostgres()) return true;
  const mode = process.env.LORE_WRITE_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev' || !isDevContentSnapshot()) throw new Error('Invalid lore database configuration');
  return true;
}

export function isDevSoundWriter() {
  if (isProductionPostgres()) return true;
  const mode = process.env.SOUND_WRITE_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev' || !isDevContentSnapshot()) throw new Error('Invalid sound database configuration');
  return true;
}

export function isDevVideoWriter() {
  if (isProductionPostgres()) return true;
  const mode = process.env.VIDEO_WRITE_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev' || !isDevContentSnapshot()) throw new Error('Invalid video database configuration');
  return true;
}

export function isDevSocialWriter() {
  if (isProductionPostgres()) return true;
  const mode = process.env.SOCIAL_WRITE_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev' || !isDevContentSnapshot()) throw new Error('Invalid social database configuration');
  return true;
}

export function isDevProfileWriter() {
  if (isProductionPostgres()) return true;
  const mode = process.env.PROFILE_WRITE_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev' || !isDevContentSnapshot() || !isDevSocialWriter()) throw new Error('Invalid profile database configuration');
  return true;
}

export function isDevLeaderboardWriter() {
  if (isProductionPostgres()) return true;
  const mode = process.env.LEADERBOARD_WRITE_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev' || !isDevContentSnapshot()) throw new Error('Invalid leaderboard database configuration');
  return true;
}

export function isDevRateLimitWriter() {
  if (isProductionPostgres()) return true;
  const mode = process.env.RATE_LIMIT_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev' || !isDevContentSnapshot()) throw new Error('Invalid rate limit database configuration');
  return true;
}

export function isDevStudioWriter() {
  if (isProductionPostgres()) return true;
  const mode = process.env.STUDIO_ACCESS_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev' || !isDevContentSnapshot()) throw new Error('Invalid Studio database configuration');
  return true;
}

export async function withDevContentDb<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isDevContentSnapshot()) throw new Error('Postgres content database is not enabled');
  const prod = isProductionPostgres();
  const mode = prod ? 'prod' : 'dev';
  const host = prod ? process.env.PROD_CONTENT_PG_HOST : process.env.DEV_CONTENT_PG_HOST;
  const user = prod ? process.env.PROD_CONTENT_PG_USER : process.env.DEV_CONTENT_PG_USER;
  const password = prod ? process.env.PROD_CONTENT_PG_PASSWORD : process.env.DEV_CONTENT_PG_PASSWORD;
  const ref = process.env.PROD_SUPABASE_PROJECT_REF;
  if (!host || !user || !password) throw new Error('Content database is not configured');
  if (prod) {
    if (!ref || !/^[a-z0-9]{1,64}$/.test(ref) || !(process.env.PROD_CONTENT_PG_CA || process.env.PROD_CONTENT_PG_CA_FILE)
      || !((host === `db.${ref}.supabase.co` && user === 'ambatu_prod_content_reader')
        || (/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host) && user === `ambatu_prod_content_reader.${ref}`))
      || Number(process.env.PROD_CONTENT_PG_PORT || 5432) !== 5432) throw new Error('Production database target is not configured');
  } else if (!/^ambatu_dev_content_reader(?:\.[a-z0-9]+)?$/.test(user)) {
    throw new Error('Dev content database is not configured');
  }
  const local = host === '127.0.0.1' || host === 'localhost';
  if (local && process.env.DEV_CONTENT_PG_LOCAL_TEST !== '1') throw new Error('Local test database is not enabled');
  if (poolMode && poolMode !== mode) throw new Error('Database mode cannot change while the server is running');
  if (!pool) {
    const caPath = prod ? process.env.PROD_CONTENT_PG_CA_FILE : process.env.DEV_CONTENT_PG_CA_FILE;
    const ca = prod && process.env.PROD_CONTENT_PG_CA ? process.env.PROD_CONTENT_PG_CA : caPath ? readFileSync(caPath, 'utf8') : undefined;
    const ssl = local ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
    pool = new Pool({ host, user, password, database: prod ? 'postgres' : process.env.DEV_CONTENT_PG_DATABASE || 'postgres',
      port: Number((prod ? process.env.PROD_CONTENT_PG_PORT : process.env.DEV_CONTENT_PG_PORT) || 5432), max: 3, connectionTimeoutMillis: 5000,
      ssl, application_name: `ambatu-${mode}-content-reader` });
    poolMode = mode;
    pool.on('error', () => console.error('Content database connection lost'));
  }
  const client = await pool.connect();
  try {
    const marker = await client.query('SELECT 1 FROM app.migration_runs WHERE id=$1 AND source_project=$2',
      prod ? ['firestore-prod-v1', 'ambatuapp-bcebb'] : ['firestore-dev-v1', 'ambatuapp-dev']);
    if (marker.rowCount !== 1) throw new Error('Content database marker is missing');
    return await callback(client);
  } finally { client.release(); }
}

export async function withDevCharacterDb<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isDevCharacterWriter()) throw new Error('Dev character database is not enabled');
  return withDevContentDb(async client => {
    await client.query('BEGIN');
    try {
      await client.query(isProductionPostgres() ? 'SET LOCAL ROLE ambatu_prod_character_writer' : 'SET LOCAL ROLE ambatu_dev_character_writer');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* The original error is more useful. */ }
      throw error;
    }
  });
}

export async function withDevLoreDb<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isDevLoreWriter()) throw new Error('Dev lore database is not enabled');
  return withDevContentDb(async client => {
    await client.query('BEGIN');
    try {
      await client.query(isProductionPostgres() ? 'SET LOCAL ROLE ambatu_prod_lore_writer' : 'SET LOCAL ROLE ambatu_dev_lore_writer');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  });
}

export async function withDevSoundDb<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isDevSoundWriter()) throw new Error('Dev sound database is not enabled');
  return withDevContentDb(async client => {
    await client.query('BEGIN');
    try {
      await client.query(isProductionPostgres() ? 'SET LOCAL ROLE ambatu_prod_sound_writer' : 'SET LOCAL ROLE ambatu_dev_sound_writer');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  });
}

export async function withDevVideoDb<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isDevVideoWriter()) throw new Error('Dev video database is not enabled');
  return withDevContentDb(async client => {
    await client.query('BEGIN');
    try {
      await client.query(isProductionPostgres() ? 'SET LOCAL ROLE ambatu_prod_video_writer' : 'SET LOCAL ROLE ambatu_dev_video_writer');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  });
}

export async function withDevSocialDb<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isDevSocialWriter()) throw new Error('Dev social database is not enabled');
  return withDevContentDb(async client => {
    await client.query('BEGIN');
    try {
      await client.query(isProductionPostgres() ? 'SET LOCAL ROLE ambatu_prod_social_writer' : 'SET LOCAL ROLE ambatu_dev_social_writer');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  });
}

export async function withDevProfileDb<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isDevProfileWriter()) throw new Error('Dev profile database is not enabled');
  return withDevContentDb(async client => {
    await client.query('BEGIN');
    try {
      await client.query(isProductionPostgres() ? 'SET LOCAL ROLE ambatu_prod_profile_writer' : 'SET LOCAL ROLE ambatu_dev_profile_writer');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  });
}

export async function withDevLeaderboardDb<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isDevLeaderboardWriter()) throw new Error('Dev leaderboard database is not enabled');
  return withDevContentDb(async client => {
    await client.query('BEGIN');
    try {
      await client.query(isProductionPostgres() ? 'SET LOCAL ROLE ambatu_prod_leaderboard_writer' : 'SET LOCAL ROLE ambatu_dev_leaderboard_writer');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  });
}

export async function withDevRateLimitDb<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isDevRateLimitWriter()) throw new Error('Dev rate limit database is not enabled');
  return withDevContentDb(async client => {
    await client.query('BEGIN');
    try {
      await client.query(isProductionPostgres() ? 'SET LOCAL ROLE ambatu_prod_rate_limit_writer' : 'SET LOCAL ROLE ambatu_dev_rate_limit_writer');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  });
}

export async function withDevStudioDb<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isDevStudioWriter()) throw new Error('Dev Studio database is not enabled');
  return withDevContentDb(async client => {
    await client.query('BEGIN');
    try {
      await client.query(isProductionPostgres() ? 'SET LOCAL ROLE ambatu_prod_studio_writer' : 'SET LOCAL ROLE ambatu_dev_studio_writer');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  });
}
