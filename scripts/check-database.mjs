import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import dotenv from "dotenv";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not configured. The application will use local SQLite instead.");
  process.exitCode = 2;
} else {
  const require = createRequire(import.meta.url);
  const { connectionOptions } = require("../storage/postgres");
  const client = new pg.Client(connectionOptions({
    databaseUrl: process.env.DATABASE_URL, databaseSsl: process.env.DATABASE_SSL,
  }));
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const result = await client.query("SELECT current_database() AS database, current_user AS role, current_setting('server_version') AS version");
    await client.query("COMMIT");
    console.log(JSON.stringify({ connected: true, readOnlyProbe: true, ...result.rows[0] }));
  } catch (error) {
    console.error(`Database probe failed (${error.code || "CONNECTION_ERROR"}). No schema or data changes were attempted.`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
