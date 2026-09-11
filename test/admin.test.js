"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { io } = require("socket.io-client");
const { createGameServer } = require("../server");
const { createStorage, StorageError } = require("../storage");

const id = () => crypto.randomUUID();
const key = () => crypto.randomBytes(32).toString("hex");

function call(socket, event, payload = {}) {
  return new Promise((resolve, reject) => socket.timeout(5000).emit(event, payload,
    (error, result) => error ? reject(error) : resolve(result)));
}

function waitFor(socket, predicate) {
  if (socket.latest && predicate(socket.latest)) return Promise.resolve(socket.latest);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("state", inspect);
      reject(new Error("Authoritative state timed out"));
    }, 5000);
    function inspect(state) {
      if (!predicate(state)) return;
      clearTimeout(timer);
      socket.off("state", inspect);
      resolve(state);
    }
    socket.on("state", inspect);
  });
}

function mutation(socket, event, body = {}) {
  return call(socket, event, { ...body, requestId: id(), clientSeq: socket.latest.nextSequence });
}

async function harness(t, count = 3, storageOptions = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-admin-"));
  const clients = [];
  let clock = Date.UTC(2026, 8, 11);
  let service;
  let port;
  async function start() {
    service = createGameServer({ ...storageOptions, dataDir, now: () => clock, random: () => 0.37 });
    port = await service.listen();
  }
  await start();
  async function connect() {
    const socket = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false });
    clients.push(socket);
    socket.states = [];
    socket.on("state", (state) => { socket.latest = state; socket.states.push(state); });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    return socket;
  }
  const host = await connect();
  const created = await call(host, "createRoom", { name: "Host", requestId: id(), resumeKey: key() });
  assert.equal(created.ok, true);
  const seats = new Map([[created.playerId, { ...created, socket: host }]]);
  for (let index = 1; index < count; index++) {
    const socket = await connect();
    const joined = await call(socket, "joinRoom", {
      name: `Guest ${index}`, code: created.roomCode, requestId: id(), resumeKey: key(),
    });
    assert.equal(joined.ok, true);
    seats.set(joined.playerId, { ...joined, socket });
  }
  t.after(async () => {
    clients.forEach((client) => client.close());
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    host, created, seats, connect, dataDir,
    get service() { return service; },
    advance() { clock += 1001; },
    read() { return service.storage.getRoom(created.roomCode); },
    events() { return service.storage.listEvents(created.roomCode, { limit: 1000 }); },
    async restart() {
      await service.close();
      clients.forEach((client) => client.close());
      await start();
    },
  };
}

test("an offline administrator remains the sole administrator across disconnect, requests, reconnect and restart", async (t) => {
  const h = await harness(t);
  const guest = [...h.seats.values()].find((seat) => seat.playerId !== h.created.playerId);
  h.host.close();
  const offline = await waitFor(guest.socket, (state) => !state.players.find((player) => player.id === h.created.playerId).connected);
  assert.equal(offline.hostId, h.created.playerId);
  assert.equal(offline.adminId, h.created.playerId);
  assert.equal(offline.legal.canResign, false);
  assert.equal(offline.legal.canRequestRemoval, true);
  assert.equal(offline.legal.canTransferAdmin, false);
  assert.equal((await mutation(guest.socket, "transferAdmin", { playerId: guest.playerId })).code, "ADMIN_REQUIRED");
  assert.equal((await mutation(guest.socket, "removePlayer", { playerId: guest.playerId, confirmed: true })).code, "ADMIN_REQUIRED");
  assert.equal((await mutation(guest.socket, "resignGame", { confirmed: true })).code, "ADMIN_APPROVAL_REQUIRED");
  assert.deepEqual(guest.socket.latest.removalRequests, [], "An unauthorized resignation must not silently request removal");
  assert.equal((await mutation(guest.socket, "requestRemoval")).ok, true);
  assert.equal(guest.socket.latest.removalRequests[0].playerId, guest.playerId);
  assert.equal(guest.socket.latest.players.length, 3);
  await h.restart();
  const returningGuest = await h.connect();
  await call(returningGuest, "reconnectRoom", { reconnectToken: guest.reconnectToken });
  assert.equal(returningGuest.latest.adminId, h.created.playerId);
  const admin = await h.connect();
  const bound = await call(admin, "reconnectRoom", { reconnectToken: h.created.reconnectToken });
  assert.equal(bound.adminId, h.created.playerId);
  assert.equal(admin.latest.removalRequests[0].playerId, guest.playerId);
});

test("departure requests are idempotent, cancellable and declinable; the player keeps playing until admin approval", async (t) => {
  const h = await harness(t);
  assert.equal((await mutation(h.host, "startGame")).ok, true);
  const actor = h.seats.get(h.host.latest.currentPlayerId);
  assert.notEqual(actor.playerId, h.created.playerId, "The deterministic setup actor is a nonadministrator");
  await waitFor(actor.socket, (state) => state.phase === "setup");
  const request = { requestId: id(), clientSeq: actor.socket.latest.nextSequence };
  assert.equal((await call(actor.socket, "requestRemoval", request)).ok, true);
  const firstEvents = (await h.events()).length;
  assert.equal((await call(actor.socket, "requestRemoval", request)).ok, true);
  assert.equal((await h.events()).length, firstEvents);
  assert.equal((await mutation(actor.socket, "requestRemoval")).ok, true);
  assert.equal((await h.events()).length, firstEvents, "A fresh repeated request adds no duplicate queue entry or event");
  assert.equal(actor.socket.latest.removalRequests.length, 1);
  assert.equal((await mutation(actor.socket, "gameAction", {
    type: "setupSettlement", vertexId: actor.socket.latest.legal.settlementVertices[0],
    expectedTurnNumber: actor.socket.latest.turnNumber,
  })).ok, true);
  assert.equal(actor.socket.latest.board.vertices.filter((vertex) => vertex.structure?.playerId === actor.playerId).length, 1);
  assert.equal((await mutation(h.host, "declineRemoval", { playerId: actor.playerId })).ok, true);
  await waitFor(actor.socket, (state) => state.removalRequests.length === 0);
  assert.equal((await mutation(actor.socket, "requestRemoval")).ok, true);
  assert.equal((await mutation(actor.socket, "cancelRemovalRequest")).ok, true);
  assert.equal(actor.socket.latest.removalRequests.length, 0);
  assert.equal((await mutation(actor.socket, "requestRemoval")).ok, true);
  const retired = new Promise((resolve) => actor.socket.once("seatRetired", resolve));
  const approve = {
    playerId: actor.playerId, confirmed: true, requestId: id(), clientSeq: h.host.latest.nextSequence,
  };
  const approval = await call(h.host, "removePlayer", approve);
  assert.equal(approval.ok, true);
  assert.equal((await retired).requestId, approve.requestId);
  assert.equal(h.host.latest.activePlayerCount, 2);
  assert.equal(h.host.latest.removalRequests.length, 0);
  assert.equal(h.host.latest.board.vertices.some((vertex) => vertex.structure?.playerId === actor.playerId), false);
  assert.deepEqual(await call(h.host, "removePlayer", approve), approval);
  assert.equal((await mutation(actor.socket, "gameAction", { type: "roll" })).code, "SEAT_RETIRED");
  const activity = await call(actor.socket, "getActivity", { limit: 100 });
  assert.equal(activity.ok, true, "Retired authenticated connections may read only public activity");
  for (const type of ["removal.requested", "removal.declined", "removal.cancelled", "playerResigned"]) {
    assert.ok(activity.events.some((event) => event.type === type), type);
  }
  const approved = activity.events.find((event) => event.type === "player.removed" &&
    event.actorId === h.created.playerId && event.data.playerId === actor.playerId);
  assert.equal(approved.data.reason, "requestApproved");
  assert.match(approved.message, /^Host approved /);
});

test("admin departure requires literal confirmation and an explicit active successor, including an offline successor", async (t) => {
  const h = await harness(t);
  assert.equal((await mutation(h.host, "startGame")).ok, true);
  const others = [...h.seats.values()].filter((seat) => seat.playerId !== h.created.playerId);
  const before = await h.read();
  assert.equal((await mutation(h.host, "resignGame", { confirmed: "true", successorId: others[0].playerId })).code, "REJECTED");
  for (const successorId of [undefined, h.created.playerId, "not-a-member"]) {
    assert.equal((await mutation(h.host, "resignGame", { confirmed: true, successorId })).code, "SUCCESSOR_REQUIRED");
  }
  const rejected = await h.read();
  for (const field of ["players", "board", "bank", "hostId", "phase", "eventSequence"]) assert.deepEqual(rejected[field], before[field], field);
  others[0].socket.close();
  await waitFor(h.host, (state) => !state.players.find((player) => player.id === others[0].playerId).connected);
  const payload = {
    confirmed: true, successorId: others[0].playerId, requestId: id(), clientSeq: h.host.latest.nextSequence,
  };
  const departed = await call(h.host, "resignGame", payload);
  assert.equal(departed.ok, true);
  const survivor = await waitFor(others[1].socket, (state) => state.activePlayerCount === 2);
  assert.equal(survivor.adminId, others[0].playerId);
  assert.equal(survivor.players.find((player) => player.id === others[0].playerId).connected, false);
  assert.deepEqual(await call(h.host, "resignGame", payload), departed);
  assert.equal((await call(others[1].socket, "transferAdmin", {
    playerId: others[1].playerId, requestId: id(), clientSeq: others[1].socket.latest.nextSequence,
  })).code, "ADMIN_REQUIRED");
  const nextAdmin = await h.connect();
  await call(nextAdmin, "reconnectRoom", { reconnectToken: others[0].reconnectToken });
  assert.equal(nextAdmin.latest.adminId, others[0].playerId);
  assert.equal((await mutation(nextAdmin, "removePlayer", { playerId: others[1].playerId, confirmed: true })).ok, true);
  assert.equal(nextAdmin.latest.phase, "finished");
  assert.equal(nextAdmin.latest.winReason, "last-player");
  assert.equal(nextAdmin.latest.winnerId, others[0].playerId);
});

test("racing transfers and removals use fresh administrator authority and preserve exact replay outcomes", async (t) => {
  const h = await harness(t);
  const others = [...h.seats.values()].filter((seat) => seat.playerId !== h.created.playerId);
  const transfer = { playerId: others[0].playerId, requestId: id(), clientSeq: 1 };
  const removal = { playerId: others[1].playerId, confirmed: true, requestId: id(), clientSeq: 2 };
  const [transferred, forbidden] = await Promise.all([
    call(h.host, "transferAdmin", transfer), call(h.host, "removePlayer", removal),
  ]);
  assert.equal(transferred.ok, true);
  assert.equal(forbidden.code, "ADMIN_REQUIRED");
  assert.equal(h.host.latest.adminId, others[0].playerId);
  assert.equal(h.host.latest.players.length, 3);
  assert.deepEqual(await call(h.host, "transferAdmin", transfer), { ...transferred, nextSequence: 3 });
  assert.equal((await mutation(others[0].socket, "removePlayer", { playerId: others[1].playerId, confirmed: true })).ok, true);
  assert.equal((await h.read()).hostId, others[0].playerId);
  assert.equal((await h.events()).filter((event) => event.type === "admin.transferred").length, 1);
  const removed = (await h.events()).find((event) => event.type === "player.removed");
  assert.equal(removed.actorId, others[0].playerId);
  assert.equal(removed.data.playerId, others[1].playerId);
  assert.equal(removed.data.reason, "adminRemoval");
  assert.equal(removed.message, "Guest 1 removed Guest 2 from the lobby.");
});

test("SQL failure rolls back approved departure, receipt, sequence, history and socket capability", async (t) => {
  const h = await harness(t);
  await mutation(h.host, "startGame");
  const guest = [...h.seats.values()].find((seat) => seat.playerId !== h.created.playerId);
  await mutation(guest.socket, "requestRemoval");
  const before = await h.read();
  const history = await h.events();
  const savedCommit = h.service.storage.commitRoom;
  h.service.storage.commitRoom = async () => { throw new StorageError("STORAGE_FAILURE", "Injected transaction failure."); };
  let retired = false;
  guest.socket.on("seatRetired", () => { retired = true; });
  const payload = { confirmed: true, playerId: guest.playerId, requestId: id(), clientSeq: h.host.latest.nextSequence };
  try {
    const failed = await call(h.host, "removePlayer", payload);
    assert.equal(failed.code, "SAVE_FAILED");
    assert.equal(failed.retryable, true);
    assert.equal(failed.nextSequence, payload.clientSeq);
    assert.deepEqual(await h.read(), before);
    assert.deepEqual(await h.events(), history);
    assert.equal(retired, false);
    assert.equal((await call(guest.socket, "mapPointer", { mapVersion: guest.socket.latest.mapVersion, x: 0.2, y: 0.4 })).ok, true);
  } finally {
    h.service.storage.commitRoom = savedCommit;
  }
  assert.equal((await call(h.host, "removePlayer", payload)).ok, true);
  await waitFor(h.host, (state) => state.activePlayerCount === 2);
  assert.equal((await h.read()).requests.filter((receipt) => receipt.id === payload.requestId).length, 1);
});

test("an unknown committed SQL outcome is reconciled from storage before retry and retires the target safely", async (t) => {
  const h = await harness(t);
  await mutation(h.host, "startGame");
  const guest = [...h.seats.values()].find((seat) => seat.playerId !== h.created.playerId);
  const realCommit = h.service.storage.commitRoom.bind(h.service.storage);
  let ambiguous = true;
  h.service.storage.commitRoom = async (...args) => {
    const result = await realCommit(...args);
    if (ambiguous) {
      ambiguous = false;
      throw new StorageError("STORAGE_FAILURE", "The commit acknowledgement was lost.");
    }
    return result;
  };
  const payload = { playerId: guest.playerId, confirmed: true, requestId: id(), clientSeq: h.host.latest.nextSequence };
  const retirement = new Promise((resolve) => guest.socket.once("seatRetired", resolve));
  const unknown = await call(h.host, "removePlayer", payload);
  assert.equal(unknown.code, "SAVE_FAILED");
  assert.equal((await retirement).requestId, payload.requestId);
  assert.equal(h.host.latest.ownReceipt.requestId, payload.requestId);
  assert.equal(h.host.latest.ownReceipt.ok, true);
  assert.equal((await call(guest.socket, "mapPointer", { mapVersion: guest.socket.latest.mapVersion, x: 0.1, y: 0.1 })).code, "SEAT_RETIRED");
  const snapshot = await h.read();
  assert.equal((await call(h.host, "removePlayer", payload)).ok, true);
  assert.deepEqual(await h.read(), snapshot);
  assert.equal((await h.events()).filter((event) => event.type === "playerResigned" && event.actorId === guest.playerId).length, 1);
});

test("unknown entry commit outcomes recover the original seat without reserving a second room", async (t) => {
  const h = await harness(t, 1);
  const socket = await h.connect();
  const realCommit = h.service.storage.commitRoom.bind(h.service.storage);
  let ambiguous = true;
  h.service.storage.commitRoom = async (...args) => {
    const result = await realCommit(...args);
    if (ambiguous) {
      ambiguous = false;
      throw new StorageError("STORAGE_FAILURE", "The entry commit acknowledgement was lost.");
    }
    return result;
  };
  const payload = { name: "Another host", requestId: id(), resumeKey: key() };
  assert.equal((await call(socket, "createRoom", payload)).code, "SAVE_FAILED");
  const recovered = await call(socket, "createRoom", payload);
  assert.equal(recovered.ok, true);
  const rooms = await h.service.storage.listRooms();
  assert.equal(rooms.length, 2);
  assert.equal(rooms.flatMap((room) => room.players).filter((player) => player.reconnectToken === payload.resumeKey).length, 1);
});

test("unconfirmed database reads quarantine presence and actions until a fresh snapshot can be loaded", async (t) => {
  const h = await harness(t, 1);
  const realRead = h.service.storage.getRoom;
  h.service.storage.getRoom = async () => { throw new StorageError("STORAGE_FAILURE", "Injected read failure."); };
  const payload = { requestId: id(), clientSeq: 1, expectedMapVersion: h.host.latest.mapVersion };
  try {
    assert.equal((await call(h.host, "shuffleMap", payload)).code, "SAVE_FAILED");
    assert.equal((await call(h.host, "mapPointer", { mapVersion: h.host.latest.mapVersion, x: 0.2, y: 0.2 })).code, "SESSION_REQUIRED");
  } finally {
    h.service.storage.getRoom = realRead;
  }
  assert.equal((await call(h.host, "shuffleMap", payload)).ok, true);
  assert.equal(h.host.latest.nextSequence, 2);
  assert.equal((await h.events()).filter((event) => event.type === "mapShuffled").length, 1);
});

test("a failed listen releases the database coordinator without disturbing an already running isolated server", async (t) => {
  const h = await harness(t, 1);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-bind-failure-"));
  const blocked = createGameServer({ dataDir });
  const replacement = createGameServer({ dataDir });
  t.after(async () => {
    await blocked.close();
    await replacement.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await assert.rejects(blocked.listen(h.service.server.address().port), { code: "EADDRINUSE" });
  await replacement.listen();
  assert.equal((await replacement.storage.health()).ok, true);
  assert.equal((await call(h.host, "reconnectRoom", { reconnectToken: h.created.reconnectToken })).ok, true);
});

test("a queued mutation cannot move to a new seat while its authoritative room read is delayed", async (t) => {
  const h = await harness(t, 2);
  const successor = [...h.seats.values()].find((seat) => seat.playerId !== h.created.playerId);
  assert.equal((await mutation(h.host, "removePlayer", {
    playerId: h.created.playerId, successorId: successor.playerId, confirmed: true,
  })).ok, true);
  const originalRead = h.service.storage.getRoom;
  let enteredRead;
  let releaseRead;
  let delay = true;
  const entered = new Promise((resolve) => { enteredRead = resolve; });
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  h.service.storage.getRoom = async (code) => {
    if (code === h.created.roomCode && delay) {
      delay = false;
      enteredRead();
      await gate;
    }
    return originalRead.call(h.service.storage, code);
  };
  const stale = call(h.host, "shuffleMap", { requestId: id(), clientSeq: 1, expectedMapVersion: 1 });
  await entered;
  let created;
  try {
    created = await call(h.host, "createRoom", { name: "New seat", requestId: id(), resumeKey: key() });
    assert.equal(created.ok, true);
  } finally {
    releaseRead();
    h.service.storage.getRoom = originalRead;
  }
  assert.equal((await stale).code, "SESSION_REQUIRED");
  const saved = await h.service.storage.getRoom(created.roomCode);
  assert.equal(saved.mapVersion, 1);
  assert.equal(saved.clientSequences, undefined);
  assert.equal((await h.service.storage.listEvents(created.roomCode)).some((event) => event.type === "mapShuffled"), false);
});

test("duplicate in-flight operations serialize without duplicate receipts or events, and close drains pending SQL writes", async (t) => {
  const h = await harness(t, 1);
  const realCommit = h.service.storage.commitRoom.bind(h.service.storage);
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  h.service.storage.commitRoom = async (...args) => { enter(); await gate; return realCommit(...args); };
  const payload = { requestId: id(), clientSeq: 1, expectedMapVersion: h.host.latest.mapVersion };
  const first = call(h.host, "shuffleMap", payload);
  const second = call(h.host, "shuffleMap", payload);
  await entered;
  release();
  assert.deepEqual(await first, await second);
  assert.equal((await h.events()).filter((event) => event.type === "mapShuffled").length, 1);

  let enteredClose;
  let releaseClose;
  const beforeClose = new Promise((resolve) => { enteredClose = resolve; });
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  h.service.storage.commitRoom = async (...args) => { enteredClose(); await closeGate; return realCommit(...args); };
  const closingRequest = { requestId: id(), clientSeq: 2, expectedMapVersion: h.host.latest.mapVersion };
  h.host.emit("shuffleMap", closingRequest);
  await beforeClose;
  const closing = h.service.close();
  releaseClose();
  await closing;
  await h.restart();
  const snapshot = await h.read();
  assert.equal(snapshot.requests.find((receipt) => receipt.id === closingRequest.requestId).result.ok, true);
  assert.equal(snapshot.clientSequences[h.created.playerId], 2);
  assert.equal((await h.events()).filter((event) => event.type === "mapShuffled").length, 2);
});

test("public activity pagination spans more than the recent 80, stays room-scoped and never exposes receipt or credential data", async (t) => {
  const h = await harness(t, 2);
  const guest = [...h.seats.values()].find((seat) => seat.playerId !== h.created.playerId);
  for (let index = 0; index < 95; index++) {
    if (index % 10 === 0) h.advance();
    const from = index % 2 === 0 ? h.host : guest.socket;
    const to = index % 2 === 0 ? guest.playerId : h.created.playerId;
    assert.equal((await mutation(from, "transferAdmin", { playerId: to })).ok, true);
  }
  h.advance();
  assert.equal(h.host.latest.log.length, 80);
  const ownBefore = h.host.latest.nextSequence;
  const foreign = await h.connect();
  const otherRoom = await call(foreign, "createRoom", { name: "Other room" });
  const first = await call(h.host, "getActivity", { limit: 25, roomCode: otherRoom.roomCode, code: otherRoom.roomCode });
  assert.equal(first.ok, true);
  assert.equal(first.events.length, 25);
  assert.equal(first.hasMore, true);
  assert.equal(first.latestSeq, h.host.latest.eventSequence);
  assert.equal(first.nextBeforeSeq, first.events[0].seq);
  const seen = [...first.events];
  let page = first;
  while (page.hasMore) {
    page = await call(h.host, "getActivity", { beforeSeq: page.nextBeforeSeq, limit: 25 });
    seen.push(...page.events);
  }
  assert.equal(new Set(seen.map((event) => event.seq)).size, first.latestSeq);
  assert.equal(seen.some((event) => event.message.includes("Other room")), false);
  assert.equal(h.host.latest.nextSequence, ownBefore);
  const increment = await call(h.host, "getActivity", { afterSeq: first.latestSeq - 2, limit: 100 });
  assert.deepEqual(increment.events.map((event) => event.seq), [first.latestSeq - 1, first.latestSeq]);
  const serialized = JSON.stringify({ events: seen, state: h.host.latest });
  for (const secret of [h.created.reconnectToken, guest.reconnectToken, "payloadHash", "eventOutbox", "retirementRequestId", "clientSequences"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.equal((await call(await h.connect(), "getActivity", { roomCode: h.created.roomCode })).code, "SESSION_REQUIRED");
  for (const payload of [{ limit: 0 }, { limit: 101 }, { beforeSeq: -1 }, { afterSeq: 1.5 }, { beforeSeq: 2, afterSeq: 0 }]) {
    assert.equal((await call(h.host, "getActivity", payload)).code, "REJECTED");
  }
});

test("same-bound reconnects and cursor movement do not append activity; rematch appends exactly one real event", async (t) => {
  const h = await harness(t);
  const initialEvents = await h.events();
  assert.equal(initialEvents.filter((event) => event.type === "playerJoined").length, 3);
  for (let index = 0; index < 3; index++) {
    assert.equal((await call(h.host, "reconnectRoom", { reconnectToken: h.created.reconnectToken })).ok, true);
    assert.equal((await call(h.host, "mapPointer", { mapVersion: h.host.latest.mapVersion, x: 0.3, y: 0.2 })).ok, true);
  }
  assert.deepEqual(await h.events(), initialEvents);
  await mutation(h.host, "startGame");
  for (const guest of [...h.seats.values()].filter((seat) => seat.playerId !== h.created.playerId)) {
    assert.equal((await mutation(h.host, "removePlayer", { playerId: guest.playerId, confirmed: true })).ok, true);
  }
  assert.equal(h.host.latest.phase, "finished");
  const before = await h.events();
  const sequence = h.host.latest.eventSequence;
  const payload = { requestId: id(), clientSeq: h.host.latest.nextSequence };
  const rematch = await call(h.host, "rematch", payload);
  assert.equal(rematch.ok, true);
  const after = await h.events();
  assert.equal(after.length, before.length + 1);
  assert.equal(after[0].type, "game.rematched");
  assert.equal(after[0].seq, sequence + 1);
  assert.equal(after.filter((event) => event.type === "playerJoined").length, 3);
  assert.equal((await call(h.host, "rematch", payload)).ok, true);
  assert.deepEqual(await h.events(), after);
});

test("administration can transfer after victory without changing game results or player holdings", async (t) => {
  const h = await harness(t);
  await mutation(h.host, "startGame");
  const fixture = await h.read();
  Object.assign(fixture, { phase: "finished", winnerId: h.created.playerId, winReason: "points", revision: fixture.revision + 1 });
  await h.service.storage.commitRoom(fixture, { expectedRevision: fixture.revision - 1 });
  const guest = [...h.seats.values()].find((seat) => seat.playerId !== h.created.playerId);
  assert.equal((await mutation(h.host, "transferAdmin", { playerId: guest.playerId })).ok, true);
  const saved = await h.read();
  assert.equal(saved.hostId, guest.playerId);
  assert.equal(saved.phase, "finished");
  assert.equal(saved.winnerId, fixture.winnerId);
  assert.deepEqual(saved.players, fixture.players);
});

test("real PostgreSQL server recovers ambiguous commits and preserves admin, retirement, rematch and history across restart", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  let url;
  try { url = new URL(process.env.TEST_DATABASE_URL); } catch { throw new Error("The isolated PostgreSQL test URL is invalid."); }
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Only loopback PostgreSQL tests are allowed");
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "hearthlands_test", "Only the isolated test database is allowed");
  const h = await harness(t, 3, {
    databaseUrl: process.env.TEST_DATABASE_URL, databaseSsl: "disable",
    databaseSchema: `hearthlands_server_test_${crypto.randomBytes(8).toString("hex")}`,
  });
  assert.equal((await h.service.storage.health()).backend, "postgresql");
  const interruptedClient = h.service.storage.adapter.client;
  const query = interruptedClient.query.bind(interruptedClient);
  let ambiguous = true;
  interruptedClient.query = async (sql, parameters) => {
    const result = await query(sql, parameters);
    if (ambiguous && sql === "COMMIT") {
      ambiguous = false;
      await interruptedClient.end();
      const error = new Error("Injected lost PostgreSQL commit acknowledgement.");
      error.code = "ECONNRESET";
      throw error;
    }
    return result;
  };
  const shuffle = { requestId: id(), clientSeq: 1, expectedMapVersion: h.host.latest.mapVersion };
  assert.equal((await call(h.host, "shuffleMap", shuffle)).code, "SAVE_FAILED");
  assert.equal(h.host.latest.ownReceipt.ok, true);
  assert.ok(h.service.storage.adapter.client !== interruptedClient);
  assert.equal((await call(h.host, "shuffleMap", shuffle)).ok, true);
  assert.equal((await h.events()).filter((event) => event.type === "mapShuffled").length, 1);
  assert.equal((await mutation(h.host, "startGame")).ok, true);
  const guests = [...h.seats.values()].filter((seat) => seat.playerId !== h.created.playerId);
  assert.equal((await mutation(guests[0].socket, "requestRemoval")).ok, true);
  assert.equal((await mutation(h.host, "removePlayer", { playerId: guests[0].playerId, confirmed: true })).ok, true);
  assert.equal((await mutation(h.host, "resignGame", { confirmed: true, successorId: guests[1].playerId })).ok, true);
  const won = await waitFor(guests[1].socket, (state) => state.phase === "finished");
  assert.equal(won.adminId, guests[1].playerId);
  assert.equal(won.winReason, "last-player");
  const rematch = { requestId: id(), clientSeq: won.nextSequence };
  assert.equal((await call(guests[1].socket, "rematch", rematch)).ok, true);
  await h.restart();
  const resumed = await h.connect();
  const bound = await call(resumed, "reconnectRoom", { reconnectToken: guests[1].reconnectToken });
  assert.equal(bound.adminId, guests[1].playerId);
  assert.equal(bound.nextSequence, rematch.clientSeq + 1);
  assert.equal(resumed.latest.players.length, 1);
  assert.equal((await call(resumed, "rematch", rematch)).ok, true);
  const retired = await h.connect();
  assert.equal((await call(retired, "reconnectRoom", { reconnectToken: h.created.reconnectToken })).code, "SEAT_RETIRED");
  const activity = await call(resumed, "getActivity", { limit: 100 });
  assert.equal(activity.events.filter((event) => event.type === "mapShuffled").length, 1);
  assert.equal(activity.events.filter((event) => event.type === "game.rematched").length, 1);
  assert.equal(activity.events.filter((event) => event.type === "playerJoined").length, 3);
  assert.equal(JSON.stringify(activity).includes(h.created.reconnectToken), false);
});

test("PostgreSQL server health and requests recover automatically only after the competing coordinator releases its lease", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  let url;
  try { url = new URL(process.env.TEST_DATABASE_URL); } catch { throw new Error("The isolated PostgreSQL test URL is invalid."); }
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Only loopback PostgreSQL tests are allowed");
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "hearthlands_test", "Only the isolated test database is allowed");
  const h = await harness(t, 1, {
    databaseUrl: process.env.TEST_DATABASE_URL, databaseSsl: "disable",
    databaseSchema: `hearthlands_recovery_test_${crypto.randomBytes(8).toString("hex")}`,
  });
  const healthUrl = `http://127.0.0.1:${h.service.server.address().port}/health`;
  await h.service.storage.adapter.client.end();
  const owner = createStorage(h.service.storage.options);
  await owner.init();
  const request = { requestId: id(), clientSeq: 1, expectedMapVersion: h.host.latest.mapVersion };
  try {
    const unhealthy = await fetch(healthUrl);
    assert.equal(unhealthy.status, 503);
    assert.deepEqual(await unhealthy.json(), { ok: false });
    const blocked = await call(h.host, "shuffleMap", request);
    assert.equal(blocked.code, "SAVE_FAILED");
    assert.equal(blocked.retryable, true);
    const current = await owner.getRoom(h.created.roomCode);
    assert.equal(current.clientSequences, undefined);
    current.players[0].name = "Current writer";
    current.revision++;
    current.updatedAt++;
    await owner.commitRoom(current, { expectedRevision: current.revision - 1 });
  } finally {
    await owner.close();
  }
  const healthy = await fetch(healthUrl);
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { ok: true });
  const bound = await call(h.host, "reconnectRoom", { reconnectToken: h.created.reconnectToken });
  assert.equal(bound.ok, true);
  assert.equal(h.host.latest.players[0].name, "Current writer");
  assert.equal(bound.nextSequence, 1);
  assert.equal((await call(h.host, "shuffleMap", request)).ok, true);
  assert.equal((await h.events()).filter((event) => event.type === "mapShuffled").length, 1);
});
