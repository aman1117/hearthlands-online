"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { io } = require("socket.io-client");
const { createRoom, addPlayer, startGame, applyAction, publicState, resignPlayer, RESOURCES } = require("../game");
const { createGameServer } = require("../server");
const { createStorage, StorageError } = require("../storage");

function fixture(count = 3) {
  const { room, player } = createRoom("Rowan");
  for (let index = 1; index < count; index++) addPlayer(room, `Seat ${index + 1}`);
  startGame(room, player.id, () => .999);
  while (room.phase === "setup") {
    const id = room.players[room.turnIndex].id;
    const view = publicState(room, id);
    applyAction(room, id, view.setupNeedsRoad ? { type: "setupRoad", edgeId: view.legal.roadEdges[0] }
      : { type: "setupSettlement", vertexId: view.legal.settlementVertices[0] });
  }
  applyAction(room, player.id, { type: "roll" }, () => .1);
  for (const p of room.players) {
    for (const r of RESOURCES) { room.bank[r] += p.resources[r]; p.resources[r] = 0; }
  }
  for (const [index, bundle] of [{ wood: 8, sheep: 2, wheat: 2, ore: 2, brick: 2 }, { ore: 4, sheep: 2 }, { brick: 2 }].entries()) {
    for (const [r, n] of Object.entries(bundle)) { room.bank[r] -= n; room.players[index].resources[r] += n; }
  }
  room.code = "TRADES"; room.revision = 1; room.updatedAt = Date.now();
  return room;
}
const initialOffer = (room) => ({ type: "offerTrade", targetId: room.players[1].id, give: { wood: 1 }, want: { ore: 1 }, replaceTradeId: null });
const run = (room, action, seat = 0) => applyAction(room, room.players[seat].id, action, () => .1);
function reject(room, action, seat = 0) {
  const before = structuredClone(room);
  assert.throws(() => run(room, action, seat));
  assert.deepEqual(room, before);
}
function conserve(room) {
  for (const resource of RESOURCES) {
    assert.equal(room.bank[resource] + room.players.reduce((sum, p) => sum + p.resources[resource], 0), room.players.length > 4 ? 24 : 19);
  }
}
const holdings = (room) => ({ bank: room.bank, players: room.players.map((p) => p.resources) });

for (const count of [3, 4, 5, 6]) test(`${count} players cannot offer, counter, accept or bank trade before the production roll`, () => {
  const room = fixture(count);
  run(room, initialOffer(room));
  room.phase = "roll";
  for (const [seat, p] of room.players.entries()) {
    assert.equal(publicState(room, p.id).legal.canOfferTrade, false);
    assert.equal(publicState(room, p.id).legal.canBankTrade, false);
    reject(room, { ...initialOffer(room), replaceTradeId: room.trades.at(-1).id }, seat);
    reject(room, { type: "respondTrade", accept: true, tradeId: room.trades.at(-1).id }, seat);
    reject(room, { type: "bankTrade", giveResource: "wood", receiveResource: "ore" }, seat);
  }
  conserve(room);
});

for (const closing of ["cancel", "decline", "accept", "turn-end"]) test(`a delayed counteroffer cannot resurrect a trade after ${closing}`, () => {
  const room = fixture();
  run(room, initialOffer(room));
  const stale = { type: "offerTrade", targetId: room.players[0].id, give: { ore: 1 }, want: { wood: 2 }, replaceTradeId: room.trades.at(-1).id };
  if (closing === "cancel") run(room, { type: "cancelTrade", tradeId: room.trades.at(-1).id });
  else if (closing === "turn-end") run(room, { type: "endTurn" });
  else run(room, { type: "respondTrade", accept: closing === "accept", tradeId: room.trades.at(-1).id }, 1);
  if (closing === "turn-end") run(room, { type: "roll" }, room.turnIndex);
  reject(room, stale, 1);
  assert.deepEqual(room.trades, []);
  conserve(room);
});

test("recipient shortages never leak through public offer cancellation and invalid acceptance stays atomic", () => {
  const room = fixture();
  run(room, { ...initialOffer(room), want: { wheat: 1 } });
  const id = room.trades.at(-1).id;
  reject(room, { type: "respondTrade", accept: true, tradeId: id }, 1);
  assert.equal(room.trades.at(-1).id, id);
  run(room, { type: "bankTrade", giveResource: "wood", receiveResource: "brick" });
  assert.equal(room.trades.at(-1).id, id, "Sender still holds offered wood; recipient's hidden wheat must not cause cancellation");
  for (const viewer of room.players) {
    assert.equal(publicState(room, viewer.id).trades[0].id, id);
    assert.equal(publicState(room, viewer.id).trades[0].unavailableReason, null);
  }
});

test("a legacy unfundable offer reports a safe public reason without rewriting the saved game or revealing recipient cards", () => {
  const room = fixture();
  run(room, initialOffer(room));
  room.bank.wood += room.players[0].resources.wood;
  room.players[0].resources.wood = 0;
  const before = structuredClone(room);
  for (const player of room.players) {
    const view = publicState(room, player.id);
    assert.equal(view.trades[0].unavailableReason, "offered-resources-spent");
    assert.ok(!Object.hasOwn(view.trades[0], "resources"));
  }
  assert.deepEqual(room, before);
  reject(room, { type: "respondTrade", accept: true, tradeId: room.trades.at(-1).id }, 1);
});
for (const cardType of ["knight", "roadBuilding"]) test(`${cardType} resolves the pending offer rather than leaving unclickable trade controls`, () => {
  const room = fixture();
  const card = room.developmentDeck.splice(room.developmentDeck.findIndex((card) => card.type === cardType), 1)[0];
  room.players[0].developmentCards.push({ ...card, boughtTurn: 0 });
  run(room, initialOffer(room));
  const offerId = room.trades.at(-1).id;
  run(room, { type: "playDevelopment", cardId: card.id });
  assert.deepEqual(room.trades, []);
  assert.equal(room.log.findLast((event) => event.type === "tradeCancelled").data.reason, "required-action");
  reject(room, { type: "respondTrade", accept: true, tradeId: offerId }, 1);
  conserve(room);
});

test("only spending the actual offered resources cancels an offer, while failed actions preserve it", () => {
  const room = fixture();
  run(room, { ...initialOffer(room), give: { wood: 8 } });
  const id = room.trades.at(-1).id;
  reject(room, { type: "bankTrade", giveResource: "ore", receiveResource: "wood" });
  assert.equal(room.trades.at(-1).id, id);
  run(room, { type: "bankTrade", giveResource: "wood", receiveResource: "ore" });
  assert.deepEqual(room.trades, []);
  assert.equal(room.log.findLast((event) => event.type === "tradeCancelled").data.reason, "offered-resources-spent");
  assert.equal(room.log.filter((event) => event.type === "tradeAccepted").length, 0);
  conserve(room);
});

const openOffer = (give = { wood: 1 }, want = { ore: 1 }) => ({ type: "offerTrade", targetId: null, give, want, replaceTradeId: null });

test("open offers reach every opponent, show their responses and exchange only with the acceptor the offerer chooses", () => {
  const room = fixture(4);
  const [rowan, mira, ellis] = room.players;
  run(room, openOffer());
  const id = room.trades.at(-1).id;
  assert.equal(room.trades.at(-1).targetId, null);
  assert.deepEqual(room.trades.at(-1).responses, {});
  assert.match(room.log.at(-1).message, /offered a trade to everyone: 1 wood for 1 ore/);
  assert.equal(publicState(room, mira.id).legal.canOfferTrade, true, "every opponent may counter an open offer");
  reject(room, { ...openOffer(), replaceTradeId: id }, 1);
  reject(room, { type: "respondTrade", accept: true, tradeId: id }, 2);
  reject(room, { type: "respondTrade", accept: true, tradeId: id }, 0);
  const before = holdings(room);
  run(room, { type: "respondTrade", accept: false, tradeId: id }, 2);
  run(room, { type: "respondTrade", accept: true, tradeId: id }, 1);
  reject(room, { type: "respondTrade", accept: true, tradeId: id }, 1);
  assert.deepEqual(holdings(room), before, "responses to an open offer never move cards");
  assert.deepEqual(publicState(room, ellis.id).trades[0].responses, { [ellis.id]: "declined", [mira.id]: "accepted" });
  assert.deepEqual(room.log.filter((event) => event.type === "tradeResponded").map((event) => event.data),
    [{ tradeId: id, fromId: rowan.id, playerId: ellis.id, response: "declined" },
      { tradeId: id, fromId: rowan.id, playerId: mira.id, response: "accepted" }]);
  reject(room, { type: "confirmTrade", tradeId: id, partnerId: ellis.id });
  reject(room, { type: "confirmTrade", tradeId: id, partnerId: rowan.id });
  reject(room, { type: "confirmTrade", tradeId: "stale", partnerId: mira.id });
  reject(room, { type: "confirmTrade", tradeId: id, partnerId: mira.id }, 1);
  run(room, { type: "confirmTrade", tradeId: id, partnerId: mira.id });
  assert.deepEqual(room.trades, []);
  assert.deepEqual([rowan.resources.wood, rowan.resources.ore, mira.resources.wood, mira.resources.ore], [7, 3, 1, 3]);
  assert.deepEqual(room.log.findLast((event) => event.type === "tradeAccepted").data,
    { tradeId: id, fromId: rowan.id, targetId: mira.id, give: { wood: 1, brick: 0, sheep: 0, wheat: 0, ore: 0 },
      want: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 1 } });
  conserve(room);
});

test("open-offer acceptances are dropped when Monopoly or departure makes them stale, and counters sit beside the offer", () => {
  const room = fixture(4);
  const [rowan, mira, ellis, sage] = room.players;
  room.bank.ore -= 1; sage.resources.ore += 1;
  const monopoly = room.developmentDeck.splice(room.developmentDeck.findIndex((card) => card.type === "monopoly"), 1)[0];
  rowan.developmentCards.push({ ...monopoly, boughtTurn: 0 });
  run(room, openOffer());
  run(room, { type: "respondTrade", accept: true, tradeId: room.trades.at(-1).id }, 1);
  run(room, { type: "respondTrade", accept: true, tradeId: room.trades.at(-1).id }, 3);
  resignPlayer(room, sage.id, () => .1);
  assert.deepEqual(room.trades.at(-1).responses, { [mira.id]: "accepted" });
  run(room, { type: "playDevelopment", cardId: monopoly.id, resource: "ore" });
  assert.deepEqual(room.trades.at(-1).responses, {}, "Mira no longer holds the requested ore after a public Monopoly");
  reject(room, { type: "confirmTrade", tradeId: room.trades.at(-1).id, partnerId: mira.id });
  run(room, { type: "cancelTrade", tradeId: room.trades.at(-1).id });
  run(room, openOffer({ wood: 2 }, { brick: 1 }));
  const openId = room.trades.at(-1).id;
  reject(room, { type: "offerTrade", targetId: mira.id, give: { brick: 1 }, want: { wood: 1 }, replaceTradeId: openId }, 2);
  run(room, { type: "offerTrade", targetId: rowan.id, give: { brick: 1 }, want: { wood: 3 }, replaceTradeId: openId }, 2);
  assert.equal(room.trades.at(-1).fromId, ellis.id);
  assert.equal(room.trades.at(-1).targetId, rowan.id);
  assert.equal(room.trades.at(-1).counterTo, openId);
  assert.deepEqual(room.trades.map((trade) => trade.id).slice(0, 1), [openId]);
  run(room, { type: "respondTrade", accept: true, tradeId: room.trades.at(-1).id });
  assert.equal(ellis.resources.wood, 3);
  conserve(room);
});

test("bank trades exchange several cards in one action only in whole sets at each resource's own rate", () => {
  const room = fixture();
  const [rowan, mira] = room.players;
  const bank = (give, want) => ({ type: "bankTrade", give, want });
  const ports = room.board.ports;
  room.board.ports = [];
  for (const [give, want] of [[{ wood: 6 }, { ore: 1 }], [{ wood: 8 }, { ore: 1 }], [{ wood: 4 }, { ore: 2 }],
    [{ wood: 4 }, { wood: 1 }], [{ wood: 4 }, {}], [{}, { ore: 1 }], [{ wood: 12 }, { ore: 3 }], [{ wood: -4 }, { ore: -1 }],
    [{ wood: "8" }, { ore: 2 }], [{ gold: 4 }, { ore: 1 }]]) reject(room, bank(give, want));
  run(room, bank({ wood: 8 }, { ore: 1, brick: 1 }));
  assert.deepEqual([rowan.resources.wood, rowan.resources.ore, rowan.resources.brick], [0, 3, 3]);
  assert.deepEqual(room.log.at(-1).data, { give: { wood: 8 }, want: { brick: 1, ore: 1 }, ratio: 4 });
  assert.equal(room.log.at(-1).message, "Rowan traded with the bank: 8 wood for 1 brick, 1 ore.");
  room.board.ports = ports.filter((port) => port === ports.find((p) => p.resource === null) || port.resource === "sheep");
  const vertex = (port) => room.board.vertices.find((v) => v.id === room.board.ports.find((p) => p.resource === port).vertices[0]);
  vertex(null).structure = { playerId: rowan.id, kind: "settlement" };
  vertex("sheep").structure = { playerId: rowan.id, kind: "settlement" };
  room.bank.wood -= 3; rowan.resources.wood += 3;
  run(room, bank({ wood: 3, sheep: 2 }, { wheat: 2 }));
  assert.deepEqual(room.log.at(-1).data, { give: { wood: 3, sheep: 2 }, want: { wheat: 2 }, ratio: null });
  const spare = room.bank.ore - 1;
  room.bank.ore -= spare; mira.resources.ore += spare;
  reject(room, bank({ brick: 3, wheat: 3 }, { ore: 2 }));
  run(room, bank({ brick: 3 }, { ore: 1 }));
  conserve(room);
});

test("several offers and counteroffers stay open together within Colonist's per-player limits", () => {
  const room = fixture(4);
  const [rowan, mira, ellis] = room.players;
  room.bank.wheat -= 2; ellis.resources.wheat += 2;
  for (const [index, want] of [{ ore: 1 }, { sheep: 1 }, { brick: 1 }, { ore: 2 }, { sheep: 2 }].entries()) {
    run(room, index % 2 ? openOffer({ wood: 1 }, want) : { type: "offerTrade", targetId: mira.id, give: { wood: 1 }, want });
  }
  assert.equal(room.trades.length, 5);
  assert.equal(publicState(room, rowan.id).legal.canOfferTrade, false, "the active player may hold at most five offers");
  reject(room, openOffer({ wood: 1 }, { wheat: 1 }));
  const open = room.trades[1];
  for (const [give, want] of [[{ ore: 1 }, { wood: 1 }], [{ ore: 2 }, { wood: 2 }], [{ sheep: 1 }, { wood: 2 }]]) {
    run(room, { type: "offerTrade", counterTo: open.id, give, want }, 1);
  }
  reject(room, { type: "offerTrade", counterTo: open.id, give: { ore: 3 }, want: { wood: 3 } }, 1);
  assert.equal(room.trades.length, 8);
  assert.ok(room.trades.slice(5).every((trade) => trade.fromId === mira.id && trade.targetId === rowan.id && trade.counterTo === open.id));
  run(room, { type: "offerTrade", targetId: rowan.id, give: { wheat: 1 }, want: { wood: 1 }, counterTo: null }, 2);
  run(room, { type: "respondTrade", accept: true, tradeId: room.trades[6].id });
  assert.equal(mira.resources.ore, 2);
  assert.ok(room.trades.some((trade) => trade.id === open.id), "completing a counteroffer leaves the original open");
  conserve(room);
});

test("identical offers are refused while open and limited per turn, while edits replace an offer in place", () => {
  const room = fixture();
  const [, mira] = room.players;
  const offer = { type: "offerTrade", targetId: mira.id, give: { wood: 1 }, want: { ore: 1 } };
  run(room, offer);
  reject(room, offer);
  for (let count = 0; count < 2; count++) {
    run(room, { type: "cancelTrade", tradeId: room.trades.at(-1).id });
    run(room, offer);
  }
  run(room, { type: "cancelTrade", tradeId: room.trades.at(-1).id });
  reject(room, offer);
  run(room, openOffer({ wood: 2 }, { ore: 1 }));
  const first = room.trades.at(-1).id;
  run(room, { type: "respondTrade", accept: true, tradeId: first }, 1);
  run(room, { type: "offerTrade", targetId: null, give: { wood: 3 }, want: { ore: 1 }, replaceTradeId: first });
  assert.equal(room.trades.length, 1);
  assert.notEqual(room.trades[0].id, first);
  assert.deepEqual(room.trades[0].responses, {}, "changed terms need fresh answers");
  assert.equal(room.log.at(-1).data.replacesTradeId, first);
  assert.match(room.log.at(-1).message, /updated their offer to everyone: 3 wood for 1 ore/);
  run(room, { type: "endTurn" });
  assert.deepEqual(room.trades, []);
});

test("open-ended Any offers can only be declined or countered with exact cards", () => {
  const room = fixture(4);
  const [rowan, mira] = room.players;
  reject(room, openOffer({ wood: 1 }, {}));
  for (const extra of [{ anyWant: 5 }, { anyWant: -1 }, { anyWant: 1.5 }, { anyWant: "1" }, { anyWant: 1, anyGive: 1 }]) {
    reject(room, { ...openOffer({ wood: 1 }, {}), ...extra });
  }
  reject(room, { ...openOffer({}, { ore: 1 }), anyGive: 17 }, 0);
  run(room, { ...openOffer({ wood: 1 }, {}), anyWant: 1 });
  const id = room.trades.at(-1).id;
  assert.match(room.log.at(-1).message, /1 wood for any 1 card/);
  assert.equal(room.log.at(-1).data.anyWant, 1);
  reject(room, { type: "respondTrade", accept: true, tradeId: id }, 1);
  run(room, { type: "offerTrade", counterTo: id, give: { ore: 1 }, want: { wood: 1 } }, 1);
  run(room, { type: "respondTrade", accept: true, tradeId: room.trades.at(-1).id });
  assert.equal(rowan.resources.ore, 3);
  assert.equal(mira.resources.wood, 1);
  run(room, { ...openOffer({}, { sheep: 1 }), anyGive: 2 });
  assert.equal(publicState(room, mira.id).trades.at(-1).anyGive, 2);
  conserve(room);
});

test("trade blocks are one-directional, public, and close offers that can no longer reach anyone", () => {
  const room = fixture(4);
  const [rowan, mira, ellis, sage] = room.players;
  run(room, { type: "offerTrade", targetId: mira.id, give: { wood: 1 }, want: { ore: 1 } });
  run(room, openOffer({ wood: 2 }, { sheep: 1 }));
  const open = room.trades.at(-1).id;
  run(room, { type: "respondTrade", accept: true, tradeId: open }, 1);
  run(room, { type: "setEmbargo", playerId: rowan.id, blocked: true }, 1);
  reject(room, { type: "setEmbargo", playerId: rowan.id, blocked: true }, 1);
  reject(room, { type: "setEmbargo", playerId: mira.id, blocked: true }, 1);
  reject(room, { type: "setEmbargo", playerId: rowan.id, blocked: "yes" }, 2);
  assert.equal(room.trades.length, 1, "the named offer to Mira closes once she blocks Rowan");
  assert.equal(room.log.findLast((event) => event.type === "tradeCancelled").data.reason, "blocked");
  const view = publicState(room, ellis.id);
  assert.deepEqual(view.embargoes, { [mira.id]: [rowan.id] });
  assert.deepEqual(view.trades[0].responders, [ellis.id, sage.id]);
  assert.deepEqual(view.trades[0].blockedBy, [mira.id]);
  assert.deepEqual(view.trades[0].responses, {}, "a blocker's earlier acceptance is withdrawn");
  reject(room, { type: "respondTrade", accept: true, tradeId: open }, 1);
  reject(room, { type: "offerTrade", targetId: mira.id, give: { wood: 1 }, want: { ore: 1 } });
  run(room, { type: "offerTrade", targetId: rowan.id, give: { ore: 1 }, want: { wood: 1 } }, 1);
  run(room, { type: "respondTrade", accept: true, tradeId: room.trades.at(-1).id });
  run(room, { type: "setEmbargo", playerId: rowan.id, blocked: true }, 2);
  run(room, { type: "respondTrade", accept: false, tradeId: open }, 3);
  assert.equal(room.trades.length, 0, "an open offer closes once every remaining player has blocked or declined it");
  assert.equal(room.log.findLast((event) => event.type === "tradeCancelled").data.reason, "declined-by-all");
  run(room, { type: "setEmbargo", playerId: rowan.id, blocked: true }, 3);
  reject(room, openOffer());
  run(room, { type: "setEmbargo", playerId: rowan.id, blocked: false }, 1);
  run(room, openOffer());
  resignPlayer(room, ellis.id, () => .1);
  assert.deepEqual(room.embargoes, { [sage.id]: [rowan.id] });
  conserve(room);
});

test("saved games with a single legacy offer load, answer and migrate without losing it", () => {
  const room = fixture();
  room.trades = undefined;
  delete room.trades;
  room.trade = { id: "legacy", fromId: room.players[0].id, targetId: room.players[1].id,
    give: { wood: 1, brick: 0, sheep: 0, wheat: 0, ore: 0 }, want: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 1 } };
  delete room.embargoes;
  const view = publicState(room, room.players[1].id);
  assert.equal(view.trades[0].id, "legacy");
  assert.equal(view.trades[0].unavailableReason, null);
  run(room, { type: "respondTrade", accept: true, tradeId: "legacy" }, 1);
  assert.ok(!Object.hasOwn(room, "trade"));
  assert.deepEqual(room.trades, []);
  assert.equal(room.players[1].resources.wood, 1);
  conserve(room);
});

async function harness(t, postgres = false) {
  const room = fixture();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-trade-atomic-"));
  const options = { dataDir };
  if (postgres) {
    const url = new URL(process.env.TEST_DATABASE_URL);
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    assert.equal(url.pathname, "/hearthlands_test");
    Object.assign(options, { databaseUrl: process.env.TEST_DATABASE_URL, databaseSsl: "disable",
      databaseSchema: `hearthlands_trade_test_${crypto.randomBytes(8).toString("hex")}` });
  }
  const seed = createStorage(options);
  await seed.init(); await seed.commitRoom(room); await seed.close();
  let service = createGameServer(options), port = await service.listen(0);
  const clients = [];
  async function connect(index) {
    const client = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false });
    clients.push(client); client.on("state", (state) => { client.latest = state; });
    await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("connect_error", reject); });
    assert.equal((await call(client, "reconnectRoom", { reconnectToken: room.players[index].reconnectToken })).ok, true);
    return client;
  }
  t.after(async () => { clients.forEach((c) => c.close()); await service.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { room, connect, get service() { return service; },
    read: () => service.storage.getRoom(room.code),
    history: () => service.storage.listEvents(room.code, { limit: 1000 }),
    async restart() { clients.forEach((c) => c.close()); await service.close(); service = createGameServer(options); port = await service.listen(0); },
  };
}
function call(client, event, data) {
  return new Promise((resolve, reject) => client.timeout(5000).emit(event, data, (error, response) => error ? reject(error) : resolve(response)));
}
const packet = (client, action) => ({ ...action, requestId: crypto.randomUUID(), clientSeq: client.latest.nextSequence, expectedTurnNumber: client.latest.turnNumber });
const send = (client, action) => call(client, "gameAction", packet(client, action));

for (const postgres of [false, true]) test(`${postgres ? "PostgreSQL" : "SQLite"} acceptance failure, retry, duplicate delivery and restart never lose or double-exchange cards`, {
  skip: postgres && !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const h = await harness(t, postgres);
  let a = await h.connect(0), b = await h.connect(1);
  assert.equal((await send(a, initialOffer(h.room))).ok, true);
  const request = packet(b, { type: "respondTrade", accept: true, tradeId: a.latest.trades.at(-1).id });
  const before = holdings(await h.read());
  const commit = h.service.storage.commitRoom.bind(h.service.storage);
  h.service.storage.commitRoom = async () => { throw new StorageError("SAVE_FAILED", "Injected write failure"); };
  const failed = await call(b, "gameAction", request);
  assert.equal(failed.ok, false);
  assert.deepEqual(holdings(await h.read()), before);
  assert.equal((await h.read()).trades.at(-1).id, request.tradeId);
  h.service.storage.commitRoom = commit;
  const results = await Promise.all([call(b, "gameAction", request), call(b, "gameAction", request)]);
  assert.ok(results.every((result) => result.ok));
  const after = holdings(await h.read());
  assert.equal(after.players[0].wood, before.players[0].wood - 1);
  assert.equal(after.players[1].wood, before.players[1].wood + 1);
  assert.deepEqual(after.bank, before.bank);
  await h.restart(); a = await h.connect(0); b = await h.connect(1);
  assert.equal((await call(b, "gameAction", request)).ok, true);
  assert.deepEqual(holdings(await h.read()), after);
  assert.equal((await h.history()).filter((event) => event.type === "tradeAccepted").length, 1);
});

for (const competitor of ["cancel", "counter", "end", "spend", "remove"]) test(`acceptance racing ${competitor} is serialized and preserves resource totals`, async (t) => {
  const h = await harness(t);
  const a = await h.connect(0), b = await h.connect(1);
  await send(a, { ...initialOffer(h.room), give: { wood: 8 } });
  const oldId = a.latest.trades.at(-1).id;
  const accept = packet(b, { type: "respondTrade", accept: true, tradeId: oldId });
  let event = "gameAction", action;
  if (competitor === "cancel") action = { type: "cancelTrade", tradeId: oldId };
  if (competitor === "counter") action = { ...initialOffer(h.room), give: { wood: 2 }, replaceTradeId: oldId };
  if (competitor === "end") action = { type: "endTurn" };
  if (competitor === "spend") action = { type: "bankTrade", giveResource: "wood", receiveResource: "brick" };
  if (competitor === "remove") { event = "removePlayer"; action = { playerId: h.room.players[1].id, confirmed: true }; }
  const results = await Promise.all([call(a, event, packet(a, action)), call(b, "gameAction", accept)]);
  const room = await h.read();
  conserve(room);
  const accepted = (await h.history()).filter((e) => e.type === "tradeAccepted");
  assert.ok(accepted.length <= 1);
  assert.equal(accepted.length, results[1].ok ? 1 : 0);
  assert.ok(!room.trades.some((trade) => trade.id === oldId));
});

test("a delayed sequenced counter after cancellation is terminally rejected and replay cannot recreate it", async (t) => {
  const h = await harness(t);
  const a = await h.connect(0), b = await h.connect(1);
  await send(a, initialOffer(h.room));
  const stale = packet(b, { type: "offerTrade", targetId: h.room.players[0].id, give: { ore: 1 }, want: { wood: 2 }, replaceTradeId: a.latest.trades.at(-1).id });
  await send(a, { type: "cancelTrade", tradeId: a.latest.trades.at(-1).id });
  assert.equal((await call(b, "gameAction", stale)).ok, false);
  assert.equal((await call(b, "gameAction", stale)).ok, false);
  assert.deepEqual((await h.read()).trades, []);
  assert.equal((await h.history()).filter((event) => event.type === "tradeCounteroffered").length, 0);
});

test("counteroffer drafting hints reach other seats only for live trades and are never stored", async (t) => {
  const h = await harness(t);
  const a = await h.connect(0), b = await h.connect(1);
  await send(a, { type: "offerTrade", targetId: null, give: { wood: 1 }, want: { ore: 1 } });
  const tradeId = (await h.read()).trades.at(-1).id;
  const revision = (await h.read()).revision;
  const heard = new Promise((resolve) => b.once("tradeDrafting", resolve));
  assert.equal((await call(a, "tradeDrafting", { tradeId })).ok, true);
  const hint = await heard;
  assert.equal(hint.playerId, h.room.players[0].id);
  assert.equal(hint.tradeId, tradeId);
  assert.equal((await call(a, "tradeDrafting", { tradeId: "closed" })).ok, false);
  assert.equal((await call(a, "tradeDrafting", { tradeId: null })).ok, true);
  assert.equal((await h.read()).revision, revision);
});
