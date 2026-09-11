"use strict";

const { StorageError } = require("./errors");

const APP_MAGIC = "hearthlands-online/game-storage";
const SCHEMA_VERSION = "1";

function schemaName(value = "hearthlands_game") {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new StorageError("INVALID_CONFIGURATION", "The game database schema must be a lowercase SQL identifier of at most 63 characters.");
  }
  return value;
}

function tables(postgres, schema) {
  const prefix = postgres ? `"${schemaName(schema)}".` : "";
  return Object.fromEntries(["metadata", "rooms", "events"].map((name) => [name, `${prefix}"${name}"`]));
}

function statements(postgres, schema) {
  const names = tables(postgres, schema);
  const json = postgres ? "JSONB" : "TEXT";
  const integer = postgres ? "BIGINT" : "INTEGER";
  return [
    `CREATE TABLE IF NOT EXISTS ${names.metadata} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${names.rooms} (
      code TEXT PRIMARY KEY, revision ${integer} NOT NULL CHECK(revision >= 0),
      updated_at ${integer} NOT NULL, snapshot ${json} NOT NULL, archived_at ${integer}
    )`,
    `CREATE TABLE IF NOT EXISTS ${names.events} (
      room_code TEXT NOT NULL REFERENCES ${names.rooms}(code),
      seq ${integer} NOT NULL CHECK(seq > 0), id TEXT NOT NULL, at ${integer} NOT NULL,
      event ${json} NOT NULL, PRIMARY KEY(room_code, seq), UNIQUE(room_code, id)
    )`,
  ];
}

module.exports = { APP_MAGIC, SCHEMA_VERSION, schemaName, tables, statements };
