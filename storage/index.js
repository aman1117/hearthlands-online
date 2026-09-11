"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { StorageError, storageError } = require("./errors");
const { tables } = require("./schema");
const { RESOURCES } = require("../game");

function validateRoom(room) {
  if (!room || typeof room !== "object" || !/^[A-Z]{6}$/.test(room.code) ||
      !Array.isArray(room.players) || !Number.isSafeInteger(room.revision) || room.revision < 0 ||
      !Number.isSafeInteger(room.updatedAt) || !Number.isSafeInteger(room.eventSequence) || room.eventSequence < 0 ||
      !Array.isArray(room.eventOutbox)) {
    throw new StorageError("INVALID_SNAPSHOT", "The room snapshot is malformed or has invalid version/event metadata.");
  }
  if (!["lobby", "setup", "roll", "action", "discard", "robber", "steal", "finished"].includes(room.phase) ||
      !Array.isArray(room.log) || room.updatedAt < 0 ||
      (room.board !== null && (!room.board || !Array.isArray(room.board.tiles) ||
        !Array.isArray(room.board.vertices) || !Array.isArray(room.board.edges))) ||
      (room.phase !== "lobby" && !room.board)) {
    throw new StorageError("INVALID_SNAPSHOT", "The saved room has an invalid phase, board or activity history.");
  }
  const ids = new Set();
  const tokens = new Set();
  for (const player of [...room.players, ...(room.retiredPlayers || []), ...(room.removedPlayers || [])]) {
    if (!player || typeof player.id !== "string" || !player.id ||
        typeof player.reconnectToken !== "string" || !/^[a-f0-9]{64}$/.test(player.reconnectToken) ||
        ids.has(player.id) || tokens.has(player.reconnectToken)) {
      throw new StorageError("INVALID_SNAPSHOT", "The room contains invalid or duplicate seat identities.");
    }
    ids.add(player.id);
    tokens.add(player.reconnectToken);
  }
  for (const player of room.players) {
    if (typeof player.name !== "string" || !player.name.trim() || typeof player.color !== "string" ||
        !Array.isArray(player.developmentCards) || !player.resources ||
        !RESOURCES.every((key) => Number.isSafeInteger(player.resources[key]) && player.resources[key] >= 0)) {
      throw new StorageError("INVALID_SNAPSHOT", "The saved room has malformed player holdings or names.");
    }
  }
}

function publicEvent(event) {
  if (!event || typeof event !== "object" || typeof event.id !== "string" || !event.id ||
      !Number.isSafeInteger(event.seq) || event.seq <= 0 || !Number.isSafeInteger(event.at) ||
      typeof event.type !== "string" || typeof event.message !== "string" ||
      !(event.actorId === null || event.actorId === undefined || typeof event.actorId === "string") ||
      !event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
    throw new StorageError("INVALID_EVENT", "The public activity event is malformed.");
  }
  const selected = {
    id: event.id, seq: event.seq, at: event.at, type: event.type,
    actorId: event.actorId ?? null, message: event.message, data: structuredClone(event.data),
  };
  const { normalizePublicEvents } = require("../game");
  const normalized = normalizePublicEvents({ log: [selected], eventSequence: event.seq, eventOutbox: [] }).log[0];
  if (normalized.type !== selected.type || normalized.seq !== selected.seq || normalized.id !== selected.id) {
    throw new StorageError("INVALID_EVENT", "The activity event contains data that is not safe for public history.");
  }
  return normalized;
}

function decode(value) {
  return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
}

function snapshot(row) {
  if (!row) return null;
  const room = decode(row.snapshot);
  if (row.archived_at !== null && row.archived_at !== undefined) room.archivedAt = Number(row.archived_at);
  return room;
}

class GameStorage {
  constructor(options) {
    this.options = options;
    this.adapter = null;
    this.initialization = null;
    this.tail = Promise.resolve();
    this.closed = false;
    this.closing = false;
  }

  init() {
    if (this.closed || this.closing) return Promise.reject(new StorageError("STORAGE_CLOSED", "The game database is closed."));
    this.initialization ||= this.initialize();
    return this.initialization;
  }

  async initialize() {
    try {
      const Adapter = this.options.databaseUrl
        ? require("./postgres").PostgresAdapter
        : require("./sqlite").SqliteAdapter;
      this.adapter = new Adapter(this.options);
      this.names = tables(this.adapter.postgres, this.options.databaseSchema);
      await this.adapter.open();
      await this.importLegacy();
    } catch (error) {
      if (this.adapter) await this.adapter.close();
      this.closed = true;
      throw storageError(error);
    }
    return this;
  }

  run(operation) {
    if (this.closing || this.closed) return Promise.reject(new StorageError("STORAGE_CLOSED", "The game database is closed."));
    const ready = this.init();
    const work = this.tail.then(async () => {
      await ready;
      if (this.adapter.postgres) await this.adapter.ensureConnection();
      return operation();
    });
    this.tail = work.then(() => undefined, () => undefined);
    return work.catch((error) => { throw storageError(error); });
  }

  async transaction(operation) {
    await this.adapter.query(this.adapter.postgres ? "BEGIN" : "BEGIN IMMEDIATE");
    try {
      const result = await operation();
      await this.adapter.query("COMMIT");
      return result;
    } catch (error) {
      // Recovery occurs only before a later storage operation, never inside an
      // interrupted transaction. Fresh snapshots and CAS resolve ambiguous commits.
      if (!this.adapter.lost) {
        try {
          await this.adapter.query("ROLLBACK");
        } catch {
          this.adapter.lost = true;
          throw new StorageError("WRITER_LOST", "The transaction could not be rolled back safely. Coordinator ownership must be restored before continuing.");
        }
      }
      throw error;
    }
  }

  async importLegacy() {
    const migration = await this.adapter.query(`SELECT value FROM ${this.names.metadata} WHERE key = $1`, ["legacy_import"]);
    if (migration.rows[0]?.value === "complete") return;
    const existing = await this.adapter.query(`SELECT COUNT(*) AS count FROM ${this.names.rooms}`);
    const imports = [];
    if (Number(existing.rows[0].count) === 0) {
      const { normalizePublicEvents } = require("../game");
      const tokens = new Set();
      fs.mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
      for (const file of fs.readdirSync(this.options.dataDir).filter((entry) => entry.endsWith(".json")).sort()) {
        if (!/^[A-Z]{6}\.json$/.test(file) || !fs.lstatSync(path.join(this.options.dataDir, file)).isFile()) {
          throw new StorageError("INVALID_LEGACY_SAVE", "A legacy JSON backup has an invalid filename or file type.");
        }
        let saved;
        try {
          saved = JSON.parse(fs.readFileSync(path.join(this.options.dataDir, file), "utf8"));
        } catch {
          throw new StorageError("INVALID_LEGACY_SAVE", "A legacy JSON backup is corrupt; no rooms were imported.");
        }
        if (saved.version !== 2 || saved.room?.code !== file.slice(0, 6)) {
          throw new StorageError("INVALID_LEGACY_SAVE", "A legacy JSON backup has an unsupported version or mismatched room code.");
        }
        const room = structuredClone(saved.room);
        if (!Array.isArray(room.log)) throw new StorageError("INVALID_LEGACY_SAVE", "The legacy activity log is malformed.");
        normalizePublicEvents(room);
        const available = new Map();
        const legacyLog = Array.isArray(saved.room.log) ? saved.room.log : [];
        for (let end = Math.min(80, legacyLog.length); end > 0; end = Math.min(end + 80, legacyLog.length)) {
          const normalized = normalizePublicEvents({ log: legacyLog.slice(0, end), eventSequence: saved.room.eventSequence, eventOutbox: [] });
          for (const event of normalized.log) available.set(event.seq, event);
          if (end === legacyLog.length) break;
        }
        for (const event of room.eventOutbox) available.set(event.seq, event);
        room.eventOutbox = [...available.values()].sort((a, b) => a.seq - b.seq);
        const eventIds = new Set();
        for (const event of room.eventOutbox.map(publicEvent)) {
          if (eventIds.has(event.id)) throw new StorageError("INVALID_LEGACY_SAVE", "The legacy activity log has duplicate event identifiers.");
          eventIds.add(event.id);
        }
        room.revision ??= 0;
        validateRoom(room);
        for (const player of [...room.players, ...(room.retiredPlayers || []), ...(room.removedPlayers || [])]) {
          if (tokens.has(player.reconnectToken)) throw new StorageError("INVALID_LEGACY_SAVE", "Legacy rooms contain a duplicate resume credential.");
          tokens.add(player.reconnectToken);
        }
        imports.push(room);
      }
    }
    // All backups are validated before the import transaction starts. Backups are
    // deliberately never renamed, overwritten, removed, or used to overwrite SQL.
    await this.transaction(async () => {
      for (const room of imports) await this.writeRoom(room, null, true);
      await this.adapter.query(`UPDATE ${this.names.metadata} SET value = $1 WHERE key = $2`, ["complete", "legacy_import"]);
    });
  }

  async writeRoom(input, expectedRevision, importing = false) {
    const room = structuredClone(input);
    validateRoom(room);
    const existing = (await this.adapter.query(`SELECT revision, snapshot, archived_at FROM ${this.names.rooms} WHERE code = $1`, [room.code])).rows[0];
    if ((expectedRevision === null && existing) ||
        (expectedRevision !== null && (!existing || Number(existing.revision) !== expectedRevision || existing.archived_at !== null))) {
      throw new StorageError("REVISION_CONFLICT", "The saved room changed. Reload it and retry the same request.");
    }
    if (!importing && room.revision !== (expectedRevision === null ? 1 : expectedRevision + 1)) {
      throw new StorageError("REVISION_CONFLICT", "The next room revision must follow its saved revision.");
    }
    const previousSequence = existing ? (decode(existing.snapshot).eventSequence || 0) : 0;
    const events = room.eventOutbox.map(publicEvent);
    let sequence = previousSequence;
    for (const event of events) {
      if (importing ? event.seq <= sequence : event.seq !== sequence + 1) {
        throw new StorageError("INVALID_EVENT", "Activity events must be ordered and contiguous with the saved room.");
      }
      sequence = event.seq;
    }
    if (room.eventSequence !== sequence && !(importing && room.eventSequence >= sequence)) {
      throw new StorageError("INVALID_EVENT", "The room event sequence does not match its activity outbox.");
    }
    room.eventOutbox = [];
    delete room.archivedAt;
    if (expectedRevision === null) {
      await this.adapter.query(
        `INSERT INTO ${this.names.rooms}(code, revision, updated_at, snapshot, archived_at) VALUES ($1, $2, $3, $4, NULL)`,
        [room.code, room.revision, room.updatedAt, JSON.stringify(room)],
      );
    } else {
      const result = await this.adapter.query(
        `UPDATE ${this.names.rooms} SET revision = $1, updated_at = $2, snapshot = $3 WHERE code = $4 AND revision = $5 AND archived_at IS NULL`,
        [room.revision, room.updatedAt, JSON.stringify(room), room.code, expectedRevision],
      );
      if (result.rowCount !== 1) throw new StorageError("REVISION_CONFLICT", "The saved room changed during the transaction.");
    }
    for (const event of events) {
      await this.adapter.query(
        `INSERT INTO ${this.names.events}(room_code, seq, id, at, event) VALUES ($1, $2, $3, $4, $5)`,
        [room.code, event.seq, event.id, event.at, JSON.stringify(event)],
      );
    }
    return room;
  }

  commitRoom(room, { expectedRevision = null } = {}) {
    return this.run(() => this.transaction(() => this.writeRoom(room, expectedRevision)));
  }

  getRoom(code) {
    return this.run(async () => snapshot((await this.adapter.query(
      `SELECT snapshot, archived_at FROM ${this.names.rooms} WHERE code = $1`, [code],
    )).rows[0]));
  }

  listRooms({ includeArchived = false } = {}) {
    return this.run(async () => (await this.adapter.query(
      `SELECT snapshot, archived_at FROM ${this.names.rooms}${includeArchived ? "" : " WHERE archived_at IS NULL"} ORDER BY code`,
    )).rows.map(snapshot));
  }

  archiveRooms(before, at) {
    if (!Number.isSafeInteger(before) || !Number.isSafeInteger(at)) {
      return Promise.reject(new StorageError("INVALID_QUERY", "Archival timestamps must be safe integer milliseconds."));
    }
    return this.run(() => this.transaction(async () => {
      const rows = (await this.adapter.query(
        `UPDATE ${this.names.rooms} SET archived_at = $1 WHERE updated_at < $2 AND archived_at IS NULL RETURNING code`, [at, before],
      )).rows;
      return rows.map((row) => row.code);
    }));
  }

  listEvents(code, { beforeSeq, afterSeq, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 ||
        (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) ||
        (afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < 0)) ||
        (beforeSeq !== undefined && afterSeq !== undefined)) {
      return Promise.reject(new StorageError("INVALID_QUERY", "Invalid activity pagination bounds."));
    }
    return this.run(async () => {
      const parameters = [code];
      let bounds = "";
      if (beforeSeq !== undefined || afterSeq !== undefined) {
        parameters.push(beforeSeq ?? afterSeq);
        bounds = ` AND seq ${beforeSeq !== undefined ? "<" : ">"} $2`;
      }
      parameters.push(limit);
      return (await this.adapter.query(
        `SELECT event FROM ${this.names.events} WHERE room_code = $1${bounds} ORDER BY seq ${afterSeq !== undefined ? "ASC" : "DESC"} LIMIT $${parameters.length}`,
        parameters,
      )).rows.map((row) => publicEvent(decode(row.event)));
    });
  }

  health() {
    return this.run(async () => {
      await this.adapter.query(`SELECT value FROM ${this.names.metadata} WHERE key = $1`, ["app_magic"]);
      return { ok: true, backend: this.adapter.postgres ? "postgresql" : "sqlite" };
    });
  }

  async close() {
    if (this.closed) return;
    if (this.closing) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      if (this.initialization) {
        try { await this.initialization; } catch { return; }
      }
      await this.tail;
      if (this.adapter) await this.adapter.close();
      this.closed = true;
    })();
    return this.closePromise;
  }
}

function createStorage(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, "..", "data");
  const databaseUrl = options.databaseUrl ?? (options.dataDir ? undefined : process.env.DATABASE_URL);
  return new GameStorage({ ...options, dataDir, databaseUrl });
}

module.exports = { createStorage, StorageError };
