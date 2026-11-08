// Copies only runtime code and public npm dependencies; never copies project env.
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
const source = dirname(fileURLToPath(import.meta.url));
const destination = resolve(
  process.argv[2] || join(source, "../../.tmp/dream-media-lambda"),
);
await mkdir(destination, { recursive: false }); // Fresh directory required: no stale artifacts.
const runtime = [
  "package.json",
  "lambda-gateway.mjs",
  "lambda-dispatcher.mjs",
  "runtime-config.mjs",
  "db.mjs",
  "gateway.mjs",
  "budget.mjs",
  "objects.mjs",
  "maintenance.mjs",
  "cleanup.mjs",
  "core.mjs",
];
for (const file of runtime)
  await writeFile(join(destination, file), await readFile(join(source, file)));
await cp(join(source, "certs"), join(destination, "certs"), {
  recursive: true,
});
await cp(join(source, "node_modules"), join(destination, "node_modules"), {
  recursive: true,
  filter: (path) =>
    !["sharp", "@img", ".git", ".npmrc"].includes(basename(path)) &&
    !basename(path).startsWith(".env"),
});
async function inventory(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await inventory(path)));
    else paths.push(path);
  }
  return paths;
}
const files = await inventory(destination);
if (
  files.some(
    (file) =>
      /(?:\.env|\.pem$|\.key$)/.test(file) && !file.endsWith("supabase-ca.pem"),
  )
)
  throw new Error("UNEXPECTED_PRIVATE_ARTIFACT");
console.log(JSON.stringify({ directory: destination, files: files.length }));
