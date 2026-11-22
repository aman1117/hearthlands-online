"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { io } = require("socket.io-client");
const {
  RESOURCES, createRoom, addPlayer, startGame, applyAction, publicState, resignPlayer, setTurnTimer, expireTurnTimer,
} = require("../game");
const { createGameServer } = require("../server");
const { createStorage } = require("../storage");

const T0 = 1_800_000_000_000;
const seq = (...values) => { let index = 0; return () => values[index++ % values.length]; };
const current = (room) => room.players[room.turnIndex];
function lobby(count = 3) {
  const { room, player } = createRoom("Rowan");
  for (let index = 1; index < count; index++) addPlayer(room, `Seat ${index + 1}`);
  return { room, host: player };
}
function conserve(room) {
  for (const resource of RESOURCES) {
    assert.equal(room.bank[resource] + room.players.reduce((sum, p) => sum + p.resources[resource], 0), room.players.length > 4 ? 24 : 19);
  }
}
// Finishes setup by letting every placement time out, which also exercises the automatic setup moves.
function timedSetup(room, now) {
  let clock = now;
  while (room.phase === "setup") {
    clock = room.timer.deadline;
    assert.equal(expireTurnTimer(room, clock, () => .37), true);
  }
  return clock;
}
function give(room, player, bundle) {
  for (const [resource, amount] of Object.entries(bundle)) { room.bank[resource] -= amount; player.resources[resource] += amount; }
}

test("timers are off by default, including saves made before timers existed", () => {
  const { room, host } = lobby();
  assert.deepEqual(room.turnTimer, { preset: "off" });
  startGame(room, host.id, () => .5, T0);
  assert.equal(room.timer, null);
  assert.deepEqual(publicState(room, host.id).turnTimer, { preset: "off", durations: null, timer: null });
  delete room.turnTimer;
  delete room.timer;
  const id = current(room).id;
  applyAction(room, id, { type: "setupSettlement", vertexId: publicState(room, id).legal.settlementVertices[0] }, Math.random, T0);
  assert.equal(room.timer, null);
  assert.equal(expireTurnTimer(room, T0 + 10 ** 9), false);
});

test("only the administrator can choose a valid timer, and changes are logged and restart the countdown", () => {
  const { room, host } = lobby();
  const guest = room.players[1];
  assert.throws(() => setTurnTimer(room, guest.id, { preset: "60" }, T0), /administrator/);
  for (const bad of [null, {}, { preset: "15" }, { preset: 60 }, { preset: "custom" },
    { preset: "custom", durations: { setupSettlement: 60, setupRoad: 15, roll: 10, discard: 15, robber: 10, turn: 9, bonus: 5 } },
    { preset: "custom", durations: { setupSettlement: 60, setupRoad: 15, roll: "10", discard: 15, robber: 10, turn: 30, bonus: 5 } },
    { preset: "custom", durations: { setupSettlement: 60, setupRoad: 15, roll: 10, discard: 15, robber: 10, turn: 30 } }]) {
    assert.throws(() => setTurnTimer(room, host.id, bad, T0));
  }
  setTurnTimer(room, host.id, { preset: "60" }, T0);
  assert.throws(() => setTurnTimer(room, host.id, { preset: "60" }, T0), /already/);
  assert.equal(room.timer, null, "the lobby has no countdown");
  assert.match(room.log.at(-1).message, /60s \(fast\): 60s per turn, 10s to roll, 20s for the robber/);
  assert.deepEqual(room.log.at(-1).data, { preset: "60", durations: { setupSettlement: 120, setupRoad: 30, roll: 10, discard: 20, robber: 20, turn: 60, bonus: 10 } });
  startGame(room, host.id, () => .5, T0);
  assert.deepEqual([room.timer.kind, room.timer.deadline], ["setupSettlement", T0 + 120_000]);
  const custom = { setupSettlement: 40, setupRoad: 12, roll: 7, discard: 9, robber: 8, turn: 45, bonus: 0 };
  setTurnTimer(room, host.id, { preset: "custom", durations: custom }, T0 + 5000);
  assert.equal(room.timer.deadline, T0 + 45_000);
  assert.deepEqual(publicState(room, guest.id).turnTimer.durations, custom);
  setTurnTimer(room, host.id, { preset: "off" }, T0 + 6000);
  assert.equal(room.timer, null);
  assert.equal(room.log.at(-1).message, "The administrator turned the turn timer off.");
  room.phase = "finished";
  assert.throws(() => setTurnTimer(room, host.id, { preset: "30" }, T0), /over/);
});

test("each move has its own countdown and an expired move is made automatically", () => {
  const { room, host } = lobby();
  setTurnTimer(room, host.id, { preset: "60" }, T0);
  startGame(room, host.id, () => .5, T0);
  const first = current(room);
  assert.equal(expireTurnTimer(room, T0 + 119_999, () => .37), false, "nothing happens before the deadline");
  assert.equal(expireTurnTimer(room, T0 + 120_000, () => .37), true);
  assert.equal(room.board.vertices.filter((vertex) => vertex.structure?.playerId === first.id).length, 1);
  assert.match(room.log.find((event) => event.type === "turnTimedOut").message, /^Rowan|ran out of time; a starting settlement was placed for them\./);
  assert.deepEqual([room.timer.kind, room.timer.deadline], ["setupRoad", T0 + 150_000]);
  const clock = timedSetup(room, T0 + 120_000);
  assert.equal(room.phase, "roll");
  assert.ok(room.players.every((player) => player.settlementsLeft === 3 && player.roadsLeft === 13));
  assert.deepEqual([room.timer.kind, room.timer.deadline], ["roll", clock + 10_000]);
  const roller = current(room);
  expireTurnTimer(room, clock + 10_000, seq(.0, .5));
  assert.equal(room.log.findLast((event) => event.type === "diceRolled").actorId, roller.id);
  assert.equal(room.phase, "action");
  assert.deepEqual([room.timer.kind, room.timer.deadline], ["action", clock + 70_000]);
  expireTurnTimer(room, clock + 70_000, Math.random);
  assert.notEqual(current(room).id, roller.id);
  assert.equal(room.phase, "roll");
  assert.match(room.log.findLast((event) => event.type === "turnTimedOut").message, /their turn ended/);
  conserve(room);
});

test("a timed-out seven discards at random, then moves the robber and picks a victim", () => {
  const { room, host } = lobby();
  setTurnTimer(room, host.id, { preset: "30" }, T0);
  startGame(room, host.id, () => .5, T0);
  let clock = timedSetup(room, T0);
  const [, second, third] = room.players;
  for (const player of room.players) give(room, player, { wood: 2, brick: 2, sheep: 2, wheat: 2, ore: 1 });
  expireTurnTimer(room, clock += 10_000, seq(0, .99));
  assert.equal(room.phase, "discard");
  assert.deepEqual(room.timer.playerIds.sort(), room.players.map((player) => player.id).sort());
  const holding = (player) => RESOURCES.reduce((sum, r) => sum + player.resources[r], 0);
  const before = room.players.map(holding);
  applyAction(room, second.id, { type: "discard", resources: { wood: 2, brick: 2, sheep: 1 } }, Math.random, clock + 1000);
  assert.equal(room.timer.deadline, clock + 15_000, "one player's discard does not restart the others' countdown");
  expireTurnTimer(room, clock += 15_000, () => .42);
  assert.deepEqual(room.players.map(holding), before.map((count) => count - Math.floor(count / 2)));
  assert.match(room.log.findLast((event) => event.type === "turnTimedOut").message, /and .* ran out of time; cards were discarded at random/);
  assert.equal(room.phase, "robber");
  expireTurnTimer(room, clock += 10_000, () => .3);
  assert.ok(["steal", "action"].includes(room.phase));
  if (room.phase === "steal") expireTurnTimer(room, clock += 10_000, () => .3);
  assert.equal(room.phase, "action");
  assert.ok(third);
  conserve(room);
});

test("building earns capped bonus time, undo returns it, and a Knight keeps the turn's remaining time", () => {
  const { room, host } = lobby();
  setTurnTimer(room, host.id, { preset: "60" }, T0);
  startGame(room, host.id, () => .5, T0);
  let clock = timedSetup(room, T0);
  expireTurnTimer(room, clock += 10_000, seq(0, .5));
  const player = current(room);
  assert.equal(room.timer.deadline, clock + 60_000);
  give(room, player, { wood: 2, brick: 2 });
  const edge = () => publicState(room, player.id).legal.roadEdges[0];
  applyAction(room, player.id, { type: "buildRoad", edgeId: edge() }, Math.random, clock + 5000);
  assert.equal(room.timer.deadline, clock + 65_000, "capped at a full turn from now");
  applyAction(room, player.id, { type: "buildRoad", edgeId: edge() }, Math.random, clock + 30_000);
  assert.equal(room.timer.deadline, clock + 75_000);
  applyAction(room, player.id, { type: "undoPlacement", placementId: publicState(room, player.id).undoPlacement.id }, Math.random, clock + 31_000);
  assert.equal(room.timer.deadline, clock + 65_000);
  const deck = room.developmentDeck;
  const knight = deck.splice(deck.findIndex((card) => card.type === "knight"), 1)[0];
  player.developmentCards.push({ ...knight, boughtTurn: 0 });
  applyAction(room, player.id, { type: "playDevelopment", cardId: knight.id }, Math.random, clock + 45_000);
  assert.deepEqual([room.timer.kind, room.timer.deadline], ["robber", clock + 65_000]);
  const tile = publicState(room, player.id).legal.robberTiles.find((id) => {
    const target = room.board.tiles.find((candidate) => candidate.id === id);
    return !target.vertices.some((vertexId) => room.board.vertices.find((v) => v.id === vertexId).structure);
  });
  applyAction(room, player.id, { type: "moveRobber", tileId: tile }, Math.random, clock + 50_000);
  assert.equal(room.phase, "action");
  assert.equal(room.timer.deadline, clock + 50_000 + 20_000 + 10_000, "20s left before the Knight plus the 10s bonus");
  conserve(room);
});

test("a resigning active player hands a fresh countdown to the next player", () => {
  const { room, host } = lobby(4);
  setTurnTimer(room, host.id, { preset: "120" }, T0);
  startGame(room, host.id, () => .5, T0);
  let clock = timedSetup(room, T0);
  const leaving = current(room);
  resignPlayer(room, leaving.id, () => .5, clock += 3000);
  assert.notEqual(current(room).id, leaving.id);
  assert.deepEqual([room.timer.kind, room.timer.deadline, room.timer.playerIds], ["roll", clock + 20_000, [current(room).id]]);
});

async function harness(t, { grace = 0, late = 0 } = {}) {
  let clock = T0;
  const { room, host } = lobby();
  setTurnTimer(room, host.id, { preset: "60" }, clock);
  startGame(room, host.id, () => .5, clock);
  room.code = "TIMERS"; room.revision = 1; room.updatedAt = clock;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-timer-"));
  const seed = createStorage({ dataDir });
  await seed.init(); await seed.commitRoom(room); await seed.close();
  clock += late;
  const options = { dataDir, now: () => clock, random: () => .37, timerGraceMs: grace, timerSweepMs: 60_000 };
  let service = createGameServer(options);
  let port = await service.listen(0);
  const clients = [];
  const call = (client, event, data) => new Promise((resolve, reject) =>
    client.timeout(5000).emit(event, data, (error, response) => error ? reject(error) : resolve(response)));
  async function connect(index) {
    const client = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false });
    clients.push(client);
    client.on("state", (state) => { client.latest = state; });
    await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("connect_error", reject); });
    assert.equal((await call(client, "reconnectRoom", { reconnectToken: room.players[index].reconnectToken })).ok, true);
    return client;
  }
  t.after(async () => { clients.forEach((client) => client.close()); await service.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return {
    room, call, connect, read: () => service.storage.getRoom(room.code), sweep: () => service.sweepTimers(),
    advance(ms) { clock += ms; }, get now() { return clock; },
    async settle() { await new Promise((resolve) => setTimeout(resolve, 150)); await service.sweepTimers(); await new Promise((resolve) => setTimeout(resolve, 150)); },
    async restart() { clients.forEach((client) => client.close()); await service.close(); service = createGameServer(options); port = await service.listen(0); },
  };
}

test("the server applies expired timers, pauses empty tables, and gives grace after restarts", async (t) => {
  const h = await harness(t, { grace: 20_000, late: 150_000 });
  const hostIndex = h.room.players.findIndex((player) => player.id === h.room.hostId);
  const client = await h.connect(hostIndex);
  const guest = await h.connect(hostIndex === 0 ? 1 : 0);
  const packet = (data) => ({ ...data, requestId: crypto.randomUUID() });
  assert.equal((await h.call(guest, "setTurnTimer", packet({ settings: { preset: "30" } }))).ok, false);
  assert.ok(Number.isSafeInteger(client.latest.serverTime));
  assert.equal(client.latest.turnTimer.timer.kind, "setupSettlement");
  assert.equal(client.latest.turnTimer.timer.deadline, h.now + 20_000, "the startup grace hides a deadline that already passed");
  h.advance(25_000);
  await h.settle();
  const placed = await h.read();
  assert.equal(placed.timer.kind, "setupRoad", "the overdue settlement was placed once the grace ended");
  assert.equal(placed.log.filter((event) => event.type === "turnTimedOut").length, 1);
  await h.settle();
  assert.equal((await h.read()).revision, placed.revision, "a fresh countdown is not expired early");
  client.close(); guest.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  h.advance(10 * 60_000);
  await h.settle();
  assert.equal((await h.read()).timer.kind, "setupRoad", "nobody is connected, so the table is paused");
  const back = await h.connect(0);
  assert.equal(back.latest.turnTimer.timer.deadline, h.now + 20_000, "a returning player gets the grace period");
  h.advance(20_000);
  await h.settle();
  assert.equal((await h.read()).log.filter((event) => event.type === "turnTimedOut").length, 2);
  assert.equal((await h.call(back, "setTurnTimer", packet({ settings: { preset: "off" } }))).ok, back.latest.adminId === back.latest.viewerId);
});
