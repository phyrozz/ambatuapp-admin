// Local rehearsal only. This creates and removes fixture data and temporarily
// disables root users in the disposable local prod_role_rehearsal database.
// Never use a server containing live or user-maintained data.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PGTEST_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Set PGTEST_PORT to the disposable local PostgreSQL port.');
const names = ['character', 'lore', 'sound', 'video', 'social', 'profile', 'leaderboard', 'rate-limit', 'studio'];
const generated = [];
try {
  for (const name of names) {
    const source = new URL(`${name}-write.test.mjs`, import.meta.url);
    const target = new URL(`.production-rehearsal-${name}.test.mjs`, import.meta.url);
    const text = readFileSync(source, 'utf8').replaceAll('ambatu_dev_', 'ambatu_prod_').replaceAll("database: 'postgres'", "database: 'prod_role_rehearsal'");
    writeFileSync(target, text, { flag: 'wx' });
    generated.push(target);
  }
  const args = ['--test', ...generated.map(fileURLToPath)];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, PGTEST_PORT: String(port) } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  for (const file of generated) unlinkSync(file);
}
