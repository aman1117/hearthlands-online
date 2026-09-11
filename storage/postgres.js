"use strict";

const crypto = require("node:crypto");
const { Client } = require("pg");
const { StorageError } = require("./errors");
const { APP_MAGIC, SCHEMA_VERSION, schemaName, tables, statements } = require("./schema");

function connectionOptions(options) {
  let url;
  try {
    url = new URL(options.databaseUrl);
  } catch {
    throw new StorageError("INVALID_CONFIGURATION", "DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new StorageError("INVALID_CONFIGURATION", "DATABASE_URL must use PostgreSQL.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || 5432);
  if (!hostname || !url.username || !url.pathname.slice(1) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new StorageError("INVALID_CONFIGURATION", "DATABASE_URL must explicitly name a host, user, database and valid port.");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(hostname.toLowerCase());
  const explicitDisable = options.databaseSsl === "disable" || options.databaseSsl === false;
  const compose = ["db", "postgres"].includes(hostname.toLowerCase()) && explicitDisable;
  const disableTls = explicitDisable || url.searchParams.get("sslmode") === "disable";
  if (disableTls && !local && !compose) {
    throw new StorageError("INVALID_CONFIGURATION", "TLS can only be disabled for loopback testing or explicitly configured db/postgres Compose hosts.");
  }
  if (options.databaseSsl !== undefined && !["verify-full", "require", "disable", false].includes(options.databaseSsl)) {
    throw new StorageError("INVALID_CONFIGURATION", "Use verified TLS, or explicitly disable TLS only for loopback or db/postgres Compose hosts.");
  }
  return {
    host: hostname, port,
    user: decodeURIComponent(url.username), password: url.password ? decodeURIComponent(url.password) : process.env.PGPASSWORD || "",
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl: disableTls ? false : { rejectUnauthorized: true, ...(options.databaseCa ? { ca: options.databaseCa } : {}) },
    application_name: "hearthlands-online", connectionTimeoutMillis: 5000, query_timeout: 10_000,
    statement_timeout: 10_000, lock_timeout: 5000, idle_in_transaction_session_timeout: 15_000,
    options: "-c search_path=pg_catalog",
  };
}

class PostgresAdapter {
  constructor(options) {
    this.config = connectionOptions(options);
    this.schema = schemaName(options.databaseSchema);
    this.names = tables(true, this.schema);
    this.postgres = true;
    this.client = null;
    this.leaseHeld = false;
    this.lost = false;
    this.closed = false;
    this.recovery = null;
    const digest = crypto.createHash("sha256").update(`${APP_MAGIC}:${this.schema}`).digest();
    this.lock = [digest.readInt32BE(0), digest.readInt32BE(4)];
  }

  async acquireConnection() {
    if (this.closed) throw new StorageError("STORAGE_CLOSED", "The PostgreSQL coordinator is closed.");
    const client = new Client(this.config);
    this.client = client;
    this.lost = true;
    this.leaseHeld = false;
    const disconnected = () => {
      if (this.client === client) {
        this.lost = true;
        this.leaseHeld = false;
      }
    };
    client.on("error", disconnected);
    client.on("end", disconnected);
    try {
      await client.connect();
      const lock = await client.query("SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired", this.lock);
      if (!lock.rows[0].acquired) throw new StorageError("WRITER_LOCKED", "Another game coordinator already holds the PostgreSQL schema lease.");
      if (this.closed) throw new StorageError("STORAGE_CLOSED", "The PostgreSQL coordinator closed during recovery.");
      this.leaseHeld = true;
      this.lost = false;
    } catch (error) {
      await this.releaseConnection();
      throw error;
    }
  }

  async verifyIdentity() {
    let metadata;
    try {
      metadata = Object.fromEntries((await this.query(`SELECT key, value FROM ${this.names.metadata}`)).rows.map((row) => [row.key, row.value]));
    } catch (error) {
      if (this.lost) throw error;
      throw new StorageError("FOREIGN_STORAGE", "The existing PostgreSQL metadata is not a game storage identity.");
    }
    if (metadata.app_magic !== APP_MAGIC) throw new StorageError("FOREIGN_STORAGE", "The PostgreSQL schema belongs to another application.");
    if (metadata.schema_version !== SCHEMA_VERSION) throw new StorageError("UNSUPPORTED_SCHEMA", "This game database schema version is unsupported.");
  }

  async open() {
    await this.acquireConnection();
    const existing = await this.query(
      "SELECT c.relname, c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1",
      [this.schema],
    );
    if (existing.rows.length) {
      if (!existing.rows.some((row) => row.relname === "metadata" && row.relkind === "r")) {
        throw new StorageError("FOREIGN_STORAGE", "Refusing a nonempty PostgreSQL schema without the game application's identity.");
      }
      await this.verifyIdentity();
    }
    await this.query("BEGIN");
    try {
      await this.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
      for (const sql of statements(true, this.schema)) await this.query(sql);
      for (const [key, value] of [["app_magic", APP_MAGIC], ["schema_version", SCHEMA_VERSION], ["legacy_import", "pending"]]) {
        await this.query(`INSERT INTO ${this.names.metadata}(key, value) VALUES ($1, $2) ON CONFLICT(key) DO NOTHING`, [key, value]);
      }
      await this.query("COMMIT");
    } catch (error) {
      if (!this.lost) await this.query("ROLLBACK");
      throw error;
    }
  }

  async ensureConnection() {
    if (this.closed) throw new StorageError("STORAGE_CLOSED", "The PostgreSQL coordinator is closed.");
    if (this.client && this.leaseHeld && !this.lost) return;
    this.recovery ||= this.recover();
    const pending = this.recovery;
    try {
      await pending;
    } finally {
      if (this.recovery === pending) this.recovery = null;
    }
  }

  async recover() {
    await this.releaseConnection();
    await this.acquireConnection();
    try {
      // Recovery may only reattach to the existing owned schema. It must not run
      // migrations, import backups, or replay an interrupted transaction.
      await this.verifyIdentity();
    } catch (error) {
      await this.releaseConnection();
      throw error;
    }
  }

  async query(sql, parameters = []) {
    if (!this.client || !this.leaseHeld || this.lost) {
      throw new StorageError("WRITER_LOST", "The PostgreSQL coordinator lease was lost. Retry after the coordinator reacquires ownership.");
    }
    const client = this.client;
    try {
      return await client.query(sql, parameters);
    } catch (error) {
      const disconnected = /^(08|57P0[123])/.test(error.code || "") ||
        ["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"].includes(error.code) ||
        ["FATAL", "PANIC"].includes(error.severity) || error.message === "Query read timeout" ||
        /^Connection terminated(?: unexpectedly)?$/.test(error.message || "") || client.connection?.stream?.destroyed;
      if (disconnected && this.client === client) {
        this.lost = true;
        this.leaseHeld = false;
      }
      throw error;
    }
  }

  async releaseConnection() {
    const client = this.client;
    this.client = null;
    this.leaseHeld = false;
    this.lost = true;
    if (client) await client.end();
  }

  async close() {
    this.closed = true;
    try {
      if (this.recovery) await this.recovery;
    } finally {
      await this.releaseConnection();
    }
  }
}

module.exports = { PostgresAdapter, connectionOptions };
