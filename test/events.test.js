"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  RESOURCES, COSTS, createRoom, addPlayer, startGame, applyAction, resignPlayer,
  appendPublicEvent, normalizePublicEvents, publicState,
} = require("../game");

function rng(seed = 12345) {
  return () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
}
function roomFor(count = 4, phase = "action") {
  const { room, player } = createRoom("Host");
  for (let i = 1; i < count; i += 1) addPlayer(room, `Guest${i}`);
  startGame(room, player.id, rng());
  room.phase = phase;
  room.turnNumber = 1;
  return room;
}
const actor = (room) => room.players[room.turnIndex];
const act = (room, action, player = actor(room), random = () => 0) => applyAction(room, player.id, action, random);
const events = (room, type) => room.eventOutbox.filter((event) => event.type === type);
function give(room, player, bundle) {
  for (const [resource, amount] of Object.entries(bundle)) {
    assert.ok(room.bank[resource] >= amount);
    room.bank[resource] -= amount;
    player.resources[resource] += amount;
  }
}
function card(room, player, type) {
  const index = room.developmentDeck.findIndex((card) => card.type === type);
  const chosen = { ...room.developmentDeck.splice(index, 1)[0], boughtTurn: 0 };
  player.developmentCards.push(chosen);
  return chosen;
}

test("structured events retain all unpersisted activity beyond the public 80-entry tail", () => {
  const { room, player } = createRoom("Host");
  for (let i = 0; i < 180; i += 1) {
    appendPublicEvent(room, { type: "admin.notice", actorId: player.id, message: `Notice ${i}`, data: { count: i } }, 1000 + i);
  }
  assert.equal(room.eventSequence, 181);
  assert.equal(room.eventOutbox.length, 181);
  assert.equal(room.log.length, 80);
  assert.deepEqual(room.eventOutbox.map((event) => event.seq), Array.from({ length: 181 }, (_, i) => i + 1));
  assert.equal(new Set(room.eventOutbox.map((event) => event.id)).size, 181);
  assert.deepEqual(room.log, room.eventOutbox.slice(-80));
  const view = publicState(room, player.id);
  assert.equal(view.eventSequence, 181);
  assert.equal(view.log.length, 80);
  assert.equal(view.eventOutbox, undefined);
  assert.ok(!JSON.stringify(view).includes("eventOutbox"));
  for (const event of view.log) {
    assert.deepEqual(Object.keys(event).sort(), ["actorId", "at", "data", "id", "message", "seq", "type"]);
    assert.ok(Number.isSafeInteger(event.seq));
  }
  const snapshot = structuredClone(room);
  normalizePublicEvents(room);
  assert.deepEqual(room, snapshot);
  room.eventOutbox = [];
  appendPublicEvent(room, { type: "admin.notice", message: "Persisted boundary" }, 1300);
  assert.equal(room.eventSequence, 182);
  assert.equal(room.eventOutbox.length, 1);
  assert.equal(room.eventOutbox[0].seq, 182);
  assert.equal(room.log.length, 80);
});

test("legacy normalization preserves identity/message/time, does not touch game data and is idempotent", () => {
  const room = roomFor();
  const old = [{ id: "old-a", at: 123, message: "A joined.", requestId: "private" },
    { id: "old-b", at: 124, message: "A rolled.", type: "unsafe", actorId: actor(room).id,
      data: { resources: { ore: 10 }, reconnectToken: "private-key" } }];
  room.log = old;
  delete room.eventSequence;
  delete room.eventOutbox;
  const beforeBoard = structuredClone(room.board);
  const beforePlayers = structuredClone(room.players);
  const returned = normalizePublicEvents(room);
  assert.equal(returned, room);
  assert.equal(room.eventSequence, 2);
  assert.deepEqual(room.eventOutbox, []);
  assert.deepEqual(room.log, old.map((entry, index) => ({
    id: entry.id, at: entry.at, message: entry.message, seq: index + 1, type: "legacy", actorId: null, data: {},
  })));
  assert.deepEqual(room.board, beforeBoard);
  assert.deepEqual(room.players, beforePlayers);
  const once = structuredClone(room);
  normalizePublicEvents(room);
  assert.deepEqual(room, once);
  appendPublicEvent(room, { type: "admin.notice", message: "New activity" }, 125);
  assert.equal(room.log.at(-1).seq, 3);
  assert.equal(room.eventOutbox.length, 1);
});

test("existing event high-water marks and structured logs survive normalization without reissuing sequences", () => {
  const { room } = createRoom("Host");
  room.eventSequence = 500;
  room.eventOutbox = [];
  normalizePublicEvents(room);
  appendPublicEvent(room, { type: "admin.notice", message: "Sequence after import" });
  assert.equal(room.log.at(-1).seq, 501);
  const before = structuredClone(room);
  normalizePublicEvents(room);
  assert.deepEqual(room, before);
  room.log[0].extra = { reconnectToken: "private" };
  normalizePublicEvents(room);
  assert.equal(room.log[0].extra, undefined);
  assert.equal(room.eventSequence, 501);
});

test("stale event counters recover from safe history and malformed pending activity is never silently lost", () => {
  const { room } = createRoom("Host");
  appendPublicEvent(room, { type: "admin.notice", message: "A second event" });
  room.eventSequence = 0;
  appendPublicEvent(room, { type: "admin.notice", message: "Recovered counter" });
  assert.equal(room.eventSequence, 3);
  assert.equal(room.eventOutbox.length, 3);
  room.eventOutbox[0] = { id: "broken", message: "A pending event without sequence" };
  const before = structuredClone(room);
  assert.throws(() => normalizePublicEvents(room), /cannot be discarded silently/);
  assert.deepEqual(room, before);
});

test("new event validation rejects unsafe JSON and exhausted sequence before mutating anything", () => {
  const { room } = createRoom("Host");
  const cyclic = {};
  cyclic.self = cyclic;
  for (const data of [null, [], { x: NaN }, { x: Infinity }, { x: undefined }, { x: () => 1 },
    { x: new Map() }, { x: new Date() }, { reconnectToken: "secret" }, { nested: { requestId: "id" } },
    { payloadHash: "private" }, { developmentCards: ["knight"] }, cyclic, { hole: Array(2) },
    JSON.parse('{"__proto__":{"secret":"value"}}')]) {
    const before = structuredClone(room);
    assert.throws(() => appendPublicEvent(room, { type: "admin.notice", message: "Invalid", data }));
    assert.deepEqual(room, before);
  }
  for (const entry of [{ type: "", message: "Invalid" }, { type: "valid", message: 5 },
    { type: "valid", message: "Invalid", actorId: {} }]) {
    const before = structuredClone(room);
    assert.throws(() => appendPublicEvent(room, entry));
    assert.deepEqual(room, before);
  }
  room.eventSequence = Number.MAX_SAFE_INTEGER;
  const before = structuredClone(room);
  assert.throws(() => appendPublicEvent(room, { type: "admin.notice", message: "Overflow" }), /exhausted/);
  assert.deepEqual(room, before);
});

test("public snapshots are detached, sanitize known event data and never mutate legacy input", () => {
  const room = roomFor();
  const player = actor(room);
  appendPublicEvent(room, {
    type: "developmentBought", actorId: player.id, message: "A development card was bought.",
    data: { count: 1, cardType: "victoryPoint", cardId: "private-card-id", reconnectToken: player.reconnectToken },
  });
  assert.deepEqual(room.log.at(-1).data, { count: 1 });
  room.log.at(-1).data.cardType = "victoryPoint";
  room.log.at(-1).reconnectToken = player.reconnectToken;
  const before = structuredClone(room);
  const state = publicState(room, player.id);
  assert.deepEqual(state.log.at(-1).data, { count: 1 });
  assert.equal(state.log.at(-1).reconnectToken, undefined);
  assert.deepEqual(room, before);
  state.log.at(-1).data.count = 100;
  assert.equal(room.log.at(-1).data.count, 1);
  delete room.eventSequence;
  delete room.eventOutbox;
  room.log = [{ id: "legacy", at: 10, message: "Old message", data: { token: "private" } }];
  const old = structuredClone(room);
  assert.equal(publicState(room, player.id).log[0].type, "legacy");
  assert.deepEqual(room, old);
});

for (const ratio of [4, 3, 2]) {
  test(`bank/port activity records the actual ${ratio}:1 exchange identically for every player`, () => {
    const room = roomFor();
    const player = actor(room);
    if (ratio !== 4) {
      const port = room.board.ports.find((port) => port.resource === (ratio === 3 ? null : "wood"));
      room.board.vertices.find((v) => v.id === port.vertices[0]).structure = { playerId: player.id, kind: "settlement" };
      player.settlementsLeft -= 1;
    }
    give(room, player, { wood: ratio });
    act(room, { type: "bankTrade", giveResource: "wood", receiveResource: "ore", requestId: "private-request-id" });
    const event = events(room, "bankTrade").at(-1);
    assert.equal(event.actorId, player.id);
    assert.equal(event.message, `${player.name} traded with the bank: ${ratio} wood for 1 ore.`);
    assert.deepEqual(event.data, { give: { wood: ratio }, want: { ore: 1 }, ratio });
    assert.equal(player.resources.ore, 1);
    assert.equal(player.resources.wood, 0);
    for (const viewer of room.players) assert.deepEqual(publicState(room, viewer.id).log.at(-1), event);
    assert.ok(!JSON.stringify(event).includes("private-request-id"));
  });
}

test("offers, legal off-turn counteroffers and accepted trades identify actual parties and card amounts", () => {
  const room = roomFor();
  const [primary, other] = room.players;
  give(room, primary, { wood: 3 });
  give(room, other, { ore: 2 });
  act(room, { type: "offerTrade", targetId: other.id, give: { wood: 2 }, want: { ore: 1 } });
  const initial = room.trade.id;
  act(room, { type: "offerTrade", targetId: primary.id, replaceTradeId: initial, give: { ore: 2 }, want: { wood: 3 } }, other);
  const counter = events(room, "tradeCounteroffered").at(-1);
  assert.equal(counter.actorId, other.id);
  assert.equal(counter.data.fromId, other.id);
  assert.equal(counter.data.targetId, primary.id);
  assert.equal(counter.data.replacesTradeId, initial);
  assert.equal(counter.data.give.ore, 2);
  assert.equal(counter.data.want.wood, 3);
  assert.match(counter.message, /2 ore for 3 wood/);
  act(room, { type: "respondTrade", tradeId: room.trade.id, accept: true });
  const accepted = events(room, "tradeAccepted").at(-1);
  assert.equal(accepted.actorId, primary.id);
  assert.match(accepted.message, /accepted/);
  assert.match(accepted.message, /2 ore for 3 wood/);
  assert.equal(accepted.data.fromId, other.id);
  assert.equal(accepted.data.targetId, primary.id);
  assert.equal(primary.resources.ore, 2);
  assert.equal(other.resources.wood, 3);
});

test("decline, explicit cancel, turn end and retirement all record pending-trade cancellation correctly", () => {
  for (const reason of ["decline", "cancelled", "turn-ended", "player-left"]) {
    const room = roomFor();
    const [primary, other] = room.players;
    give(room, primary, { wood: 1 });
    give(room, other, { ore: 1 });
    act(room, { type: "offerTrade", targetId: other.id, give: { wood: 1 }, want: { ore: 1 } });
    const tradeId = room.trade.id;
    if (reason === "decline") act(room, { type: "respondTrade", accept: false, tradeId }, other);
    if (reason === "cancelled") act(room, { type: "cancelTrade", tradeId });
    if (reason === "turn-ended") act(room, { type: "endTurn" });
    if (reason === "player-left") resignPlayer(room, other.id, rng());
    const recorded = events(room, reason === "decline" ? "tradeDeclined" : "tradeCancelled");
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].data.tradeId, tradeId);
    assert.equal(recorded[0].data.give.wood, 1);
    assert.equal(recorded[0].data.want.ore, 1);
    if (reason !== "decline") assert.equal(recorded[0].data.reason, reason);
    assert.equal(room.trade, null);
  }
});

test("dice, public production recipients and multi-recipient shortages have explicit trustworthy events", () => {
  const room = roomFor(4, "roll");
  const [a, b, holder] = room.players;
  for (const tile of room.board.tiles) tile.number = null;
  const tile = room.board.tiles.find((tile) => tile.resource === "wood");
  tile.number = 2;
  room.board.vertices.find((v) => v.id === tile.vertices[0]).structure = { playerId: a.id, kind: "city" };
  room.board.vertices.find((v) => v.id === tile.vertices[3]).structure = { playerId: b.id, kind: "settlement" };
  give(room, holder, { wood: 17 });
  act(room, { type: "roll" });
  assert.deepEqual(events(room, "diceRolled").at(-1).data, { dice: [1, 1], total: 2 });
  const shortage = events(room, "productionShortage").at(-1);
  assert.deepEqual(shortage.data, { resource: "wood", requested: 3, available: 2, recipientCount: 2, distributed: 0 });
  assert.match(shortage.message, /none is distributed/);
  assert.deepEqual(events(room, "production").at(-1).data.recipients, []);
  room.board.vertices.find((v) => v.id === tile.vertices[3]).structure = null;
  room.phase = "roll";
  give(room, holder, { wood: 1 });
  act(room, { type: "roll" });
  assert.deepEqual(events(room, "productionShortage").at(-1).data,
    { resource: "wood", requested: 2, available: 1, recipientCount: 1, distributed: 1 });
  const paid = events(room, "production").at(-1).data.recipients;
  assert.equal(paid.length, 1);
  assert.equal(paid[0].playerId, a.id);
  assert.equal(paid[0].resources.wood, 1);
  assert.equal(a.resources.wood, 1);
});

test("discard and theft logs reveal counts/victim only, never the discarded or stolen resource types", () => {
  const room = roomFor(4, "roll");
  const [a, b] = room.players;
  give(room, b, { wood: 8, ore: 1 });
  let die = 0;
  act(room, { type: "roll" }, a, () => die++ ? 0.999 : 0);
  act(room, { type: "discard", resources: { wood: 4 } }, b);
  const discarded = events(room, "discarded").at(-1);
  assert.deepEqual(discarded.data, { count: 4 });
  assert.equal(discarded.actorId, b.id);
  assert.match(discarded.message, /discarded 4 resource cards/);
  const tile = room.board.tiles.find((tile) => !tile.robber);
  room.board.vertices.find((v) => v.id === tile.vertices[0]).structure = { playerId: b.id, kind: "settlement" };
  act(room, { type: "moveRobber", tileId: tile.id });
  assert.deepEqual(events(room, "robberMoved").at(-1).data, { tileId: tile.id });
  act(room, { type: "steal", targetId: b.id }, a, () => 0.999);
  const stolen = events(room, "resourceStolen").at(-1);
  assert.deepEqual(stolen.data, { victimId: b.id, count: 1 });
  assert.equal(a.resources.ore, 1);
  for (const event of [discarded, stolen]) {
    const serialized = JSON.stringify(event);
    for (const resource of RESOURCES) assert.ok(!serialized.includes(`"${resource}"`));
    assert.ok(!event.message.includes("wood"));
    assert.ok(!event.message.includes("ore"));
    assert.ok(!serialized.includes(b.reconnectToken));
  }
});

test("development purchase is generic, Invention choices stay private, and Monopoly type/count are public", () => {
  const room = roomFor();
  const [a, b] = room.players;
  give(room, a, COSTS.development);
  act(room, { type: "buyDevelopment" });
  const bought = a.developmentCards[0];
  const purchase = events(room, "developmentBought").at(-1);
  assert.deepEqual(purchase.data, { count: 1 });
  assert.ok(!JSON.stringify(purchase).includes(bought.id));
  assert.ok(!JSON.stringify(purchase).includes(bought.type));
  const plenty = card(room, a, "yearOfPlenty");
  act(room, { type: "playDevelopment", cardId: plenty.id, resources: { ore: 1, wheat: 1 } });
  const invention = events(room, "developmentPlayed").at(-1);
  assert.deepEqual(invention.data, { cardType: "yearOfPlenty", count: 2 });
  assert.ok(!JSON.stringify(invention).includes('"ore"'));
  assert.ok(!JSON.stringify(invention).includes('"wheat"'));
  room.developmentPlayed = false;
  const monopoly = card(room, a, "monopoly");
  give(room, b, { wood: 3 });
  act(room, { type: "playDevelopment", cardId: monopoly.id, resource: "wood" });
  const event = events(room, "developmentPlayed").at(-1);
  assert.deepEqual(event.data, { cardType: "monopoly", resource: "wood", count: 3 });
  assert.match(event.message, /collected 3 wood/);
});

test("bonus acquisition/removal is emitted once despite repeated score updates and turn changes", () => {
  const room = roomFor();
  const [a, b] = room.players;
  room.board = {
    tiles: [], ports: [],
    vertices: Array.from({ length: 7 }, (_, i) => ({
      id: `v${i}`, x: i, y: 0, structure: null, adjacentTiles: [],
      adjacentVertices: [i - 1, i + 1].filter((n) => n >= 0 && n < 7).map((n) => `v${n}`),
    })),
    edges: Array.from({ length: 6 }, (_, i) => ({
      id: `e${i}`, vertices: [`v${i}`, `v${i + 1}`], road: i < 4 ? { playerId: a.id } : null,
    })),
  };
  a.roadsLeft = 11;
  give(room, a, { wood: 2, brick: 2 });
  act(room, { type: "buildRoad", edgeId: "e4" });
  assert.deepEqual(events(room, "roadBuilt").at(-1).data, { edgeId: "e4", free: false, setup: false });
  assert.equal(events(room, "bonusChanged").length, 1);
  assert.deepEqual(events(room, "bonusChanged")[0].data, { bonus: "longestRoad", fromId: null, toId: a.id, points: 2 });
  act(room, { type: "buildRoad", edgeId: "e5" });
  assert.equal(events(room, "bonusChanged").length, 1);
  act(room, { type: "endTurn" });
  assert.equal(actor(room).id, b.id);
  assert.equal(events(room, "bonusChanged").length, 1);
  resignPlayer(room, a.id, rng());
  assert.equal(events(room, "bonusChanged").length, 2);
  assert.deepEqual(events(room, "bonusChanged").at(-1).data, { bonus: "longestRoad", fromId: a.id, toId: null, points: 2 });
  act(room, { type: "roll" });
  assert.equal(events(room, "bonusChanged").length, 2);
});

test("winning third Knight records played card, army transfer and victory once in order", () => {
  const room = roomFor(4, "roll");
  const player = actor(room);
  for (const v of room.board.vertices.slice(0, 4)) v.structure = { playerId: player.id, kind: "city" };
  player.citiesLeft = 0;
  player.knightsPlayed = 2;
  const knight = card(room, player, "knight");
  act(room, { type: "playDevelopment", cardId: knight.id });
  assert.deepEqual(room.log.slice(-3).map((event) => event.type), ["developmentPlayed", "bonusChanged", "gameFinished"]);
  assert.deepEqual(events(room, "gameFinished")[0].data, { winnerId: player.id, reason: "points", points: 10 });
  const before = structuredClone(room);
  assert.throws(() => act(room, { type: "endTurn" }));
  assert.deepEqual(room, before);
  assert.equal(events(room, "gameFinished").length, 1);
});

test("resignation events use only aggregate returned counts and preserve an explicitly assigned host", () => {
  const room = roomFor();
  const retiring = room.players[1];
  room.hostId = room.players[2].id;
  give(room, retiring, { ore: 2, wheat: 1 });
  card(room, retiring, "victoryPoint");
  card(room, retiring, "monopoly");
  const v = room.board.vertices[0];
  v.structure = { playerId: retiring.id, kind: "settlement" };
  retiring.settlementsLeft -= 1;
  resignPlayer(room, retiring.id, rng());
  assert.equal(room.hostId, room.players[2].id);
  const event = events(room, "playerResigned").at(-1);
  assert.equal(event.actorId, retiring.id);
  assert.deepEqual(event.data, { resourceCount: 3, developmentCount: 2, roadCount: 0, settlementCount: 1, cityCount: 0 });
  assert.ok(!JSON.stringify(event).includes("victoryPoint"));
  assert.ok(!JSON.stringify(event).includes("monopoly"));
  assert.ok(!JSON.stringify(event).includes('"ore"'));
  assert.ok(!JSON.stringify(event).includes(retiring.reconnectToken));
  assert.match(event.message, /left the match/);
});

test("setup, city upgrades, free-road forfeiture and last-player victory all emit public location/count events", () => {
  const room = roomFor(3, "setup");
  const first = actor(room);
  const site = publicState(room, first.id).legal.settlementVertices[0];
  act(room, { type: "setupSettlement", vertexId: site });
  assert.deepEqual(events(room, "settlementBuilt").at(-1).data, { vertexId: site, setup: true });
  act(room, { type: "setupRoad", edgeId: publicState(room, first.id).legal.roadEdges[0] });
  assert.equal(events(room, "roadBuilt").at(-1).data.setup, true);
  assert.equal(events(room, "setupTurnStarted").at(-1).actorId, actor(room).id);
  room.turnIndex = room.players.findIndex((player) => player.id === first.id);
  room.primaryIndex = room.turnIndex;
  room.phase = "action";
  give(room, first, COSTS.city);
  act(room, { type: "buildCity", vertexId: site });
  assert.deepEqual(events(room, "cityBuilt").at(-1).data, { vertexId: site });
  const development = card(room, first, "roadBuilding");
  act(room, { type: "playDevelopment", cardId: development.id });
  act(room, { type: "finishFreeRoads" });
  assert.deepEqual(events(room, "freeRoadsForfeited").at(-1).data, { count: 2 });
  resignPlayer(room, room.players[1].id);
  resignPlayer(room, room.players[2].id);
  const win = events(room, "gameFinished").at(-1);
  assert.equal(win.actorId, first.id);
  assert.equal(win.data.reason, "last-player");
  assert.equal(win.data.winnerId, first.id);
  assert.equal(events(room, "gameFinished").length, 1);
});

test("invalid gameplay never enqueues or consumes an event sequence", () => {
  const room = roomFor();
  const before = structuredClone(room);
  assert.throws(() => act(room, { type: "bankTrade", giveResource: "wood", receiveResource: "ore" }));
  assert.deepEqual(room, before);
  assert.throws(() => applyAction(room, "outsider", { type: "roll" }));
  assert.deepEqual(room, before);
});

test("server-only dotted event types preserve public IDs and remain normalization-idempotent", () => {
  const { room, player } = createRoom("Host");
  const types = ["player.joined", "player.reconnected", "player.disconnected", "admin.transferred",
    "removal.requested", "removal.cancelled", "removal.declined", "player.removed", "game.rematched"];
  const data = { playerId: player.id, successorId: "successor", fromPlayerId: player.id, toPlayerId: "target" };
  for (const type of types) {
    const event = appendPublicEvent(room, { type, actorId: player.id, message: type, data }, 1234);
    assert.equal(event.type, type);
    assert.deepEqual(event.data, data);
    assert.equal(event.at, 1234);
    assert.ok(Number.isSafeInteger(event.seq) && event.seq > 0);
    assert.equal(typeof event.id, "string");
  }
  const before = structuredClone(room);
  normalizePublicEvents(room);
  assert.deepEqual(room, before);
});

test("nonadmin resignation never transfers an offline valid administrator", () => {
  const room = roomFor();
  const administrator = room.players[2];
  administrator.connected = false;
  room.hostId = administrator.id;
  resignPlayer(room, room.players[1].id);
  assert.equal(room.hostId, administrator.id);
  assert.equal(administrator.connected, false);
  assert.equal(events(room, "admin.transferred").length, 0);
});
