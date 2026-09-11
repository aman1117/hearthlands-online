import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const connectionFile = path.join(root, ".local-postgres", "connection.env");
if (!fs.existsSync(connectionFile)) throw new Error("Start npm run db:local first.");
const config = dotenv.parse(fs.readFileSync(connectionFile));
const child = spawn(process.execPath, ["server.js"], {
  cwd: root, stdio: "inherit",
  env: { ...process.env, DATABASE_URL: config.DATABASE_URL, DATABASE_SCHEMA: config.DATABASE_SCHEMA, DATABASE_SSL: config.DATABASE_SSL },
});
child.on("exit", (code) => { process.exitCode = code ?? 1; });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
