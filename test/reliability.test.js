"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { io } = require("socket.io-client");
const { createRoom, addPlayer, ensureMapPreview, startGame } = require("../game");
const { createGameServer } = require("../server");
const { StorageError } = require("../storage");

const DAY = 86_400_000;
const requestId = () => crypto.randomUUID();
const resumeKey = () => crypto.randomBytes(32).toString("hex");

function call(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, payload, (error, reply) => error ? reject(error) : resolve(reply));
  });
}

function waitFor(socket, predicate) {
  if (socket.latest && predicate(socket.latest)) return Promise.resolve(socket.latest);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("state", inspect);
      reject(new Error("State update timed out"));
    }, 3000);
    function inspect(state) {
      if (!predicate(state)) return;
      clearTimeout(timeout);
      socket.off("state", inspect);
      resolve(state);
    }
    socket.on("state", inspect);
  });
}

function fixture(code, at, names = ["Host"]) {
  const { room } = createRoom(names[0]);
  for (const name of names.slice(1)) addPlayer(room, name);
  Object.assign(room, { code, updatedAt: at, createdAt: at });
  ensureMapPreview(room, () => 0.37);
  return room;
}

function writeFixture(dataDir, room) {
  fs.writeFileSync(path.join(dataDir, `${room.code}.json`), JSON.stringify({ version: 2, room }));
}

async function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-reliability-"));
  const dataDir = path.join(root, "saves");
  fs.mkdirSync(dataDir);
  let clock = Date.UTC(2026, 8, 11);
  options.seed?.(dataDir, clock);
  const clients = [];
  const heldEvents = new Map();
  let service;
  let port;
  function start() {
    service = createGameServer({
      ...options, dataDir, now: () => clock,
      ackInterceptor(event, payload, result, deliver, socket) {
        const held = heldEvents.get(event);
        if (!held) return deliver();
        heldEvents.delete(event);
        held({ payload, result, deliver, socket });
      },
    });
    return service.listen().then((value) => { port = value; });
  }
  await start();
  t.after(async () => {
    clients.forEach((client) => client.close());
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, dataDir, clients,
    get service() { return service; },
    get port() { return port; },
    get now() { return clock; },
    advance(ms) { clock += ms; },
    read(code) { return service.storage.getRoom(code); },
    async restart() {
      await service.close();
      clients.forEach((client) => client.close());
      await start();
    },
    async connect() {
      const client = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false });
      clients.push(client);
      client.on("state", (state) => { client.latest = state; });
      await new Promise((resolve, reject) => {
        client.once("connect", resolve);
        client.once("connect_error", reject);
      });
      return client;
    },
    async hold(socket, event, payload) {
      let resolveReply;
      const reply = new Promise((resolve) => { resolveReply = resolve; });
      const held = new Promise((resolve) => heldEvents.set(event, resolve));
      socket.emit(event, payload, resolveReply);
      return { ...await held, reply };
    },
    blockSave() {
      const original = service.storage.commitRoom;
      let hit;
      const attempted = new Promise((resolve) => { hit = resolve; });
      service.storage.commitRoom = async () => {
        hit();
        throw new StorageError("STORAGE_FAILURE", "Injected database failure.");
      };
      const restore = () => { service.storage.commitRoom = original; };
      restore.attempted = attempted;
      return restore;
    },
  };
}

async function table(h, count = 3) {
  const host = await h.connect();
  const created = await call(host, "createRoom", { name: "Host", resumeKey: resumeKey(), requestId: requestId() });
  assert.equal(created.ok, true);
  const seats = new Map([[created.playerId, { socket: host, ...created }]]);
  for (let index = 1; index < count; index++) {
    const socket = await h.connect();
    const joined = await call(socket, "joinRoom", {
      name: `Guest ${index}`, code: created.roomCode, resumeKey: resumeKey(), requestId: requestId(),
    });
    assert.equal(joined.ok, true);
    seats.set(joined.playerId, { socket, ...joined });
  }
  return { host, created, seats };
}

for (const event of ["createRoom", "joinRoom"]) {
  test(`${event}: lost and delayed entry ACKs cannot create duplicate seats, including after restart`, async (t) => {
    const h = await harness(t);
    let code;
    if (event === "joinRoom") {
      const owner = await h.connect();
      code = (await call(owner, "createRoom", { name: "Owner" })).roomCode;
    }
    const first = await h.connect();
    const payload = { name: "Traveler", resumeKey: resumeKey(), requestId: requestId(), ...(code ? { code } : {}) };
    const pending = await h.hold(first, event, payload);
    assert.equal(pending.result.ok, true);
    const created = pending.result;
    assert.equal(created.reconnectToken, payload.resumeKey);
    assert.equal(created.protocolVersion, 3);
    assert.equal(created.nextSequence, 1);
    assert.equal(created.savedAt, h.now);
    assert.equal(created.expiresAt, h.now + 90 * DAY);
    const sameSocket = await call(first, event, { ...payload, name: " Traveler " });
    assert.equal(sameSocket.playerId, created.playerId);
    assert.equal(sameSocket.revision, created.revision);
    pending.deliver();
    assert.equal((await pending.reply).roomCode, created.roomCode);
    assert.equal((await call(first, event, { ...payload, name: "Changed" })).code, "REQUEST_CONFLICT");
    assert.equal((await call(first, event, { ...payload, requestId: requestId() })).code, "REQUEST_CONFLICT");
    assert.equal((await call(first, "createRoom", { name: "Second" })).ok, false);

    const dropped = await h.hold(first, event, payload);
    const second = await h.connect();
    const replaced = new Promise((resolve) => first.once("sessionReplaced", resolve));
    const rebound = await call(second, event, payload);
    await replaced;
    assert.equal(rebound.playerId, created.playerId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await call(second, "reconnectRoom", { reconnectToken: payload.resumeKey, code: created.roomCode });
      assert.equal(reply.ok, true);
      assert.equal(reply.playerId, created.playerId);
      assert.equal(second.latest.players.find((player) => player.id === created.playerId).connected, true);
    }
    assert.equal(dropped.result.roomCode, created.roomCode);
    await h.restart();
    const resumed = await h.connect();
    const retried = await call(resumed, event, payload);
    assert.equal(retried.ok, true);
    assert.equal(retried.playerId, created.playerId);
    assert.equal(retried.roomCode, created.roomCode);
    assert.equal((await h.read(created.roomCode)).players.length, event === "createRoom" ? 1 : 2);
    assert.equal((await h.service.storage.listRooms()).length, 1);
    assert.equal(fs.readdirSync(h.dataDir).filter((file) => file.endsWith(".json")).length, 0);
  });
}

test("entry keys are private, validated, globally unique, and cannot move an already-bound socket", async (t) => {
  const h = await harness(t);
  const first = await h.connect();
  for (const key of ["A".repeat(64), "a".repeat(63), "", 23]) {
    assert.equal((await call(first, "createRoom", { name: "First", resumeKey: key, requestId: requestId() })).ok, false);
  }
  const payload = { name: "First", resumeKey: resumeKey(), requestId: requestId() };
  const created = await call(first, "createRoom", payload);
  const other = await h.connect();
  const otherPayload = { name: "Other", resumeKey: resumeKey(), requestId: requestId() };
  const otherRoom = await call(other, "createRoom", otherPayload);
  assert.equal((await call(first, "createRoom", otherPayload)).code, "REJECTED");
  const stranger = await h.connect();
  assert.equal((await call(stranger, "joinRoom", { ...payload, code: otherRoom.roomCode })).code, "REQUEST_CONFLICT");
  assert.equal((await call(stranger, "reconnectRoom", {
    reconnectToken: payload.resumeKey, code: otherRoom.roomCode,
  })).code, "ROOM_NOT_FOUND");
  assert.equal((await call(stranger, "reconnectRoom", { reconnectToken: resumeKey() })).code, "ROOM_NOT_FOUND");
  const serialized = JSON.stringify(first.latest);
  for (const secret of ["reconnectToken", "resumeKey", "payloadHash", "clientSequences", "lastReceipts", payload.resumeKey, h.dataDir]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.equal((await h.read(created.roomCode)).players[0].entry.id, payload.requestId);
});

test("sequenced rejected starts remain rejected after eligibility changes; delayed shuffle and start ACKs replay across phases", async (t) => {
  const h = await harness(t);
  const { host, created } = await table(h, 1);
  const rejected = { requestId: requestId(), clientSeq: 1 };
  const rejectedReply = await call(host, "startGame", rejected);
  assert.equal(rejectedReply.code, "REJECTED");
  assert.equal(rejectedReply.retryable, false);
  assert.equal(rejectedReply.nextSequence, 2);
  assert.equal(host.latest.ownReceipt.ok, false);
  for (let index = 1; index < 3; index++) {
    assert.equal((await call(await h.connect(), "joinRoom", { name: `Guest ${index}`, code: created.roomCode })).ok, true);
  }
  assert.deepEqual(await call(host, "startGame", rejected), rejectedReply);
  assert.equal(host.latest.phase, "lobby");
  const sharedId = requestId();
  const shuffle = { requestId: sharedId, clientSeq: 2, expectedMapVersion: host.latest.mapVersion };
  const shuffled = await h.hold(host, "shuffleMap", shuffle);
  assert.equal(shuffled.result.ok, true);
  await waitFor(host, (state) => state.ownReceipt?.event === "shuffleMap");
  const shuffledBoard = structuredClone(host.latest.board);
  const start = { requestId: sharedId, clientSeq: 3 };
  const started = await h.hold(host, "startGame", start);
  assert.equal(started.result.ok, true);
  await waitFor(host, (state) => state.phase === "setup");
  assert.equal(host.latest.players.length, 3);
  assert.equal(host.latest.phase, "setup");
  assert.equal(host.latest.ownReceipt.event, "startGame");
  const replayedShuffle = await call(host, "shuffleMap", shuffle);
  assert.equal(replayedShuffle.ok, true);
  assert.equal(replayedShuffle.mapVersion, shuffled.result.mapVersion);
  assert.equal(replayedShuffle.revision, shuffled.result.revision);
  assert.equal(replayedShuffle.nextSequence, 4);
  assert.deepEqual(host.latest.board, shuffledBoard);
  assert.deepEqual(await call(host, "startGame", start), started.result);
  shuffled.deliver();
  started.deliver();
  assert.equal((await shuffled.reply).nextSequence, 3);
  assert.equal((await started.reply).nextSequence, 4);
  await h.restart();
  const resumed = await h.connect();
  const bound = await call(resumed, "reconnectRoom", { reconnectToken: created.reconnectToken });
  assert.equal(bound.nextSequence, 4);
  assert.equal(bound.ownReceipt.requestId, sharedId);
  assert.deepEqual(await call(resumed, "startGame", start), started.result);
  assert.equal((await call(resumed, "shuffleMap", shuffle)).ok, true);
  assert.equal((await call(resumed, "startGame", rejected)).code, "REJECTED");
  assert.equal(resumed.latest.phase, "setup");
});

test("game actions commit once despite dropped ACKs, reordered object keys, other actors and process restart", async (t) => {
  const h = await harness(t);
  const { host, created, seats } = await table(h);
  assert.equal((await call(host, "startGame", { requestId: requestId(), clientSeq: 1 })).ok, true);
  const setup = await waitFor(host, (state) => state.phase === "setup");
  const actor = seats.get(setup.currentPlayerId);
  const own = await waitFor(actor.socket, (state) => state.phase === "setup");
  const action = {
    type: "setupSettlement", vertexId: own.legal.settlementVertices[0],
    requestId: requestId(), clientSeq: own.nextSequence, metadata: { first: 1, nested: { a: 2, b: [3, 4] } },
  };
  const held = await h.hold(actor.socket, "gameAction", action);
  assert.equal(held.result.ok, true);
  const saved = (await h.read(created.roomCode));
  const receipt = saved.requests.find((request) => request.id === action.requestId);
  assert.equal(receipt.result.ok, true);
  assert.equal(saved.board.vertices.filter((vertex) => vertex.structure).length, 1);
  const reordered = {
    metadata: { nested: { b: [3, 4], a: 2 }, first: 1 }, clientSeq: action.clientSeq,
    requestId: action.requestId, vertexId: action.vertexId, type: action.type,
  };
  assert.deepEqual(await call(actor.socket, "gameAction", reordered), held.result);
  for (const changed of [
    { ...action, vertexId: "another-vertex" },
    { ...action, metadata: { first: 1, nested: { a: 2, b: [4, 3] } } },
  ]) {
    const conflict = await call(actor.socket, "gameAction", changed);
    assert.equal(conflict.code, "REQUEST_CONFLICT");
    assert.equal(conflict.retryable, false);
  }
  const other = [...seats.values()].find((seat) => seat.playerId !== actor.playerId);
  const invalid = await call(other.socket, "gameAction", {
    type: "invalid", requestId: action.requestId, clientSeq: other.socket.latest.nextSequence,
  });
  assert.equal(invalid.code, "REJECTED");
  assert.equal(other.socket.latest.ownReceipt.ok, false);
  assert.equal(actor.socket.latest.ownReceipt.ok, true);
  const disk = (await h.read(created.roomCode));
  assert.equal(disk.requests.filter((request) => request.id === action.requestId).length, 2);
  assert.equal(disk.board.vertices.filter((vertex) => vertex.structure).length, 1);
  const visible = JSON.stringify(actor.socket.latest);
  for (const privateValue of [receipt.payloadHash, "payloadHash", "clientSequences", "lastReceipts", ...[...seats.values()].map((seat) => seat.reconnectToken)]) {
    assert.equal(visible.includes(privateValue), false, "Only the viewer's safe receipt summary is public");
  }
  assert.equal(actor.socket.latest.players.filter((player) => player.resources).length, 1);
  await h.restart();
  const resumed = await h.connect();
  const restored = await call(resumed, "reconnectRoom", { reconnectToken: actor.reconnectToken });
  assert.equal(restored.nextSequence, action.clientSeq + 1);
  assert.equal(restored.ownReceipt.requestId, action.requestId);
  assert.deepEqual(await call(resumed, "gameAction", action), held.result);
  assert.equal(resumed.latest.board.vertices.filter((vertex) => vertex.structure).length, 1);
  assert.equal(resumed.latest.setupNeedsRoad, true);
});

test("accepted shuffle and start replay after phase and host changes, while fresh requests remain forbidden", async (t) => {
  const h = await harness(t);
  const { host, created, seats } = await table(h);
  const shuffle = { requestId: requestId(), clientSeq: 1, expectedMapVersion: host.latest.mapVersion };
  const shuffled = await call(host, "shuffleMap", shuffle);
  assert.equal(shuffled.ok, true);
  const start = { requestId: requestId(), clientSeq: 2 };
  const started = await call(host, "startGame", start);
  assert.equal(started.ok, true);
  const other = [...seats.values()].find((seat) => seat.playerId !== created.playerId);
  const observer = other.socket;
  assert.equal((await call(host, "transferAdmin", { playerId: other.playerId, requestId: requestId(), clientSeq: 3 })).ok, true);
  host.close();
  await waitFor(observer, (state) => !state.players.find((player) => player.id === created.playerId).connected);
  const resumed = await h.connect();
  assert.equal((await call(resumed, "reconnectRoom", { reconnectToken: created.reconnectToken })).ok, true);
  assert.notEqual(resumed.latest.hostId, created.playerId);
  assert.equal(resumed.latest.phase, "setup");
  const before = (await h.read(created.roomCode));
  assert.deepEqual(await call(resumed, "shuffleMap", shuffle), { ...shuffled, nextSequence: 4 });
  assert.deepEqual(await call(resumed, "startGame", start), { ...started, nextSequence: 4 });
  assert.deepEqual((await h.read(created.roomCode)), before, "Replays cannot reshuffle, restart, or rewrite the saved match");
  assert.equal((await call(resumed, "shuffleMap", {
    requestId: requestId(), clientSeq: 4, expectedMapVersion: resumed.latest.mapVersion,
  })).code, "REJECTED");
  assert.equal((await call(resumed, "startGame", { requestId: requestId(), clientSeq: 5 })).code, "REJECTED");
  const after = (await h.read(created.roomCode));
  for (const key of ["board", "players", "bank", "developmentDeck", "phase", "turnIndex", "mapVersion", "log"]) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.equal(resumed.latest.nextSequence, 6);
});

test("turn guard durably rejects delayed intent after legacy activations but replays committed actions before checking the turn", async (t) => {
  let seats;
  const h = await harness(t, { random: () => 0.37, seed(dataDir, now) {
    const room = fixture("ABCDEF", now, ["Host", "Second", "Third"]);
    startGame(room, room.hostId, () => 0.37);
    Object.assign(room, { phase: "roll", turnNumber: 7 });
    seats = room.players.map((player) => ({ playerId: player.id, reconnectToken: player.reconnectToken }));
    writeFixture(dataDir, room);
  } });
  for (const seat of seats) {
    seat.socket = await h.connect();
    assert.equal((await call(seat.socket, "reconnectRoom", { reconnectToken: seat.reconnectToken })).ok, true);
  }
  const actor = seats[0];
  const delayed = { type: "roll", expectedTurnNumber: 7, requestId: requestId(), clientSeq: 1 };
  for (const seat of seats) {
    assert.equal((await call(seat.socket, "gameAction", { type: "roll", requestId: requestId() })).ok, true);
    assert.equal((await call(seat.socket, "gameAction", { type: "endTurn", requestId: requestId() })).ok, true);
  }
  await waitFor(actor.socket, (state) => state.turnNumber === 10);
  assert.equal(actor.socket.latest.currentPlayerId, actor.playerId);
  const before = (await h.read("ABCDEF"));
  const stale = await h.hold(actor.socket, "gameAction", delayed);
  assert.equal(stale.result.code, "STALE_TURN");
  assert.equal(stale.result.retryable, false);
  assert.equal(stale.result.nextSequence, 2);
  await waitFor(actor.socket, (state) => state.ownReceipt?.requestId === delayed.requestId);
  assert.equal(actor.socket.latest.ownReceipt.code, "STALE_TURN");
  const after = (await h.read("ABCDEF"));
  for (const key of ["phase", "turnNumber", "turnIndex", "dice", "players", "board", "bank", "log"]) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.equal(after.clientSequences[actor.playerId], 1);
  await h.restart();
  const resumed = await h.connect();
  const bound = await call(resumed, "reconnectRoom", { reconnectToken: actor.reconnectToken });
  assert.equal(bound.nextSequence, 2);
  assert.equal(bound.ownReceipt.code, "STALE_TURN");
  const beforeRetry = (await h.read("ABCDEF"));
  assert.deepEqual(await call(resumed, "gameAction", delayed), stale.result);
  assert.deepEqual((await h.read("ABCDEF")), beforeRetry);

  const fresh = { type: "roll", expectedTurnNumber: 10, requestId: requestId(), clientSeq: 2 };
  const accepted = await call(resumed, "gameAction", fresh);
  assert.equal(accepted.ok, true);
  assert.equal((await call(resumed, "gameAction", { type: "endTurn", requestId: requestId() })).ok, true);
  assert.equal(resumed.latest.turnNumber, 11);
  const beforeReplay = (await h.read("ABCDEF"));
  assert.deepEqual(await call(resumed, "gameAction", fresh), accepted);
  assert.deepEqual((await h.read("ABCDEF")), beforeReplay, "An accepted old-turn action must never apply again");
  assert.equal((await call(resumed, "gameAction", { ...fresh, expectedTurnNumber: 11 })).code, "REQUEST_CONFLICT");
});

test("same-turn disconnect and reconnect revisions do not invalidate guarded game actions", async (t) => {
  const h = await harness(t);
  const { host, seats } = await table(h);
  assert.equal((await call(host, "startGame")).ok, true);
  const actor = seats.get(host.latest.currentPlayerId);
  const state = await waitFor(actor.socket, (value) => value.phase === "setup");
  const action = {
    type: "setupSettlement", vertexId: state.legal.settlementVertices[0], expectedTurnNumber: state.turnNumber,
    requestId: requestId(), clientSeq: state.nextSequence,
  };
  const guest = [...seats.values()].find((seat) => seat.playerId !== actor.playerId);
  guest.socket.close();
  await waitFor(actor.socket, (value) => !value.players.find((player) => player.id === guest.playerId).connected);
  const replacement = await h.connect();
  assert.equal((await call(replacement, "reconnectRoom", { reconnectToken: guest.reconnectToken })).ok, true);
  await waitFor(actor.socket, (value) => value.players.find((player) => player.id === guest.playerId).connected);
  assert.ok(actor.socket.latest.revision > state.revision);
  assert.equal(actor.socket.latest.turnNumber, state.turnNumber);
  assert.equal((await call(actor.socket, "gameAction", action)).ok, true);
  assert.equal(actor.socket.latest.board.vertices.filter((vertex) => vertex.structure).length, 1);
});

test("gaps, stale sequences, terminal validation receipts and transient session/rate failures have distinct outcomes", async (t) => {
  const h = await harness(t);
  const { host, created } = await table(h, 1);
  const unbound = await h.connect();
  const request = { requestId: requestId(), clientSeq: 1 };
  const missing = await call(unbound, "startGame", request);
  assert.equal(missing.code, "SESSION_REQUIRED");
  assert.equal(missing.retryable, true);
  const gap = await call(host, "startGame", { ...request, clientSeq: 2 });
  assert.equal(gap.code, "SEQUENCE_GAP");
  assert.equal(gap.nextSequence, 1);
  for (const clientSeq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
    assert.equal((await call(host, "startGame", { ...request, clientSeq })).code, "REJECTED");
    assert.equal(host.latest.nextSequence, 1);
  }
  const before = (await h.read(created.roomCode));
  const terminal = await call(host, "gameAction", { ...request, type: "notAnAction" });
  assert.equal(terminal.code, "REJECTED");
  assert.equal(terminal.nextSequence, 2);
  const after = (await h.read(created.roomCode));
  for (const key of ["board", "players", "bank", "phase", "log", "turnIndex"]) {
    assert.deepEqual(after[key], before[key], key);
  }
  const stale = await call(host, "startGame", { requestId: requestId(), clientSeq: 1 });
  assert.equal(stale.code, "STALE_REQUEST");
  assert.equal(stale.processed, true);
  assert.equal(stale.retryable, false);
  let limited;
  for (let index = 0; index < 45; index++) {
    const response = await call(host, "reconnectRoom", { reconnectToken: created.reconnectToken });
    if (response.code === "RATE_LIMITED") { limited = response; break; }
  }
  assert.equal(limited.retryable, true);
  assert.ok(limited.retryAfterMs > 0 && limited.retryAfterMs <= 1000);
  const pending = { requestId: requestId(), clientSeq: 2, expectedMapVersion: host.latest.mapVersion };
  assert.equal((await call(host, "shuffleMap", pending)).code, "RATE_LIMITED");
  assert.equal((await h.read(created.roomCode)).clientSequences[created.playerId], 1);
  h.advance(1001);
  assert.equal((await call(host, "shuffleMap", pending)).ok, true);
  assert.equal(host.latest.nextSequence, 3);
});

test("save failures cannot consume sequences, publish partial changes, or turn a retry into a duplicate", async (t) => {
  const h = await harness(t);
  const { host, created } = await table(h, 1);
  const original = structuredClone(host.latest);
  const payload = { requestId: requestId(), clientSeq: 1, expectedMapVersion: original.mapVersion };
  const restore = h.blockSave(created.roomCode);
  try {
    const failed = await call(host, "shuffleMap", payload);
    assert.equal(failed.code, "SAVE_FAILED");
    assert.equal(failed.retryable, true);
    assert.equal(failed.nextSequence, 1);
    assert.equal(failed.error.includes(h.dataDir), false);
    assert.deepEqual(host.latest, original);
    const rejected = await call(host, "startGame", { requestId: requestId(), clientSeq: 1 });
    assert.equal(rejected.code, "SAVE_FAILED");
    assert.equal(rejected.nextSequence, 1);
  } finally {
    restore();
  }
  assert.equal((await h.read(created.roomCode)).requests, undefined);
  assert.equal((await call(host, "shuffleMap", payload)).ok, true);
  assert.equal(host.latest.nextSequence, 2);
  assert.equal(host.latest.mapVersion, original.mapVersion + 1);
  assert.equal((await h.read(created.roomCode)).requests.length, 1);
});

test("failed create and private-key join do not leave ghost rooms or reserve a resume key", async (t) => {
  const h = await harness(t, { maxRooms: 1 });
  const host = await h.connect();
  const payload = { name: "Host", resumeKey: resumeKey(), requestId: requestId() };
  const unblockCreate = h.blockSave();
  try {
    const failed = await call(host, "createRoom", payload);
    assert.equal(failed.code, "SAVE_FAILED");
    assert.equal(failed.retryable, true);
  } finally {
    unblockCreate();
  }
  const created = await call(host, "createRoom", payload);
  assert.equal(created.ok, true);
  const guest = await h.connect();
  const join = { name: "Guest", code: created.roomCode, resumeKey: resumeKey(), requestId: requestId() };
  const restore = h.blockSave(created.roomCode);
  try {
    assert.equal((await call(guest, "joinRoom", join)).code, "SAVE_FAILED");
    assert.equal(host.latest.players.length, 1);
  } finally {
    restore();
  }
  assert.equal((await call(guest, "joinRoom", join)).ok, true);
  assert.equal((await h.read(created.roomCode)).players.length, 2);
});

test("lobby removal receipts replay after ACK loss, and delayed entry retries cannot revive a revoked key", async (t) => {
  const h = await harness(t);
  const { host, created } = await table(h, 1);
  const guest = await h.connect();
  const entry = { code: created.roomCode, name: "Guest", resumeKey: resumeKey(), requestId: requestId() };
  const joined = await call(guest, "joinRoom", entry);
  const payload = { playerId: joined.playerId, confirmed: true, requestId: requestId(), clientSeq: 1 };
  const pending = await h.hold(host, "removePlayer", payload);
  assert.equal(pending.result.ok, true);
  await waitFor(host, (state) => state.players.length === 1);
  assert.deepEqual(await call(host, "removePlayer", payload), pending.result);
  const outsider = await h.connect();
  assert.equal((await call(outsider, "joinRoom", entry)).code, "ROOM_NOT_FOUND");
  assert.equal((await call(outsider, "createRoom", entry)).code, "ROOM_NOT_FOUND");
  assert.equal((await call(outsider, "reconnectRoom", { reconnectToken: entry.resumeKey })).code, "ROOM_NOT_FOUND");
  assert.equal(host.latest.players.length, 1);
  await h.restart();
  const resumed = await h.connect();
  await call(resumed, "reconnectRoom", { reconnectToken: created.reconnectToken });
  assert.deepEqual(await call(resumed, "removePlayer", payload), pending.result);
  assert.equal(resumed.latest.nextSequence, 2);
  const guestRetry = await h.connect();
  assert.equal((await call(guestRetry, "joinRoom", entry)).code, "ROOM_NOT_FOUND");
  assert.equal((await call(guestRetry, "joinRoom", { ...entry, resumeKey: resumeKey(), requestId: requestId() })).ok, true);
});

test("dropped reconnect ACKs transfer ownership once and stale socket work cannot affect the replacement", async (t) => {
  const h = await harness(t);
  const { host, created } = await table(h, 1);
  const staleSocket = h.service.io.sockets.sockets.get(host.id);
  const replacement = await h.connect();
  const reconnect = { reconnectToken: created.reconnectToken, code: created.roomCode };
  const pending = await h.hold(replacement, "reconnectRoom", reconnect);
  assert.equal(pending.result.ok, true);
  assert.deepEqual(await call(replacement, "reconnectRoom", reconnect), pending.result);
  assert.equal(replacement.latest.players[0].connected, true);
  const stale = await new Promise((resolve) => staleSocket.listeners("gameAction")[0]({
    type: "roll", requestId: requestId(), clientSeq: 1,
  }, resolve));
  assert.equal(stale.code, "SESSION_REQUIRED");
  assert.equal(stale.retryable, true);
  assert.equal((await h.read(created.roomCode)).clientSequences, undefined);
  assert.equal((await call(replacement, "shuffleMap", {
    requestId: requestId(), clientSeq: 1, expectedMapVersion: replacement.latest.mapVersion,
  })).ok, true);
  pending.deliver();
  assert.equal((await pending.reply).playerId, created.playerId);
  host.close();
  assert.equal(replacement.latest.players[0].connected, true);
});

test("a failed disconnect save never reports stale presence and can be repaired by idempotent resume", async (t) => {
  const h = await harness(t);
  const { host, created, seats } = await table(h, 2);
  const guest = [...seats.values()].find((seat) => seat.playerId !== created.playerId);
  const oldSocket = h.service.io.sockets.sockets.get(host.id);
  const disconnected = new Promise((resolve) => oldSocket.once("disconnect", resolve));
  const restore = h.blockSave(created.roomCode);
  try {
    host.close();
    await disconnected;
    await restore.attempted;
  } finally {
    restore();
  }
  const reply = await call(guest.socket, "reconnectRoom", { reconnectToken: guest.reconnectToken });
  assert.equal(reply.ok, true);
  assert.equal(guest.socket.latest.players.find((player) => player.id === created.playerId).connected, false);
  assert.equal(guest.socket.latest.hostId, created.playerId);
  assert.equal((await h.read(created.roomCode)).hostId, created.playerId);
});

test("bounded receipt eviction retains durable sequence high-water and cannot reapply an aged retry", async (t) => {
  let token;
  let playerId;
  const h = await harness(t, { seed(dataDir, now) {
    const room = fixture("ABCDEF", now);
    ({ reconnectToken: token, id: playerId } = room.players[0]);
    room.clientSequences = { [playerId]: 2048 };
    room.requests = Array.from({ length: 2048 }, (_, index) => ({
      id: `request-${index + 1}`, playerId, event: "startGame", clientSeq: index + 1, payloadHash: "historical",
      result: { ok: false, code: "REJECTED", error: "Not enough players.", retryable: false, revision: index + 1, nextSequence: index + 2 },
    }));
    room.lastReceipts = { [playerId]: room.requests.at(-1) };
    writeFixture(dataDir, room);
  } });
  const host = await h.connect();
  assert.equal((await call(host, "reconnectRoom", { reconnectToken: token })).nextSequence, 2049);
  assert.equal((await call(host, "startGame", { requestId: requestId(), clientSeq: 2049 })).code, "REJECTED");
  const saved = (await h.read("ABCDEF"));
  assert.equal(saved.requests.length, 2048);
  assert.equal(saved.requests.some((receipt) => receipt.id === "request-1"), false);
  const replay = { requestId: "request-1", clientSeq: 1 };
  assert.equal((await call(host, "startGame", replay)).code, "STALE_REQUEST");
  await h.restart();
  const resumed = await h.connect();
  const bound = await call(resumed, "reconnectRoom", { reconnectToken: token });
  assert.equal(bound.nextSequence, 2050);
  const stale = await call(resumed, "startGame", replay);
  assert.equal(stale.processed, true);
  assert.equal(stale.code, "STALE_REQUEST");
  assert.equal((await h.read("ABCDEF")).clientSequences[playerId], 2049);
  assert.equal(resumed.latest.phase, "lobby");
});

test("version-2 saves and unverifiable legacy receipts are retained without reapplying actions", async (t) => {
  let token;
  let original;
  const h = await harness(t, { seed(dataDir, now) {
    original = fixture("ABCDEF", now - 30 * DAY);
    const player = original.players[0];
    token = player.reconnectToken;
    original.requests = [
      { id: "legacy-action", playerId: player.id },
      { id: "legacy-shuffle", playerId: player.id, event: "shuffleMap", mapVersion: original.mapVersion },
    ];
    writeFixture(dataDir, original);
  } });
  const host = await h.connect();
  assert.equal((await call(host, "reconnectRoom", { reconnectToken: token })).ok, true);
  const before = structuredClone(host.latest);
  assert.equal((await call(host, "gameAction", { requestId: "legacy-action", type: "setupSettlement" })).processed, true);
  const shuffle = await call(host, "shuffleMap", { requestId: "legacy-shuffle", expectedMapVersion: -100 });
  assert.equal(shuffle.ok, true);
  assert.equal(shuffle.mapVersion, original.mapVersion);
  assert.deepEqual(host.latest.board, before.board);
  assert.equal(host.latest.revision, before.revision);
  assert.equal(host.latest.nextSequence, 1);
  assert.equal((await h.read("ABCDEF")).requests.length, 2);
});

test("resignation persists before revoking capability, retries safely, and excludes retired seats from rematches", async (t) => {
  const h = await harness(t);
  const { host, created, seats } = await table(h);
  assert.equal((await call(host, "startGame", { requestId: requestId(), clientSeq: 1 })).ok, true);
  const unconfirmed = await call(host, "resignGame", { confirmed: "true", requestId: requestId(), clientSeq: 2 });
  assert.equal(unconfirmed.code, "REJECTED");
  assert.equal(host.latest.activePlayerCount, 3);
  const payload = {
    confirmed: true, successorId: [...seats.keys()].find((id) => id !== created.playerId),
    requestId: requestId(), clientSeq: 3,
  };
  let retiredEvent;
  host.on("seatRetired", (event) => { retiredEvent = event; });
  const restore = h.blockSave(created.roomCode);
  try {
    const failed = await call(host, "resignGame", payload);
    assert.equal(failed.code, "SAVE_FAILED");
    assert.equal(failed.nextSequence, 3);
    assert.equal(retiredEvent, undefined);
    assert.equal(host.latest.activePlayerCount, 3);
  } finally {
    restore();
  }
  const retirement = new Promise((resolve) => host.once("seatRetired", resolve));
  const resignation = await h.hold(host, "resignGame", payload);
  assert.equal(resignation.result.ok, true);
  await retirement;
  const remaining = [...seats.values()].filter((seat) => seat.playerId !== created.playerId);
  const state = await waitFor(remaining[0].socket, (value) => value.activePlayerCount === 2);
  assert.equal(state.players.some((player) => player.id === created.playerId), false);
  assert.equal(state.departedPlayers.some((player) => player.id === created.playerId), true);
  assert.equal(state.hostId === created.playerId, false);
  assert.deepEqual(retiredEvent, { roomCode: created.roomCode, playerId: created.playerId, requestId: payload.requestId });
  const saved = (await h.read(created.roomCode));
  assert.equal(saved.players.length, 3);
  const retired = saved.players.find((player) => player.id === created.playerId);
  assert.equal(retired.resigned, true);
  assert.equal(retired.connected, false);
  assert.equal(retired.resignedAt, h.now);
  assert.equal(retired.reconnectToken, created.reconnectToken);
  assert.deepEqual(await call(host, "resignGame", payload), resignation.result);
  for (const [event, data] of [
    ["startGame", { requestId: requestId(), clientSeq: 4 }],
    ["shuffleMap", { requestId: requestId(), clientSeq: 4, expectedMapVersion: state.mapVersion }],
    ["gameAction", { requestId: requestId(), clientSeq: 4, type: "roll" }],
    ["resignGame", { ...payload, requestId: requestId(), clientSeq: 4 }],
    ["mapPointer", { x: 0.5, y: 0.5, mapVersion: state.mapVersion }],
  ]) {
    assert.equal((await call(host, event, data)).code, "SEAT_RETIRED", event);
  }
  const outsider = await h.connect();
  const denied = await call(outsider, "reconnectRoom", { reconnectToken: created.reconnectToken });
  assert.equal(denied.code, "SEAT_RETIRED");
  assert.equal(denied.retryable, false);
  assert.equal(denied.playerId, created.playerId);
  assert.equal(denied.roomCode, created.roomCode);
  assert.equal(denied.reconnectToken, undefined);

  const nextHost = remaining.find((seat) => seat.playerId === state.hostId);
  const survivor = remaining.find((seat) => seat !== nextHost);
  const resignAgain = { confirmed: true, successorId: survivor.playerId, requestId: requestId(), clientSeq: nextHost.socket.latest.nextSequence };
  assert.equal((await call(nextHost.socket, "resignGame", resignAgain)).ok, true);
  const won = await waitFor(survivor.socket, (value) => value.phase === "finished");
  assert.equal(won.winReason, "last-player");
  assert.equal(won.winnerId, survivor.playerId);
  assert.equal(won.hostId, survivor.playerId);
  const rematch = { requestId: requestId(), clientSeq: won.nextSequence };
  const pending = await h.hold(survivor.socket, "rematch", rematch);
  assert.equal(pending.result.ok, true);
  await waitFor(survivor.socket, (state) => state.phase === "lobby");
  assert.equal(survivor.socket.latest.players.length, 1);
  assert.equal(survivor.socket.latest.phase, "lobby");
  const board = structuredClone(survivor.socket.latest.board);
  assert.deepEqual(await call(survivor.socket, "rematch", rematch), pending.result);
  assert.deepEqual(survivor.socket.latest.board, board);
  assert.equal((await call(survivor.socket, "startGame", {
    requestId: requestId(), clientSeq: survivor.socket.latest.nextSequence,
  })).code, "REJECTED");
  assert.equal((await call(outsider, "reconnectRoom", { reconnectToken: created.reconnectToken })).code, "SEAT_RETIRED");
  const rematched = (await h.read(created.roomCode));
  assert.equal(rematched.players.length, 1);
  assert.equal(rematched.retiredPlayers.length, 2);
  assert.equal(rematched.clientSequences[created.playerId], 3);
  assert.equal(rematched.requests.some((receipt) => receipt.id === payload.requestId), true);
  assert.equal(JSON.stringify(survivor.socket.latest).includes(created.reconnectToken), false);
  await h.restart();
  const resumed = await h.connect();
  const bound = await call(resumed, "reconnectRoom", { reconnectToken: survivor.reconnectToken });
  assert.equal(bound.ok, true);
  assert.equal((await call(resumed, "rematch", rematch)).ok, true);
  for (let index = 0; index < 2; index++) {
    assert.equal((await call(await h.connect(), "joinRoom", { code: created.roomCode, name: `New ${index}` })).ok, true);
  }
  assert.equal((await call(resumed, "startGame", { requestId: requestId(), clientSeq: resumed.latest.nextSequence })).ok, true);
  assert.equal(resumed.latest.players.length, 3);
  const retiredReconnect = await h.connect();
  assert.equal((await call(retiredReconnect, "reconnectRoom", { reconnectToken: created.reconnectToken })).code, "SEAT_RETIRED");
  assert.equal((await call(retiredReconnect, "reconnectRoom", { reconnectToken: nextHost.reconnectToken })).code, "SEAT_RETIRED");
});

test("closing a tab is not resignation and a saved active match resumes on another day", async (t) => {
  const h = await harness(t);
  const { host, created, seats } = await table(h);
  assert.equal((await call(host, "startGame", { requestId: requestId(), clientSeq: 1 })).ok, true);
  const observer = [...seats.values()].find((seat) => seat.playerId !== created.playerId).socket;
  const before = (await h.read(created.roomCode));
  host.close();
  const offline = await waitFor(observer, (state) => !state.players.find((player) => player.id === created.playerId).connected);
  assert.equal(offline.activePlayerCount, 3);
  assert.equal(offline.departedPlayers.length, 0);
  h.advance(2 * DAY);
  await h.restart();
  const resumed = await h.connect();
  const reply = await call(resumed, "reconnectRoom", { reconnectToken: created.reconnectToken });
  assert.equal(reply.ok, true);
  assert.equal(reply.savedAt, h.now);
  assert.equal(reply.expiresAt, h.now + 90 * DAY);
  assert.equal(resumed.latest.activePlayerCount, 3);
  assert.equal(resumed.latest.players.filter((player) => player.connected).length, 1);
  const after = (await h.read(created.roomCode));
  for (const key of ["board", "developmentDeck", "phase", "turnIndex", "bank", "clientSequences", "requests"]) {
    assert.deepEqual(after[key], before[key], key);
  }
});

test("default 90-day retention and injected clock preserve old v2 saves but expire genuinely inactive rooms", async (t) => {
  const tokens = {};
  const h = await harness(t, { seed(dataDir, now) {
    for (const [code, days] of [["ABCDEF", 89], ["BCDEFG", 91], ["CDEFGH", 90]]) {
      const room = fixture(code, now - days * DAY);
      tokens[code] = room.players[0].reconnectToken;
      writeFixture(dataDir, room);
    }
  } });
  assert.equal(fs.existsSync(path.join(h.dataDir, "BCDEFG.json")), true);
  assert.equal((await h.read("BCDEFG")).archivedAt, h.now);
  assert.equal(fs.existsSync(path.join(h.dataDir, "CDEFGH.json")), true);
  const host = await h.connect();
  const resumed = await call(host, "reconnectRoom", { reconnectToken: tokens.ABCDEF });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.savedAt, h.now);
  assert.equal(resumed.expiresAt, h.now + 90 * DAY);
  const outsider = await h.connect();
  assert.equal((await call(outsider, "reconnectRoom", { reconnectToken: tokens.BCDEFG })).code, "ROOM_NOT_FOUND");
  h.advance(90 * DAY + 1);
  assert.equal((await call(outsider, "reconnectRoom", { reconnectToken: tokens.ABCDEF })).code, "ROOM_NOT_FOUND");
  assert.equal((await call(host, "shuffleMap", {
    requestId: requestId(), clientSeq: 1, expectedMapVersion: host.latest.mapVersion,
  })).code, "ROOM_NOT_FOUND");
  await h.restart();
  assert.equal(fs.existsSync(path.join(h.dataDir, "ABCDEF.json")), true, "Legacy backups must never be deleted");
  assert.equal((await h.read("ABCDEF")).archivedAt, h.now, "Shutdown must not resurrect an expired room");
});

test("retention settings are bounded and options can override the environment", async (t) => {
  for (const retentionDays of [0, -1, 3651, "invalid", 1.5, ""]) {
    assert.throws(() => createGameServer({ retentionDays }), /between 1 and 3650/);
  }
  const previous = process.env.ROOM_RETENTION_DAYS;
  process.env.ROOM_RETENTION_DAYS = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.ROOM_RETENTION_DAYS;
    else process.env.ROOM_RETENTION_DAYS = previous;
  });
  const h = await harness(t, { retentionDays: 2 });
  const host = await h.connect();
  const created = await call(host, "createRoom", { name: "Host" });
  assert.equal(created.expiresAt, h.now + 2 * DAY);
  const environmental = await harness(t);
  const other = await environmental.connect();
  assert.equal((await call(other, "createRoom", { name: "Other" })).expiresAt, environmental.now + DAY);
});

test("static staging is server-controlled and vendor JavaScript remains read-only", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-static-"));
  const staged = path.join(root, "staged");
  const explicit = path.join(root, "explicit");
  fs.mkdirSync(staged);
  fs.mkdirSync(explicit);
  fs.writeFileSync(path.join(staged, "index.html"), "staged-ui");
  fs.writeFileSync(path.join(explicit, "index.html"), "explicit-ui");
  const previous = process.env.HEARTHLANDS_PUBLIC_DIR;
  process.env.HEARTHLANDS_PUBLIC_DIR = staged;
  t.after(() => {
    if (previous === undefined) delete process.env.HEARTHLANDS_PUBLIC_DIR;
    else process.env.HEARTHLANDS_PUBLIC_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const fromEnvironment = await harness(t);
  assert.equal(await (await fetch(`http://127.0.0.1:${fromEnvironment.port}/`)).text(), "staged-ui");
  const h = await harness(t, { publicDir: explicit });
  const base = `http://127.0.0.1:${h.port}`;
  assert.equal(await (await fetch(`${base}/?publicDir=${encodeURIComponent(staged)}`)).text(), "explicit-ui");
  const vendor = await fetch(`${base}/vendor/panzoom.min.js`);
  assert.equal(vendor.status, 200);
  assert.equal(vendor.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await fetch(`${base}/vendor/panzoom.min.js`, { method: "POST", body: "overwrite" })).status, 404);
  assert.equal((await fetch(`${base}/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
});

test("graceful shutdown remains bounded with an incomplete HTTP connection and is safe to call twice", async (t) => {
  const h = await harness(t);
  const connection = net.createConnection({ host: "127.0.0.1", port: h.port });
  t.after(() => connection.destroy());
  await new Promise((resolve, reject) => {
    connection.once("connect", resolve);
    connection.once("error", reject);
  });
  connection.write("GET / HTTP/1.1\r\nHost: localhost\r\n");
  const began = performance.now();
  await Promise.all([h.service.close(), h.service.close()]);
  assert.ok(performance.now() - began < 4000, "Transport drain must not wait indefinitely");
  assert.equal(h.service.server.listening, false);
});
