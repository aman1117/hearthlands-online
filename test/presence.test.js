"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { io } = require("socket.io-client");
const { createGameServer } = require("../server");
const { createRoom, addPlayer, startGame } = require("../game");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function call(client, event, payload = {}) {
  return new Promise((resolve, reject) => {
    client.timeout(5000).emit(event, payload, (error, reply) => error ? reject(error) : resolve(reply));
  });
}

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Presence/state update timed out");
    await delay(5);
  }
}

async function harness(t, initialRoom) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-presence-"));
  if (initialRoom) {
    fs.writeFileSync(path.join(dataDir, `${initialRoom.code}.json`), JSON.stringify({ version: 2, room: initialRoom }));
  }
  const service = createGameServer({ dataDir });
  const clients = [];
  t.after(async () => {
    clients.forEach((client) => client.close());
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const port = await service.listen(0);
  async function connect() {
    const client = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false });
    clients.push(client);
    client.presence = [];
    client.states = [];
    client.errors = [];
    client.on("state", (state) => { client.latest = state; client.states.push(state); });
    client.on("mapPresence", (event) => client.presence.push(event));
    client.on("requestError", (error) => client.errors.push(error));
    await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("connect_error", reject); });
    return client;
  }
  return {
    service, dataDir, connect,
    async raw(code) { return JSON.stringify(await service.storage.getRoom(code)); },
    async modified(code) { return (await service.storage.getRoom(code)).revision; },
  };
}

async function seatedPair(h) {
  const host = await h.connect();
  const created = await call(host, "createRoom", { name: "Host" });
  const guest = await h.connect();
  const joined = await call(guest, "joinRoom", { name: "Guest", code: created.roomCode });
  assert.equal(created.ok, true);
  assert.equal(joined.ok, true);
  await until(() => host.latest?.players.length === 2);
  return { host, guest, created, joined };
}

test("authenticated map pointers and pings relay trusted identity only within current room without saving", async (t) => {
  const h = await harness(t);
  const { host, guest, created, joined } = await seatedPair(h);
  const otherRoom = await h.connect();
  const other = await call(otherRoom, "createRoom", { name: "Other room" });
  const spectator = await h.connect();
  const before = (await h.raw(created.roomCode));
  const mtime = (await h.modified(created.roomCode));
  const stateCount = host.states.length;
  const payload = { x: 0.25, y: 0.75, mapVersion: 1, playerId: created.playerId,
    name: "Spoof", color: "red", code: other.roomCode, roomCode: other.roomCode };
  assert.equal((await call(guest, "mapPointer", payload)).ok, true);
  await until(() => host.presence.length === 1);
  const event = host.presence[0];
  const real = guest.latest.players.find((p) => p.id === joined.playerId);
  assert.deepEqual({ ...event, at: 0 }, {
    kind: "pointer", playerId: joined.playerId, name: real.name, color: real.color,
    x: 0.25, y: 0.75, at: 0, mapVersion: 1,
  });
  assert.ok(Number.isSafeInteger(event.at) && Math.abs(Date.now() - event.at) < 5000);
  assert.equal(guest.presence[0].playerId, joined.playerId);
  assert.equal((await call(host, "mapPing", { x: 0, y: 1, mapVersion: 1 })).ok, true);
  await until(() => guest.presence.length === 2);
  assert.equal(host.presence.at(-1).kind, "ping");
  assert.equal(host.presence.at(-1).playerId, created.playerId);
  assert.equal(otherRoom.presence.length, 0);
  assert.equal(spectator.presence.length, 0);
  assert.equal((await call(spectator, "mapPointer", payload)).ok, false);
  assert.equal((await call(otherRoom, "mapPointer", { ...payload, code: created.roomCode })).ok, true);
  assert.equal(otherRoom.presence.at(-1).playerId, other.playerId);
  await delay(20);
  assert.equal(host.presence.length, 2);
  assert.equal(host.states.length, stateCount);
  assert.equal((await h.raw(created.roomCode)), before);
  assert.equal((await h.modified(created.roomCode)), mtime);
});

test("presence rejects malformed coordinates, visibility and versions privately without room mutation", async (t) => {
  const h = await harness(t);
  const { host, guest, created } = await seatedPair(h);
  const before = (await h.raw(created.roomCode));
  const valid = { x: 0.2, y: 0.3, mapVersion: 1 };
  for (const payload of [null, [], "pointer", {}, { ...valid, x: "0.2" },
    { ...valid, x: null }, { ...valid, x: NaN }, { ...valid, y: Infinity },
    { ...valid, x: -0.001 }, { ...valid, y: 1.001 }, { ...valid, mapVersion: 0 },
    { ...valid, mapVersion: "1" }, { ...valid, mapVersion: 1.5 },
    { ...valid, visible: "false" }, { visible: false, x: 0, mapVersion: 1 }]) {
    const reply = await call(guest, "mapPointer", payload);
    assert.equal(reply.ok, false);
    assert.equal(reply.throttled, undefined, "Malformed cases must reach validation");
  }
  assert.equal((await call(guest, "mapPing", { ...valid, y: -1 })).ok, false);
  assert.equal((await call(guest, "mapPing", { ...valid, mapVersion: -1 })).ok, false);
  assert.equal(host.presence.length, 0);
  assert.equal(guest.presence.length, 0);
  assert.equal(host.errors.length, 0);
  assert.equal(guest.errors.length, 0);
  assert.equal((await h.raw(created.roomCode)), before);
  guest.emit("mapPointer", { ...valid, x: -1 });
  guest.emit("mapPointer", { ...valid, y: 2 });
  await until(() => guest.errors.length === 1);
  await delay(20);
  assert.equal(guest.errors.length, 1);
  assert.equal(host.errors.length, 0);
});

test("visible false clears only the authenticated player's pointer and accepts omitted coordinates", async (t) => {
  const h = await harness(t);
  const { host, guest, created, joined } = await seatedPair(h);
  const before = (await h.raw(created.roomCode));
  await call(guest, "mapPointer", { x: 0.3, y: 0.4, mapVersion: 1 });
  assert.equal((await call(guest, "mapPointer", { visible: false, mapVersion: 1, playerId: created.playerId })).ok, true);
  await until(() => host.presence.length === 2);
  const leave = host.presence.at(-1);
  assert.equal(leave.kind, "leave");
  assert.equal(leave.playerId, joined.playerId);
  assert.equal(leave.x, undefined);
  assert.equal(leave.y, undefined);
  assert.equal((await h.raw(created.roomCode)), before);
});

test("pointer and ping rolling budgets are independent per socket and never consume action budget", async (t) => {
  const h = await harness(t);
  const { host, guest, created } = await seatedPair(h);
  const payload = { x: 0.5, y: 0.5, mapVersion: 1 };
  const results = [];
  const began = Date.now();
  for (let i = 0; i < 60; i += 1) results.push(await call(host, "mapPointer", payload));
  assert.ok(Date.now() - began < 1000, "Rate-limit burst must fit one rolling window");
  assert.equal(results.filter((r) => r.ok).length, 20);
  assert.equal(results.filter((r) => r.throttled).length, 40);
  assert.equal((await call(host, "mapPing", payload)).ok, true);
  assert.equal((await call(host, "mapPing", payload)).ok, true);
  assert.equal((await call(host, "mapPing", payload)).throttled, true);
  assert.equal((await call(guest, "mapPointer", payload)).ok, true);
  host.emit("mapPointer", payload);
  host.emit("mapPing", payload);
  assert.equal((await call(host, "shuffleMap", { requestId: crypto.randomUUID(), expectedMapVersion: 1 })).ok, true);
  assert.equal((await h.raw(created.roomCode)).includes("presenceRates"), false);
  assert.equal(host.errors.length, 0);
  assert.equal(guest.errors.length, 0);
  await delay(1050);
  assert.equal((await call(host, "mapPointer", { ...payload, mapVersion: 2 })).ok, true);
  assert.equal((await call(host, "mapPing", { ...payload, mapVersion: 2 })).ok, true);
});

test("shuffle clears all pointers at new version and rejects stale queued map events", async (t) => {
  const h = await harness(t);
  const { host, guest } = await seatedPair(h);
  await call(guest, "mapPointer", { x: 0.1, y: 0.2, mapVersion: 1 });
  await call(host, "shuffleMap", { requestId: crypto.randomUUID(), expectedMapVersion: 1 });
  await until(() => guest.presence.some((event) => event.kind === "clear"));
  const clear = guest.presence.find((event) => event.kind === "clear");
  assert.deepEqual({ ...clear, at: 0 }, { kind: "clear", at: 0, mapVersion: 2 });
  const count = host.presence.length;
  assert.equal((await call(guest, "mapPointer", { x: 0.3, y: 0.4, mapVersion: 1 })).ok, false);
  assert.equal((await call(guest, "mapPing", { x: 0.3, y: 0.4, mapVersion: 1 })).ok, false);
  assert.equal(host.presence.length, count);
  assert.equal((await call(guest, "mapPointer", { x: 0.3, y: 0.4, mapVersion: 2 })).ok, true);
});

test("disconnect, removal, and session takeover emit leave without stale disconnect clearing new pointer", async (t) => {
  const h = await harness(t);
  const { host, guest, created, joined } = await seatedPair(h);
  await call(guest, "mapPointer", { x: 0.1, y: 0.2, mapVersion: 1 });
  const replacement = await h.connect();
  assert.equal((await call(replacement, "reconnectRoom", {
    code: created.roomCode, reconnectToken: joined.reconnectToken,
  })).ok, true);
  await until(() => host.presence.some((event) => event.kind === "leave"));
  assert.equal(host.presence.filter((event) => event.kind === "leave").length, 1);
  assert.equal(host.presence.at(-1).playerId, joined.playerId);
  assert.equal(replacement.presence.some((event) => event.kind === "pointer"), false, "No cursor snapshot is replayed");
  const saved = (await h.raw(created.roomCode));
  await call(replacement, "mapPointer", { x: 0.6, y: 0.7, mapVersion: 1 });
  guest.close();
  await until(() => host.presence.at(-1).kind === "pointer");
  await delay(25);
  assert.equal(host.presence.filter((event) => event.kind === "leave").length, 1);
  assert.equal((await h.raw(created.roomCode)), saved);
  assert.equal((await call(host, "removePlayer", { playerId: joined.playerId, confirmed: true })).ok, true);
  assert.equal(host.presence.filter((event) => event.kind === "leave").length, 2);
  const newGuest = await h.connect();
  const newSeat = await call(newGuest, "joinRoom", { name: "New Guest", code: created.roomCode });
  await call(newGuest, "mapPointer", { x: 0.1, y: 0.9, mapVersion: 1 });
  newGuest.close();
  await until(() => host.presence.some((event) => event.kind === "leave" && event.playerId === newSeat.playerId));
  assert.equal(host.latest.players.find((p) => p.id === newSeat.playerId).connected, false);
});

for (const phase of ["setup", "roll", "action", "discard", "robber", "steal", "finished"]) {
  test(`seated non-active players can share map presence during ${phase} without changing saved game`, async (t) => {
    const { room, player: hostPlayer } = createRoom("Host");
    for (let i = 1; i < 4; i += 1) addPlayer(room, `Guest ${i}`);
    startGame(room, hostPlayer.id, () => 0.42);
    room.phase = phase;
    room.turnIndex = room.players.findIndex((p) => p.id !== hostPlayer.id);
    room.code = "ABCDEF";
    room.updatedAt = Date.now();
    if (phase === "finished") room.winnerId = room.players[room.turnIndex].id;
    const h = await harness(t, room);
    const client = await h.connect();
    await call(client, "reconnectRoom", { code: room.code, reconnectToken: hostPlayer.reconnectToken });
    assert.notEqual(client.latest.currentPlayerId, hostPlayer.id);
    const before = (await h.raw(room.code));
    const pointer = { x: 0.2, y: 0.4, mapVersion: client.latest.mapVersion };
    assert.equal((await call(client, "mapPointer", pointer)).ok, true);
    assert.equal((await call(client, "mapPing", pointer)).ok, true);
    assert.equal((await h.raw(room.code)), before);
    assert.equal(client.latest.phase, phase);
  });
}

test("old started saves accept map version zero without resetting game or using action budget", async (t) => {
  const { room, player: hostPlayer } = createRoom("Host");
  for (let i = 1; i < 4; i += 1) addPlayer(room, `Guest ${i}`);
  startGame(room, hostPlayer.id, () => 0.42);
  delete room.mapVersion;
  room.code = "ABCDEF";
  room.updatedAt = Date.now();
  const h = await harness(t, room);
  const client = await h.connect();
  await call(client, "reconnectRoom", { code: room.code, reconnectToken: hostPlayer.reconnectToken });
  assert.equal(client.latest.mapVersion, 0);
  const before = (await h.raw(room.code));
  assert.equal((await call(client, "mapPointer", { x: 0, y: 0, mapVersion: 0 })).ok, true);
  assert.equal((await h.raw(room.code)), before);
  const serverSocket = h.service.io.sockets.sockets.get(client.id);
  assert.equal(serverSocket.data.rate.count, 1, "Presence does not touch action throttling");
});

test("a corrupt finished save without a board is refused before sockets or map presence are enabled", async (t) => {
  const { room, player } = createRoom("Host");
  room.phase = "finished";
  room.winnerId = player.id;
  room.code = "ABCDEF";
  room.updatedAt = Date.now();
  await assert.rejects(harness(t, room), { code: "INVALID_SNAPSHOT" });
  assert.equal(room.board, null, "Invalid legacy saves must not receive a newly generated map");
});
