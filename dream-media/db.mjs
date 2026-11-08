import pg from "pg";
import { readFileSync } from "node:fs";

export function database(role) {
  const stage = process.env.STAGE;
  if (!["dev", "prod"].includes(stage)) throw new Error("INVALID_MEDIA_STAGE");
  const config = JSON.parse(process.env.DATABASE_CONFIG ?? "{}");
  const local = ["127.0.0.1", "localhost"].includes(config.host);
  if (local && process.env.DREAM_MEDIA_LOCAL_TEST !== "1")
    throw new Error("LOCAL_DATABASE_DISABLED");
  if (
    !local &&
    (!/^(db\.[a-z0-9]+\.supabase\.co|aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com)$/.test(
      config.host ?? "",
    ) ||
      !new RegExp(`^ambatu_${stage}_dream_${role}(?:\.[a-z0-9]+)?$`).test(
        config.user ?? "",
      ) ||
      !config.password ||
      ![5432, 6543].includes(Number(config.port)))
  )
    throw new Error("INVALID_MEDIA_DATABASE");
  const pool = new pg.Pool({
    host: config.host,
    port: Number(config.port),
    user: config.user,
    password: config.password,
    database: config.database || "postgres",
    max: Number(process.env.DATABASE_POOL_MAX || 2),
    connectionTimeoutMillis: Number(process.env.DATABASE_TIMEOUT_MS || 5000),
    statement_timeout: Number(process.env.DATABASE_TIMEOUT_MS || 20_000),
    ssl: local
      ? false
      : {
          rejectUnauthorized: true,
          ca: readFileSync(
            new URL("./certs/supabase-ca.pem", import.meta.url),
            "utf8",
          ),
        },
    application_name: `ambatu-${stage}-dream-${role}`,
  });
  pool.on("error", () => console.error("MEDIA_DATABASE_IDLE_ERROR"));
  const transaction = async (callback) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };
  const verify = async () => {
    const result = await pool.query(
      "SELECT 1 FROM app.migration_runs WHERE id=$1 AND source_project=$2",
      stage === "prod"
        ? ["firestore-prod-v1", "ambatuapp-bcebb"]
        : ["firestore-dev-v1", "ambatuapp-dev"],
    );
    if (result.rowCount !== 1) throw new Error("MEDIA_DATABASE_MARKER_MISSING");
  };
  return { pool, transaction, verify };
}
