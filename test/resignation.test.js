"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  RESOURCES, COSTS, createRoom, addPlayer, startGame, applyAction, publicState,
  resignPlayer, activePlayers, ensureMapPreview, resourceTotal,
} = require("../game");

function rng(seed = 12345) {
  return () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
function roomFor(count = 6, phase = "action") {
  const { room, player: host } = createRoom("Host");
  for (let i = 1; i < count; i += 1) addPlayer(room, `Player ${i}`);
  startGame(room, host.id, rng());
  room.phase = phase;
  if (phase !== "setup") room.turnNumber = 7;
  return room;
}
const current = (room) => room.players[room.turnIndex];
const legal = (room, player = current(room)) => publicState(room, player.id).legal;
const act = (room, action, player = current(room), random = () => 0) => applyAction(room, player.id, action, random);
const retire = (room, player = current(room)) => resignPlayer(room, player.id, rng(99));
const vertex = (room, vertexId) => room.board.vertices.find((v) => v.id === vertexId);

function give(room, player, resources) {
  for (const [resource, amount] of Object.entries(resources)) {
    assert.ok(room.bank[resource] >= amount);
    player.resources[resource] += amount;
    room.bank[resource] -= amount;
  }
}
function giveCard(room, player, type, boughtTurn = 0) {
  const index = room.developmentDeck.findIndex((card) => card.type === type);
  assert.ok(index >= 0);
  const card = { ...room.developmentDeck.splice(index, 1)[0], boughtTurn };
  player.developmentCards.push(card);
  return card;
}
function structure(room, player, v, kind = "settlement") {
  v.structure = { playerId: player.id, kind };
  if (kind === "settlement") player.settlementsLeft -= 1;
  else player.citiesLeft -= 1;
}
function conserved(room) {
  const supply = room.players.length > 4 ? 24 : 19;
  for (const resource of RESOURCES) {
    assert.equal(room.bank[resource] + room.players.reduce((sum, player) => sum + player.resources[resource], 0), supply);
    assert.ok(room.bank[resource] >= 0);
  }
  for (const player of room.players) {
    const structures = room.board.vertices.filter((v) => v.structure?.playerId === player.id);
    assert.equal(player.settlementsLeft + structures.filter((v) => v.structure.kind === "settlement").length, 5);
    assert.equal(player.citiesLeft + structures.filter((v) => v.structure.kind === "city").length, 4);
    assert.equal(player.roadsLeft + room.board.edges.filter((edge) => edge.road?.playerId === player.id).length, 15);
  }
}
function rejectedResignation(room, actorId) {
  const before = structuredClone(room);
  assert.throws(() => resignPlayer(room, actorId, rng()));
  assert.deepEqual(room, before);
}
function rejectedAction(room, action, player) {
  const before = structuredClone(room);
  assert.throws(() => act(room, action, player));
  assert.deepEqual(room, before);
}
function nextSeat(count, anchor, retired, steps = 1) {
  let seat = anchor;
  for (let i = 0; i < steps; i += 1) {
    do { seat = (seat + 1) % count; } while (retired.includes(seat));
  }
  return seat;
}
function setupStep(room) {
  if (room.setupNeedsRoad) act(room, { type: "setupRoad", edgeId: legal(room).roadEdges[0] });
  else act(room, { type: "setupSettlement", vertexId: legal(room).settlementVertices[0] });
}
function completeSetup(room) {
  for (let guard = 0; room.phase === "setup" && guard < 48; guard += 1) setupStep(room);
  assert.equal(room.phase, "roll");
  for (const player of activePlayers(room)) {
    assert.equal(player.roadsLeft, 13);
    assert.equal(player.settlementsLeft, 3);
    assert.equal(player.points, 2);
  }
  conserved(room);
}
function reachSetup(room, round, index) {
  for (let guard = 0; !(room.setupRound === round && room.turnIndex === index) && guard < 48; guard += 1) {
    assert.equal(room.phase, "setup");
    setupStep(room);
  }
  assert.equal(room.phase, "setup");
  assert.equal(room.setupRound, round);
  assert.equal(room.turnIndex, index);
  assert.equal(room.setupNeedsRoad, false);
}
function island(room) {
  const board = structuredClone(room.board);
  for (const v of board.vertices) delete v.structure;
  for (const edge of board.edges) delete edge.road;
  return board;
}

test("resignation returns held resources, all unplayed card types and pieces without revealing private holdings", () => {
  const room = roomFor();
  const player = room.players[2];
  const seatIds = room.players.map((p) => p.id);
  const initialDeck = room.developmentDeck.map((card) => card.id).sort();
  const board = island(room);
  const version = room.mapVersion;
  give(room, player, { wood: 5, brick: 4, sheep: 3, wheat: 2, ore: 1 });
  for (const type of ["knight", "roadBuilding", "yearOfPlenty", "monopoly", "victoryPoint"]) {
    giveCard(room, player, type, room.turnNumber);
  }
  const hiddenIds = player.developmentCards.map((card) => card.id);
  structure(room, player, room.board.vertices[0]);
  structure(room, player, room.board.vertices[4], "city");
  for (const edge of room.board.edges.slice(0, 3)) {
    edge.road = { playerId: player.id };
    player.roadsLeft -= 1;
  }
  const token = player.reconnectToken;
  const beforeTurn = room.turnNumber;
  retire(room, player);
  assert.equal(room.players.length, 6);
  assert.deepEqual(room.players.map((p) => p.id), seatIds);
  assert.equal(player.resigned, true);
  assert.equal(player.connected, false);
  assert.equal(player.reconnectToken, token);
  assert.ok(Number.isSafeInteger(player.resignedAt));
  assert.equal(resourceTotal(player), 0);
  assert.deepEqual(player.developmentCards, []);
  assert.equal(player.knightsPlayed, 0);
  assert.equal(player.longestRoad, 0);
  assert.equal(player.points, 0);
  assert.deepEqual(room.developmentDeck.map((card) => card.id).sort(), initialDeck);
  assert.ok(room.developmentDeck.every((card) => !Object.hasOwn(card, "boughtTurn")));
  assert.equal(room.turnNumber, beforeTurn);
  assert.equal(room.phase, "action");
  assert.equal(room.mapVersion, version);
  assert.deepEqual(island(room), board);
  assert.equal(ensureMapPreview(room), false);
  assert.equal(room.board.tiles.length, 30);
  const view = publicState(room, player.id);
  assert.equal(view.activePlayerCount, 5);
  assert.equal(view.players.some((p) => p.id === player.id), false);
  assert.deepEqual(view.departedPlayers, [{
    id: player.id, name: player.name, color: player.color, resignedAt: player.resignedAt,
  }]);
  assert.ok(Object.values(view.legal).every((v) => Array.isArray(v) ? !v.length : v === false));
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes(token));
  for (const cardId of hiddenIds) assert.ok(!serialized.includes(cardId));
  assert.ok(!/knight|victoryPoint|roadBuilding|yearOfPlenty|monopoly/.test(room.log.at(-1).message));
  conserved(room);
  assert.deepEqual(JSON.parse(JSON.stringify(room)), room);
});

test("resignation rejects strangers, retired players, lobby/final states and failing shuffle without mutation", () => {
  const room = roomFor();
  for (const actorId of [null, "", {}, "outsider", 1]) rejectedResignation(room, actorId);
  const player = room.players[1];
  give(room, player, { ore: 2 });
  giveCard(room, player, "victoryPoint");
  const before = structuredClone(room);
  assert.throws(() => resignPlayer(room, player.id, () => NaN));
  assert.deepEqual(room, before);
  retire(room, player);
  rejectedResignation(room, player.id);
  const { room: lobby, player: host } = createRoom("Host");
  rejectedResignation(lobby, host.id);
  room.phase = "finished";
  rejectedResignation(room, current(room).id);
});

test("three-player starts preserve preview and use the complete base supply", () => {
  const { room, player: host } = createRoom("Host");
  addPlayer(room, "Second");
  addPlayer(room, "Third");
  ensureMapPreview(room, rng());
  const preview = structuredClone(room.board);
  startGame(room, host.id, rng(123));
  assert.deepEqual(room.board, preview);
  assert.equal(room.bank.wood, 19);
  assert.equal(room.developmentDeck.length, 25);
  assert.equal(publicState(room, host.id).boardPlayerCount, 4);
  assert.equal(publicState(room, host.id).activePlayerCount, 3);
  completeSetup(room);
});

test("resign permission is available to every participant throughout forced phases, not spectators or final rooms", () => {
  const room = roomFor(4);
  for (const phase of ["setup", "roll", "action", "discard", "robber", "steal"]) {
    room.phase = phase;
    for (const player of room.players) assert.equal(legal(room, player).canResign, true);
    assert.equal(publicState(room, "outsider").legal.canResign, false);
  }
  room.phase = "roll";
  room.freeRoadsRemaining = 1;
  assert.equal(legal(room).canResign, true);
  for (const phase of ["lobby", "finished", "invalid"]) {
    room.phase = phase;
    assert.equal(legal(room).canResign, false);
    rejectedResignation(room, current(room).id);
  }
});

for (const count of [3, 4, 5, 6]) {
  for (const role of count > 4 ? ["primary", "secondary"] : ["primary"]) {
    for (let primary = 0; primary < count; primary += 1) {
      for (let departure = 0; departure < count; departure += 1) {
        test(`${count} seats: ${role} anchored at ${primary}, resignation at ${departure} repairs turns without skipping`, () => {
          const room = roomFor(count);
          room.primaryIndex = primary;
          room.turnRole = role;
          room.turnIndex = role === "primary" ? primary : (primary + 3) % count;
          const previousActor = room.turnIndex;
          const previousPhase = room.phase;
          room.developmentPlayed = true;
          const actorChanged = departure === previousActor;
          const expectedRole = actorChanged ? (role === "primary" && count - 1 >= 5 ? "secondary" : "primary") : role;
          const expectedActor = actorChanged ? nextSeat(count, primary, [departure], expectedRole === "secondary" ? 3 : 1) : previousActor;
          retire(room, room.players[departure]);
          assert.equal(room.turnIndex, expectedActor);
          assert.equal(room.turnRole, expectedRole);
          assert.equal(room.turnNumber, actorChanged ? 8 : 7);
          assert.equal(room.developmentPlayed, !actorChanged);
          assert.equal(room.phase, actorChanged ? (expectedRole === "primary" ? "roll" : "action") : previousPhase);
          assert.equal(room.primaryIndex, actorChanged && expectedRole === "primary" ? expectedActor : primary);
          assert.equal(room.players.length, count);
          assert.equal(publicState(room, current(room).id).currentPlayerId, current(room).id);
          if (expectedRole === "secondary") {
            assert.equal(publicState(room, current(room).id).secondaryPlayerId, current(room).id);
          }
          if (room.phase === "roll") act(room, { type: "roll" });
          const anchor = room.primaryIndex;
          const pairedNext = room.turnRole === "primary" && count - 1 >= 5;
          const next = nextSeat(count, anchor, [departure], pairedNext ? 3 : 1);
          act(room, { type: "endTurn" });
          assert.equal(room.turnIndex, next);
          assert.equal(room.turnRole, pairedNext ? "secondary" : "primary");
          assert.equal(room.phase, pairedNext ? "action" : "roll");
          conserved(room);
        });
      }
    }
  }
}

test("six-to-five-to-four secondary wrap retains retired primary anchor, then continues ordinary three/two-player turns", () => {
  const room = roomFor(6);
  const map = island(room);
  const version = room.mapVersion;
  room.primaryIndex = 5;
  room.turnIndex = 2;
  room.turnRole = "secondary";
  retire(room, room.players[5]);
  assert.equal(activePlayers(room).length, 5);
  retire(room, room.players[0]);
  assert.equal(activePlayers(room).length, 4);
  assert.equal(room.turnIndex, 2);
  assert.equal(room.primaryIndex, 5);
  assert.equal(room.turnRole, "secondary");
  assert.equal(room.turnNumber, 7);
  assert.equal(publicState(room, current(room).id).primaryPlayerId, room.players[5].id);
  act(room, { type: "endTurn" });
  assert.equal(room.turnIndex, 1);
  assert.equal(room.turnRole, "primary");
  retire(room, room.players[1]);
  assert.equal(activePlayers(room).length, 3);
  assert.equal(room.turnIndex, 2);
  retire(room, room.players[4]);
  assert.equal(activePlayers(room).length, 2);
  assert.equal(room.phase, "roll");
  for (let i = 0; i < 4; i += 1) {
    act(room, { type: "roll" });
    act(room, { type: "endTurn" });
    assert.equal(room.turnIndex, i % 2 === 0 ? 3 : 2);
    assert.equal(room.phase, "roll");
  }
  assert.deepEqual(island(room), map);
  assert.equal(room.mapVersion, version);
  assert.equal(publicState(room, current(room).id).boardPlayerCount, 6);
  assert.equal(room.developmentDeck.length, 34);
  assert.equal(room.bank.wood, 24);
  conserved(room);
});

for (const count of [3, 6]) {
  for (const round of [0, 1]) {
    for (const afterSettlement of [false, true]) {
      for (let seat = 0; seat < count; seat += 1) {
        test(`${count}-player setup round ${round}, seat ${seat} retires ${afterSettlement ? "after" : "before"} settlement`, () => {
          const room = roomFor(count, "setup");
          reachSetup(room, round, seat);
          if (afterSettlement) setupStep(room);
          const player = current(room);
          retire(room, player);
          assert.equal(room.setupNeedsRoad, false);
          assert.equal(room.lastSetupVertex, null);
          assert.ok(!current(room).resigned);
          completeSetup(room);
          assert.equal(player.roadsLeft, 15);
          assert.equal(player.settlementsLeft, 5);
          assert.equal(player.points, 0);
          assert.equal(resourceTotal(player), 0);
          assert.equal(room.turnIndex, room.players.findIndex((p) => !p.resigned));
        });
      }
    }
  }
}

for (const round of [0, 1]) {
  for (const afterSettlement of [false, true]) {
    test(`noncurrent setup retirement preserves current placement, round ${round}, road pending ${afterSettlement}`, () => {
      const room = roomFor(6, "setup");
      reachSetup(room, round, 2);
      if (afterSettlement) setupStep(room);
      const vertexId = room.lastSetupVertex;
      retire(room, room.players[0]);
      retire(room, room.players[4]);
      assert.equal(room.turnIndex, 2);
      assert.equal(room.setupRound, round);
      assert.equal(room.setupNeedsRoad, afterSettlement);
      assert.equal(room.lastSetupVertex, vertexId);
      if (vertexId) assert.equal(vertex(room, vertexId).structure.playerId, current(room).id);
      completeSetup(room);
      assert.equal(room.turnIndex, 1);
      assert.equal(activePlayers(room).length, 4);
    });
  }
}

function seven(room) {
  room.phase = "roll";
  let draw = 0;
  act(room, { type: "roll" }, current(room), () => draw++ === 0 ? 0 : 0.999);
  assert.equal(room.dice[0] + room.dice[1], 7);
}
function payDiscards(room) {
  for (const [playerId, required] of Object.entries(room.pendingDiscards)) {
    const player = room.players.find((p) => p.id === playerId);
    let left = required;
    const resources = {};
    for (const resource of RESOURCES) {
      resources[resource] = Math.min(left, player.resources[resource]);
      left -= resources[resource];
    }
    assert.equal(left, 0);
    act(room, { type: "discard", resources }, player);
  }
}

for (const count of [3, 6]) {
  test(`${count}-player roller resignation preserves survivors' discard obligations then resumes successor activation`, () => {
    const room = roomFor(count);
    give(room, room.players[0], { wood: 9 });
    give(room, room.players[1], { ore: 9 });
    give(room, room.players[2], { sheep: 8 });
    const tileId = room.board.tiles.find((tile) => tile.robber).id;
    seven(room);
    retire(room);
    const paired = count === 6;
    assert.equal(room.turnIndex, paired ? 3 : 1);
    assert.equal(room.turnRole, paired ? "secondary" : "primary");
    assert.equal(room.turnNumber, 8);
    assert.equal(room.phase, "discard");
    assert.deepEqual(room.pendingDiscards, { [room.players[1].id]: 4, [room.players[2].id]: 4 });
    assert.equal(legal(room).canRoll, false);
    assert.equal(legal(room).canEndTurn, false);
    assert.equal(legal(room).canResign, true);
    assert.equal(room.mustMoveRobber, false);
    payDiscards(room);
    assert.equal(room.phase, paired ? "action" : "roll");
    assert.equal(room.board.tiles.find((tile) => tile.robber).id, tileId);
    if (!paired) act(room, { type: "roll" });
    act(room, { type: "endTurn" });
    assert.equal(room.turnIndex, paired ? 1 : 2);
    conserved(room);
  });
}

test("nonroller departure clears only their discard; surviving roller still moves robber when debts resolve", () => {
  const room = roomFor(4);
  give(room, room.players[1], { wood: 9 });
  give(room, room.players[2], { sheep: 9 });
  seven(room);
  retire(room, room.players[1]);
  assert.equal(room.turnIndex, 0);
  assert.equal(room.turnNumber, 7);
  assert.equal(room.phase, "discard");
  assert.deepEqual(room.pendingDiscards, { [room.players[2].id]: 4 });
  payDiscards(room);
  assert.equal(room.phase, "robber");
  assert.equal(room.mustMoveRobber, true);
  conserved(room);
});

test("a departing final discarder unblocks the surviving roller without changing activation", () => {
  const room = roomFor(3);
  give(room, room.players[2], { ore: 8 });
  seven(room);
  retire(room, room.players[2]);
  assert.equal(room.phase, "robber");
  assert.equal(room.turnNumber, 7);
  assert.equal(room.turnIndex, 0);
  assert.deepEqual(room.pendingDiscards, {});
});

test("successive acting departures during inherited discards do not orphan debts or create a robber phase", () => {
  const room = roomFor(6);
  give(room, room.players[1], { ore: 8 });
  give(room, room.players[4], { wheat: 8 });
  seven(room);
  retire(room, room.players[0]);
  assert.equal(room.turnIndex, 3);
  assert.equal(room.phase, "discard");
  retire(room, room.players[3]);
  assert.equal(room.turnIndex, 1);
  assert.equal(room.turnRole, "primary");
  assert.equal(room.turnNumber, 9);
  assert.equal(room.phase, "discard");
  retire(room, room.players[4]);
  payDiscards(room);
  assert.equal(room.phase, "roll");
  assert.equal(room.mustMoveRobber, false);
  assert.equal(room.turnIndex, 1);
  conserved(room);
});

test("pre-roll Knight victim resignation finishes theft back into roll, keeping spent card and robber location", () => {
  const room = roomFor(4, "roll");
  const player = current(room);
  const victim = room.players[1];
  const knight = giveCard(room, player, "knight");
  const tile = room.board.tiles.find((tile) => !tile.robber);
  structure(room, victim, vertex(room, tile.vertices[0]));
  give(room, victim, { wood: 2 });
  act(room, { type: "playDevelopment", cardId: knight.id });
  act(room, { type: "moveRobber", tileId: tile.id });
  assert.equal(room.phase, "steal");
  retire(room, victim);
  assert.equal(room.phase, "roll");
  assert.equal(room.turnIndex, 0);
  assert.equal(room.turnNumber, 7);
  assert.equal(room.developmentPlayed, true);
  assert.equal(player.knightsPlayed, 1);
  assert.equal(room.board.tiles.find((tile) => tile.robber).id, tile.id);
  assert.ok(!room.developmentDeck.some((card) => card.id === knight.id));
  assert.deepEqual(room.robberVictims, []);
  conserved(room);
});

test("resigning one of several victims retains surviving choices and current robber phase", () => {
  const room = roomFor(4);
  const knight = giveCard(room, current(room), "knight");
  const tile = room.board.tiles.find((tile) => !tile.robber);
  for (const [index, victim] of room.players.slice(1, 3).entries()) {
    structure(room, victim, vertex(room, tile.vertices[index * 3]));
    give(room, victim, { wood: 1 });
  }
  act(room, { type: "playDevelopment", cardId: knight.id });
  act(room, { type: "moveRobber", tileId: tile.id });
  retire(room, room.players[1]);
  assert.equal(room.phase, "steal");
  assert.deepEqual(room.robberVictims, [room.players[2].id]);
  rejectedAction(room, { type: "steal", targetId: room.players[1].id }, current(room));
  act(room, { type: "steal", targetId: room.players[2].id });
  assert.equal(room.phase, "action");
  conserved(room);
});

for (const phase of ["robber", "steal"]) {
  test(`acting Knight player retires during ${phase}: no orphaned action or card refund`, () => {
    const room = roomFor(4, "roll");
    const player = current(room);
    const knight = giveCard(room, player, "knight");
    const tile = room.board.tiles.find((tile) => !tile.robber);
    structure(room, room.players[1], vertex(room, tile.vertices[0]));
    give(room, room.players[1], { ore: 1 });
    act(room, { type: "playDevelopment", cardId: knight.id });
    if (phase === "steal") act(room, { type: "moveRobber", tileId: tile.id });
    const robber = room.board.tiles.find((tile) => tile.robber).id;
    retire(room, player);
    assert.equal(room.phase, "roll");
    assert.equal(room.turnIndex, 1);
    assert.equal(room.turnNumber, 8);
    assert.equal(room.mustMoveRobber, false);
    assert.equal(room.robberReturnPhase, null);
    assert.deepEqual(room.robberVictims, []);
    assert.ok(!room.developmentDeck.some((card) => card.id === knight.id));
    assert.equal(room.board.tiles.find((tile) => tile.robber).id, robber);
    conserved(room);
  });
}

for (const actorDeparts of [false, true]) {
  test(`free-road pending retirement by ${actorDeparts ? "actor" : "nonactor"} preserves correct phase and card spending`, () => {
    const room = roomFor(4, "roll");
    const player = current(room);
    structure(room, player, room.board.vertices[0]);
    const development = giveCard(room, player, "roadBuilding");
    act(room, { type: "playDevelopment", cardId: development.id });
    act(room, { type: "buildRoad", edgeId: legal(room).roadEdges[0] });
    assert.equal(room.freeRoadsRemaining, 1);
    retire(room, actorDeparts ? player : room.players[1]);
    assert.equal(room.phase, "roll");
    assert.equal(room.freeRoadsRemaining, actorDeparts ? 0 : 1);
    assert.equal(room.developmentPlayed, !actorDeparts);
    assert.equal(room.turnNumber, actorDeparts ? 8 : 7);
    assert.ok(!room.developmentDeck.some((card) => card.id === development.id));
    if (!actorDeparts) act(room, { type: "finishFreeRoads" });
    conserved(room);
  });
}

test("spent Monopoly effects are not reversed; stolen cards return to bank rather than their prior owners", () => {
  const room = roomFor(4);
  const player = current(room);
  for (const other of room.players.slice(1)) give(room, other, { ore: 2 });
  const monopoly = giveCard(room, player, "monopoly");
  act(room, { type: "playDevelopment", cardId: monopoly.id, resource: "ore" });
  assert.equal(player.resources.ore, 6);
  retire(room, player);
  assert.equal(room.bank.ore, 19);
  assert.ok(room.players.every((p) => p.resources.ore === 0));
  assert.equal(room.developmentDeck.length, 24);
  assert.ok(!room.developmentDeck.some((card) => card.id === monopoly.id));
  conserved(room);
});

for (const departure of [0, 1, 2]) {
  test(`pending trade resignation at ${departure} cancels only an involved trade`, () => {
    const room = roomFor(4);
    give(room, room.players[0], { wood: 1 });
    give(room, room.players[1], { ore: 1 });
    act(room, { type: "offerTrade", targetId: room.players[1].id, give: { wood: 1 }, want: { ore: 1 } });
    const offer = structuredClone(room.trade);
    retire(room, room.players[departure]);
    if (departure === 2) assert.deepEqual(room.trade, offer);
    else assert.equal(room.trade, null);
    conserved(room);
  });
}

test("retired actors cannot act, resign again, or become domestic trade/theft targets", () => {
  const room = roomFor(4);
  const departed = room.players[1];
  retire(room, departed);
  departed.connected = true;
  assert.equal(activePlayers(room).some((player) => player.id === departed.id), false,
    "Restoring transport connectivity must never resurrect a retired seat");
  for (const type of ["setupSettlement", "setupRoad", "roll", "discard", "moveRobber", "steal", "buildRoad",
    "buildSettlement", "buildCity", "bankTrade", "offerTrade", "respondTrade", "cancelTrade",
    "buyDevelopment", "playDevelopment", "finishFreeRoads", "endTurn"]) {
    rejectedAction(room, { type }, departed);
  }
  rejectedResignation(room, departed.id);
  give(room, current(room), { wood: 1 });
  rejectedAction(room, { type: "offerTrade", targetId: departed.id, give: { wood: 1 }, want: { ore: 1 } }, current(room));
  const before = structuredClone(room);
  assert.throws(() => addPlayer(room, "Late join"));
  assert.deepEqual(room, before);
});

test("development age and one-card allowance survive paired-to-ordinary transition with unchanged secondary", () => {
  const room = roomFor(6);
  room.turnIndex = 3;
  room.turnRole = "secondary";
  const player = current(room);
  const card = giveCard(room, player, "monopoly", room.turnNumber);
  retire(room, room.players[5]);
  retire(room, room.players[0]);
  assert.equal(room.turnIndex, 3);
  assert.equal(room.turnRole, "secondary");
  assert.equal(room.turnNumber, 7);
  rejectedAction(room, { type: "playDevelopment", cardId: card.id, resource: "wood" }, player);
  rejectedAction(room, { type: "offerTrade", targetId: room.players[1].id, give: { wood: 1 }, want: { ore: 1 } }, player);
  act(room, { type: "endTurn" });
  assert.equal(room.turnIndex, 1);
  for (const seat of [1, 2]) {
    assert.equal(room.turnIndex, seat);
    act(room, { type: "roll" });
    act(room, { type: "endTurn" });
  }
  assert.equal(room.turnIndex, 3);
  assert.equal(room.turnRole, "primary");
  assert.equal(room.turnNumber, 10);
  assert.ok(legal(room).playableCardIds.includes(card.id));
  act(room, { type: "playDevelopment", cardId: card.id, resource: "wood" });
});

function graph(room, pairs) {
  const ids = [...new Set(pairs.flatMap(([a, b]) => [a, b]))];
  room.board = {
    tiles: [], ports: [],
    vertices: ids.map((id, index) => ({
      id, x: index, y: 0, adjacentTiles: [], structure: null,
      adjacentVertices: pairs.filter(([a, b]) => a === id || b === id).map(([a, b]) => a === id ? b : a),
    })),
    edges: pairs.map(([a, b, owner], index) => ({
      id: `e${index}`, vertices: [a, b], adjacentTiles: [], road: { playerId: room.players[owner].id },
    })),
  };
  for (const player of room.players) player.roadsLeft = 15 - pairs.filter(([, , owner]) => room.players[owner].id === player.id).length;
}
const chain = (prefix, length, owner) => Array.from({ length }, (_, i) => [`${prefix}${i}`, `${prefix}${i + 1}`, owner]);

test("retiring incumbent leaves new longest-road and army ties unset until a strict leader emerges", () => {
  const room = roomFor(6);
  graph(room, [...chain("a", 6, 0), ...chain("b", 5, 1), ...chain("c", 5, 2)]);
  room.players[0].knightsPlayed = 4;
  room.players[1].knightsPlayed = 3;
  room.players[2].knightsPlayed = 3;
  room.phase = "roll";
  act(room, { type: "roll" });
  assert.equal(room.longestRoadHolderId, room.players[0].id);
  assert.equal(room.largestArmyHolderId, room.players[0].id);
  room.primaryIndex = 3;
  room.turnIndex = 3;
  retire(room, room.players[0]);
  assert.equal(room.longestRoadHolderId, null);
  assert.equal(room.largestArmyHolderId, null);
  assert.equal(room.players[1].longestRoad, 5);
  assert.equal(room.players[2].longestRoad, 5);
  room.turnIndex = 1;
  room.primaryIndex = 1;
  const knight = giveCard(room, current(room), "knight");
  act(room, { type: "playDevelopment", cardId: knight.id });
  assert.equal(room.largestArmyHolderId, room.players[1].id);
  conserved(room);
});

test("surviving road and army incumbents keep a tied award when an unrelated player resigns", () => {
  const room = roomFor(6);
  graph(room, [...chain("a", 5, 0), ...chain("b", 5, 1)]);
  room.longestRoadHolderId = room.players[0].id;
  room.largestArmyHolderId = room.players[0].id;
  room.players[0].knightsPlayed = 3;
  room.players[1].knightsPlayed = 3;
  retire(room, room.players[4]);
  assert.equal(room.longestRoadHolderId, room.players[0].id);
  assert.equal(room.largestArmyHolderId, room.players[0].id);
  assert.equal(room.players[0].points, 4);
  assert.equal(room.players[1].points, 0);
  conserved(room);
});

for (const currentWins of [false, true]) {
  test(`removing an enemy settlement reconnects surviving road; victory ${currentWins ? "is immediate on own activation" : "waits until owner activates"}`, () => {
    const room = roomFor(4);
    graph(room, chain("a", 8, 0));
    const winner = room.players[0];
    for (const id of ["a0", "a2", "a6", "a8"]) structure(room, winner, vertex(room, id), "city");
    structure(room, room.players[1], vertex(room, "a4"));
    room.phase = "roll";
    act(room, { type: "roll" });
    assert.equal(winner.longestRoad, 4);
    room.turnIndex = currentWins ? 0 : 3;
    room.primaryIndex = room.turnIndex;
    retire(room, room.players[1]);
    assert.equal(winner.longestRoad, 8);
    assert.equal(winner.points, 10);
    if (!currentWins) {
      assert.equal(room.winnerId, null);
      act(room, { type: "endTurn" });
    }
    assert.equal(room.winnerId, winner.id);
    assert.equal(room.phase, "finished");
    assert.equal(publicState(room, winner.id).winReason, "points");
    conserved(room);
  });
}

test("ordinary disconnections remain active, retain holdings and turns, and do not imply resignation", () => {
  const room = roomFor(3);
  const offline = room.players[1];
  give(room, offline, { wheat: 3 });
  offline.connected = false;
  assert.equal(activePlayers(room).length, 3);
  act(room, { type: "endTurn" });
  assert.equal(room.turnIndex, 1);
  assert.equal(offline.resources.wheat, 3);
  assert.equal(publicState(room, room.players[0].id).players.length, 3);
  assert.deepEqual(publicState(room, offline.id).departedPlayers, []);
});

test("one remaining participant wins below ten points and finalized match rejects any further retirement", () => {
  const room = roomFor(3, "setup");
  room.hostId = room.players[0].id;
  const ids = room.players.map((p) => p.id);
  retire(room, room.players[0]);
  assert.equal(room.phase, "setup");
  assert.equal(activePlayers(room).length, 2);
  assert.notEqual(room.hostId, ids[0]);
  retire(room, room.players[1]);
  assert.equal(room.phase, "finished");
  assert.equal(room.winnerId, ids[2]);
  assert.equal(room.winReason, "last-player");
  assert.equal(room.turnIndex, 2);
  assert.equal(current(room).points, 0);
  assert.equal(legal(room).canResign, false);
  rejectedResignation(room, ids[2]);
  rejectedAction(room, { type: "endTurn" }, current(room));
  assert.equal(publicState(room, ids[2]).activePlayerCount, 1);
  conserved(room);
});

test("an unfinished legacy room losing its last participant becomes abandoned with no invalid seat index", () => {
  const room = roomFor(3);
  for (const player of room.players.slice(1)) {
    player.resigned = true;
    player.connected = false;
    player.resignedAt = Date.now();
  }
  const last = current(room);
  retire(room, last);
  assert.equal(room.phase, "finished");
  assert.equal(room.winnerId, null);
  assert.equal(room.winReason, "abandoned");
  assert.ok(room.turnIndex >= 0 && room.turnIndex < room.players.length);
  const view = publicState(room, last.id);
  assert.equal(view.currentPlayerId, null);
  assert.equal(view.primaryPlayerId, null);
  assert.equal(view.secondaryPlayerId, null);
  assert.equal(view.activePlayerCount, 0);
  assert.deepEqual(view.players, []);
  assert.equal(view.departedPlayers.length, 3);
  conserved(room);
});

test("old v2 rooms missing every retirement field remain usable and return safe public defaults", () => {
  const room = roomFor(4);
  delete room.winReason;
  delete room.discardReturnPhase;
  for (const player of room.players) {
    delete player.resigned;
    delete player.resignedAt;
  }
  let view = publicState(room, current(room).id);
  assert.equal(view.activePlayerCount, 4);
  assert.deepEqual(view.departedPlayers, []);
  assert.equal(view.winReason, null);
  assert.equal(view.legal.canResign, true);
  retire(room, room.players[1]);
  assert.equal(activePlayers(room).length, 3);
  assert.equal(room.phase, "action");
  act(room, { type: "endTurn" });
  assert.equal(room.turnIndex, 2);
  room.phase = "finished";
  room.winnerId = current(room).id;
  delete room.winReason;
  view = publicState(room, current(room).id);
  assert.equal(view.winReason, "points");
  assert.equal(view.legal.canResign, false);
});
