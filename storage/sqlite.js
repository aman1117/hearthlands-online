"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { StorageError } = require("./errors");
const { APP_MAGIC, SCHEMA_VERSION, statements } = require("./schema");

class SqliteAdapter {
  constructor(options) {
    this.file = path.join(options.dataDir, "hearthlands.sqlite");
    this.lockFile = `${this.file}.writer-lock`;
    this.owner = { magic: APP_MAGIC, pid: process.pid, nonce: crypto.randomBytes(24).toString("hex") };
    this.db = null;
    this.ownsLock = false;
    this.postgres = false;
  }

  acquireLock() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.lockFile, "wx", 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify(this.owner));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        this.ownsLock = true;
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const recoveryFile = `${this.lockFile}.recovery`;
      let recovery;
      try {
        recovery = fs.openSync(recoveryFile, "wx", 0o600);
      } catch (error) {
        if (error.code === "EEXIST") throw new StorageError("WRITER_LOCKED", "SQLite coordinator recovery is already in progress.");
        throw error;
      }
      try {
        let previous;
        let text;
        try {
          text = fs.readFileSync(this.lockFile, "utf8");
          previous = JSON.parse(text);
        } catch {
          throw new StorageError("WRITER_LOCKED", "The SQLite writer lock cannot be verified. Do not remove an unverified lock.");
        }
        if (previous.magic !== APP_MAGIC || !Number.isSafeInteger(previous.pid) || previous.pid <= 0 ||
            typeof previous.nonce !== "string" || !/^[a-f0-9]{48}$/.test(previous.nonce)) {
          throw new StorageError("WRITER_LOCKED", "The SQLite writer lock does not belong to this application.");
        }
        try {
          process.kill(previous.pid, 0);
          throw new StorageError("WRITER_LOCKED", "Another game coordinator is already using this SQLite database.");
        } catch (error) {
          if (error.code !== "ESRCH") {
            if (error instanceof StorageError) throw error;
            throw new StorageError("WRITER_LOCKED", "The existing SQLite writer cannot be proven inactive.");
          }
        }
        // Serialize stale-lock inspection so competing recoveries cannot remove a
        // newly acquired live lock between the comparison and unlink.
        if (fs.readFileSync(this.lockFile, "utf8") !== text) {
          throw new StorageError("WRITER_LOCKED", "The SQLite writer lock changed while it was being inspected.");
        }
        fs.unlinkSync(this.lockFile);
      } finally {
        fs.closeSync(recovery);
        fs.unlinkSync(recoveryFile);
      }
    }
    throw new StorageError("WRITER_LOCKED", "The SQLite writer lock could not be acquired.");
  }

  async open() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.acquireLock();
    try {
      fs.closeSync(fs.openSync(this.file, "wx", 0o600));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const { DatabaseSync } = require("node:sqlite");
    if (fs.statSync(this.file).size > 0) {
      const probe = new DatabaseSync(this.file, { readOnly: true });
      try {
        const existing = probe.prepare("SELECT name, type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
        if (existing.length) {
          if (!existing.some((entry) => entry.name === "metadata" && entry.type === "table")) {
            throw new StorageError("FOREIGN_STORAGE", "Refusing a nonempty SQLite database without the game application's identity.");
          }
          let metadata;
          try {
            metadata = Object.fromEntries(probe.prepare("SELECT key, value FROM metadata").all().map((row) => [row.key, row.value]));
          } catch {
            throw new StorageError("FOREIGN_STORAGE", "The existing database metadata is not a game storage identity.");
          }
          if (metadata.app_magic !== APP_MAGIC) throw new StorageError("FOREIGN_STORAGE", "The SQLite database belongs to another application.");
          if (metadata.schema_version !== SCHEMA_VERSION) throw new StorageError("UNSUPPORTED_SCHEMA", "This game database schema version is unsupported.");
        }
      } finally {
        probe.close();
      }
    }
    this.db = new DatabaseSync(this.file);
    fs.chmodSync(this.file, 0o600);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const sql of statements(false)) this.db.exec(sql);
      const insert = this.db.prepare("INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING");
      for (const [key, value] of [["app_magic", APP_MAGIC], ["schema_version", SCHEMA_VERSION], ["legacy_import", "pending"]]) {
        insert.run(key, value);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async query(sql, parameters = []) {
    if (!this.db || !this.ownsLock || this.lost) throw new StorageError("WRITER_LOST", "The SQLite coordinator is not active.");
    let owner;
    try {
      owner = JSON.parse(fs.readFileSync(this.lockFile, "utf8"));
    } catch {
      throw new StorageError("WRITER_LOST", "The SQLite coordinator lock is no longer verifiable.");
    }
    if (owner.nonce !== this.owner.nonce || owner.pid !== process.pid || owner.magic !== APP_MAGIC) {
      throw new StorageError("WRITER_LOST", "The SQLite coordinator no longer owns the writer lock.");
    }
    const ordered = [];
    const statement = this.db.prepare(sql.replace(/\$(\d+)/g, (_match, index) => {
      ordered.push(parameters[Number(index) - 1]);
      return "?";
    }));
    if (statement.columns().length) {
      const rows = statement.all(...ordered);
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: Number(statement.run(...ordered).changes) };
  }

  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    if (this.ownsLock) {
      const current = JSON.parse(fs.readFileSync(this.lockFile, "utf8"));
      if (current.magic !== APP_MAGIC || current.nonce !== this.owner.nonce || current.pid !== process.pid) {
        throw new StorageError("WRITER_LOST", "The SQLite coordinator lock changed unexpectedly.");
      }
      fs.unlinkSync(this.lockFile);
      this.ownsLock = false;
    }
  }
}

module.exports = { SqliteAdapter };
