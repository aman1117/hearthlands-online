"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { io } = require("socket.io-client");
const { createGameServer } = require("../server");
const { StorageError } = require("../storage");

function call(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (error, reply) => error ? reject(error) : resolve(reply));
  });
}

function waitFor(socket, predicate) {
  if (socket.latest && predicate(socket.latest)) return Promise.resolve(socket.latest);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("state", inspect); reject(new Error("State update timed out")); }, 5000);
    function inspect(state) {
      if (!predicate(state)) return;
      clearTimeout(timer);
      socket.off("state", inspect);
      resolve(state);
    }
    socket.on("state", inspect);
  });
}

async function harness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-server-test-"));
  const service = createGameServer({ dataDir });
  const port = await service.listen();
  const clients = [];
  async function connect() {
    const client = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false });
    clients.push(client);
    client.on("state", (state) => { client.latest = state; });
    await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("connect_error", reject); });
    return client;
  }
  t.after(async () => {
    clients.forEach((client) => client.close());
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { service, port, dataDir, connect, clients };
}

test("six browser clients can create, join, start and receive only their own hand", async (t) => {
  const h = await harness(t);
  const host = await h.connect();
  const created = await call(host, "createRoom", { name: "Host" });
  assert.equal(created.ok, true);
  for (let i = 1; i < 6; i++) {
    const client = await h.connect();
    assert.equal((await call(client, "joinRoom", { name: `Player ${i}`, code: created.roomCode })).ok, true);
  }
  const seventh = await h.connect();
  assert.equal((await call(seventh, "joinRoom", { name: "Extra", code: created.roomCode })).ok, false);
  assert.equal((await call(h.clients[1], "startGame")).ok, false);
  assert.equal((await call(host, "startGame")).ok, true);
  const state = await waitFor(host, (value) => value.phase === "setup");
  assert.equal(state.players.length, 6);
  assert.equal(state.board.tiles.length, 30);
  assert.ok(state.players.find((player) => player.id === created.playerId).resources);
  assert.equal(state.players.filter((player) => player.resources).length, 1);
  assert.equal(JSON.stringify(state).includes("reconnectToken"), false);
  assert.equal(JSON.stringify(state).includes("developmentDeck"), false);
});

test("malformed events and repeated seating do not crash or mutate a room", async (t) => {
  const h = await harness(t);
  const client = await h.connect();
  for (const value of [null, [], "invalid", 42]) {
    assert.equal((await call(client, "createRoom", value)).ok, false);
  }
  assert.equal((await call(client, "createRoom", { name: { malicious: true } })).ok, false);
  const created = await call(client, "createRoom", { name: "Solo" });
  assert.equal(created.ok, true);
  assert.equal((await call(client, "createRoom", { name: "Again" })).ok, false);
  const health = await fetch(`http://127.0.0.1:${h.port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await call(client, "gameAction", { type: "roll" })).ok, false);
  const privateFile = await fetch(`http://127.0.0.1:${h.port}/data/${created.roomCode}.json`);
  assert.equal(privateFile.status, 404);
});

test("reconnect transfers ownership and old socket cannot disconnect new seat", async (t) => {
  const h = await harness(t);
  const first = await h.connect();
  const created = await call(first, "createRoom", { name: "Original" });
  const second = await h.connect();
  const replaced = new Promise((resolve) => first.once("sessionReplaced", resolve));
  assert.equal((await call(second, "reconnectRoom", { reconnectToken: created.reconnectToken, code: created.roomCode })).ok, true);
  await replaced;
  assert.equal(second.latest.players[0].connected, true);
  assert.equal((await call(second, "createRoom", { name: "Duplicate" })).ok, false);
});

test("host removes an absent lobby seat and its resume key is revoked", async (t) => {
  const h = await harness(t);
  const host = await h.connect();
  const created = await call(host, "createRoom", { name: "Host" });
  const guest = await h.connect();
  const joined = await call(guest, "joinRoom", { code: created.roomCode, name: "Guest" });
  assert.equal((await call(host, "removePlayer", { playerId: joined.playerId, confirmed: true })).ok, true);
  const replacement = await h.connect();
  assert.equal((await call(replacement, "reconnectRoom", { reconnectToken: joined.reconnectToken })).ok, false);
  assert.equal((await call(replacement, "joinRoom", { code: created.roomCode, name: "New guest" })).ok, true);
});

test("failed durable write does not publish or commit a partial join", async (t) => {
  const h = await harness(t);
  const host = await h.connect();
  const created = await call(host, "createRoom", { name: "Host" });
  const commit = h.service.storage.commitRoom;
  h.service.storage.commitRoom = async () => { throw new StorageError("STORAGE_FAILURE", "Injected database failure."); };
  const guest = await h.connect();
  try {
    const reply = await call(guest, "joinRoom", { code: created.roomCode, name: "Guest" });
    assert.equal(reply.ok, false);
    assert.equal(reply.code, "SAVE_FAILED");
    assert.equal(reply.retryable, true);
    assert.equal(host.latest.players.length, 1);
  } finally {
    h.service.storage.commitRoom = commit;
  }
  assert.equal((await call(guest, "joinRoom", { code: created.roomCode, name: "Guest" })).ok, true);
  await waitFor(host, (state) => state.players.length === 2);
});

test("foreign browser origins cannot open game sockets", async (t) => {
  const h = await harness(t);
  const client = io(`http://127.0.0.1:${h.port}`, {
    transports: ["websocket"], reconnection: false,
    extraHeaders: { Origin: "https://untrusted.example" },
  });
  t.after(() => client.close());
  await new Promise((resolve, reject) => {
    client.once("connect_error", resolve);
    client.once("connect", () => reject(new Error("Foreign origin unexpectedly accepted")));
  });
});

test("committed game survives service restart and duplicate request IDs apply once", async (t) => {
  const h = await harness(t);
  const host = await h.connect();
  const created = await call(host, "createRoom", { name: "Host" });
  const seats = new Map([[created.playerId, host]]);
  for (let i = 1; i < 4; i++) {
    const client = await h.connect();
    const joined = await call(client, "joinRoom", { code: created.roomCode, name: `Guest ${i}` });
    seats.set(joined.playerId, client);
  }
  await call(host, "startGame");
  const started = await waitFor(host, (state) => state.phase === "setup");
  const actor = seats.get(started.currentPlayerId);
  const own = await waitFor(actor, (state) => state.phase === "setup");
  const action = { type: "setupSettlement", vertexId: own.legal.settlementVertices[0], requestId: crypto.randomUUID() };
  assert.equal((await call(actor, "gameAction", action)).ok, true);
  assert.equal((await call(actor, "gameAction", action)).ok, true);
  await waitFor(actor, (state) => state.setupNeedsRoad);
  assert.equal(actor.latest.board.vertices.filter((vertex) => vertex.structure).length, 1);
  await h.service.close();
  const restored = createGameServer({ dataDir: h.dataDir });
  const port = await restored.listen();
  const resumed = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false });
  try {
    resumed.on("state", (state) => { resumed.latest = state; });
    await new Promise((resolve) => resumed.once("connect", resolve));
    assert.equal((await call(resumed, "reconnectRoom", { reconnectToken: created.reconnectToken, code: created.roomCode })).ok, true);
    const state = await waitFor(resumed, (value) => value.setupNeedsRoad);
    assert.equal(state.board.vertices.filter((vertex) => vertex.structure).length, 1);
  } finally {
    resumed.close();
    await restored.close();
  }
});
