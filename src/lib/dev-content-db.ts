import { Pool, type PoolClient } from 'pg';
import { readFileSync } from 'node:fs';

let pool: Pool | undefined;

export function isDevContentSnapshot() {
  const mode = process.env.CONTENT_READ_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev-snapshot' || process.env.NODE_ENV !== 'development' || process.env.FIREBASE_PROJECT_ID !== 'ambatuapp-dev') {
    throw new Error('Invalid content database configuration');
  }
  return true;
}

export function isDevCharacterWriter() {
  const mode = process.env.CHARACTER_WRITE_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev' || !isDevContentSnapshot()) throw new Error('Invalid character database configuration');
  return true;
}

export function isDevLoreWriter() {
  const mode = process.env.LORE_WRITE_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev' || !isDevContentSnapshot()) throw new Error('Invalid lore database configuration');
  return true;
}

export function isDevSoundWriter() {
  const mode = process.env.SOUND_WRITE_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev' || !isDevContentSnapshot()) throw new Error('Invalid sound database configuration');
  return true;
}

export function isDevVideoWriter() {
  const mode = process.env.VIDEO_WRITE_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev' || !isDevContentSnapshot()) throw new Error('Invalid video database configuration');
  return true;
}

export function isDevSocialWriter() {
  const mode = process.env.SOCIAL_WRITE_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev' || !isDevContentSnapshot()) throw new Error('Invalid social database configuration');
  return true;
}

export function isDevProfileWriter() {
  const mode = process.env.PROFILE_WRITE_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev' || !isDevContentSnapshot() || !isDevSocialWriter()) throw new Error('Invalid profile database configuration');
  return true;
}

export function isDevLeaderboardWriter() {
  const mode = process.env.LEADERBOARD_WRITE_BACKEND;
  if (!mode || mode === 'firestore') return false;
  if (mode !== 'postgres-dev' || !isDevContentSnapshot()) throw new Error('Invalid leaderboard database configuration');
  return true;
}

export async function withDevContentDb<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const { DEV_CONTENT_PG_HOST: host, DEV_CONTENT_PG_USER: user, DEV_CONTENT_PG_PASSWORD: password } = process.env;
  if (!host || !user || !password || !/^ambatu_dev_content_reader(?:\.[a-z0-9]+)?$/.test(user)) {
    throw new Error('Dev content database is not configured');
  }
  const local = host === '127.0.0.1' || host === 'localhost';
  if (local && process.env.DEV_CONTENT_PG_LOCAL_TEST !== '1') throw new Error('Local test database is not enabled');
  if (!pool) {
    const caPath = process.env.DEV_CONTENT_PG_CA_FILE;
    const ssl = local ? false : { rejectUnauthorized: true, ...(caPath ? { ca: readFileSync(caPath, 'utf8') } : {}) };
    pool = new Pool({ host, user, password, database: process.env.DEV_CONTENT_PG_DATABASE || 'postgres',
      port: Number(process.env.DEV_CONTENT_PG_PORT || 5432), max: 3, connectionTimeoutMillis: 5000,
      ssl, application_name: 'ambatu-dev-content-reader' });
    pool.on('error', () => console.error('Dev content database connection lost'));
  }
  const client = await pool.connect();
  try {
    const marker = await client.query("SELECT 1 FROM app.migration_runs WHERE id = 'firestore-dev-v1' AND source_project = 'ambatuapp-dev'");
    if (marker.rowCount !== 1) throw new Error('Dev content database marker is missing');
    return await callback(client);
  } finally { client.release(); }
}

export async function withDevCharacterDb<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isDevCharacterWriter()) throw new Error('Dev character database is not enabled');
  return withDevContentDb(async client => {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE ambatu_dev_character_writer');
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
      await client.query('SET LOCAL ROLE ambatu_dev_lore_writer');
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
      await client.query('SET LOCAL ROLE ambatu_dev_sound_writer');
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
      await client.query('SET LOCAL ROLE ambatu_dev_video_writer');
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
      await client.query('SET LOCAL ROLE ambatu_dev_social_writer');
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
      await client.query('SET LOCAL ROLE ambatu_dev_profile_writer');
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
      await client.query('SET LOCAL ROLE ambatu_dev_leaderboard_writer');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  });
}
