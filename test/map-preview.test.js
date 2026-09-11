"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { io } = require("socket.io-client");
const { createGameServer } = require("../server");
const { StorageError } = require("../storage");
const { createRoom, addPlayer, ensureMapPreview, makeBoard, publicState, shuffleMap, startGame } = require("../game");

function rng(seed = 12345) {
  return () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function lobby(count = 4) {
  const { room, player } = createRoom("Host");
  for (let i = 1; i < count; i += 1) addPlayer(room, `Player ${i}`);
  return { room, host: player };
}

function validBoard(board, expanded = false) {
  assert.equal(board.tiles.length, expanded ? 30 : 19);
  assert.equal(board.vertices.length, expanded ? 80 : 54);
  assert.equal(board.edges.length, expanded ? 109 : 72);
  assert.equal(board.vertices.length - board.edges.length + board.tiles.length, 1);
  assert.equal(board.ports.length, expanded ? 11 : 9);
  assert.ok(board.vertices.every((v) => v.structure === null));
  assert.ok(board.edges.every((e) => e.road === null));
  assert.equal(board.tiles.filter((tile) => tile.robber).length, 1);
  for (const edge of board.edges) {
    assert.ok(edge.adjacentTiles.filter((tileId) => {
      const number = board.tiles.find((tile) => tile.id === tileId).number;
      return number === 6 || number === 8;
    }).length < 2);
  }
}

function call(client, event, payload = {}) {
  return new Promise((resolve, reject) => {
    client.timeout(5000).emit(event, payload, (error, reply) => error ? reject(error) : resolve(reply));
  });
}

async function harness(t, initialRooms = []) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-map-preview-"));
  for (const room of initialRooms) {
    fs.writeFileSync(path.join(dataDir, `${room.code}.json`), JSON.stringify({ version: 2, room }));
  }
  let service = createGameServer({ dataDir, random: rng() });
  let port = await service.listen(0);
  const clients = [];
  async function connect() {
    const client = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false });
    clients.push(client);
    client.states = [];
    client.presence = [];
    client.on("state", (state) => { client.latest = state; client.states.push(state); });
    client.on("mapPresence", (event) => client.presence.push(event));
    await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("connect_error", reject); });
    return client;
  }
  t.after(async () => {
    clients.forEach((client) => client.close());
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir, connect,
    get service() { return service; },
    get url() { return `http://127.0.0.1:${port}`; },
    read(code) { return service.storage.getRoom(code); },
    async restart() {
      await service.close();
      clients.forEach((client) => client.close());
      service = createGameServer({ dataDir, random: rng(99) });
      port = await service.listen(0);
    },
  };
}

test("Panzoom vendor route serves only the installed bundle with same-origin security headers", async (t) => {
  const h = await harness(t);
  const response = await fetch(`${h.url}/vendor/panzoom.min.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await response.text(), fs.readFileSync(require.resolve("@panzoom/panzoom/dist/panzoom.min.js"), "utf8"));
  for (const endpoint of ["/vendor/package.json", "/vendor/panzoom.js", "/node_modules/@panzoom/panzoom/package.json"]) {
    assert.equal((await fetch(`${h.url}${endpoint}`)).status, 404);
  }
});

test("preview creation is explicit, stable within board size, and expands/contracts at four/five seats", () => {
  const { room, host } = lobby(1);
  assert.equal(room.board, null);
  assert.equal(ensureMapPreview(room, rng()), true);
  validBoard(room.board);
  const base = structuredClone(room.board);
  assert.equal(room.mapVersion, 1);
  assert.equal(publicState(room, host.id).boardPlayerCount, 4);
  for (let i = 1; i < 4; i += 1) {
    addPlayer(room, `Player ${i}`);
    assert.equal(ensureMapPreview(room, () => { throw new Error("Must not draw new map randomness"); }), false);
    assert.deepEqual(room.board, base);
    assert.equal(room.mapVersion, 1);
  }
  addPlayer(room, "Player 4");
  assert.equal(ensureMapPreview(room, rng(2)), true);
  validBoard(room.board, true);
  assert.equal(room.mapVersion, 2);
  assert.equal(publicState(room, host.id).boardPlayerCount, 6);
  const expanded = structuredClone(room.board);
  addPlayer(room, "Player 5");
  assert.equal(ensureMapPreview(room), false);
  room.players.pop();
  assert.equal(ensureMapPreview(room), false);
  assert.deepEqual(room.board, expanded);
  room.players.pop();
  assert.equal(ensureMapPreview(room, rng(3)), true);
  validBoard(room.board);
  assert.equal(room.mapVersion, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(room)), room);
});

test("preview helpers do not change any started/finished room or retrofit old started saves", () => {
  const { room, host } = lobby();
  startGame(room, host.id, rng());
  delete room.mapVersion;
  for (const phase of ["setup", "roll", "action", "discard", "robber", "steal", "finished"]) {
    room.phase = phase;
    const before = structuredClone(room);
    assert.equal(ensureMapPreview(room, () => { throw new Error("Must not regenerate"); }), false);
    assert.throws(() => shuffleMap(room, host.id, 0), /lobby host/);
    assert.deepEqual(room, before);
    assert.equal(publicState(room, host.id).mapVersion, 0);
    assert.equal(publicState(room, host.id).legal.canShuffleMap, false);
  }
});

for (const count of [4, 5, 6]) {
  test(`${count}-player start preserves every preview tile, junction, edge, number and port`, () => {
    const { room, host } = lobby(count);
    ensureMapPreview(room, rng(55));
    const preview = structuredClone(room.board);
    const mapVersion = room.mapVersion;
    let draws = 0;
    const random = rng(17);
    startGame(room, host.id, () => { draws += 1; return random(); });
    assert.deepEqual(room.board, preview);
    assert.equal(room.mapVersion, mapVersion + 1);
    assert.equal(draws, count - 1 + (count > 4 ? 33 : 24), "Only seats and development deck shuffle at start");
    assert.equal(room.bank.wood, count > 4 ? 24 : 19);
    assert.equal(room.phase, "setup");
  });

  test(`${count}-player direct engine start without preview retains legacy randomness ordering`, () => {
    const { room, host } = lobby(count);
    const expectedRandom = rng(123);
    for (let i = count - 1; i > 0; i -= 1) expectedRandom();
    const expectedBoard = makeBoard(expectedRandom, count);
    startGame(room, host.id, rng(123));
    assert.deepEqual(room.board, expectedBoard);
  });
}

test("host-only engine shuffle validates version before mutation and exposes lobby-only permission", () => {
  const { room, host } = lobby();
  ensureMapPreview(room, rng());
  assert.equal(publicState(room, host.id).legal.canShuffleMap, true);
  assert.equal(publicState(room, room.players[1].id).legal.canShuffleMap, false);
  assert.equal(publicState(room, "spectator").legal.canShuffleMap, false);
  for (const [actor, version] of [[room.players[1].id, 1], ["outsider", 1], [host.id, 0],
    [host.id, "1"], [host.id, null], [host.id, -1], [host.id, NaN]]) {
    const before = structuredClone(room);
    assert.throws(() => shuffleMap(room, actor, version, rng(4)));
    assert.deepEqual(room, before);
  }
  const beforeFailure = structuredClone(room);
  assert.throws(() => shuffleMap(room, host.id, 1, () => NaN));
  assert.deepEqual(room, beforeFailure);
  const first = structuredClone(room.board);
  shuffleMap(room, host.id, 1, rng(567));
  assert.equal(room.mapVersion, 2);
  assert.notDeepEqual(room.board, first);
  validBoard(room.board);
  assert.match(room.log.at(-1).message, /Host shuffled the map/);
});

test("server persists preview on create/join/remove and clears presence only at layout transitions", async (t) => {
  const h = await harness(t);
  const host = await h.connect();
  const created = await call(host, "createRoom", { name: "Host" });
  assert.equal(created.ok, true);
  validBoard(host.latest.board);
  assert.equal(host.latest.mapVersion, 1);
  const initial = structuredClone(host.latest.board);
  const joined = [];
  for (let i = 1; i < 6; i += 1) {
    const guest = await h.connect();
    const seat = await call(guest, "joinRoom", { name: `Guest ${i}`, code: created.roomCode });
    assert.equal(seat.ok, true);
    joined.push({ guest, seat });
    const saved = (await h.read(created.roomCode));
    assert.deepEqual(saved.eventOutbox, []);
    assert.equal(saved.mapVersion, i < 4 ? 1 : 2);
    if (i < 4) assert.deepEqual(saved.board, initial);
    assert.equal(guest.latest.legal.canShuffleMap, false);
  }
  assert.equal(host.presence.filter((event) => event.kind === "clear").length, 1);
  const expanded = (await h.read(created.roomCode)).board;
  assert.equal((await call(host, "removePlayer", { playerId: joined[4].seat.playerId, confirmed: true })).ok, true);
  assert.deepEqual((await h.read(created.roomCode)).board, expanded);
  assert.equal(host.presence.filter((event) => event.kind === "clear").length, 1);
  assert.equal((await call(host, "removePlayer", { playerId: joined[3].seat.playerId, confirmed: true })).ok, true);
  const saved = (await h.read(created.roomCode));
  validBoard(saved.board);
  assert.equal(saved.mapVersion, 3);
  assert.equal(host.presence.filter((event) => event.kind === "clear").length, 2);
  assert.equal(host.presence.filter((event) => event.kind === "clear").at(-1).mapVersion, 3);
});

test("shuffle persists request idempotence across reconnect/restart and rejects stale or unauthorized requests", async (t) => {
  const h = await harness(t);
  const host = await h.connect();
  const created = await call(host, "createRoom", { name: "Host" });
  const guest = await h.connect();
  await call(guest, "joinRoom", { name: "Guest", code: created.roomCode });
  const before = (await h.read(created.roomCode));
  const request = { requestId: crypto.randomUUID(), expectedMapVersion: 1 };
  assert.equal((await call(guest, "shuffleMap", request)).ok, false);
  assert.equal((await call(host, "shuffleMap", { expectedMapVersion: 1 })).ok, false);
  assert.deepEqual((await h.read(created.roomCode)), before);
  const response = await call(host, "shuffleMap", request);
  assert.deepEqual(response, {
    ok: true, mapVersion: 2, requestId: request.requestId,
    revision: before.revision + 1, nextSequence: 1,
  });
  const shuffled = (await h.read(created.roomCode));
  assert.equal(shuffled.requests.at(-1).event, "shuffleMap");
  assert.deepEqual(await call(host, "shuffleMap", request), response);
  assert.deepEqual((await h.read(created.roomCode)), shuffled);
  assert.equal((await call(host, "shuffleMap", { ...request, requestId: crypto.randomUUID() })).ok, false);
  assert.deepEqual((await h.read(created.roomCode)), shuffled);
  await h.restart();
  const resumed = await h.connect();
  const resumedReply = await call(resumed, "reconnectRoom", { code: created.roomCode, reconnectToken: created.reconnectToken });
  assert.equal(resumedReply.ok, true);
  assert.deepEqual(resumed.latest.board, shuffled.board);
  assert.equal(resumed.latest.mapVersion, 2);
  const afterResume = (await h.read(created.roomCode));
  assert.deepEqual(await call(resumed, "shuffleMap", request), response);
  assert.deepEqual((await h.read(created.roomCode)), afterResume);
  assert.equal(resumed.presence.some((event) => event.kind === "clear"), false);
});

test("serialized shuffle/start uses the committed preview and refuses delayed shuffle after setup", async (t) => {
  const h = await harness(t);
  const host = await h.connect();
  const created = await call(host, "createRoom", { name: "Host" });
  for (let i = 1; i < 4; i += 1) {
    await call(await h.connect(), "joinRoom", { name: `Guest ${i}`, code: created.roomCode });
  }
  const shuffle = call(host, "shuffleMap", { requestId: crypto.randomUUID(), expectedMapVersion: 1 });
  const start = call(host, "startGame");
  assert.equal((await shuffle).ok, true);
  assert.equal((await start).ok, true);
  const preview = host.states.find((state) => state.phase === "lobby" && state.mapVersion === 2);
  assert.ok(preview);
  assert.equal(host.latest.phase, "setup");
  assert.deepEqual(host.latest.board, preview.board);
  assert.equal(host.latest.mapVersion, 3);
  const before = (await h.read(created.roomCode));
  assert.equal((await call(host, "shuffleMap", { requestId: crypto.randomUUID(), expectedMapVersion: 3 })).ok, false);
  assert.deepEqual((await h.read(created.roomCode)), before);
  assert.equal(host.latest.legal.canShuffleMap, false);
  assert.deepEqual(host.presence.filter((event) => event.kind === "clear").map((event) => event.mapVersion), [2, 3]);
});

test("start followed by queued shuffle cannot wipe setup", async (t) => {
  const h = await harness(t);
  const host = await h.connect();
  const created = await call(host, "createRoom", { name: "Host" });
  const guests = [];
  for (let i = 1; i < 4; i += 1) {
    const guest = await h.connect();
    const seat = await call(guest, "joinRoom", { name: `Guest ${i}`, code: created.roomCode });
    guests.push({ guest, seat });
  }
  const start = call(host, "startGame");
  const shuffle = call(host, "shuffleMap", { requestId: crypto.randomUUID(), expectedMapVersion: 1 });
  assert.equal((await start).ok, true);
  assert.equal((await shuffle).ok, false);
  assert.equal((await h.read(created.roomCode)).phase, "setup");
  assert.equal((await h.read(created.roomCode)).mapVersion, 2);
});

test("two pending shuffles from the same displayed version generate only one new map", async (t) => {
  const h = await harness(t);
  const host = await h.connect();
  const created = await call(host, "createRoom", { name: "Host" });
  const firstRequest = { requestId: crypto.randomUUID(), expectedMapVersion: 1 };
  const first = call(host, "shuffleMap", firstRequest);
  const second = call(host, "shuffleMap", { requestId: crypto.randomUUID(), expectedMapVersion: 1 });
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, false);
  const saved = (await h.read(created.roomCode));
  assert.equal(saved.mapVersion, 2);
  assert.equal(saved.requests.length, 1);
  assert.equal(saved.revision, 2);
  assert.equal((await call(host, "shuffleMap", firstRequest)).ok, true);
  assert.deepEqual((await h.read(created.roomCode)), saved);
  assert.equal(host.presence.filter((event) => event.kind === "clear").length, 1);
});

test("a pending start with an absent seat fails without replacing or clearing the preview", async (t) => {
  const h = await harness(t);
  const host = await h.connect();
  const created = await call(host, "createRoom", { name: "Host" });
  let lastGuest;
  for (let i = 1; i < 4; i += 1) {
    lastGuest = await h.connect();
    await call(lastGuest, "joinRoom", { name: `Guest ${i}`, code: created.roomCode });
  }
  const disconnected = new Promise((resolve) => host.on("state", function inspect(state) {
    if (!state.players.some((player) => !player.connected)) return;
    host.off("state", inspect);
    resolve();
  }));
  lastGuest.close();
  await disconnected;
  const before = (await h.read(created.roomCode));
  const response = await call(host, "startGame");
  assert.equal(response.ok, false);
  assert.match(response.error, /reconnect/);
  assert.deepEqual((await h.read(created.roomCode)), before);
  assert.equal(host.presence.some((event) => event.kind === "clear"), false);
  assert.equal((await call(host, "shuffleMap", { requestId: crypto.randomUUID(), expectedMapVersion: 1 })).ok, true);
});

test("old lobby previews migrate only on resume; old started saves never regenerate", async (t) => {
  const { room: oldLobby, host: lobbyHost } = lobby(5);
  oldLobby.code = "ABCDEF";
  oldLobby.updatedAt = Date.now();
  delete oldLobby.mapVersion;
  const { room: started, host: startedHost } = lobby();
  startGame(started, startedHost.id, rng());
  started.code = "BCDEFG";
  started.updatedAt = Date.now();
  started.board.vertices[0].structure = { playerId: started.players[0].id, kind: "settlement" };
  delete started.mapVersion;
  const h = await harness(t, [oldLobby, started]);
  assert.equal((await h.read(oldLobby.code)).board, null, "Loading alone must not rewrite saves");
  const lobbyClient = await h.connect();
  assert.equal((await call(lobbyClient, "reconnectRoom", { code: oldLobby.code, reconnectToken: lobbyHost.reconnectToken })).ok, true);
  validBoard(lobbyClient.latest.board, true);
  assert.equal(lobbyClient.latest.mapVersion, 1);
  const startedClient = await h.connect();
  assert.equal((await call(startedClient, "reconnectRoom", { code: started.code, reconnectToken: startedHost.reconnectToken })).ok, true);
  assert.deepEqual(startedClient.latest.board, started.board);
  assert.equal(startedClient.latest.mapVersion, 0);
  assert.equal((await h.read(started.code)).mapVersion, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dataDir, `${started.code}.json`), "utf8")).version, 2);
});

test("rematch replaces preview at a higher version while preserving seats, colors, and bearer keys", async (t) => {
  const { room, host: hostPlayer } = lobby(6);
  ensureMapPreview(room, rng());
  startGame(room, hostPlayer.id, rng());
  room.phase = "finished";
  room.winnerId = room.players[0].id;
  room.code = "ABCDEF";
  room.updatedAt = Date.now();
  room.mapVersion = 9;
  const h = await harness(t, [room]);
  const host = await h.connect();
  await call(host, "reconnectRoom", { code: room.code, reconnectToken: hostPlayer.reconnectToken });
  assert.equal((await call(host, "rematch")).ok, true);
  assert.equal(host.latest.phase, "lobby");
  assert.equal(host.latest.mapVersion, 10);
  validBoard(host.latest.board, true);
  const saved = (await h.read(room.code));
  assert.deepEqual(saved.players.map((p) => [p.id, p.color, p.reconnectToken]),
    room.players.map((p) => [p.id, p.color, p.reconnectToken]));
  assert.equal(host.presence.at(-1).kind, "clear");
  assert.equal(host.presence.at(-1).mapVersion, 10);
});

test("failed shuffle storage does not change preview, version, request cache or ephemeral layout", async (t) => {
  const h = await harness(t);
  const host = await h.connect();
  const created = await call(host, "createRoom", { name: "Host" });
  const original = structuredClone(host.latest);
  const commit = h.service.storage.commitRoom;
  h.service.storage.commitRoom = async () => { throw new StorageError("STORAGE_FAILURE", "Injected database failure."); };
  const request = { requestId: crypto.randomUUID(), expectedMapVersion: 1 };
  try {
    const result = await call(host, "shuffleMap", request);
    assert.equal(result.ok, false);
    assert.equal(result.code, "SAVE_FAILED");
    assert.equal(result.retryable, true);
    assert.deepEqual(host.latest, original);
    assert.equal(host.presence.length, 0);
  } finally {
    h.service.storage.commitRoom = commit;
  }
  assert.equal((await call(host, "shuffleMap", request)).ok, true);
  assert.equal(host.latest.mapVersion, 2);
});
