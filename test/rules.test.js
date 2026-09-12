"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RESOURCES, COSTS, createRoom, addPlayer, startGame, makeBoard, applyAction, publicState, resourceTotal,
} = require("../game");

function rng(seed = 12345) {
  return () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
function roomFor(count = 4, phase = "action") {
  const { room, player } = createRoom("Ada");
  for (let index = 1; index < count; index += 1) addPlayer(room, `Player${index}`);
  startGame(room, player.id, rng());
  if (phase !== "setup") {
    room.phase = phase;
    room.turnNumber = 1;
  }
  return room;
}
const active = (room) => room.players[room.turnIndex];
const act = (room, action, player = active(room), random = rng()) => applyAction(room, player.id, action, random);
const legal = (room, player = active(room)) => publicState(room, player.id).legal;
const vertex = (room, vertexId) => room.board.vertices.find((v) => v.id === vertexId);

function give(room, player, bundle) {
  for (const [resource, amount] of Object.entries(bundle)) {
    assert.ok(room.bank[resource] >= amount, `Test bank lacks ${resource}`);
    room.bank[resource] -= amount;
    player.resources[resource] += amount;
  }
}
function conserved(room) {
  const supply = room.players.length > 4 ? 24 : 19;
  for (const resource of RESOURCES) {
    assert.equal(room.bank[resource] + room.players.reduce((sum, p) => sum + p.resources[resource], 0), supply, resource);
    assert.ok(Number.isInteger(room.bank[resource]) && room.bank[resource] >= 0);
    for (const player of room.players) assert.ok(Number.isInteger(player.resources[resource]) && player.resources[resource] >= 0);
  }
}
function rejected(room, action, player = active(room), pattern) {
  const before = structuredClone(room);
  assert.throws(() => act(room, action, player), pattern);
  assert.deepEqual(room, before, "Rejected actions must not mutate any room state");
}
function card(room, player, type, boughtTurn = 0) {
  const index = room.developmentDeck.findIndex((c) => c.type === type);
  assert.notEqual(index, -1, `Test deck lacks ${type}`);
  const result = { ...room.developmentDeck.splice(index, 1)[0], boughtTurn };
  player.developmentCards.push(result);
  return result;
}
function settlement(room, player, target = room.board.vertices[0], kind = "settlement") {
  target.structure = { playerId: player.id, kind };
  if (kind === "settlement") player.settlementsLeft -= 1;
  else player.citiesLeft -= 1;
  return target;
}
function completeSetup(room) {
  const order = [];
  while (room.phase === "setup") {
    const player = active(room);
    order.push(player.id);
    const vertexId = legal(room).settlementVertices[0];
    assert.ok(vertexId, "Setup must have a legal settlement");
    act(room, { type: "setupSettlement", vertexId });
    const edgeId = legal(room).roadEdges[0];
    assert.ok(edgeId);
    act(room, { type: "setupRoad", edgeId });
    conserved(room);
  }
  return order;
}
function graph(room, pairs) {
  const names = [...new Set(pairs.flatMap(([a, b]) => [a, b]))];
  room.board = {
    tiles: [], ports: [],
    vertices: names.map((name, index) => ({
      id: name, x: index, y: 0, structure: null, adjacentTiles: [],
      adjacentVertices: pairs.filter(([a, b]) => a === name || b === name)
        .map(([a, b]) => a === name ? b : a),
    })),
    edges: pairs.map(([a, b, owner], index) => ({
      id: `e${index}`, vertices: [a, b], adjacentTiles: [],
      road: owner === undefined ? null : { playerId: room.players[owner].id },
    })),
  };
  for (const player of room.players) {
    player.roadsLeft = 15 - room.board.edges.filter((e) => e.road?.playerId === player.id).length;
  }
}
function chain(prefix, length, owner) {
  return Array.from({ length }, (_, index) => [`${prefix}${index}`, `${prefix}${index + 1}`, owner]);
}
function updateByRoll(room) {
  room.phase = "roll";
  act(room, { type: "roll" }, active(room), () => 0);
}

test("trade counterparties can counteroffer while stale and unrelated replacements fail", () => {
  const room = roomFor();
  const a = active(room);
  const [b, outsider] = room.players.filter((player) => player.id !== a.id);
  give(room, a, { wood: 2 });
  give(room, b, { ore: 2 });
  give(room, outsider, { sheep: 1 });
  act(room, { type: "offerTrade", targetId: b.id, give: { wood: 1 }, want: { ore: 1 } }, a);
  const originalId = room.trade.id;
  assert.equal(legal(room, b).canOfferTrade, true);
  assert.equal(legal(room, outsider).canOfferTrade, false);
  rejected(room, { type: "offerTrade", targetId: a.id, give: { sheep: 1 }, want: { wood: 1 }, replaceTradeId: originalId }, outsider);
  act(room, { type: "offerTrade", targetId: a.id, give: { ore: 1 }, want: { wood: 2 }, replaceTradeId: originalId }, b);
  rejected(room, { type: "respondTrade", accept: true, tradeId: originalId }, a);
  rejected(room, { type: "cancelTrade", tradeId: originalId }, b);
  act(room, { type: "respondTrade", accept: true, tradeId: room.trade.id }, a);
  assert.equal(a.resources.ore, 1);
  assert.equal(b.resources.wood, 2);
  conserved(room);
});

test("trade availability does not reveal opponents' private resource types", () => {
  const room = roomFor();
  const a = active(room);
  const b = room.players.find((player) => player.id !== a.id);
  give(room, a, { wood: 1 });
  give(room, b, { wood: 1 });
  const before = legal(room, a).canOfferTrade;
  room.bank.wood++;
  b.resources.wood--;
  room.bank.ore--;
  b.resources.ore++;
  assert.equal(legal(room, a).canOfferTrade, before);
  assert.equal(before, true);
});

for (const count of [3, 4, 5, 6]) {
  test(`${count}-player exact board/deck/bank inventories and manifold topology`, () => {
    const room = roomFor(count);
    const expanded = count > 4;
    const board = room.board;
    assert.equal(board.tiles.length, expanded ? 30 : 19);
    assert.equal(board.vertices.length, expanded ? 80 : 54);
    assert.equal(board.edges.length, expanded ? 109 : 72);
    assert.equal(board.vertices.length - board.edges.length + board.tiles.length, 1);
    const terrainCounts = expanded ? [6, 5, 6, 6, 5, 2] : [4, 3, 4, 4, 3, 1];
    [...RESOURCES, "desert"].forEach((resource, index) => {
      assert.equal(board.tiles.filter((tile) => tile.resource === resource).length, terrainCounts[index]);
    });
    for (const number of [2, 3, 4, 5, 6, 8, 9, 10, 11, 12]) {
      const expected = number === 2 || number === 12 ? (expanded ? 2 : 1) : (expanded ? 3 : 2);
      assert.equal(board.tiles.filter((tile) => tile.number === number).length, expected);
    }
    assert.equal(board.tiles.filter((tile) => tile.robber).length, 1);
    assert.ok(board.tiles.find((tile) => tile.robber).resource === "desert");
    const coordinates = new Set(board.vertices.map((v) => `${Math.round(v.x * 1e6)},${Math.round(v.y * 1e6)}`));
    assert.equal(coordinates.size, board.vertices.length);
    const edgeKeys = new Set(board.edges.map((e) => [...e.vertices].sort().join(":")));
    assert.equal(edgeKeys.size, board.edges.length);
    for (const tile of board.tiles) {
      assert.equal(new Set(tile.vertices).size, 6);
      assert.equal(new Set(tile.edges).size, 6);
    }
    for (const edge of board.edges) {
      assert.ok(edge.adjacentTiles.length === 1 || edge.adjacentTiles.length === 2);
      const [a, b] = edge.vertices.map((v) => vertex(room, v));
      assert.ok(a.adjacentVertices.includes(b.id) && b.adjacentVertices.includes(a.id));
      assert.ok(Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - 1) < 1e-10);
    }
    const visited = new Set([board.vertices[0].id]);
    for (const vertexId of visited) for (const neighbour of vertex(room, vertexId).adjacentVertices) visited.add(neighbour);
    assert.equal(visited.size, board.vertices.length);
    const expectedDeck = expanded ? [20, 3, 3, 3, 5] : [14, 2, 2, 2, 5];
    ["knight", "roadBuilding", "yearOfPlenty", "monopoly", "victoryPoint"].forEach((type, index) => {
      assert.equal(room.developmentDeck.filter((c) => c.type === type).length, expectedDeck[index]);
    });
    assert.equal(room.developmentDeck.length, expanded ? 34 : 25);
    assert.equal(new Set(room.developmentDeck.map((c) => c.id)).size, room.developmentDeck.length);
    conserved(room);
    assert.deepEqual(JSON.parse(JSON.stringify(room)), room);
  });

  test(`${count}-player ports are boundary edges with disjoint junctions and exact types`, () => {
    const board = makeBoard(rng(2), count);
    assert.equal(board.ports.length, count > 4 ? 11 : 9);
    const endpoints = new Set();
    for (const port of board.ports) {
      const edge = board.edges.find((e) => port.vertices.every((v) => e.vertices.includes(v)));
      assert.equal(edge.adjacentTiles.length, 1);
      for (const v of port.vertices) {
        assert.ok(!endpoints.has(v), "Ports must not share a junction");
        endpoints.add(v);
      }
    }
    assert.equal(board.ports.filter((p) => p.resource === null).length, count > 4 ? 5 : 4);
    for (const resource of RESOURCES) {
      assert.equal(board.ports.filter((p) => p.resource === resource).length, count > 4 && resource === "sheep" ? 2 : 1);
    }
  });

  test(`${count}-player snake setup gives only second-settlement resources and two pieces each`, () => {
    const room = roomFor(count, "setup");
    const ids = room.players.map((p) => p.id);
    const order = completeSetup(room);
    assert.deepEqual(order, [...ids, ...ids].slice(0, count).concat([...ids].reverse()));
    assert.equal(room.phase, "roll");
    assert.equal(room.turnNumber, 1);
    assert.equal(active(room).id, ids[0]);
    assert.equal(room.turnRole, "primary");
    for (const player of room.players) {
      assert.equal(player.settlementsLeft, 3);
      assert.equal(player.roadsLeft, 13);
      assert.equal(player.points, 2);
      assert.ok(resourceTotal(player) <= 3);
    }
    conserved(room);
  });
}

test("number placement is bounded for constant RNG and never places adjacent 6/8", () => {
  for (const count of [3, 4, 5, 6]) {
    for (const random of [() => 0, () => 0.42, () => 0.999999, ...Array.from({ length: 40 }, (_, i) => rng(i))]) {
      const board = makeBoard(random, count);
      for (const edge of board.edges) {
        const red = edge.adjacentTiles.filter((tileId) => {
          const number = board.tiles.find((t) => t.id === tileId).number;
          return number === 6 || number === 8;
        });
        assert.ok(red.length < 2);
      }
    }
  }
});

test("setup authorization, spacing, piece limits, and mandatory adjacent road are atomic", () => {
  const room = roomFor(6, "setup");
  const first = active(room);
  const target = room.board.vertices[0];
  rejected(room, { type: "setupSettlement", vertexId: target.id }, room.players[1]);
  rejected(room, { type: "roll" });
  act(room, { type: "setupSettlement", vertexId: target.id });
  assert.equal(resourceTotal(first), 0);
  rejected(room, { type: "setupSettlement", vertexId: legal(room).settlementVertices[0] });
  rejected(room, { type: "setupRoad", edgeId: room.board.edges.find((e) => !e.vertices.includes(target.id)).id });
  act(room, { type: "setupRoad", edgeId: legal(room).roadEdges[0] });
  rejected(room, { type: "setupSettlement", vertexId: target.id });
  rejected(room, { type: "setupSettlement", vertexId: target.adjacentVertices[0] });
  active(room).settlementsLeft = 0;
  assert.deepEqual(legal(room).settlementVertices, []);
  rejected(room, { type: "setupSettlement", vertexId: room.board.vertices.find((v) =>
    !v.structure && v.adjacentVertices.every((other) => !vertex(room, other).structure)).id });
  conserved(room);
});

test("second setup settlement draws only what remains in finite bank", () => {
  const room = roomFor(6, "setup");
  room.setupRound = 1;
  const player = active(room);
  for (const resource of RESOURCES) give(room, room.players[1], { [resource]: room.bank[resource] });
  act(room, { type: "setupSettlement", vertexId: legal(room).settlementVertices[0] });
  assert.equal(resourceTotal(player), 0);
  conserved(room);
});

for (const count of [3, 4, 5, 6]) {
  test(`${count}-player activation order and secondary restrictions`, () => {
    const room = roomFor(count, "roll");
    const order = [];
    for (let primary = 0; primary < count * 2; primary += 1) {
      assert.equal(room.turnRole, "primary");
      assert.equal(room.turnIndex, primary % count);
      assert.equal(room.phase, "roll");
      assert.equal(room.dice, null);
      assert.equal(legal(room).canRoll, true);
      order.push(room.turnNumber);
      rejected(room, { type: "endTurn" });
      act(room, { type: "roll" }, active(room), () => 0);
      act(room, { type: "endTurn" });
      if (count > 4) {
        assert.equal(room.turnRole, "secondary");
        assert.equal(room.turnIndex, (primary + 3) % count);
        assert.equal(room.phase, "action");
        assert.equal(legal(room).canRoll, false);
        assert.equal(legal(room).canOfferTrade, false);
        const state = publicState(room, active(room).id);
        assert.equal(state.currentPlayerId, state.secondaryPlayerId);
        assert.equal(state.primaryPlayerId, room.players[primary % count].id);
        rejected(room, { type: "roll" });
        rejected(room, { type: "offerTrade", targetId: room.players[(room.turnIndex + 1) % count].id,
          give: { wood: 1 }, want: { ore: 1 } });
        rejected(room, { type: "respondTrade", accept: true });
        order.push(room.turnNumber);
        act(room, { type: "endTurn" });
      }
    }
    assert.deepEqual(order, Array.from({ length: order.length }, (_, i) => i + 1));
  });
}

test("paid construction conserves cards, caps pieces, and returns settlement on city upgrade", () => {
  const room = roomFor();
  const player = active(room);
  const home = settlement(room, player);
  give(room, player, { wood: 5, brick: 5, sheep: 2, wheat: 6, ore: 6 });
  const road1 = legal(room).roadEdges[0];
  act(room, { type: "buildRoad", edgeId: road1 });
  assert.equal(player.roadsLeft, 14);
  assert.equal(player.resources.wood, 4);
  const tip = room.board.edges.find((e) => e.id === road1).vertices.find((v) => v !== home.id);
  const road2 = legal(room).roadEdges.find((edgeId) => room.board.edges.find((e) => e.id === edgeId).vertices.includes(tip));
  act(room, { type: "buildRoad", edgeId: road2 });
  const newSite = legal(room).settlementVertices[0];
  assert.ok(newSite);
  act(room, { type: "buildSettlement", vertexId: newSite });
  assert.equal(player.points, 2);
  const beforeSettlementPieces = player.settlementsLeft;
  act(room, { type: "buildCity", vertexId: newSite });
  assert.equal(player.points, 3);
  assert.equal(player.citiesLeft, 3);
  assert.equal(player.settlementsLeft, beforeSettlementPieces + 1);
  rejected(room, { type: "buildCity", vertexId: newSite });
  player.citiesLeft = 0;
  assert.deepEqual(legal(room).cityVertices, []);
  rejected(room, { type: "buildCity", vertexId: home.id });
  player.roadsLeft = 0;
  assert.deepEqual(legal(room).roadEdges, []);
  rejected(room, { type: "buildRoad", edgeId: room.board.edges.find((e) => !e.road).id });
  conserved(room);
});

test("roads cannot pass through opponents' settlements and disconnected builds fail", () => {
  const room = roomFor();
  graph(room, [["a", "b", 0], ["b", "c"], ["c", "d"]]);
  settlement(room, room.players[1], vertex(room, "b"));
  give(room, active(room), COSTS.road);
  assert.deepEqual(legal(room).roadEdges, []);
  rejected(room, { type: "buildRoad", edgeId: "e1" });
  rejected(room, { type: "buildRoad", edgeId: "e2" });
  give(room, active(room), COSTS.settlement);
  rejected(room, { type: "buildSettlement", vertexId: "d" });
  rejected(room, { type: "buildSettlement", vertexId: "a" });
});

test("city and settlement production is aggregated by resource and robber blocks only occupied hex", () => {
  const room = roomFor(4, "roll");
  const [a, b] = room.players;
  for (const tile of room.board.tiles) tile.number = null;
  const producing = room.board.tiles.find((t) => !t.robber && t.resource === "wood");
  producing.number = 2;
  settlement(room, a, vertex(room, producing.vertices[0]), "city");
  settlement(room, b, vertex(room, producing.vertices[3]));
  act(room, { type: "roll" }, a, () => 0);
  assert.equal(a.resources.wood, 2);
  assert.equal(b.resources.wood, 1);
  room.phase = "roll";
  room.board.tiles.forEach((t) => { t.robber = t.id === producing.id; });
  act(room, { type: "roll" }, a, () => 0);
  assert.equal(a.resources.wood, 2);
  assert.equal(b.resources.wood, 1);
  conserved(room);
});

test("multi-player supply shortage pays nobody of that type but pays other resources", () => {
  const room = roomFor(4, "roll");
  const [a, b, c] = room.players;
  for (const tile of room.board.tiles) tile.number = null;
  const wood = room.board.tiles.find((t) => t.resource === "wood");
  wood.number = 2;
  settlement(room, a, vertex(room, wood.vertices[0]), "city");
  settlement(room, b, vertex(room, wood.vertices[3]));
  give(room, c, { wood: 17 });
  const ore = room.board.tiles.find((t) => t.resource === "ore" &&
    t.vertices.some((v) => !vertex(room, v).structure));
  ore.number = 2;
  settlement(room, a, vertex(room, ore.vertices.find((v) => !vertex(room, v).structure)));
  act(room, { type: "roll" }, a, () => 0);
  assert.equal(a.resources.wood, 0);
  assert.equal(b.resources.wood, 0);
  assert.equal(room.bank.wood, 2);
  assert.ok(a.resources.ore >= 1);
  conserved(room);
});

test("a single resource recipient receives the remaining bank supply across multiple claims", () => {
  const room = roomFor(4, "roll");
  for (const tile of room.board.tiles) tile.number = null;
  const wood = room.board.tiles.find((t) => t.resource === "wood");
  wood.number = 2;
  settlement(room, active(room), vertex(room, wood.vertices[0]), "city");
  settlement(room, active(room), vertex(room, wood.vertices[3]), "city");
  give(room, room.players[1], { wood: 16 });
  act(room, { type: "roll" }, active(room), () => 0);
  assert.equal(active(room).resources.wood, 3);
  assert.equal(room.bank.wood, 0);
  conserved(room);
});

test("seven requires chosen exact discards from every large hand before chosen robber victim", () => {
  const room = roomFor(4, "roll");
  const [a, b, c, d] = room.players;
  give(room, a, { wood: 5, brick: 4 });
  give(room, b, { sheep: 9, wheat: 2 });
  give(room, c, { ore: 7 });
  card(room, c, "knight");
  card(room, c, "victoryPoint");
  let die = 0;
  act(room, { type: "roll" }, a, () => die++ === 0 ? 0 : 0.999);
  assert.equal(room.phase, "discard");
  assert.deepEqual(room.pendingDiscards, { [a.id]: 4, [b.id]: 5 });
  const tile = room.board.tiles.find((t) => !t.robber);
  settlement(room, b, vertex(room, tile.vertices[0]));
  settlement(room, c, vertex(room, tile.vertices[3]));
  rejected(room, { type: "moveRobber", tileId: tile.id });
  rejected(room, { type: "discard", resources: { ore: 3 } }, c);
  rejected(room, { type: "discard", resources: { sheep: 4 } }, b);
  rejected(room, { type: "discard", resources: { wood: 5 } }, b);
  act(room, { type: "discard", resources: { sheep: 5 } }, b);
  assert.equal(room.phase, "discard");
  rejected(room, { type: "moveRobber", tileId: tile.id });
  rejected(room, { type: "endTurn" });
  act(room, { type: "discard", resources: { wood: 1, brick: 3 } }, a);
  assert.equal(room.phase, "robber");
  assert.equal(legal(room).robberTiles.length, room.board.tiles.length - 1);
  rejected(room, { type: "moveRobber", tileId: room.board.tiles.find((t) => t.robber).id });
  act(room, { type: "moveRobber", tileId: tile.id });
  assert.equal(room.phase, "steal");
  assert.deepEqual(new Set(room.robberVictims), new Set([b.id, c.id]));
  rejected(room, { type: "steal", targetId: d.id });
  rejected(room, { type: "steal", targetId: a.id }, b);
  act(room, { type: "steal", targetId: c.id }, a, () => 0);
  assert.equal(a.resources.ore, 1);
  assert.equal(c.resources.ore, 6);
  assert.equal(room.phase, "action");
  assert.deepEqual(room.pendingDiscards, {});
  assert.deepEqual(room.robberVictims, []);
  conserved(room);
});

test("theft random selection is uniform over resource cards, not resource categories", () => {
  for (const [roll, expected] of [[0, "wood"], [0.49, "wood"], [0.89, "wood"], [0.9, "ore"], [0.999, "ore"]]) {
    const room = roomFor();
    const [a, b] = room.players;
    give(room, b, { wood: 9, ore: 1 });
    room.phase = "steal";
    room.robberReturnPhase = "action";
    room.robberVictims = [b.id];
    act(room, { type: "steal", targetId: b.id }, a, () => roll);
    assert.equal(a.resources[expected], 1);
    conserved(room);
  }
});

test("moving robber to no eligible victims completes immediately, including desert", () => {
  const room = roomFor();
  const knight = card(room, active(room), "knight");
  act(room, { type: "playDevelopment", cardId: knight.id });
  const tile = room.board.tiles.find((t) => !t.robber);
  settlement(room, room.players[1], vertex(room, tile.vertices[0]));
  act(room, { type: "moveRobber", tileId: tile.id });
  assert.equal(room.phase, "action");
  assert.equal(room.mustMoveRobber, false);
});

test("ports use best accessible rate and exchange one batch with finite bank", () => {
  const room = roomFor();
  const player = active(room);
  give(room, player, { wood: 12 });
  assert.equal(publicState(room, player.id).players[0].tradeRates.wood, 4);
  act(room, { type: "bankTrade", giveResource: "wood", receiveResource: "ore" });
  assert.equal(player.resources.wood, 8);
  const generic = room.board.ports.find((p) => p.resource === null);
  settlement(room, player, vertex(room, generic.vertices[0]));
  assert.equal(publicState(room, player.id).players[0].tradeRates.wood, 3);
  act(room, { type: "bankTrade", giveResource: "wood", receiveResource: "ore" });
  assert.equal(player.resources.wood, 5);
  const lumber = room.board.ports.find((p) => p.resource === "wood");
  settlement(room, player, vertex(room, lumber.vertices[0]));
  const rates = publicState(room, player.id).players[0].tradeRates;
  assert.equal(rates.wood, 2);
  assert.equal(rates.ore, 3);
  act(room, { type: "bankTrade", giveResource: "wood", receiveResource: "ore" });
  assert.equal(player.resources.wood, 3);
  give(room, room.players[1], { ore: room.bank.ore });
  rejected(room, { type: "bankTrade", giveResource: "wood", receiveResource: "ore" });
  rejected(room, { type: "bankTrade", giveResource: "wood", receiveResource: "wood" });
  rejected(room, { type: "bankTrade", giveResource: "__proto__", receiveResource: "ore" });
  conserved(room);
});

test("secondary may build, bank trade, buy and play one older development card", () => {
  const room = roomFor(6);
  act(room, { type: "endTurn" });
  const player = active(room);
  settlement(room, player);
  give(room, player, { wood: 5, brick: 1, sheep: 1, wheat: 1, ore: 1 });
  const monopoly = card(room, player, "monopoly");
  const knight = card(room, player, "knight");
  act(room, { type: "buildRoad", edgeId: legal(room).roadEdges[0] });
  act(room, { type: "bankTrade", giveResource: "wood", receiveResource: "ore" });
  act(room, { type: "buyDevelopment" });
  act(room, { type: "playDevelopment", cardId: monopoly.id, resource: "brick" });
  rejected(room, { type: "playDevelopment", cardId: knight.id });
  rejected(room, { type: "offerTrade", targetId: room.players[0].id, give: { ore: 1 }, want: { wood: 1 } });
  conserved(room);
});

test("domestic trades may be initiated off-turn only to primary and transfer on literal acceptance", () => {
  const room = roomFor();
  const [a, b, c] = room.players;
  give(room, a, { ore: 3 });
  give(room, b, { wood: 3 });
  give(room, c, { wheat: 1 });
  assert.equal(legal(room, b).canOfferTrade, true);
  rejected(room, { type: "offerTrade", targetId: c.id, give: { wood: 1 }, want: { wheat: 1 } }, b);
  act(room, { type: "offerTrade", targetId: a.id, give: { wood: 2 }, want: { ore: 1 } }, b);
  assert.equal(a.resources.wood, 0);
  assert.equal(b.resources.ore, 0);
  rejected(room, { type: "offerTrade", targetId: b.id, give: { ore: 1 }, want: { wood: 1 } }, a);
  rejected(room, { type: "respondTrade", accept: true }, c);
  for (const accept of ["true", "false", 1, 0, null, {}, []]) {
    rejected(room, { type: "respondTrade", accept }, a);
  }
  rejected(room, { type: "respondTrade", accept: true, tradeId: "stale" }, a);
  act(room, { type: "respondTrade", accept: true, tradeId: room.trade.id }, a);
  assert.equal(a.resources.wood, 2);
  assert.equal(a.resources.ore, 2);
  assert.equal(b.resources.wood, 1);
  assert.equal(b.resources.ore, 1);
  assert.equal(room.trade, null);
  conserved(room);
});

test("trade rejects gifts, overlap, unavailable cards, hostile amounts, and unauthorized cancellation", () => {
  const room = roomFor();
  const [a, b] = room.players;
  give(room, a, { wood: 4, ore: 1 });
  give(room, b, { ore: 1 });
  const offer = { type: "offerTrade", targetId: b.id, give: { wood: 1 }, want: { ore: 1 } };
  for (const giveBundle of [{}, { wood: 0 }, { wood: "1" }, { wood: true }, { wood: null },
    { wood: NaN }, { wood: Infinity }, { wood: -1 }, { wood: 0.5 }, { wood: 25 },
    { wood: Number.MAX_SAFE_INTEGER }, { gold: 1 }, { toString: 1 },
    JSON.parse('{"__proto__":1}'), [], "wood", null]) {
    rejected(room, { ...offer, give: giveBundle });
  }
  rejected(room, { ...offer, want: {} });
  rejected(room, { ...offer, want: { wood: 1, ore: 1 } });
  rejected(room, { ...offer, give: { brick: 1 } });
  rejected(room, { ...offer, targetId: a.id });
  rejected(room, { ...offer, targetId: "outsider" });
  act(room, offer);
  rejected(room, { type: "cancelTrade" }, b);
  act(room, { type: "cancelTrade" }, a);
  act(room, offer);
  act(room, { type: "respondTrade", accept: false }, b);
  assert.equal(a.resources.wood, 4);
  act(room, offer);
  const unavailableOfferId = room.trade.id;
  act(room, { type: "bankTrade", giveResource: "wood", receiveResource: "wheat" }, a);
  rejected(room, { type: "respondTrade", accept: true }, b);
  assert.equal(room.trade, null, "Spending the offered cards cancels an offer that can no longer be fulfilled");
  assert.ok(room.log.some((event) => event.type === "tradeCancelled" &&
    event.data.tradeId === unavailableOfferId && event.data.reason === "offered-resources-spent"));
  act(room, { type: "endTurn" });
  assert.equal(room.trade, null);
  conserved(room);
});

test("buying development pays finite bank, hides type, and prevents playing it in same activation", () => {
  const room = roomFor();
  const player = active(room);
  give(room, player, { sheep: 2, wheat: 2, ore: 2 });
  const knightIndex = room.developmentDeck.findIndex((c) => c.type === "knight");
  room.developmentDeck.push(...room.developmentDeck.splice(knightIndex, 1));
  const oldDeckLength = room.developmentDeck.length;
  act(room, { type: "buyDevelopment" });
  const bought = player.developmentCards[0];
  assert.equal(bought.type, "knight");
  assert.equal(bought.boughtTurn, room.turnNumber);
  assert.equal(room.developmentDeck.length, oldDeckLength - 1);
  assert.equal(player.resources.ore, 1);
  assert.equal(publicState(room, player.id).players[0].developmentCards[0].playable, false);
  rejected(room, { type: "playDevelopment", cardId: bought.id });
  room.developmentDeck = [];
  assert.equal(legal(room).canBuyDevelopment, false);
  rejected(room, { type: "buyDevelopment" });
  conserved(room);
});

for (const count of [5, 6]) {
  for (const firstRole of ["primary", "secondary"]) {
    test(`${count}-player development ages from ${firstRole} to owner's next activation`, () => {
      const room = roomFor(count);
      if (firstRole === "secondary") act(room, { type: "endTurn" });
      const player = active(room);
      give(room, player, COSTS.development);
      const index = room.developmentDeck.findIndex((c) => c.type === "monopoly");
      room.developmentDeck.push(...room.developmentDeck.splice(index, 1));
      act(room, { type: "buyDevelopment" });
      const bought = player.developmentCards[0];
      rejected(room, { type: "playDevelopment", cardId: bought.id, resource: "wood" });
      act(room, { type: "endTurn" });
      for (let guard = 0; active(room).id !== player.id && guard < 12; guard += 1) {
        if (room.phase === "roll") act(room, { type: "roll" }, active(room), () => 0);
        act(room, { type: "endTurn" });
      }
      assert.equal(active(room).id, player.id);
      assert.notEqual(room.turnRole, firstRole);
      assert.equal(legal(room).playableCardIds.includes(bought.id), true);
      act(room, { type: "playDevelopment", cardId: bought.id, resource: "wood" });
      assert.equal(room.developmentPlayed, true);
      conserved(room);
    });
  }
}

for (const phase of ["roll", "action"]) {
  for (const type of ["knight", "roadBuilding", "yearOfPlenty", "monopoly"]) {
    test(`${type} can be played during ${phase}, consumes exactly one development allowance`, () => {
      const room = roomFor(4, phase);
      const player = active(room);
      settlement(room, player);
      const chosen = card(room, player, type);
      const other = card(room, player, "knight");
      give(room, room.players[1], { wood: 2 });
      const action = { type: "playDevelopment", cardId: chosen.id,
        resource: "wood", resources: { wheat: 1, ore: 1 } };
      assert.ok(legal(room).playableCardIds.includes(chosen.id));
      act(room, action);
      assert.equal(player.developmentCards.some((c) => c.id === chosen.id), false);
      assert.equal(room.developmentPlayed, true);
      if (type === "knight") {
        assert.equal(player.knightsPlayed, 1);
        assert.equal(room.phase, "robber");
        assert.deepEqual(room.pendingDiscards, {});
        act(room, { type: "moveRobber", tileId: legal(room).robberTiles[0] });
      } else if (type === "roadBuilding") {
        assert.equal(room.freeRoadsRemaining, 2);
        assert.equal(legal(room).canRoll, false);
        rejected(room, { type: "endTurn" });
        act(room, { type: "buildRoad", edgeId: legal(room).roadEdges[0] });
        assert.equal(room.freeRoadsRemaining, 1);
        act(room, { type: "buildRoad", edgeId: legal(room).roadEdges[0] });
        assert.equal(room.freeRoadsRemaining, 0);
        assert.equal(resourceTotal(player), 0);
      } else if (type === "yearOfPlenty") {
        assert.equal(player.resources.wheat, 1);
        assert.equal(player.resources.ore, 1);
      } else {
        assert.equal(player.resources.wood, 2);
        assert.equal(room.players[1].resources.wood, 0);
      }
      assert.equal(room.phase, phase);
      rejected(room, { type: "playDevelopment", cardId: other.id });
      conserved(room);
    });
  }
}

test("knight before roll steals then returns to roll without causing any discards", () => {
  const room = roomFor(4, "roll");
  const [a, b] = room.players;
  give(room, b, { wood: 10 });
  const target = room.board.tiles.find((t) => !t.robber);
  settlement(room, b, vertex(room, target.vertices[0]));
  const knight = card(room, a, "knight");
  act(room, { type: "playDevelopment", cardId: knight.id });
  assert.deepEqual(room.pendingDiscards, {});
  act(room, { type: "moveRobber", tileId: target.id });
  assert.equal(room.phase, "steal");
  act(room, { type: "steal", targetId: b.id });
  assert.equal(room.phase, "roll");
  assert.equal(b.resources.wood, 9);
  assert.equal(legal(room).canRoll, true);
  conserved(room);
});

test("Road Building permits forfeiture, caps remaining pieces, and auto-completes when no extension exists", () => {
  for (const roadsLeft of [1, 2, 15]) {
    const room = roomFor(4, "roll");
    graph(room, [["a", "b"], ["b", "c", 1]]);
    settlement(room, active(room), vertex(room, "a"));
    settlement(room, room.players[1], vertex(room, "b"));
    active(room).roadsLeft = roadsLeft;
    const roadCard = card(room, active(room), "roadBuilding");
    act(room, { type: "playDevelopment", cardId: roadCard.id });
    assert.equal(room.freeRoadsRemaining, Math.min(roadsLeft, 2));
    act(room, { type: "buildRoad", edgeId: "e0" });
    assert.equal(room.freeRoadsRemaining, 0);
    assert.equal(room.phase, "roll");
  }
  const room = roomFor();
  settlement(room, active(room));
  const roadCard = card(room, active(room), "roadBuilding");
  act(room, { type: "playDevelopment", cardId: roadCard.id });
  act(room, { type: "finishFreeRoads" });
  assert.equal(room.phase, "action");
  assert.equal(room.developmentPlayed, true);
  assert.equal(active(room).roadsLeft, 15);
  rejected(room, { type: "finishFreeRoads" });
});

test("Road Building cannot start with no pieces or no legal roads and blocks other actions while pending", () => {
  const room = roomFor();
  const roadCard = card(room, active(room), "roadBuilding");
  rejected(room, { type: "playDevelopment", cardId: roadCard.id });
  settlement(room, active(room));
  active(room).roadsLeft = 0;
  rejected(room, { type: "playDevelopment", cardId: roadCard.id });
  active(room).roadsLeft = 15;
  give(room, active(room), { wood: 4, wheat: 3, ore: 3, sheep: 1 });
  act(room, { type: "playDevelopment", cardId: roadCard.id });
  for (const action of [{ type: "roll" }, { type: "endTurn" }, { type: "buyDevelopment" },
    { type: "bankTrade", giveResource: "wood", receiveResource: "ore" },
    { type: "buildCity", vertexId: room.board.vertices[0].id }]) rejected(room, action);
  const hints = legal(room);
  assert.equal(hints.canBuyDevelopment, false);
  assert.equal(hints.canBankTrade, false);
  assert.equal(hints.canEndTurn, false);
  assert.equal(hints.canFinishFreeRoads, true);
  assert.deepEqual(hints.cityVertices, []);
  assert.deepEqual(hints.playableCardIds, []);
});

test("Invention requires exactly min(2, bank total), available resources, and rejects an empty bank", () => {
  const room = roomFor();
  const player = active(room);
  const plenty = card(room, player, "yearOfPlenty");
  for (const resources of [{}, { wood: 1 }, { wood: 3 }, { wood: "2" }, { wood: -1, ore: 3 }]) {
    rejected(room, { type: "playDevelopment", cardId: plenty.id, resources });
  }
  for (const resource of RESOURCES) give(room, room.players[1], { [resource]: room.bank[resource] });
  assert.ok(!legal(room).playableCardIds.includes(plenty.id));
  rejected(room, { type: "playDevelopment", cardId: plenty.id, resources: {} });
  room.players[1].resources.wood -= 1;
  room.bank.wood += 1;
  rejected(room, { type: "playDevelopment", cardId: plenty.id, resources: { wood: 1, ore: 1 } });
  rejected(room, { type: "playDevelopment", cardId: plenty.id, resources: { ore: 1 } });
  act(room, { type: "playDevelopment", cardId: plenty.id, resources: { wood: 1 } });
  assert.equal(player.resources.wood, 1);
  assert.equal(room.bank.wood, 0);
  conserved(room);
});

test("Monopoly takes all chosen cards from every opponent but none from the bank", () => {
  const room = roomFor(6);
  const player = active(room);
  const monopoly = card(room, player, "monopoly");
  give(room, player, { ore: 2 });
  for (const other of room.players.slice(1)) give(room, other, { ore: 3, wood: 1 });
  const bank = room.bank.ore;
  for (const resource of [undefined, null, "gold", "__proto__", {}, 3]) {
    rejected(room, { type: "playDevelopment", cardId: monopoly.id, resource });
  }
  act(room, { type: "playDevelopment", cardId: monopoly.id, resource: "ore" });
  assert.equal(player.resources.ore, 17);
  assert.equal(room.bank.ore, bank);
  assert.ok(room.players.slice(1).every((other) => other.resources.ore === 0 && other.resources.wood === 1));
  conserved(room);
});

test("Longest Road handles forks, full cycles, and cycles with tails as edge-simple trails", () => {
  for (const [pairs, expected] of [
    [[["o", "a", 0], ["a", "b", 0], ["o", "c", 0], ["c", "d", 0], ["o", "e", 0], ["e", "f", 0]], 4],
    [[...chain("a", 5, 0), ["a5", "a0", 0]], 6],
    [[...chain("a", 5, 0), ["a5", "a0", 0], ["a0", "tail", 0]], 7],
    [[...chain("a", 5, 0), ["a5", "a0", 0], ["a0", "tail", 0], ["a3", "tail2", 0]], 7],
  ]) {
    const room = roomFor();
    graph(room, pairs);
    updateByRoll(room);
    assert.equal(active(room).longestRoad, expected);
    assert.equal(room.longestRoadHolderId, expected >= 5 ? active(room).id : null);
  }
});

test("opponent settlements split longest road and an own structure does not", () => {
  const room = roomFor();
  graph(room, chain("a", 8, 0));
  settlement(room, active(room), vertex(room, "a4"));
  updateByRoll(room);
  assert.equal(active(room).longestRoad, 8);
  vertex(room, "a4").structure.playerId = room.players[1].id;
  updateByRoll(room);
  assert.equal(room.players[0].longestRoad, 4);
  assert.equal(room.longestRoadHolderId, null);
});

test("Longest Road incumbent retains tie, transfers on strictly longer trail, and unheld tie awards nobody", () => {
  const room = roomFor();
  graph(room, [...chain("a", 5, 0), ...chain("b", 5, 1), ["b5", "b6"]]);
  room.longestRoadHolderId = room.players[0].id;
  updateByRoll(room);
  assert.equal(room.longestRoadHolderId, room.players[0].id);
  room.turnIndex = 1;
  room.primaryIndex = 1;
  give(room, active(room), COSTS.road);
  act(room, { type: "buildRoad", edgeId: "e10" });
  assert.equal(room.longestRoadHolderId, room.players[1].id);
  room.board.edges.find((e) => e.id === "e10").road = null;
  room.longestRoadHolderId = null;
  updateByRoll(room);
  assert.equal(room.longestRoadHolderId, null);
});

test("a settlement cut removes incumbent bonus and leaves a new longest-road tie unawarded", () => {
  const room = roomFor();
  graph(room, [...chain("a", 6, 0), ...chain("b", 5, 1), ...chain("c", 5, 2), ["a3", "d", 3]]);
  updateByRoll(room);
  assert.equal(room.longestRoadHolderId, room.players[0].id);
  room.turnIndex = 3;
  room.primaryIndex = 3;
  give(room, active(room), COSTS.settlement);
  assert.ok(legal(room).settlementVertices.includes("a3"));
  act(room, { type: "buildSettlement", vertexId: "a3" });
  assert.equal(room.players[0].longestRoad, 3);
  assert.equal(room.longestRoadHolderId, null);
  assert.equal(room.players[0].points, 0);
});

test("Largest Army requires three knights, retains ties, and transfers on strict takeover", () => {
  const room = roomFor();
  const [a, b] = room.players;
  a.knightsPlayed = 2;
  updateByRoll(room);
  assert.equal(room.largestArmyHolderId, null);
  a.knightsPlayed = 3;
  updateByRoll(room);
  assert.equal(room.largestArmyHolderId, a.id);
  b.knightsPlayed = 3;
  updateByRoll(room);
  assert.equal(room.largestArmyHolderId, a.id);
  b.knightsPlayed = 4;
  updateByRoll(room);
  assert.equal(room.largestArmyHolderId, b.id);
});

test("third knight instantly wins for active player before compulsory robber continuation", () => {
  const room = roomFor(4, "roll");
  const player = active(room);
  for (const v of room.board.vertices.slice(0, 4)) settlement(room, player, v, "city");
  player.knightsPlayed = 2;
  const knight = card(room, player, "knight");
  act(room, { type: "playDevelopment", cardId: knight.id });
  assert.equal(room.winnerId, player.id);
  assert.equal(room.phase, "finished");
  assert.equal(player.points, 10);
  assert.equal(room.mustMoveRobber, false);
  assert.equal(legal(room).canRoll, false);
  rejected(room, { type: "moveRobber", tileId: room.board.tiles.find((t) => !t.robber).id });
});

test("hidden VP cards are not playable and a newly bought VP can win in secondary half", () => {
  const room = roomFor(6);
  act(room, { type: "endTurn" });
  const player = active(room);
  for (const v of room.board.vertices.slice(0, 4)) settlement(room, player, v, "city");
  const vp = card(room, player, "victoryPoint");
  rejected(room, { type: "playDevelopment", cardId: vp.id });
  const own = publicState(room, player.id).players.find((p) => p.id === player.id);
  const opponent = publicState(room, room.players[0].id).players.find((p) => p.id === player.id);
  assert.equal(own.points, 9);
  assert.equal(opponent.points, 8);
  give(room, player, COSTS.development);
  const index = room.developmentDeck.findIndex((c) => c.type === "victoryPoint");
  room.developmentDeck.push(...room.developmentDeck.splice(index, 1));
  act(room, { type: "buyDevelopment" });
  assert.equal(room.winnerId, player.id);
  assert.equal(player.points, 10);
  const revealed = publicState(room, room.players[0].id).players.find((p) => p.id === player.id);
  assert.equal(revealed.points, 10);
  assert.equal(revealed.revealedVictoryPoints, 2);
  assert.equal(revealed.developmentCards, undefined);
});

test("off-turn award gain does not win until that player's next primary or secondary activation", () => {
  const room = roomFor(6);
  const future = room.players[3];
  for (const v of room.board.vertices.slice(0, 4)) settlement(room, future, v, "city");
  future.knightsPlayed = 3;
  updateByRoll(room);
  assert.equal(future.points, 10);
  assert.equal(room.winnerId, null);
  act(room, { type: "endTurn" });
  assert.equal(active(room).id, future.id);
  assert.equal(room.turnRole, "secondary");
  assert.equal(room.phase, "finished");
  assert.equal(room.winnerId, future.id);
});

test("legal hints reflect affordability, actor, phase, supply, and piece limits", () => {
  const room = roomFor();
  const player = active(room);
  settlement(room, player);
  assert.deepEqual(legal(room).roadEdges, []);
  assert.equal(legal(room).canBuyDevelopment, false);
  assert.equal(legal(room).canBankTrade, false);
  give(room, player, { wood: 5, brick: 2, sheep: 1, wheat: 3, ore: 3 });
  assert.ok(legal(room).roadEdges.length);
  assert.equal(legal(room).canBuyDevelopment, true);
  assert.equal(legal(room).canBankTrade, true);
  assert.equal(legal(room).cityVertices.length, 1);
  assert.equal(legal(room, room.players[1]).canEndTurn, false);
  assert.deepEqual(legal(room, room.players[1]).roadEdges, []);
  room.phase = "discard";
  assert.deepEqual(legal(room).roadEdges, []);
  assert.equal(legal(room).canEndTurn, false);
  assert.equal(legal(room).canBankTrade, false);
  assert.deepEqual(legal(room).cityVertices, []);
  const spectator = publicState(room, "outsider").legal;
  assert.ok(Object.values(spectator).every((value) => Array.isArray(value) ? value.length === 0 : value === false));
});

test("public state is detached and never exposes credentials, deck order, or other card faces", () => {
  const room = roomFor();
  const [a, b] = room.players;
  give(room, a, { wood: 2 });
  give(room, b, { ore: 3 });
  card(room, a, "knight");
  card(room, b, "monopoly");
  card(room, b, "victoryPoint");
  const state = publicState(room, a.id);
  assert.deepEqual(state.players[0].resources, a.resources);
  assert.equal(state.players[1].resourceCount, 3);
  assert.equal(state.players[1].resources, undefined);
  assert.equal(state.players[1].developmentCards, undefined);
  assert.equal(state.players[1].developmentCount, 2);
  assert.equal(state.developmentCount, room.developmentDeck.length);
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes("reconnectToken"));
  assert.ok(!serialized.includes("developmentDeck"));
  for (const player of room.players) assert.ok(!serialized.includes(player.reconnectToken));
  for (const hidden of [...room.developmentDeck, ...b.developmentCards]) assert.ok(!serialized.includes(hidden.id));
  assert.ok(!JSON.stringify(publicState(room, "spectator")).includes("developmentCards"));
  state.players[0].resources.wood = 1000;
  state.bank.ore = 1000;
  state.board.vertices[0].structure = { playerId: "intruder" };
  assert.equal(a.resources.wood, 2);
  assert.notEqual(room.bank.ore, 1000);
  assert.equal(room.board.vertices[0].structure, null);
});

test("all actions after victory, unknown actors, and malformed requests are atomic failures", () => {
  const room = roomFor();
  const types = ["setupSettlement", "setupRoad", "roll", "moveRobber", "discard", "steal", "buildRoad",
    "buildSettlement", "buildCity", "bankTrade", "offerTrade", "respondTrade", "cancelTrade", "buyDevelopment",
    "playDevelopment", "finishFreeRoads", "endTurn"];
  for (const type of types) rejected(room, { type }, { id: "outsider" });
  for (const action of [null, undefined, [], "roll", {}, { type: "__proto__" }, { type: 1 }]) rejected(room, action);
  room.winnerId = active(room).id;
  room.phase = "finished";
  for (const type of types) rejected(room, { type });
  for (const player of room.players) {
    const hints = legal(room, player);
    assert.ok(Object.values(hints).every((value) => Array.isArray(value) ? value.length === 0 : value === false));
  }
});

test("invalid RNG cannot partially mutate a roll or start", () => {
  const room = roomFor(4, "roll");
  const before = structuredClone(room);
  for (const value of [-1, 1, NaN, Infinity, "0.5"]) {
    assert.throws(() => act(room, { type: "roll" }, active(room), () => value));
    assert.deepEqual(room, before);
  }
  let call = 0;
  assert.throws(() => act(room, { type: "roll" }, active(room), () => call++ ? NaN : 0.4));
  assert.deepEqual(room, before);
  const { room: lobby, player: host } = createRoom("Host");
  for (let i = 1; i < 4; i += 1) addPlayer(lobby, `Player${i}`);
  const oldLobby = structuredClone(lobby);
  assert.throws(() => startGame(lobby, host.id, () => NaN));
  assert.deepEqual(lobby, oldLobby);
});

test("lobby rejects invalid and duplicate names, non-host starts, late joins, and seventh player", () => {
  for (const name of [null, "", "   ", 42, {}, []]) assert.throws(() => createRoom(name));
  const { room, player: host } = createRoom("  Host  ");
  assert.equal(host.name, "Host");
  assert.throws(() => addPlayer(room, "host"), /already/);
  assert.equal(room.players.length, 1);
  assert.throws(() => startGame(room, "outsider"), /host/);
  for (let index = 1; index < 6; index += 1) addPlayer(room, `Player${index}`);
  const before = structuredClone(room);
  assert.throws(() => addPlayer(room, "Seventh"), /six/);
  assert.deepEqual(room, before);
  startGame(room, host.id, rng());
  const started = structuredClone(room);
  assert.throws(() => addPlayer(room, "Late"), /begun/);
  assert.throws(() => startGame(room, host.id), /already/);
  assert.deepEqual(room, started);
});

test("names reject controls, blank whitespace, and overlength input without modifying lobby", () => {
  const { room } = createRoom("Host");
  for (const name of [null, 0, false, {}, [], "", " \t\n", "\u2003\u00a0",
    "A".repeat(21), `${"A".repeat(19)}  `, "Alice\nBob", "Alice\tBob", "\0Alice", "Alice\u007f",
    "Alice\u0085", "Alice\u200b", "Alice\u202e", "Alice\u2028Bob", "Alice\u2029Bob"]) {
    const before = structuredClone(room);
    assert.throws(() => addPlayer(room, name));
    assert.deepEqual(room, before);
  }
  assert.equal(addPlayer(room, "A".repeat(20)).name, "A".repeat(20));
  assert.equal(addPlayer(room, "  Ada Lovelace  ").name, "Ada Lovelace");
});

test("lobby joins reuse the first unused color after removal without duplicating existing colors", () => {
  const { room } = createRoom("Host");
  for (let index = 1; index < 6; index += 1) addPlayer(room, `Player${index}`);
  const colors = room.players.map((player) => player.color);
  room.players.splice(1, 1);
  const replacement = addPlayer(room, "Replacement");
  assert.equal(replacement.color, colors[1]);
  assert.equal(new Set(room.players.map((player) => player.color)).size, 6);
  room.players = room.players.filter((player) => player.color !== colors[2] && player.color !== colors[4]);
  assert.equal(addPlayer(room, "First available").color, colors[2]);
  assert.equal(addPlayer(room, "Second available").color, colors[4]);
  assert.equal(new Set(room.players.map((player) => player.color)).size, 6);
});

test("public state forwards server revision while engine ignores action requestId metadata", () => {
  const { room: lobby, player: host } = createRoom("Host");
  assert.equal(lobby.revision, 0);
  assert.equal(publicState(lobby, host.id).revision, 0);
  const room = roomFor(4, "roll");
  room.revision = 42;
  act(room, { type: "roll", requestId: "server-owned-idempotency-key" }, active(room), () => 0);
  assert.equal(room.revision, 42, "Only the server advances its persisted revision");
  assert.equal(room.phase, "action");
  assert.equal(publicState(room, active(room).id).revision, 42);
  assert.equal(publicState(room, "spectator").revision, 42);
});

test("resume credentials use independent 32-byte opaque tokens and never enter public state", () => {
  const { room, player: host } = createRoom("Host");
  const second = addPlayer(room, "Second");
  assert.match(host.reconnectToken, /^[a-f0-9]{64}$/);
  assert.match(second.reconnectToken, /^[a-f0-9]{64}$/);
  assert.notEqual(host.reconnectToken, second.reconnectToken);
  assert.notEqual(host.reconnectToken, host.id);
  const retained = addPlayer(room, "Rematch", host.reconnectToken);
  assert.equal(retained.reconnectToken, host.reconnectToken);
  for (const viewerId of [host.id, second.id, "spectator"]) {
    const state = JSON.stringify(publicState(room, viewerId));
    assert.ok(!state.includes(host.reconnectToken));
    assert.ok(!state.includes(second.reconnectToken));
  }
});

test("ordinary four-player development becomes playable next turn and allowance resets", () => {
  const room = roomFor();
  const player = active(room);
  const monopoly = card(room, player, "monopoly", room.turnNumber);
  const older = card(room, player, "monopoly");
  act(room, { type: "playDevelopment", cardId: older.id, resource: "wood" });
  rejected(room, { type: "playDevelopment", cardId: monopoly.id, resource: "wood" });
  act(room, { type: "endTurn" });
  while (active(room).id !== player.id) {
    act(room, { type: "roll" }, active(room), () => 0);
    act(room, { type: "endTurn" });
  }
  assert.equal(room.phase, "roll");
  assert.equal(room.developmentPlayed, false);
  act(room, { type: "playDevelopment", cardId: monopoly.id, resource: "wood" });
  assert.equal(room.phase, "roll");
});

test("first free road can win immediately without placing or forfeiting second road", () => {
  const room = roomFor();
  graph(room, [...chain("a", 4, 0), ["a4", "a5"], ["a5", "a6"]]);
  for (const v of room.board.vertices.slice(0, 4)) settlement(room, active(room), v, "city");
  const roadCard = card(room, active(room), "roadBuilding");
  act(room, { type: "playDevelopment", cardId: roadCard.id });
  act(room, { type: "buildRoad", edgeId: "e4" });
  assert.equal(room.phase, "finished");
  assert.equal(room.winnerId, active(room).id);
  assert.equal(active(room).points, 10);
  assert.equal(room.freeRoadsRemaining, 0);
  assert.equal(room.board.edges.find((e) => e.id === "e5").road, null);
});

test("building a settlement transfers Longest Road off-turn but waits for new holder's activation", () => {
  const room = roomFor();
  graph(room, [...chain("a", 6, 0), ...chain("b", 5, 1), ["a3", "c", 2]]);
  const futureWinner = room.players[1];
  for (const v of room.board.vertices.filter((v) => v.id.startsWith("b")).slice(0, 4)) {
    settlement(room, futureWinner, v, "city");
  }
  updateByRoll(room);
  assert.equal(room.longestRoadHolderId, room.players[0].id);
  assert.equal(futureWinner.points, 8);
  room.turnIndex = 2;
  room.primaryIndex = 2;
  give(room, active(room), COSTS.settlement);
  act(room, { type: "buildSettlement", vertexId: "a3" });
  assert.equal(room.longestRoadHolderId, futureWinner.id);
  assert.equal(futureWinner.points, 10);
  assert.equal(room.winnerId, null);
  act(room, { type: "endTurn" });
  act(room, { type: "roll" }, active(room), () => 0);
  act(room, { type: "endTurn" });
  act(room, { type: "roll" }, active(room), () => 0);
  act(room, { type: "endTurn" });
  assert.equal(room.winnerId, futureWinner.id);
  assert.equal(room.phase, "finished");
});

test("development effects never leak drawn or stolen card faces in public log", () => {
  const room = roomFor();
  const [a, b] = room.players;
  give(room, a, COSTS.development);
  act(room, { type: "buyDevelopment" });
  assert.ok(!room.log.at(-1).message.includes(a.developmentCards[0].type));
  give(room, b, { ore: 2 });
  room.phase = "steal";
  room.robberReturnPhase = "action";
  room.robberVictims = [b.id];
  act(room, { type: "steal", targetId: b.id });
  assert.ok(!room.log.at(-1).message.includes("ore"));
  assert.ok(!JSON.stringify(publicState(room, b.id)).includes(a.developmentCards[0].id));
});

function siteValue(room, vertexId) {
  return vertex(room, vertexId).adjacentTiles.reduce((sum, tileId) => {
    const tile = room.board.tiles.find((t) => t.id === tileId);
    return sum + (tile.number ? 6 - Math.abs(7 - tile.number) : 0);
  }, 0);
}
function chooseRoad(room, edgeIds, random) {
  const scored = edgeIds.map((edgeId) => {
    const edge = room.board.edges.find((e) => e.id === edgeId);
    const score = Math.max(...edge.vertices.map((vertexId) => {
      const v = vertex(room, vertexId);
      if (v.structure) return 0;
      const spaced = v.adjacentVertices.every((other) => !vertex(room, other).structure);
      const future = v.adjacentVertices.filter((other) => !vertex(room, other).structure)
        .reduce((sum, other) => sum + siteValue(room, other), 0);
      return (spaced ? siteValue(room, vertexId) * 3 : 0) + future / 5;
    }));
    return { edgeId, score: score + random() * 3 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].edgeId;
}
function discardBundle(player, amount) {
  const result = {};
  const ordered = [...RESOURCES].sort((a, b) => player.resources[b] - player.resources[a]);
  for (const resource of ordered) {
    result[resource] = Math.min(amount, player.resources[resource]);
    amount -= result[resource];
  }
  return result;
}
function botAction(room, random) {
  const player = active(room);
  const hints = legal(room);
  if (room.phase === "discard") {
    const [playerId, amount] = Object.entries(room.pendingDiscards)[0];
    const discarder = room.players.find((p) => p.id === playerId);
    act(room, { type: "discard", resources: discardBundle(discarder, amount) }, discarder, random);
    return;
  }
  if (room.phase === "robber") {
    const ranked = hints.robberTiles.map((tileId) => ({
      tileId,
      value: room.board.tiles.find((t) => t.id === tileId).vertices.reduce((sum, v) => {
        const owner = vertex(room, v).structure?.playerId;
        return sum + (owner ? (owner === player.id ? -3 : 1) : 0);
      }, 0),
    })).sort((a, b) => b.value - a.value);
    act(room, { type: "moveRobber", tileId: ranked[0].tileId }, player, random);
    return;
  }
  if (room.phase === "steal") {
    act(room, { type: "steal", targetId: room.robberVictims[0] }, player, random);
    return;
  }
  if (room.freeRoadsRemaining) {
    act(room, hints.roadEdges.length
      ? { type: "buildRoad", edgeId: chooseRoad(room, hints.roadEdges, random) }
      : { type: "finishFreeRoads" }, player, random);
    return;
  }
  if (hints.canRoll) { act(room, { type: "roll" }, player, random); return; }
  if (hints.playableCardIds.length) {
    const chosen = player.developmentCards.find((c) => c.id === hints.playableCardIds[0]);
    const action = { type: "playDevelopment", cardId: chosen.id };
    if (chosen.type === "monopoly") {
      action.resource = [...RESOURCES].sort((a, b) =>
        room.players.filter((p) => p.id !== player.id).reduce((sum, p) => sum + p.resources[b] - p.resources[a], 0))[0];
    }
    if (chosen.type === "yearOfPlenty") {
      action.resources = {};
      let remaining = Math.min(2, RESOURCES.reduce((sum, resource) => sum + room.bank[resource], 0));
      const order = [...RESOURCES].sort((a, b) => player.resources[a] - player.resources[b]);
      for (const resource of order) {
        action.resources[resource] = Math.min(remaining, room.bank[resource]);
        remaining -= action.resources[resource];
      }
    }
    act(room, action, player, random);
    return;
  }
  if (hints.cityVertices.length) {
    const best = [...hints.cityVertices].sort((a, b) => siteValue(room, b) - siteValue(room, a))[0];
    act(room, { type: "buildCity", vertexId: best }, player, random);
    return;
  }
  if (hints.settlementVertices.length) {
    const best = [...hints.settlementVertices].sort((a, b) => siteValue(room, b) - siteValue(room, a))[0];
    act(room, { type: "buildSettlement", vertexId: best }, player, random);
    return;
  }
  if (hints.canBuyDevelopment) { act(room, { type: "buyDevelopment" }, player, random); return; }
  if (hints.roadEdges.length) {
    act(room, { type: "buildRoad", edgeId: chooseRoad(room, hints.roadEdges, random) }, player, random);
    return;
  }
  if (hints.canBankTrade) {
    const rates = publicState(room, player.id).players.find((p) => p.id === player.id).tradeRates;
    const goals = [
      ...(player.citiesLeft && room.board.vertices.some((v) =>
        v.structure?.playerId === player.id && v.structure.kind === "settlement") ? [COSTS.city] : []),
      ...(player.settlementsLeft ? [COSTS.settlement] : []),
      ...(room.developmentDeck.length ? [COSTS.development] : []),
      ...(player.roadsLeft ? [COSTS.road] : []),
    ];
    for (const cost of goals) {
      const wanted = RESOURCES.find((resource) => room.bank[resource] > 0 && player.resources[resource] < (cost[resource] || 0));
      if (!wanted) continue;
      const giveResource = RESOURCES.find((resource) => resource !== wanted &&
        player.resources[resource] >= rates[resource] + (cost[resource] || 0));
      if (giveResource) {
        act(room, { type: "bankTrade", giveResource, receiveResource: wanted }, player, random);
        return;
      }
    }
  }
  act(room, { type: "endTurn" }, player, random);
}

for (const count of [3, 4, 5, 6]) {
  test(`${count}-player complete legal game reaches victory with conserved bank and physical pieces`, () => {
    const room = roomFor(count, "setup");
    const random = rng(24680 + count);
    while (room.phase === "setup") {
      const hints = legal(room);
      if (!room.setupNeedsRoad) {
        const best = [...hints.settlementVertices].sort((a, b) => siteValue(room, b) - siteValue(room, a))[0];
        act(room, { type: "setupSettlement", vertexId: best }, active(room), random);
      } else {
        act(room, { type: "setupRoad", edgeId: chooseRoad(room, hints.roadEdges, random) }, active(room), random);
      }
    }
    let actionCount = 0;
    while (room.phase !== "finished" && actionCount < 6000) {
      botAction(room, random);
      actionCount += 1;
      conserved(room);
      for (const player of room.players) {
        const structures = room.board.vertices.filter((v) => v.structure?.playerId === player.id);
        assert.equal(player.settlementsLeft + structures.filter((v) => v.structure.kind === "settlement").length, 5);
        assert.equal(player.citiesLeft + structures.filter((v) => v.structure.kind === "city").length, 4);
        assert.equal(player.roadsLeft + room.board.edges.filter((e) => e.road?.playerId === player.id).length, 15);
      }
      if (actionCount % 50 === 0) assert.deepEqual(JSON.parse(JSON.stringify(room)), room);
    }
    assert.equal(room.phase, "finished", `No winner after ${actionCount} actions; scores ${room.players.map((p) => p.points)}`);
    assert.equal(room.winnerId, active(room).id);
    assert.ok(active(room).points >= 10);
    assert.equal(publicState(room, active(room).id).legal.canEndTurn, false);
  });
}
