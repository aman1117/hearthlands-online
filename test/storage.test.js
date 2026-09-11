"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createStorage } = require("../storage");
const { APP_MAGIC } = require("../storage/schema");
const { connectionOptions } = require("../storage/postgres");
const { createRoom, appendPublicEvent } = require("../game");

function loopbackPostgres() {
  const configured = process.env.TEST_DATABASE_URL;
  if (!configured) return null;
  let url;
  try { url = new URL(configured); } catch { throw new Error("TEST_DATABASE_URL must be a loopback PostgreSQL URL."); }
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol), "Only PostgreSQL test URLs are supported");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase()),
    "Refusing any non-loopback TEST_DATABASE_URL; cloud databases are never test targets");
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "hearthlands_test",
    "PostgreSQL contract tests must use the dedicated hearthlands_test database");
  return configured;
}

function roomFixture(code = "ABCDEF") {
  const { room } = createRoom("Host");
  Object.assign(room, { code, revision: 1, updatedAt: 1_800_000_000_000 });
  return room;
}

async function context(t, postgres, seed) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-storage-"));
  const stores = [];
  t.after(async () => {
    try {
      for (const store of stores) await store.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  seed?.(dataDir);
  const options = {
    dataDir,
    ...(postgres ? {
      databaseUrl: loopbackPostgres(), databaseSsl: "disable",
      databaseSchema: `hearthlands_test_${crypto.randomBytes(8).toString("hex")}`,
    } : {}),
  };
  function create() {
    const store = createStorage(options);
    stores.push(store);
    return store;
  }
  const store = create();
  await store.init();
  return { store, create, options, dataDir };
}

for (const postgres of [false, true]) {
  const backend = postgres ? "PostgreSQL" : "SQLite";
  const settings = { skip: postgres && !process.env.TEST_DATABASE_URL };

  test(`${backend}: snapshot and public events commit together, rollback together, and survive reopen`, settings, async (t) => {
    const h = await context(t, postgres);
    const input = roomFixture();
    const first = await h.store.commitRoom(input);
    assert.deepEqual(first.eventOutbox, []);
    assert.equal(input.eventOutbox.length, 1, "The caller's uncommitted outbox must not be cleared optimistically");
    assert.deepEqual(await h.store.getRoom(first.code), first);
    const next = structuredClone(first);
    next.revision++;
    next.updatedAt++;
    next.players[0].name = "Changed";
    appendPublicEvent(next, { type: "test.changed", actorId: next.hostId, message: "A public change.", data: {} }, next.updatedAt);
    next.eventOutbox[0].id = input.eventOutbox[0].id;
    await assert.rejects(h.store.commitRoom(next, { expectedRevision: 1 }), { code: "STORAGE_FAILURE" });
    assert.deepEqual(await h.store.getRoom(first.code), first, "A failing event INSERT must roll back the preceding snapshot UPDATE");
    assert.equal((await h.store.listEvents(first.code)).length, 1);
    next.eventOutbox[0].id = crypto.randomUUID();
    next.log.at(-1).id = next.eventOutbox[0].id;
    const saved = await h.store.commitRoom(next, { expectedRevision: 1 });
    await h.store.close();
    const reopened = h.create();
    await reopened.init();
    assert.deepEqual(await reopened.getRoom(first.code), saved);
    assert.equal((await reopened.listEvents(first.code)).length, 2);
    assert.equal((await reopened.health()).backend, postgres ? "postgresql" : "sqlite");
  });

  test(`${backend}: compare-and-swap prevents stale, competing and duplicate first writes`, settings, async (t) => {
    const h = await context(t, postgres);
    const first = await h.store.commitRoom(roomFixture());
    await assert.rejects(h.store.commitRoom(roomFixture()), { code: "REVISION_CONFLICT" });
    const candidates = ["First", "Second"].map((name) => {
      const room = structuredClone(first);
      room.revision++;
      room.updatedAt++;
      room.players[0].name = name;
      appendPublicEvent(room, { type: "test.changed", message: "The name changed.", data: {} }, room.updatedAt);
      return room;
    });
    const results = await Promise.allSettled(candidates.map((room) => h.store.commitRoom(room, { expectedRevision: 1 })));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.code, "REVISION_CONFLICT");
    assert.equal((await h.store.getRoom(first.code)).revision, 2);
    assert.equal((await h.store.listEvents(first.code)).length, 2);
  });

  test(`${backend}: a second coordinator cannot acquire the live writer and can open after release`, settings, async (t) => {
    const h = await context(t, postgres);
    const competitor = h.create();
    await assert.rejects(competitor.init(), { code: "WRITER_LOCKED" });
    const saved = await h.store.commitRoom(roomFixture());
    await h.store.close();
    const replacement = h.create();
    await replacement.init();
    assert.deepEqual(await replacement.getRoom(saved.code), saved);
  });

  test(`${backend}: storage close drains writes already accepted by its async interface`, settings, async (t) => {
    const h = await context(t, postgres);
    const write = h.store.commitRoom(roomFixture());
    const closing = h.store.close();
    const saved = await write;
    await closing;
    const reopened = h.create();
    await reopened.init();
    assert.deepEqual(await reopened.getRoom(saved.code), saved);
  });

  test(`${backend}: history exceeds 80 entries, paginates, and archival retains snapshots and every event`, settings, async (t) => {
    const h = await context(t, postgres);
    const room = roomFixture();
    for (let index = 0; index < 150; index++) {
      appendPublicEvent(room, { type: "test.activity", message: `Public event ${index}.`, data: { index } }, room.updatedAt + index);
    }
    const saved = await h.store.commitRoom(room);
    assert.equal(saved.log.length, 80);
    const latest = await h.store.listEvents(room.code, { limit: 100 });
    assert.equal(latest.length, 100);
    assert.equal(latest[0].seq, 151);
    const older = await h.store.listEvents(room.code, { beforeSeq: latest.at(-1).seq, limit: 100 });
    assert.equal(older.length, 51);
    assert.equal(older.at(-1).seq, 1);
    const after = await h.store.listEvents(room.code, { afterSeq: 149, limit: 100 });
    assert.deepEqual(after.map((event) => event.seq), [150, 151]);
    assert.deepEqual(await h.store.archiveRooms(room.updatedAt + 1, room.updatedAt + 10), [room.code]);
    assert.equal((await h.store.getRoom(room.code)).archivedAt, room.updatedAt + 10);
    assert.equal((await h.store.listRooms()).length, 0);
    assert.equal((await h.store.listRooms({ includeArchived: true })).length, 1);
    assert.equal((await h.store.listEvents(room.code, { limit: 1000 })).length, 151);
    saved.revision++;
    await assert.rejects(h.store.commitRoom(saved, { expectedRevision: 1 }), { code: "REVISION_CONFLICT" });
    assert.equal((await h.store.getRoom(room.code)).revision, 1);
  });

  test(`${backend}: v2 backup import is atomic, preserves every available log, and never overwrites newer SQL`, settings, async (t) => {
    let source;
    const h = await context(t, postgres, (dataDir) => {
      const room = roomFixture();
      delete room.eventSequence;
      delete room.eventOutbox;
      room.log = Array.from({ length: 170 }, (_, index) => ({
        id: `legacy-${index + 1}`, at: room.updatedAt + index, message: `Legacy history ${index + 1}.`,
      }));
      source = JSON.stringify({ version: 2, room });
      fs.writeFileSync(path.join(dataDir, "ABCDEF.json"), source);
    });
    const imported = await h.store.getRoom("ABCDEF");
    assert.equal(imported.log.length, 80);
    assert.equal(imported.eventSequence, 170);
    assert.equal((await h.store.listEvents("ABCDEF", { limit: 1000 })).length, 170);
    assert.equal(fs.readFileSync(path.join(h.dataDir, "ABCDEF.json"), "utf8"), source);
    imported.revision++;
    imported.updatedAt++;
    imported.players[0].name = "SQL name";
    const saved = await h.store.commitRoom(imported, { expectedRevision: 1 });
    await h.store.close();
    fs.writeFileSync(path.join(h.dataDir, "BCDEFG.json"), JSON.stringify({ version: 2, room: roomFixture("BCDEFG") }));
    const reopened = h.create();
    await reopened.init();
    assert.deepEqual(await reopened.getRoom("ABCDEF"), saved);
    assert.equal(await reopened.getRoom("BCDEFG"), null, "A completed migration does not re-import stale backup directories");
    assert.equal(fs.readFileSync(path.join(h.dataDir, "ABCDEF.json"), "utf8"), source);
  });

  test(`${backend}: invalid public events and invalid snapshots cannot commit or expose credentials`, settings, async (t) => {
    const h = await context(t, postgres);
    const room = roomFixture();
    room.eventOutbox[0].data = { reconnectToken: room.players[0].reconnectToken };
    room.eventOutbox[0].type = "test.unsafe";
    await assert.rejects(h.store.commitRoom(room), { code: "INVALID_EVENT" });
    assert.equal(await h.store.getRoom(room.code), null);
    assert.deepEqual(await h.store.listEvents(room.code), []);
    room.eventOutbox[0].type = "playerJoined";
    const saved = await h.store.commitRoom(room);
    const events = JSON.stringify(await h.store.listEvents(room.code));
    assert.equal(events.includes("reconnectToken"), false);
    assert.equal(events.includes(room.players[0].reconnectToken), false);
    saved.revision++;
    delete saved.players[0].resources;
    await assert.rejects(h.store.commitRoom(saved, { expectedRevision: 1 }), { code: "INVALID_SNAPSHOT" });
    assert.equal((await h.store.getRoom(room.code)).revision, 1);
  });

  test(`${backend}: persisted public history never reveals theft types, development draws or discard vectors`, settings, async (t) => {
    const h = await context(t, postgres);
    const room = roomFixture();
    appendPublicEvent(room, { type: "resourceStolen", message: "A card was stolen.", data: { victimId: "victim", count: 1, resource: "ore" } });
    appendPublicEvent(room, { type: "developmentBought", message: "A development card was bought.", data: { count: 1, cardType: "knight", cardId: "private-card" } });
    appendPublicEvent(room, { type: "discarded", message: "Two cards were discarded.", data: { count: 2, resources: { wood: 2 } } });
    await h.store.commitRoom(room);
    const events = await h.store.listEvents(room.code);
    assert.deepEqual(events.find((event) => event.type === "resourceStolen").data, { victimId: "victim", count: 1 });
    assert.deepEqual(events.find((event) => event.type === "developmentBought").data, { count: 1 });
    assert.deepEqual(events.find((event) => event.type === "discarded").data, { count: 2 });
  });
}

test("SQLite refuses foreign or corrupt databases without overwriting a byte", async (t) => {
  for (const corrupt of [false, true]) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-foreign-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const file = path.join(dataDir, "hearthlands.sqlite");
    if (corrupt) fs.writeFileSync(file, "not a SQLite database");
    else {
      const foreign = new DatabaseSync(file);
      foreign.exec("CREATE TABLE unrelated (message TEXT); INSERT INTO unrelated VALUES ('keep me');");
      foreign.close();
    }
    const bytes = fs.readFileSync(file);
    const store = createStorage({ dataDir });
    await assert.rejects(store.init(), { code: corrupt ? "STORAGE_FAILURE" : "FOREIGN_STORAGE" });
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(fs.existsSync(`${file}.writer-lock`), false);
  }
});

test("corrupt legacy input cannot partially import otherwise valid backups", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-bad-import-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const source = JSON.stringify({ version: 2, room: roomFixture() });
  fs.writeFileSync(path.join(dataDir, "ABCDEF.json"), source);
  fs.writeFileSync(path.join(dataDir, "BCDEFG.json"), "{broken");
  const store = createStorage({ dataDir });
  await assert.rejects(store.init(), { code: "INVALID_LEGACY_SAVE" });
  const database = new DatabaseSync(path.join(dataDir, "hearthlands.sqlite"), { readOnly: true });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM rooms").get().count, 0);
  assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'legacy_import'").get().value, "pending");
  database.close();
  assert.equal(fs.readFileSync(path.join(dataDir, "ABCDEF.json"), "utf8"), source);
  assert.equal(fs.readFileSync(path.join(dataDir, "BCDEFG.json"), "utf8"), "{broken");
  fs.renameSync(path.join(dataDir, "BCDEFG.json"), path.join(dataDir, "BCDEFG.json.corrupt"));
  const retry = createStorage({ dataDir });
  await retry.init();
  assert.equal((await retry.listRooms()).length, 1);
  await retry.close();
});

test("SQLite recovers a verified crashed coordinator lock but never steals a live or foreign lock", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-crash-lock-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["-e", `
    const {createStorage} = require(${JSON.stringify(path.resolve(__dirname, "..", "storage"))});
    createStorage({dataDir:process.argv[1]}).init().then(() => process.exit(0), () => process.exit(1));
  `, dataDir], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  assert.equal(exit, 0, stderr);
  const lock = path.join(dataDir, "hearthlands.sqlite.writer-lock");
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).magic, APP_MAGIC);
  const recovered = createStorage({ dataDir });
  await recovered.init();
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, process.pid);
  await recovered.close();
  const foreign = '{"owner":"another application"}';
  fs.writeFileSync(lock, foreign);
  await assert.rejects(createStorage({ dataDir }).init(), { code: "WRITER_LOCKED" });
  assert.equal(fs.readFileSync(lock, "utf8"), foreign);
});

test("explicit dataDir ignores ambient DATABASE_URL and database errors never echo credential-bearing configuration", async (t) => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://test:do-not-log@must-not-connect.invalid/foreign";
  t.after(() => {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  });
  const h = await context(t, false);
  assert.equal((await h.store.health()).backend, "sqlite");
  const invalid = createStorage({
    dataDir: h.dataDir, databaseUrl: "postgresql://test:do-not-log@example.invalid/foreign",
    databaseSchema: "bad;schema", databaseSsl: "disable",
  });
  await assert.rejects(invalid.init(), (error) => {
    assert.equal(error.code, "INVALID_CONFIGURATION");
    assert.equal(error.message.includes("do-not-log"), false);
    assert.equal(error.message.includes("example.invalid"), false);
    return true;
  });
});

test("PostgreSQL TLS is verified by default and disabling it is limited to explicit local targets, never Azure", () => {
  for (const host of ["db", "postgres"]) {
    const databaseUrl = `postgresql://test@${host}/hearthlands_test`;
    assert.equal(connectionOptions({ databaseUrl }).ssl.rejectUnauthorized, true);
    assert.equal(connectionOptions({ databaseUrl, databaseSsl: "disable" }).ssl, false);
    assert.throws(() => connectionOptions({ databaseUrl: `${databaseUrl}?sslmode=disable` }), { code: "INVALID_CONFIGURATION" });
  }
  for (const host of ["sample.postgres.database.azure.com", "db.example.invalid", "192.168.1.20"]) {
    assert.throws(() => connectionOptions({
      databaseUrl: `postgresql://test@${host}/hearthlands_test`, databaseSsl: "disable",
    }), { code: "INVALID_CONFIGURATION" });
  }
  const remote = connectionOptions({ databaseUrl: "postgresql://user:unused@example.invalid/game?sslmode=no-verify" });
  assert.equal(remote.ssl.rejectUnauthorized, true);
  assert.throws(() => connectionOptions({ databaseUrl: "postgresql://user:unused@example.invalid/game?sslmode=disable" }), { code: "INVALID_CONFIGURATION" });
  assert.throws(() => connectionOptions({ databaseUrl: "postgresql://user:unused@example.invalid/game", databaseSsl: false }), { code: "INVALID_CONFIGURATION" });
  assert.equal(connectionOptions({ databaseUrl: "postgresql://user:unused@127.0.0.1/game" }).ssl.rejectUnauthorized, true);
  assert.equal(connectionOptions({ databaseUrl: "postgresql://user:unused@127.0.0.1/game", databaseSsl: "disable" }).ssl, false);
});

test("PostgreSQL automatically recovers ended and dropped connections before serialized reads and writes", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const h = await context(t, true);
  const saved = await h.store.commitRoom(roomFixture());
  const adapter = h.store.adapter;
  const originalClient = adapter.client;
  await originalClient.end();
  let acquired = 0;
  const acquire = adapter.acquireConnection.bind(adapter);
  adapter.acquireConnection = async () => { acquired++; return acquire(); };
  const [first, health, second] = await Promise.all([
    h.store.getRoom(saved.code), h.store.health(), h.store.getRoom(saved.code),
  ]);
  assert.deepEqual(first, saved);
  assert.deepEqual(second, saved);
  assert.equal(health.ok, true);
  assert.equal(acquired, 1, "Concurrent queued operations must share the recovered coordinator");
  assert.ok(adapter.client !== originalClient);
  originalClient.emit("end");
  assert.equal(adapter.lost, false, "A late event from the old connection must not poison its replacement");

  const dropped = adapter.client;
  const ended = new Promise((resolve) => dropped.once("end", resolve));
  dropped.connection.stream.destroy();
  await ended;
  const next = structuredClone(saved);
  next.revision++;
  next.updatedAt++;
  appendPublicEvent(next, { type: "test.recovered", message: "The writer recovered.", data: {} }, next.updatedAt);
  const updated = await h.store.commitRoom(next, { expectedRevision: 1 });
  assert.equal(updated.revision, 2);
  assert.equal(acquired, 2);
  assert.equal((await h.store.listEvents(saved.code)).length, 2);
});

test("PostgreSQL recovery never steals another coordinator lease and reads its latest revision after release", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const h = await context(t, true);
  const saved = await h.store.commitRoom(roomFixture());
  await h.store.adapter.client.end();
  const owner = h.create();
  await owner.init();
  await assert.rejects(h.store.health(), { code: "WRITER_LOCKED" });
  const stale = { ...structuredClone(saved), revision: 2 };
  await assert.rejects(h.store.commitRoom(stale, { expectedRevision: 1 }), { code: "WRITER_LOCKED" });
  assert.equal((await owner.health()).ok, true);

  const next = structuredClone(saved);
  next.revision++;
  next.updatedAt++;
  next.players[0].name = "Current writer";
  appendPublicEvent(next, { type: "test.owner", message: "The current writer committed.", data: {} }, next.updatedAt);
  const updated = await owner.commitRoom(next, { expectedRevision: 1 });
  await assert.rejects(h.store.getRoom(saved.code), { code: "WRITER_LOCKED" });
  await owner.close();
  assert.deepEqual(await h.store.getRoom(saved.code), updated);
  assert.equal((await h.store.health()).ok, true);
  await assert.rejects(h.store.commitRoom(stale, { expectedRevision: 1 }), { code: "REVISION_CONFLICT" });
  assert.deepEqual(await h.store.getRoom(saved.code), updated);
  assert.equal((await h.store.listEvents(saved.code)).length, 2);
});

test("PostgreSQL does not replay a transaction whose COMMIT succeeded before its connection acknowledgement was lost", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const h = await context(t, true);
  const saved = await h.store.commitRoom(roomFixture());
  const client = h.store.adapter.client;
  const query = client.query.bind(client);
  let committed = 0;
  client.query = async (sql, parameters) => {
    const result = await query(sql, parameters);
    if (sql === "COMMIT") {
      committed++;
      await client.end();
      const error = new Error("Injected lost commit acknowledgement.");
      error.code = "ECONNRESET";
      throw error;
    }
    return result;
  };
  const next = structuredClone(saved);
  next.revision++;
  next.updatedAt++;
  appendPublicEvent(next, { type: "test.committed", message: "Committed once.", data: {} }, next.updatedAt);
  await assert.rejects(h.store.commitRoom(next, { expectedRevision: 1 }), { code: "STORAGE_FAILURE" });
  assert.equal(committed, 1);
  const durable = await h.store.getRoom(saved.code);
  assert.equal(durable.revision, 2);
  assert.equal(durable.eventSequence, next.eventSequence);
  assert.equal((await h.store.listEvents(saved.code)).filter((event) => event.type === "test.committed").length, 1);
  await assert.rejects(h.store.commitRoom(next, { expectedRevision: 1 }), { code: "REVISION_CONFLICT" });
  assert.deepEqual(await h.store.getRoom(saved.code), durable);
  assert.equal(committed, 1);
});

test("PostgreSQL refuses a nonempty foreign schema while preserving its marker row", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const { Client } = require("pg");
  const options = {
    databaseUrl: loopbackPostgres(), databaseSsl: "disable",
    databaseSchema: `hearthlands_foreign_${crypto.randomBytes(8).toString("hex")}`,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-pg-foreign-")),
  };
  const client = new Client(connectionOptions(options));
  await client.connect().catch(() => { throw new Error("The isolated PostgreSQL fixture connection could not be opened."); });
  t.after(async () => {
    await client.end();
    fs.rmSync(options.dataDir, { recursive: true, force: true });
  });
  await client.query(`CREATE SCHEMA "${options.databaseSchema}"`);
  await client.query(`CREATE TABLE "${options.databaseSchema}".foreign_marker (value TEXT)`);
  await client.query(`INSERT INTO "${options.databaseSchema}".foreign_marker VALUES ('preserve')`);
  await assert.rejects(createStorage(options).init(), { code: "FOREIGN_STORAGE" });
  assert.equal((await client.query(`SELECT value FROM "${options.databaseSchema}".foreign_marker`)).rows[0].value, "preserve");
});
