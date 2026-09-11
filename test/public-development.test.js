"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { io } = require("socket.io-client");
const { createStorage } = require("../storage");
const { createGameServer } = require("../server");
const { migratePublicDevelopmentHistory } = require("../development-history");
const {
  createRoom, addPlayer, startGame, applyAction, appendPublicEvent, publicState, resignPlayer, COSTS,
} = require("../game");

const progressTypes = ["roadBuilding", "yearOfPlenty", "monopoly"];
const zero = () => ({ roadBuilding: 0, yearOfPlenty: 0, monopoly: 0 });
function fixture(phase = "action") {
  const { room, player } = createRoom("Host");
  addPlayer(room, "Second");
  addPlayer(room, "Third");
  if (phase !== "lobby") startGame(room, player.id, () => 0.42);
  Object.assign(room, { phase, code: "ABCDEF", revision: 1, updatedAt: Date.now() - 60_000, turnNumber: 1 });
  return room;
}
const current = (room) => room.players[room.turnIndex];
const gallery = (room, player, viewer = player) =>
  publicState(room, viewer.id).players.find((p) => p.id === player.id)?.revealedDevelopment;
function legacy(room) {
  for (const player of room.players) {
    delete player.playedProgressCards;
    delete player.playedProgressHistoryComplete;
  }
  return room;
}
function card(room, player, type) {
  const index = room.developmentDeck.findIndex((candidate) => candidate.type === type);
  assert.ok(index >= 0);
  const chosen = { ...room.developmentDeck.splice(index, 1)[0], boughtTurn: 0 };
  player.developmentCards.push(chosen);
  return chosen;
}
function resources(room, player, bundle) {
  for (const [type, count] of Object.entries(bundle)) {
    assert.ok(room.bank[type] >= count);
    room.bank[type] -= count;
    player.resources[type] += count;
  }
}
function progressEvent(room, player, type, count = 1) {
  appendPublicEvent(room, {
    type: "developmentPlayed", actorId: player.id, message: `${player.name} played a public card.`,
    data: { cardType: type, count, ...(type === "monopoly" ? { resource: "wood" } : {}) },
  });
}
function preparePlay(room, type) {
  const player = current(room);
  const chosen = card(room, player, type);
  if (type === "roadBuilding") {
    room.board.vertices[0].structure = { playerId: player.id, kind: "settlement" };
    player.settlementsLeft -= 1;
  }
  return { type: "playDevelopment", cardId: chosen.id,
    ...(type === "monopoly" ? { resource: "wood" } : {}),
    ...(type === "yearOfPlenty" ? { resources: { wheat: 1, ore: 1 } } : {}) };
}
function call(client, event, payload = {}) {
  return new Promise((resolve, reject) => {
    client.timeout(5000).emit(event, payload, (error, reply) => error ? reject(error) : resolve(reply));
  });
}

async function harness(t, room, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-public-development-"));
  const sourceFile = path.join(dataDir, `${room.code}.json`);
  let source;
  if (options.legacyJson) {
    source = JSON.stringify({ version: 2, room });
    fs.writeFileSync(sourceFile, source);
  }
  const storageOptions = { dataDir, ...options.storage };
  const seed = createStorage(storageOptions);
  await seed.init();
  if (!options.legacyJson) await seed.commitRoom(room);
  if (options.archived) await seed.archiveRooms(room.updatedAt + 1, room.updatedAt + 2);
  const before = await seed.getRoom(room.code);
  await seed.close();
  let service;
  let port;
  const clients = [];
  const historyQueries = [];
  async function start() {
    service = createGameServer(storageOptions);
    const originalListEvents = service.storage.listEvents.bind(service.storage);
    service.storage.listEvents = async (code, query) => {
      historyQueries.push(query);
      return originalListEvents(code, query);
    };
    port = await service.listen(0);
  }
  t.after(async () => {
    clients.forEach((client) => client.close());
    if (service) await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await start();
  return {
    before, source, sourceFile, historyQueries,
    get service() { return service; },
    read() { return service.storage.getRoom(room.code); },
    async restart() {
      await service.close();
      clients.forEach((client) => client.close());
      await start();
    },
    async connect(player) {
      const client = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false });
      clients.push(client);
      client.on("state", (state) => { client.latest = state; });
      await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("connect_error", reject); });
      const response = await call(client, "reconnectRoom", { code: room.code, reconnectToken: player.reconnectToken });
      assert.equal(response.ok, true);
      return client;
    },
  };
}

function unchangedExceptStatistics(before, after) {
  const stripped = structuredClone(after);
  stripped.revision = before.revision;
  for (const [index, player] of stripped.players.entries()) {
    if (!Object.hasOwn(before.players[index], "playedProgressCards")) delete player.playedProgressCards;
    else player.playedProgressCards = before.players[index].playedProgressCards;
    if (!Object.hasOwn(before.players[index], "playedProgressHistoryComplete")) delete player.playedProgressHistoryComplete;
    else player.playedProgressHistoryComplete = before.players[index].playedProgressHistoryComplete;
  }
  assert.deepEqual(stripped, before);
}

test("fresh gallery is public counts only; buying never reveals progress/VP cards or increments played totals", () => {
  const room = fixture();
  const player = current(room);
  assert.deepEqual(gallery(room, player), { knight: 0, ...zero(), historyComplete: true });
  const index = room.developmentDeck.findIndex((candidate) => candidate.type === "victoryPoint");
  room.developmentDeck.push(...room.developmentDeck.splice(index, 1));
  resources(room, player, COSTS.development);
  applyAction(room, player.id, { type: "buyDevelopment" });
  const bought = player.developmentCards[0];
  assert.equal(bought.type, "victoryPoint");
  for (const viewer of room.players) {
    const revealed = gallery(room, player, viewer);
    assert.deepEqual(revealed, { knight: 0, ...zero(), historyComplete: true });
    assert.equal(Object.hasOwn(revealed, "victoryPoint"), false);
    assert.ok(!JSON.stringify(revealed).includes(bought.id));
    assert.ok(!JSON.stringify(revealed).includes(player.reconnectToken));
  }
});

test("Knights always use actual persistent army count and VP appears only when the game finishes", () => {
  const room = fixture();
  const player = current(room);
  player.knightsPlayed = 2;
  const knight = card(room, player, "knight");
  card(room, player, "knight");
  card(room, player, "victoryPoint");
  card(room, player, "victoryPoint");
  assert.equal(gallery(room, player).knight, 2);
  applyAction(room, player.id, { type: "playDevelopment", cardId: knight.id });
  assert.equal(player.knightsPlayed, 3);
  assert.equal(gallery(room, player).knight, 3);
  for (const viewer of room.players) assert.equal(Object.hasOwn(gallery(room, player, viewer), "victoryPoint"), false);
  room.phase = "finished";
  room.winnerId = player.id;
  for (const viewer of room.players) {
    const shown = gallery(room, player, viewer);
    assert.equal(shown.victoryPoint, 2);
    assert.equal(shown.knight, player.knightsPlayed);
    assert.deepEqual(Object.keys(shown).sort(), ["historyComplete", "knight", "monopoly", "roadBuilding", "victoryPoint", "yearOfPlenty"]);
  }
});

for (const type of progressTypes) {
  test(`${type} increments exactly once on successful play and failed replay never changes counters`, () => {
    const room = fixture();
    const player = current(room);
    const action = preparePlay(room, type);
    const before = structuredClone(room);
    assert.throws(() => applyAction(room, room.players[1].id, action));
    assert.deepEqual(room, before);
    if (type === "monopoly") {
      assert.throws(() => applyAction(room, player.id, { ...action, resource: "invalid" }));
      assert.deepEqual(room, before);
    }
    if (type === "yearOfPlenty") {
      assert.throws(() => applyAction(room, player.id, { ...action, resources: { ore: 1 } }));
      assert.deepEqual(room, before);
    }
    if (type === "roadBuilding") {
      room.phase = "discard";
      const blocked = structuredClone(room);
      assert.throws(() => applyAction(room, player.id, action));
      assert.deepEqual(room, blocked);
      room.phase = "action";
    }
    applyAction(room, player.id, action);
    assert.deepEqual(player.playedProgressCards, { ...zero(), [type]: 1 });
    assert.equal(gallery(room, player).historyComplete, true);
    const played = structuredClone(room);
    assert.throws(() => applyAction(room, player.id, action));
    assert.deepEqual(room, played);
    const copy = gallery(room, player);
    copy[type] = 100;
    assert.equal(player.playedProgressCards[type], 1);
  });

  test(`${type} duplicate RPC and server restart preserve one played card without double counting`, async (t) => {
    const room = fixture();
    const player = current(room);
    const action = { ...preparePlay(room, type), requestId: crypto.randomUUID(), clientSeq: 1 };
    const h = await harness(t, room);
    const client = await h.connect(player);
    assert.equal((await call(client, "gameAction", action)).ok, true);
    assert.equal((await call(client, "gameAction", action)).ok, true);
    assert.equal((await h.read()).players.find((p) => p.id === player.id).playedProgressCards[type], 1);
    assert.equal(client.latest.players.find((p) => p.id === player.id).revealedDevelopment[type], 1);
    await h.restart();
    const resumed = await h.connect(player);
    assert.equal(resumed.latest.players.find((p) => p.id === player.id).revealedDevelopment[type], 1);
    assert.equal((await call(resumed, "gameAction", action)).ok, true);
    assert.equal((await h.read()).players.find((p) => p.id === player.id).playedProgressCards[type], 1);
    assert.equal(h.historyQueries.length, 0, "Known persisted counters do not need historical rescanning");
  });
}

test("legacy direct-engine progress starts an honest partial counter rather than inferring held cards", () => {
  const room = legacy(fixture());
  const player = current(room);
  card(room, player, "roadBuilding");
  const action = preparePlay(room, "monopoly");
  assert.deepEqual(gallery(room, player), { knight: 0, ...zero(), historyComplete: false });
  applyAction(room, player.id, action);
  assert.deepEqual(gallery(room, player), { knight: 0, roadBuilding: 0, yearOfPlenty: 0, monopoly: 1, historyComplete: false });
});

test("startup backfills full database history beyond 80/1000 events while preserving every game field and TTL", async (t) => {
  const room = legacy(fixture());
  const player = current(room);
  resources(room, player, { ore: 2, wood: 3 });
  player.knightsPlayed = 7;
  room.clientSequences = { [player.id]: 5 };
  room.requests = [{ id: "recorded-request", playerId: player.id, event: "gameAction" }];
  room.lastReceipts = { [player.id]: { id: "recorded-request", result: { ok: true, nextSequence: 6 } } };
  progressEvent(room, player, "roadBuilding");
  for (let i = 0; i < 1100; i += 1) {
    appendPublicEvent(room, { type: "test.notice", message: `Public notice ${i}.`, data: {} });
  }
  progressEvent(room, player, "yearOfPlenty", 2);
  progressEvent(room, player, "monopoly", 14);
  const h = await harness(t, room);
  const migrated = await h.read();
  assert.deepEqual(migrated.players.find((p) => p.id === player.id).playedProgressCards,
    { roadBuilding: 1, yearOfPlenty: 1, monopoly: 1 });
  assert.equal(migrated.players.find((p) => p.id === player.id).playedProgressHistoryComplete, true);
  assert.equal(gallery(migrated, migrated.players.find((p) => p.id === player.id)).knight, 7);
  assert.equal(migrated.revision, h.before.revision + 1);
  assert.equal(migrated.updatedAt, h.before.updatedAt);
  assert.equal(migrated.eventSequence, h.before.eventSequence);
  unchangedExceptStatistics(h.before, migrated);
  assert.ok(h.historyQueries.length >= 2);
  assert.ok(h.historyQueries.every((query) => query.limit <= 1000));
  assert.equal((await h.service.storage.listEvents(room.code, { limit: 1000 }))[0].seq, room.eventSequence);
  const revision = migrated.revision;
  await h.restart();
  assert.equal((await h.read()).revision, revision, "A completed additive migration is idempotent");
  const client = await h.connect(player);
  assert.deepEqual(client.latest.players.find((p) => p.id === player.id).revealedDevelopment, {
    knight: 7, roadBuilding: 1, yearOfPlenty: 1, monopoly: 1, historyComplete: true,
  });
});

test("PostgreSQL backfills legacy plays atomically and preserves the gallery after new plays and restart", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  let url;
  try { url = new URL(process.env.TEST_DATABASE_URL); } catch { throw new Error("The isolated PostgreSQL test URL is invalid."); }
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Only loopback PostgreSQL tests are allowed");
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "hearthlands_test", "Only the isolated test database is allowed");
  const room = legacy(fixture());
  const player = current(room);
  progressEvent(room, player, "roadBuilding");
  for (let i = 0; i < 90; i++) appendPublicEvent(room, { type: "test.notice", message: `Public notice ${i}.` });
  const move = { ...preparePlay(room, "monopoly"), requestId: crypto.randomUUID(), clientSeq: 1 };
  const h = await harness(t, room, {
    storage: {
      databaseUrl: process.env.TEST_DATABASE_URL, databaseSsl: "disable",
      databaseSchema: `hearthlands_gallery_test_${crypto.randomBytes(8).toString("hex")}`,
    },
  });
  assert.equal((await h.service.storage.health()).backend, "postgresql");
  const migrated = await h.read();
  unchangedExceptStatistics(h.before, migrated);
  assert.deepEqual(migrated.players[0].playedProgressCards, { roadBuilding: 1, yearOfPlenty: 0, monopoly: 0 });
  const client = await h.connect(player);
  assert.equal((await call(client, "gameAction", move)).ok, true);
  await h.restart();
  const resumed = await h.connect(player);
  assert.equal((await call(resumed, "gameAction", move)).ok, true);
  assert.deepEqual(resumed.latest.players[0].revealedDevelopment, {
    knight: 0, roadBuilding: 1, yearOfPlenty: 0, monopoly: 1, historyComplete: true,
  });
  assert.deepEqual((await h.read()).board, migrated.board);
});

for (const boundary of ["gameStarted", "game.rematched"]) {
  test(`history reconstruction stops at latest ${boundary} and excludes prior-match cards`, async (t) => {
    const room = legacy(fixture());
    const player = current(room);
    progressEvent(room, player, "monopoly");
    progressEvent(room, player, "monopoly");
    appendPublicEvent(room, { type: boundary, actorId: player.id, message: "New match boundary.", data: {} });
    progressEvent(room, player, "roadBuilding");
    const h = await harness(t, room);
    const restored = (await h.read()).players.find((p) => p.id === player.id);
    assert.deepEqual(restored.playedProgressCards, { roadBuilding: 1, yearOfPlenty: 0, monopoly: 0 });
    assert.equal(restored.playedProgressHistoryComplete, true);
  });
}

for (const reason of ["legacy", "missing-boundary"]) {
  test(`unknown ${reason} history remains explicitly incomplete and never parses messages or hands`, async (t) => {
    const room = legacy(fixture());
    const player = current(room);
    card(room, player, "roadBuilding");
    card(room, player, "victoryPoint");
    if (reason === "legacy") {
      progressEvent(room, player, "roadBuilding");
      appendPublicEvent(room, { type: "legacy", message: `${player.name} played roadBuilding and monopoly.`, data: {} });
    } else {
      room.log = [];
      room.eventOutbox = [];
      room.eventSequence = 0;
    }
    progressEvent(room, player, "monopoly", 7);
    const h = await harness(t, room);
    const saved = await h.read();
    const p = saved.players.find((p) => p.id === player.id);
    assert.deepEqual(p.playedProgressCards, { roadBuilding: 0, yearOfPlenty: 0, monopoly: 1 });
    assert.equal(p.playedProgressHistoryComplete, false);
    const shown = gallery(saved, p);
    assert.equal(shown.historyComplete, false);
    assert.equal(Object.hasOwn(shown, "victoryPoint"), false);
    for (const held of p.developmentCards) assert.ok(!JSON.stringify(shown).includes(held.id));
  });
}

for (const phase of ["lobby", "setup"]) {
  test(`legacy ${phase} initializes zero complete without scanning any previous-match history`, async (t) => {
    const room = legacy(fixture(phase));
    progressEvent(room, current(room), "monopoly");
    const h = await harness(t, room);
    assert.equal(h.historyQueries.length, 0);
    for (const player of (await h.read()).players) {
      assert.deepEqual(player.playedProgressCards, zero());
      assert.equal(player.playedProgressHistoryComplete, true);
    }
  });
}

test("known counters survive mixed legacy backfill, while partial fields are filled only from typed events", async (t) => {
  const room = legacy(fixture());
  const [known, partial, unknown] = room.players;
  known.playedProgressCards = { roadBuilding: 2, yearOfPlenty: 1, monopoly: 2 };
  known.playedProgressHistoryComplete = false;
  partial.playedProgressCards = { roadBuilding: 1 };
  progressEvent(room, partial, "roadBuilding");
  progressEvent(room, partial, "yearOfPlenty", 2);
  progressEvent(room, partial, "unknownType");
  card(room, unknown, "monopoly");
  const h = await harness(t, room);
  const saved = await h.read();
  assert.deepEqual(saved.players[0].playedProgressCards, known.playedProgressCards);
  assert.equal(saved.players[0].playedProgressHistoryComplete, false);
  assert.deepEqual(saved.players[1].playedProgressCards, { roadBuilding: 1, yearOfPlenty: 1, monopoly: 0 });
  assert.equal(saved.players[1].playedProgressHistoryComplete, true);
  assert.deepEqual(saved.players[2].playedProgressCards, zero());
});

test("archived rooms are never migrated and source legacy JSON backups remain byte-for-byte unchanged", async (t) => {
  const archived = legacy(fixture());
  progressEvent(archived, current(archived), "monopoly");
  const h = await harness(t, archived, { archived: true, legacyJson: true });
  assert.deepEqual(await h.read(), h.before);
  assert.equal(h.historyQueries.length, 0);
  assert.equal(fs.readFileSync(h.sourceFile, "utf8"), h.source);
  const active = legacy(fixture());
  progressEvent(active, current(active), "yearOfPlenty");
  const migrated = await harness(t, active, { legacyJson: true });
  assert.equal((await migrated.read()).players[0].playedProgressCards.yearOfPlenty, 1);
  assert.equal(fs.readFileSync(migrated.sourceFile, "utf8"), migrated.source);
});

test("finished legacy galleries disclose VP counts only after backfill; resigned players never reappear", async (t) => {
  const room = fixture();
  const [player, retired] = room.players;
  progressEvent(room, player, "monopoly");
  retired.playedProgressCards.roadBuilding = 1;
  resignPlayer(room, retired.id, () => 0.42);
  card(room, player, "victoryPoint");
  room.phase = "finished";
  room.winnerId = player.id;
  legacy(room);
  const h = await harness(t, room);
  const saved = await h.read();
  const state = publicState(saved, player.id);
  assert.equal(state.players.some((p) => p.id === retired.id), false);
  assert.equal(state.players.find((p) => p.id === player.id).revealedDevelopment.victoryPoint, 1);
  assert.equal(state.players.find((p) => p.id === player.id).revealedDevelopment.monopoly, 1);
  assert.deepEqual(Object.keys(state.departedPlayers[0]).sort(), ["color", "id", "name", "resignedAt"]);
});

test("rematch resets fresh progress history despite preserved room-wide activity and survives a restart", async (t) => {
  const room = fixture();
  const player = current(room);
  room.hostId = player.id;
  applyAction(room, player.id, preparePlay(room, "monopoly"));
  room.phase = "finished";
  room.winnerId = player.id;
  card(room, player, "victoryPoint");
  const h = await harness(t, room);
  const client = await h.connect(player);
  assert.equal(client.latest.players.find((p) => p.id === player.id).revealedDevelopment.monopoly, 1);
  const reply = await call(client, "rematch", { requestId: crypto.randomUUID(), clientSeq: 1 });
  assert.equal(reply.ok, true);
  for (const p of client.latest.players) assert.deepEqual(p.revealedDevelopment, { knight: 0, ...zero(), historyComplete: true });
  assert.equal(client.latest.phase, "lobby");
  await h.restart();
  const resumed = await h.connect(player);
  for (const p of resumed.latest.players) assert.deepEqual(p.revealedDevelopment, { knight: 0, ...zero(), historyComplete: true });
});

test("migration failures propagate without mutating source room, and incomplete sequence history cannot claim completeness", async () => {
  const room = legacy(fixture());
  const before = structuredClone(room);
  const storage = {
    async listRooms() { return [room]; },
    async listEvents() { return [{ seq: room.eventSequence, type: "gameStarted" }]; },
    async commitRoom() { throw new Error("Injected compare-and-swap failure"); },
  };
  await assert.rejects(migratePublicDevelopmentHistory(storage), /compare-and-swap/);
  assert.deepEqual(room, before);
  room.eventSequence = 20;
  const captured = [];
  storage.listEvents = async () => [
    { seq: 20, type: "developmentPlayed", actorId: room.players[0].id, data: { cardType: "roadBuilding" } },
    { seq: 18, type: "gameStarted" },
  ];
  storage.commitRoom = async (value, options) => { captured.push({ value, options }); return value; };
  await migratePublicDevelopmentHistory(storage);
  assert.equal(captured[0].value.players[0].playedProgressCards.roadBuilding, 1);
  assert.equal(captured[0].value.players[0].playedProgressHistoryComplete, false);
  assert.equal(captured[0].options.expectedRevision, room.revision);
});

test("missing or unattributable public history never claims a complete gallery", async () => {
  for (const unattributable of [false, true]) {
    const room = legacy(fixture());
    const storage = {
      async listRooms() { return [room]; },
      async listEvents() {
        return unattributable ? [
          { seq: room.eventSequence, type: "developmentPlayed", actorId: null, data: { cardType: "monopoly" } },
          { seq: room.eventSequence - 1, type: "gameStarted" },
        ] : [];
      },
      async commitRoom(saved) { return saved; },
    };
    const [saved] = await migratePublicDevelopmentHistory(storage);
    for (const player of saved.players) {
      assert.deepEqual(player.playedProgressCards, zero());
      assert.equal(player.playedProgressHistoryComplete, false);
    }
  }
});
