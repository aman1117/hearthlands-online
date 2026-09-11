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
const {
  RESOURCES, COSTS, createRoom, addPlayer, startGame, applyAction, publicState, appendPublicEvent,
  resignPlayer, resourceTotal,
} = require("../game");

function fixture(count = 3, phase = "action") {
  const { room, player: host } = createRoom("Host");
  for (let index = 1; index < count; index += 1) addPlayer(room, `Guest${index}`);
  startGame(room, host.id, () => 0.42);
  Object.assign(room, { phase, turnNumber: phase === "setup" ? 0 : 1,
    code: "ABCDEF", revision: 1, updatedAt: Date.now() - 60_000 });
  return room;
}
const actor = (room) => room.players[room.turnIndex];
const view = (room, player = actor(room)) => publicState(room, player.id);
const legal = (room, player = actor(room)) => view(room, player).legal;
const act = (room, action, player = actor(room), random = () => 0) => applyAction(room, player.id, action, random);
const vertex = (room, id) => room.board.vertices.find((item) => item.id === id);
const edge = (room, id) => room.board.edges.find((item) => item.id === id);
const opportunity = (room) => view(room).undoPlacement;
const undo = (room, id = opportunity(room)?.id) => act(room, { type: "undoPlacement", placementId: id });

function give(room, player, bundle) {
  for (const [resource, amount] of Object.entries(bundle)) {
    assert.ok(room.bank[resource] >= amount);
    room.bank[resource] -= amount;
    player.resources[resource] += amount;
  }
}
function card(room, type, player = actor(room)) {
  const index = room.developmentDeck.findIndex((card) => card.type === type);
  assert.ok(index >= 0);
  const held = { ...room.developmentDeck.splice(index, 1)[0], boughtTurn: 0 };
  player.developmentCards.push(held);
  return held;
}
function seedStructure(room, player = actor(room), site = room.board.vertices[0], kind = "settlement") {
  site.structure = { playerId: player.id, kind };
  player[kind === "city" ? "citiesLeft" : "settlementsLeft"] -= 1;
  player.points += kind === "city" ? 2 : 1;
  return site.id;
}
function conserved(room) {
  const supply = room.players.length > 4 ? 24 : 19;
  for (const resource of RESOURCES) {
    assert.equal(room.bank[resource] + room.players.reduce((sum, p) => sum + p.resources[resource], 0), supply);
    assert.ok(room.bank[resource] >= 0);
  }
  for (const player of room.players) {
    assert.equal(player.roadsLeft + room.board.edges.filter((item) => item.road?.playerId === player.id).length, 15);
    assert.equal(player.settlementsLeft + room.board.vertices.filter((v) =>
      v.structure?.playerId === player.id && v.structure.kind === "settlement").length, 5);
    assert.equal(player.citiesLeft + room.board.vertices.filter((v) =>
      v.structure?.playerId === player.id && v.structure.kind === "city").length, 4);
  }
}
function rejected(room, action, player = actor(room)) {
  const before = structuredClone(room);
  assert.throws(() => act(room, action, player));
  assert.deepEqual(room, before);
}
function graph(room, pairs) {
  const names = [...new Set(pairs.flatMap(([a, b]) => [a, b]))];
  room.board = {
    tiles: [], ports: [],
    vertices: names.map((id, index) => ({
      id, x: index, y: 0, adjacentTiles: [], structure: null,
      adjacentVertices: pairs.filter(([a, b]) => a === id || b === id).map(([a, b]) => a === id ? b : a),
    })),
    edges: pairs.map(([a, b, owner], index) => ({
      id: `e${index}`, vertices: [a, b], road: owner === undefined ? null : { playerId: room.players[owner].id },
    })),
  };
  for (const player of room.players) player.roadsLeft = 15 - room.board.edges.filter((item) => item.road?.playerId === player.id).length;
}
const chain = (prefix, length, owner) => Array.from({ length }, (_, i) => [`${prefix}${i}`, `${prefix}${i + 1}`, owner]);

test("paid road, settlement and city placements undo LIFO with exact refunds, stocks and durable history", () => {
  const room = fixture();
  const player = actor(room);
  graph(room, chain("v", 4));
  seedStructure(room, player, vertex(room, "v0"));
  give(room, player, { wood: 5, brick: 5, sheep: 2, wheat: 4, ore: 3 });
  const beforeBoard = structuredClone(room.board);
  const beforeResources = structuredClone(player.resources);
  const beforeBank = structuredClone(room.bank);
  const ids = [];
  for (const action of [{ type: "buildRoad", edgeId: "e0" }, { type: "buildRoad", edgeId: "e1" },
    { type: "buildSettlement", vertexId: "v2" }, { type: "buildCity", vertexId: "v2" }]) {
    act(room, action);
    ids.push(opportunity(room).id);
    assert.equal(opportunity(room).count, ids.length);
    assert.equal(opportunity(room).type, action.type);
    assert.equal(legal(room).canUndoPlacement, true);
    conserved(room);
  }
  const originalEventIds = room.eventOutbox.map((event) => event.id);
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    undo(room, ids[index]);
    if (index === 3) assert.equal(vertex(room, "v2").structure.kind, "settlement");
    if (index === 2) assert.equal(vertex(room, "v2").structure, null);
    if (index) assert.equal(opportunity(room).id, ids[index - 1]);
    else assert.equal(opportunity(room), null);
    rejected(room, { type: "undoPlacement", placementId: ids[index] });
    conserved(room);
  }
  assert.deepEqual(room.board, beforeBoard);
  assert.deepEqual(player.resources, beforeResources);
  assert.deepEqual(room.bank, beforeBank);
  assert.equal(player.points, 1);
  assert.equal(room.eventOutbox.filter((event) => event.type === "placementUndone").length, 4);
  assert.ok(originalEventIds.every((id) => room.eventOutbox.some((event) => event.id === id)));
  const event = room.eventOutbox.at(-1);
  assert.equal(event.actorId, player.id);
  assert.deepEqual(event.data, { placementType: "buildRoad", targetId: "e0", count: 1 });
});

test("newest placement IDs reject stale same-activation requests and change when a placement is rebuilt", () => {
  const room = fixture();
  graph(room, chain("v", 3));
  seedStructure(room, actor(room), vertex(room, "v0"));
  give(room, actor(room), { wood: 3, brick: 3 });
  act(room, { type: "buildRoad", edgeId: "e0" });
  const first = opportunity(room).id;
  act(room, { type: "buildRoad", edgeId: "e1" });
  rejected(room, { type: "undoPlacement", placementId: first });
  undo(room);
  assert.equal(opportunity(room).id, first);
  undo(room);
  act(room, { type: "buildRoad", edgeId: "e0" });
  assert.notEqual(opportunity(room).id, first);
  rejected(room, { type: "undoPlacement", placementId: first });
});

test("paired secondary owns its undo opportunity; primary anchor cannot use it or recover it on a later activation", () => {
  const room = fixture(6);
  room.turnRole = "secondary";
  room.turnIndex = 3;
  const secondary = actor(room);
  seedStructure(room);
  give(room, secondary, COSTS.road);
  const location = legal(room).roadEdges[0];
  act(room, { type: "buildRoad", edgeId: location });
  const id = opportunity(room).id;
  assert.equal(view(room, room.players[0]).undoPlacement, null);
  rejected(room, { type: "undoPlacement", placementId: id }, room.players[0]);
  undo(room, id);
  assert.equal(room.turnRole, "secondary");
  assert.equal(room.phase, "action");
  assert.equal(room.turnIndex, 3);
  act(room, { type: "buildRoad", edgeId: location });
  const second = opportunity(room).id;
  act(room, { type: "endTurn" });
  assert.equal(room.turnIndex, 1);
  assert.equal(room.turnRole, "primary");
  rejected(room, { type: "undoPlacement", placementId: second }, secondary);
  conserved(room);
});

function setupStep(room) {
  if (room.setupNeedsRoad) act(room, { type: "setupRoad", edgeId: legal(room).roadEdges[0] });
  else act(room, { type: "setupSettlement", vertexId: legal(room).settlementVertices[0] });
}

for (const round of [0, 1]) {
  test(`setup round ${round + 1} settlement undo restores grants, phase and exact finite bank`, () => {
    const room = fixture(6, "setup");
    while (room.setupRound !== round) setupStep(room);
    const player = actor(room);
    const before = { resources: structuredClone(player.resources), bank: structuredClone(room.bank),
      settlements: player.settlementsLeft, points: player.points };
    const site = legal(room).settlementVertices.find((id) =>
      vertex(room, id).adjacentTiles.some((tileId) => room.board.tiles.find((tile) => tile.id === tileId).resource !== "desert"));
    act(room, { type: "setupSettlement", vertexId: site });
    const placedId = opportunity(room).id;
    assert.equal(opportunity(room).type, "setupSettlement");
    assert.equal(room.setupNeedsRoad, true);
    if (round === 1) assert.ok(resourceTotal(player) > Object.values(before.resources).reduce((sum, count) => sum + count, 0));
    undo(room, placedId);
    assert.equal(room.phase, "setup");
    assert.equal(room.setupRound, round);
    assert.equal(room.setupNeedsRoad, false);
    assert.equal(room.lastSetupVertex, null);
    assert.equal(vertex(room, site).structure, null);
    assert.deepEqual(player.resources, before.resources);
    assert.deepEqual(room.bank, before.bank);
    assert.equal(player.settlementsLeft, before.settlements);
    assert.equal(player.points, before.points);
    assert.ok(legal(room).settlementVertices.includes(site));
    conserved(room);
  });
}

test("setup roads are commitment boundaries, including the same player's forward-to-reverse transition", () => {
  const room = fixture(3, "setup");
  const first = actor(room);
  setupStep(room);
  const id = opportunity(room).id;
  setupStep(room);
  assert.notEqual(actor(room).id, first.id);
  assert.equal(opportunity(room), null);
  rejected(room, { type: "undoPlacement", placementId: id }, first);
  while (room.turnIndex !== 2) setupStep(room);
  setupStep(room);
  const last = actor(room);
  const lastId = opportunity(room).id;
  setupStep(room);
  assert.equal(actor(room).id, last.id);
  assert.equal(room.setupRound, 1);
  assert.equal(opportunity(room), null);
  rejected(room, { type: "undoPlacement", placementId: lastId });
});

for (const phase of ["roll", "action"]) {
  test(`Road Building ${phase} roads undo intermediate/final placements without reviving the development card`, () => {
    const room = fixture(3, phase);
    const player = actor(room);
    seedStructure(room);
    const development = card(room, "roadBuilding");
    act(room, { type: "playDevelopment", cardId: development.id });
    const playedTotals = structuredClone(player.playedProgressCards);
    const firstEdge = legal(room).roadEdges[0];
    act(room, { type: "buildRoad", edgeId: firstEdge });
    const firstId = opportunity(room).id;
    assert.equal(room.freeRoadsRemaining, 1);
    const secondEdge = legal(room).roadEdges[0];
    act(room, { type: "buildRoad", edgeId: secondEdge });
    const secondId = opportunity(room).id;
    assert.equal(room.freeRoadsRemaining, 0);
    assert.equal(room.freeRoadsReturnPhase, null);
    assert.equal(room.phase, phase);
    rejected(room, { type: "finishFreeRoads" });
    undo(room, secondId);
    assert.equal(edge(room, secondEdge).road, null);
    assert.equal(room.freeRoadsRemaining, 1);
    assert.equal(room.freeRoadsReturnPhase, phase);
    assert.equal(room.phase, phase);
    assert.equal(legal(room).canRoll, false);
    assert.equal(opportunity(room).id, firstId);
    undo(room, firstId);
    assert.equal(room.freeRoadsRemaining, 2);
    assert.equal(room.freeRoadsReturnPhase, phase);
    assert.equal(room.developmentPlayed, true);
    assert.equal(player.developmentCards.some((card) => card.id === development.id), false);
    assert.equal(room.developmentDeck.some((card) => card.id === development.id), false);
    assert.deepEqual(player.playedProgressCards, playedTotals);
    assert.equal(player.roadsLeft, 15);
    conserved(room);
  });
}

test("automatic free-road completion with no legal continuation can undo, explicit forfeiture cannot", () => {
  const room = fixture();
  graph(room, [["a", "b"], ["b", "c", 1]]);
  seedStructure(room, actor(room), vertex(room, "a"));
  seedStructure(room, room.players[1], vertex(room, "b"));
  const development = card(room, "roadBuilding");
  act(room, { type: "playDevelopment", cardId: development.id });
  act(room, { type: "buildRoad", edgeId: "e0" });
  assert.equal(room.freeRoadsRemaining, 0);
  undo(room);
  assert.equal(room.freeRoadsRemaining, 2);
  assert.equal(room.phase, "action");
  conserved(room);
  const explicit = fixture();
  seedStructure(explicit);
  const secondCard = card(explicit, "roadBuilding");
  act(explicit, { type: "playDevelopment", cardId: secondCard.id });
  act(explicit, { type: "buildRoad", edgeId: legal(explicit).roadEdges[0] });
  assert.equal(explicit.freeRoadsRemaining, 1);
  const id = opportunity(explicit).id;
  act(explicit, { type: "finishFreeRoads" });
  assert.equal(opportunity(explicit), null);
  rejected(explicit, { type: "undoPlacement", placementId: id });
  conserved(explicit);
});

test("last physical free-road piece can undo back to one owed road without exceeding stock limits", () => {
  const room = fixture();
  graph(room, [...chain("a", 14, 0), ["a14", "a15"]]);
  assert.equal(actor(room).roadsLeft, 1);
  const development = card(room, "roadBuilding");
  act(room, { type: "playDevelopment", cardId: development.id });
  assert.equal(room.freeRoadsRemaining, 1);
  act(room, { type: "buildRoad", edgeId: "e14" });
  assert.equal(actor(room).roadsLeft, 0);
  assert.equal(room.freeRoadsRemaining, 0);
  undo(room);
  assert.equal(actor(room).roadsLeft, 1);
  assert.equal(room.freeRoadsRemaining, 1);
  assert.equal(room.freeRoadsReturnPhase, "action");
  assert.equal(actor(room).playedProgressCards.roadBuilding, 1);
  conserved(room);
});

test("a seven after pre-roll free roads commits both roads and discards never revive their journal", () => {
  const room = fixture(3, "roll");
  seedStructure(room);
  give(room, actor(room), { wood: 8 });
  give(room, room.players[1], { ore: 8 });
  const development = card(room, "roadBuilding");
  act(room, { type: "playDevelopment", cardId: development.id });
  act(room, { type: "buildRoad", edgeId: legal(room).roadEdges[0] });
  act(room, { type: "buildRoad", edgeId: legal(room).roadEdges[0] });
  const id = opportunity(room).id;
  let die = 0;
  act(room, { type: "roll" }, actor(room), () => die++ === 0 ? 0 : 0.999);
  assert.equal(room.phase, "discard");
  assert.equal(opportunity(room), null);
  rejected(room, { type: "undoPlacement", placementId: id });
  act(room, { type: "discard", resources: { wood: 4 } });
  act(room, { type: "discard", resources: { ore: 4 } }, room.players[1]);
  assert.equal(room.phase, "robber");
  assert.equal(opportunity(room), null);
  assert.equal(actor(room).roadsLeft, 13);
  assert.equal(actor(room).playedProgressCards.roadBuilding, 1);
  conserved(room);
});

test("winning on the first free road immediately ends the opportunity, without allowing a whole-card rewind", () => {
  const room = fixture();
  graph(room, [...chain("a", 4, 0), ["a4", "a5"]]);
  for (const site of room.board.vertices.slice(0, 4)) seedStructure(room, actor(room), site, "city");
  const development = card(room, "roadBuilding");
  act(room, { type: "playDevelopment", cardId: development.id });
  act(room, { type: "buildRoad", edgeId: "e4" });
  assert.equal(room.phase, "finished");
  assert.equal(actor(room).points, 10);
  assert.equal(room.freeRoadsRemaining, 0);
  assert.equal(opportunity(room), null);
  assert.equal(room.placementUndoJournal, null);
  rejected(room, { type: "undoPlacement", placementId: "no-winning-undo" });
});

for (const hasVictim of [false, true]) {
  test(`robber relocation ${hasVictim ? "with" : "without"} victims reverses only before theft or another side effect`, () => {
    const room = fixture(3, "roll");
    const player = actor(room);
    const knight = card(room, "knight");
    const originalTile = room.board.tiles.find((tile) => tile.robber).id;
    const newTile = room.board.tiles.find((tile) => !tile.robber);
    if (hasVictim) {
      seedStructure(room, room.players[1], vertex(room, newTile.vertices[0]));
      give(room, room.players[1], { wood: 9, ore: 1 });
    }
    act(room, { type: "playDevelopment", cardId: knight.id });
    act(room, { type: "moveRobber", tileId: newTile.id });
    const firstId = opportunity(room).id;
    assert.equal(room.phase, hasVictim ? "steal" : "roll");
    undo(room);
    assert.equal(room.phase, "robber");
    assert.equal(room.robberReturnPhase, "roll");
    assert.equal(room.mustMoveRobber, true);
    assert.deepEqual(room.robberVictims, []);
    assert.equal(room.board.tiles.find((tile) => tile.robber).id, originalTile);
    assert.equal(player.knightsPlayed, 1);
    assert.equal(room.developmentPlayed, true);
    act(room, { type: "moveRobber", tileId: newTile.id });
    assert.notEqual(opportunity(room).id, firstId);
    rejected(room, { type: "undoPlacement", placementId: firstId });
    const currentId = opportunity(room).id;
    if (hasVictim) act(room, { type: "steal", targetId: room.players[1].id }, player, () => 0.95);
    else act(room, { type: "roll" }, player, () => 0);
    assert.equal(opportunity(room), null);
    rejected(room, { type: "undoPlacement", placementId: currentId });
    if (hasVictim) assert.equal(player.resources.ore, 1);
    assert.equal(room.board.tiles.find((tile) => tile.robber).id, newTile.id);
    conserved(room);
  });
}

test("a paid placement after a no-victim robber move commits that move even when the build is later undone", () => {
  const room = fixture();
  seedStructure(room);
  give(room, actor(room), COSTS.road);
  const knight = card(room, "knight");
  act(room, { type: "playDevelopment", cardId: knight.id });
  const tile = room.board.tiles.find((tile) => !tile.robber);
  act(room, { type: "moveRobber", tileId: tile.id });
  const robberUndoId = opportunity(room).id;
  act(room, { type: "buildRoad", edgeId: legal(room).roadEdges[0] });
  assert.equal(opportunity(room).count, 1);
  undo(room);
  assert.equal(room.phase, "action");
  assert.equal(opportunity(room), null);
  assert.equal(room.board.tiles.find((candidate) => candidate.robber).id, tile.id);
  rejected(room, { type: "undoPlacement", placementId: robberUndoId });
});

test("undo restores the original Longest Road incumbent on a tie and logs an actual reverse transfer", () => {
  const room = fixture();
  graph(room, [...chain("a", 5, 0), ...chain("b", 5, 1), ["b5", "b6"]]);
  room.longestRoadHolderId = room.players[0].id;
  room.players[0].points = 2;
  room.turnIndex = 1;
  room.primaryIndex = 1;
  give(room, actor(room), COSTS.road);
  act(room, { type: "buildRoad", edgeId: "e10" });
  assert.equal(room.longestRoadHolderId, room.players[1].id);
  undo(room);
  assert.equal(room.longestRoadHolderId, room.players[0].id);
  assert.equal(room.players[0].points, 2);
  assert.equal(room.players[1].points, 0);
  const bonus = room.eventOutbox.filter((event) => event.type === "bonusChanged").at(-1);
  assert.equal(bonus.data.fromId, room.players[1].id);
  assert.equal(bonus.data.toId, room.players[0].id);
  conserved(room);
});

test("undoing a settlement road-cut restores the prior unclaimed tie instead of favoring the temporary holder", () => {
  const room = fixture();
  graph(room, [...chain("a", 5, 0), ...chain("b", 5, 1), ["a2", "c0", 2]]);
  room.turnIndex = 2;
  room.primaryIndex = 2;
  give(room, actor(room), COSTS.settlement);
  act(room, { type: "buildSettlement", vertexId: "a2" });
  assert.equal(room.longestRoadHolderId, room.players[1].id);
  undo(room);
  assert.equal(vertex(room, "a2").structure, null);
  assert.equal(room.longestRoadHolderId, null);
  assert.equal(room.players[0].longestRoad, 5);
  assert.equal(room.players[1].longestRoad, 5);
  assert.equal(room.players[1].points, 0);
  conserved(room);
});

test("failed actions and harmless negotiations/admin/connectivity changes preserve undo without rolling them back", () => {
  const room = fixture();
  const player = actor(room);
  const peer = room.players[1];
  seedStructure(room);
  give(room, player, { wood: 3, brick: 1 });
  give(room, peer, { ore: 1 });
  act(room, { type: "buildRoad", edgeId: legal(room).roadEdges[0] });
  const id = opportunity(room).id;
  rejected(room, { type: "buildRoad", edgeId: "not-an-edge" });
  rejected(room, { type: "buyDevelopment" });
  rejected(room, { type: "playDevelopment", cardId: "not-a-card" });
  assert.equal(opportunity(room).id, id);
  act(room, { type: "offerTrade", targetId: player.id, give: { ore: 1 }, want: { wood: 1 } }, peer);
  assert.equal(opportunity(room).id, id);
  const offered = structuredClone(room.trade);
  room.hostId = peer.id;
  player.connected = false;
  room.revision += 5;
  room.requests = [{ id: "server-receipt", playerId: peer.id }];
  appendPublicEvent(room, { type: "admin.transferred", actorId: player.id,
    message: "Administration transferred.", data: { fromPlayerId: player.id, toPlayerId: peer.id } });
  const seq = room.eventSequence;
  undo(room, id);
  assert.equal(room.hostId, peer.id);
  assert.equal(player.connected, false);
  assert.deepEqual(room.requests, [{ id: "server-receipt", playerId: peer.id }]);
  assert.deepEqual(room.trade, offered);
  assert.ok(room.eventSequence > seq);
  assert.equal(peer.resources.ore, 1);
  assert.equal(player.resources.wood, 3);
  conserved(room);
});

for (const event of ["cancel", "decline", "accept"]) {
  test(`trade ${event} ${event === "accept" ? "invalidates" : "preserves"} placement undo`, () => {
    const room = fixture();
    const player = actor(room);
    const peer = room.players[1];
    seedStructure(room);
    give(room, player, { wood: 3, brick: 1 });
    give(room, peer, { ore: 1 });
    act(room, { type: "buildRoad", edgeId: legal(room).roadEdges[0] });
    const id = opportunity(room).id;
    act(room, { type: "offerTrade", targetId: peer.id, give: { wood: 1 }, want: { ore: 1 } });
    if (event === "cancel") act(room, { type: "cancelTrade", tradeId: room.trade.id });
    else act(room, { type: "respondTrade", tradeId: room.trade.id, accept: event === "accept" }, peer);
    if (event === "accept") {
      assert.equal(opportunity(room), null);
      rejected(room, { type: "undoPlacement", placementId: id });
      assert.equal(peer.resources.wood, 1);
    } else {
      assert.equal(opportunity(room).id, id);
      undo(room);
      assert.equal(room.trade, null);
    }
    conserved(room);
  });
}

for (const barrier of ["buyDevelopment", "bankTrade", "playDevelopment", "endTurn", "resign"]) {
  test(`successful ${barrier} is an irreversible placement-undo barrier`, () => {
    const room = fixture(4);
    const player = actor(room);
    seedStructure(room);
    give(room, player, { wood: 6, brick: 1, sheep: 1, wheat: 1, ore: 1 });
    const development = card(room, "monopoly");
    act(room, { type: "buildRoad", edgeId: legal(room).roadEdges[0] });
    const id = opportunity(room).id;
    if (barrier === "resign") resignPlayer(room, room.players[2].id);
    else act(room, { type: barrier, giveResource: "wood", receiveResource: "ore", cardId: development.id, resource: "brick" });
    assert.equal(view(room, player).undoPlacement, null);
    rejected(room, { type: "undoPlacement", placementId: id }, player);
    conserved(room);
  });
}

test("opponent, spectator, past-turn, winning and journal-less undo requests are rejected atomically", () => {
  const room = fixture();
  const player = actor(room);
  seedStructure(room);
  give(room, player, COSTS.road);
  act(room, { type: "buildRoad", edgeId: legal(room).roadEdges[0] });
  const id = opportunity(room).id;
  const journal = structuredClone(room.placementUndoJournal);
  rejected(room, { type: "undoPlacement", placementId: id }, room.players[1]);
  rejected(room, { type: "undoPlacement", placementId: id }, { id: "outsider" });
  act(room, { type: "endTurn" });
  for (let i = 0; i < 2; i += 1) {
    act(room, { type: "roll" });
    act(room, { type: "endTurn" });
  }
  assert.equal(actor(room).id, player.id);
  room.placementUndoJournal = journal;
  assert.equal(opportunity(room), null);
  rejected(room, { type: "undoPlacement", placementId: id });
  delete room.placementUndoJournal;
  assert.equal(opportunity(room), null);
  rejected(room, { type: "undoPlacement", placementId: id });

  const winning = fixture();
  const winner = actor(winning);
  for (const v of winning.board.vertices.slice(0, 3)) seedStructure(winning, winner, v, "city");
  const site = seedStructure(winning, winner, winning.board.vertices[4]);
  card(winning, "victoryPoint");
  card(winning, "victoryPoint");
  give(winning, winner, COSTS.city);
  act(winning, { type: "buildCity", vertexId: site });
  assert.equal(winning.phase, "finished");
  assert.equal(winning.winnerId, winner.id);
  assert.equal(opportunity(winning), null);
  assert.equal(legal(winning).canUndoPlacement, false);
  rejected(winning, { type: "undoPlacement", placementId: "anything" });
});

test("dependency guards disable undo after out-of-band gameplay mutations instead of overwriting newer values", () => {
  for (const mutate of [
    (room) => give(room, room.players[1], { ore: 1 }),
    (room) => { room.board.edges.find((item) => !item.road).road = { playerId: room.players[1].id }; },
    (room) => { room.mapVersion += 1; },
    (room) => { room.players[1].knightsPlayed += 1; },
  ]) {
    const room = fixture();
    seedStructure(room);
    give(room, actor(room), COSTS.road);
    act(room, { type: "buildRoad", edgeId: legal(room).roadEdges[0] });
    const id = opportunity(room).id;
    mutate(room);
    assert.equal(opportunity(room), null);
    assert.equal(legal(room).canUndoPlacement, false);
    rejected(room, { type: "undoPlacement", placementId: id });
  }
});

function reordered(value) {
  if (Array.isArray(value)) return value.map(reordered);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().reverse().map((key) => [key, reordered(value[key])]));
  }
  return value;
}

test("public undo is owner-only, journals contain scoped inverses only, and guards survive JSONB-style key ordering", () => {
  let room = fixture();
  const player = actor(room);
  seedStructure(room);
  give(room, player, COSTS.road);
  act(room, { type: "buildRoad", edgeId: legal(room).roadEdges[0] });
  const offer = opportunity(room);
  assert.deepEqual(Object.keys(offer).sort(), ["count", "id", "label", "targetId", "type"]);
  assert.equal(view(room, room.players[1]).undoPlacement, null);
  assert.equal(publicState(room, "spectator").undoPlacement, null);
  const serializedPublic = JSON.stringify(view(room));
  assert.ok(!serializedPublic.includes("placementUndoJournal"));
  assert.ok(!serializedPublic.includes("afterGuard"));
  const serializedJournal = JSON.stringify(room.placementUndoJournal);
  assert.ok(!serializedJournal.includes("reconnectToken"));
  assert.ok(!serializedJournal.includes("developmentCards"));
  assert.ok(!serializedJournal.includes("snapshot"));
  for (const p of room.players) assert.ok(!serializedJournal.includes(p.reconnectToken));
  room = JSON.parse(JSON.stringify(reordered(room)));
  assert.equal(opportunity(room).id, offer.id);
  undo(room, offer.id);
  conserved(room);
});

function call(client, event, payload = {}) {
  return new Promise((resolve, reject) => {
    client.timeout(5000).emit(event, payload, (error, result) => error ? reject(error) : resolve(result));
  });
}
async function integration(t, room, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-placement-undo-"));
  const storage = createStorage({ dataDir, ...options });
  await storage.init();
  await storage.commitRoom(room);
  await storage.close();
  let service;
  let port;
  const clients = [];
  async function start() {
    service = createGameServer({ dataDir, ...options });
    port = await service.listen(0);
  }
  await start();
  t.after(async () => {
    clients.forEach((client) => client.close());
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    get service() { return service; },
    read() { return service.storage.getRoom(room.code); },
    async connect(player) {
      const client = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false });
      clients.push(client);
      client.on("state", (state) => { client.latest = state; });
      await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("connect_error", reject); });
      assert.equal((await call(client, "reconnectRoom", { code: room.code, reconnectToken: player.reconnectToken })).ok, true);
      return client;
    },
    async restart() {
      await service.close();
      clients.forEach((client) => client.close());
      await start();
    },
  };
}
const packet = (client, action) => ({
  ...action, requestId: crypto.randomUUID(), clientSeq: client.latest.nextSequence,
  expectedTurnNumber: client.latest.turnNumber,
});

for (const postgres of [false, true]) test(`sequenced ${postgres ? "PostgreSQL" : "SQLite"} undo survives reconnect/restart, preserves admin/receipts and replays exactly once`, {
  skip: postgres && !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const room = fixture();
  const player = actor(room);
  room.hostId = player.id;
  seedStructure(room);
  give(room, player, { wood: 2, brick: 2 });
  const options = {};
  if (postgres) {
    let url;
    try { url = new URL(process.env.TEST_DATABASE_URL); } catch { throw new Error("Invalid isolated PostgreSQL test URL"); }
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Only loopback PostgreSQL tests are allowed");
    assert.equal(decodeURIComponent(url.pathname.slice(1)), "hearthlands_test", "Only the dedicated test database is allowed");
    Object.assign(options, {
      databaseUrl: process.env.TEST_DATABASE_URL, databaseSsl: "disable",
      databaseSchema: `hearthlands_undo_test_${crypto.randomBytes(8).toString("hex")}`,
    });
  }
  const h = await integration(t, room, options);
  let client = await h.connect(player);
  const build = packet(client, { type: "buildRoad", edgeId: client.latest.legal.roadEdges[0] });
  assert.equal((await call(client, "gameAction", build)).ok, true);
  const first = client.latest.undoPlacement;
  assert.equal((await call(client, "gameAction", build)).ok, true);
  assert.equal(client.latest.undoPlacement.id, first.id);
  assert.equal(client.latest.undoPlacement.count, 1);
  const transfer = { requestId: crypto.randomUUID(), clientSeq: client.latest.nextSequence, playerId: room.players[1].id };
  assert.equal((await call(client, "transferAdmin", transfer)).ok, true);
  assert.equal(client.latest.undoPlacement.id, first.id);
  await h.restart();
  client = await h.connect(player);
  assert.equal(client.latest.undoPlacement.id, first.id);
  assert.equal(client.latest.hostId, room.players[1].id);
  const undoRequest = packet(client, { type: "undoPlacement", placementId: first.id });
  assert.equal((await call(client, "gameAction", undoRequest)).ok, true);
  assert.equal(client.latest.undoPlacement, null);
  assert.equal(client.latest.board.edges.find((item) => item.id === build.edgeId).road, null);
  const after = await h.read();
  assert.equal((await call(client, "gameAction", undoRequest)).ok, true);
  assert.deepEqual(await h.read(), after);
  await h.restart();
  client = await h.connect(player);
  assert.equal((await call(client, "gameAction", undoRequest)).ok, true);
  const saved = await h.read();
  assert.equal(saved.hostId, room.players[1].id);
  assert.equal(saved.players[0].resources.wood, 2);
  assert.ok(saved.requests.some((request) => request.id === build.requestId));
  assert.ok(saved.requests.some((request) => request.id === transfer.requestId));
  assert.ok(saved.requests.some((request) => request.id === undoRequest.requestId));
  const history = await h.service.storage.listEvents(room.code, { limit: 1000 });
  assert.equal(history.filter((event) => event.type === "placementUndone").length, 1);
  assert.equal(history.filter((event) => event.type === "roadBuilt" && event.data.edgeId === build.edgeId).length, 1);
  conserved(saved);
});

test("sequenced stale/failed requests save their receipts but preserve the latest legitimate undo", async (t) => {
  const room = fixture();
  const player = actor(room);
  graph(room, chain("v", 3));
  seedStructure(room, player, vertex(room, "v0"));
  give(room, player, { wood: 3, brick: 3 });
  const h = await integration(t, room);
  const client = await h.connect(player);
  await call(client, "gameAction", packet(client, { type: "buildRoad", edgeId: "e0" }));
  const old = client.latest.undoPlacement.id;
  await call(client, "gameAction", packet(client, { type: "buildRoad", edgeId: "e1" }));
  const latest = client.latest.undoPlacement.id;
  const failed = packet(client, { type: "undoPlacement", placementId: old });
  assert.equal((await call(client, "gameAction", failed)).ok, false);
  assert.equal(client.latest.undoPlacement.id, latest);
  const before = await h.read();
  assert.equal((await call(client, "gameAction", failed)).ok, false);
  assert.deepEqual(await h.read(), before);
  assert.equal((await call(client, "gameAction", packet(client, { type: "undoPlacement", placementId: latest }))).ok, true);
  assert.equal(client.latest.undoPlacement.id, old);
  conserved(await h.read());
});

test("peer trade acceptance is serialized against undo without losing either party's resource updates", async (t) => {
  const room = fixture();
  const [player, peer] = room.players;
  seedStructure(room);
  give(room, player, { wood: 3, brick: 1 });
  give(room, peer, { ore: 1 });
  const h = await integration(t, room);
  const client = await h.connect(player);
  const other = await h.connect(peer);
  const build = packet(client, { type: "buildRoad", edgeId: client.latest.legal.roadEdges[0] });
  await call(client, "gameAction", build);
  const placementId = client.latest.undoPlacement.id;
  await call(client, "gameAction", packet(client, { type: "offerTrade", targetId: peer.id, give: { wood: 1 }, want: { ore: 1 } }));
  const trade = (await h.read()).trade;
  const accept = call(other, "gameAction", packet(other, { type: "respondTrade", tradeId: trade.id, accept: true }));
  const reverse = call(client, "gameAction", packet(client, { type: "undoPlacement", placementId }));
  assert.equal((await accept).ok, true);
  const undone = await reverse;
  const saved = await h.read();
  assert.equal(saved.players[1].resources.wood, 1);
  assert.equal(saved.players[1].resources.ore, 0);
  assert.equal(saved.players[0].resources.ore, 1);
  assert.equal(saved.players[0].resources.wood, undone.ok ? 2 : 1);
  assert.equal(saved.board.edges.find((item) => item.id === build.edgeId).road === null, undone.ok);
  assert.equal(view(saved, saved.players[0]).undoPlacement, null);
  conserved(saved);
});

test("admin removal serialized against undo cannot revive the removed seat or overwrite returned resources", async (t) => {
  const room = fixture();
  const [player, administrator, target] = room.players;
  room.hostId = administrator.id;
  seedStructure(room);
  give(room, player, COSTS.road);
  give(room, target, { ore: 2 });
  const h = await integration(t, room);
  const client = await h.connect(player);
  const admin = await h.connect(administrator);
  const build = packet(client, { type: "buildRoad", edgeId: client.latest.legal.roadEdges[0] });
  await call(client, "gameAction", build);
  const placementId = client.latest.undoPlacement.id;
  const removal = call(admin, "removePlayer", {
    requestId: crypto.randomUUID(), clientSeq: admin.latest.nextSequence, playerId: target.id, confirmed: true,
  });
  const reverse = call(client, "gameAction", packet(client, { type: "undoPlacement", placementId }));
  assert.equal((await removal).ok, true);
  const undone = await reverse;
  const saved = await h.read();
  assert.equal(saved.players[2].resigned, true);
  assert.equal(saved.players[2].resources.ore, 0);
  assert.equal(saved.bank.ore, 19);
  assert.equal(saved.hostId, administrator.id);
  assert.equal(saved.board.edges.find((item) => item.id === build.edgeId).road === null, undone.ok);
  assert.equal(view(saved, saved.players[0]).undoPlacement, null);
  conserved(saved);
});

test("rematch does not carry a previous game's private placement journal into the new lobby", async (t) => {
  const room = fixture();
  const player = actor(room);
  room.hostId = player.id;
  seedStructure(room);
  give(room, player, COSTS.road);
  act(room, { type: "buildRoad", edgeId: legal(room).roadEdges[0] });
  const id = opportunity(room).id;
  room.phase = "finished";
  room.winnerId = player.id;
  const h = await integration(t, room);
  const client = await h.connect(player);
  assert.equal(client.latest.undoPlacement, null);
  assert.equal((await call(client, "rematch", { requestId: crypto.randomUUID(), clientSeq: client.latest.nextSequence })).ok, true);
  assert.equal(client.latest.phase, "lobby");
  assert.equal(client.latest.undoPlacement, null);
  assert.equal((await h.read()).placementUndoJournal, null);
  assert.equal((await call(client, "gameAction", packet(client, { type: "undoPlacement", placementId: id }))).ok, false);
});
