import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = path.join(root, ".local-postgres");
const configFile = path.join(base, "config.json");
await fs.mkdir(base, { recursive: true, mode: 0o700 });
let config;
try {
  config = JSON.parse(await fs.readFile(configFile, "utf8"));
  if (config.application !== "hearthlands-local-postgres" || config.host !== "127.0.0.1") {
    throw new Error("Refusing an unrecognized local PostgreSQL configuration.");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  if ((await fs.readdir(base)).length) throw new Error("Refusing to initialize an unrecognized existing local database directory.");
  config = {
    application: "hearthlands-local-postgres",
    host: "127.0.0.1",
    port: Number(process.env.HEARTHLANDS_PG_PORT || 54329),
    user: "hearthlands_dev",
    password: crypto.randomBytes(32).toString("hex"),
  };
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error("Invalid local database port.");
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600, flag: "wx" });
}
const databaseDir = path.join(base, "cluster");
const cluster = new EmbeddedPostgres({
  databaseDir, user: config.user, password: config.password, port: config.port,
  authMethod: "scram-sha-256", persistent: true, createPostgresUser: false,
  initdbFlags: ["--locale=C", "--encoding=UTF8"],
  postgresFlags: ["-h", "127.0.0.1"],
  onLog() {},
  onError(message) {
    const text = String(message).replaceAll(config.password, "[redacted]");
    if (/FATAL|PANIC/i.test(text)) console.error(text);
  },
});
let initialized = false;
try { await fs.access(path.join(databaseDir, "PG_VERSION")); initialized = true; }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (!initialized) await cluster.initialise();
await cluster.start();
const client = new pg.Client({ ...config, database: "postgres" });
try {
  await client.connect();
  for (const name of ["hearthlands", "hearthlands_test"]) {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!existing.rowCount) await client.query(`CREATE DATABASE "${name}"`);
  }
} finally {
  await client.end();
}
const uri = (database) => `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@127.0.0.1:${config.port}/${database}`;
await fs.writeFile(path.join(base, "connection.env"),
  `DATABASE_URL=${uri("hearthlands")}\nTEST_DATABASE_URL=${uri("hearthlands_test")}\nDATABASE_SCHEMA=hearthlands_game\nDATABASE_SSL=disable\n`,
  { mode: 0o600 });
console.log(`Local PostgreSQL is ready on 127.0.0.1:${config.port}.`);
console.log("Private connection settings are in .local-postgres\\connection.env (excluded from Git).");
console.log("Data is persistent. Stop with Ctrl+C; no databases or data will be deleted.");

let stopping = false;
const keepAlive = setInterval(() => {}, 60_000);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(keepAlive);
    await cluster.stop();
  });
}
