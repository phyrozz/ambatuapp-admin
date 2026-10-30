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
