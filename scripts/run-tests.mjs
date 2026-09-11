import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = fs.readdirSync(path.join(root, "test"))
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => path.join(root, "test", file));
const child = spawn(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
  cwd: root, stdio: "inherit", env: process.env,
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
