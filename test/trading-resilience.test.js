"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { io } = require("socket.io-client");
const { createRoom, addPlayer, startGame, applyAction, publicState, RESOURCES } = require("../game");
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
    reject(room, { ...initialOffer(room), replaceTradeId: room.trade.id }, seat);
    reject(room, { type: "respondTrade", accept: true, tradeId: room.trade.id }, seat);
    reject(room, { type: "bankTrade", giveResource: "wood", receiveResource: "ore" }, seat);
  }
  conserve(room);
});

for (const closing of ["cancel", "decline", "accept", "turn-end"]) test(`a delayed counteroffer cannot resurrect a trade after ${closing}`, () => {
  const room = fixture();
  run(room, initialOffer(room));
  const stale = { type: "offerTrade", targetId: room.players[0].id, give: { ore: 1 }, want: { wood: 2 }, replaceTradeId: room.trade.id };
  if (closing === "cancel") run(room, { type: "cancelTrade", tradeId: room.trade.id });
  else if (closing === "turn-end") run(room, { type: "endTurn" });
  else run(room, { type: "respondTrade", accept: closing === "accept", tradeId: room.trade.id }, 1);
  if (closing === "turn-end") run(room, { type: "roll" }, room.turnIndex);
  reject(room, stale, 1);
  assert.equal(room.trade, null);
  conserve(room);
});

test("recipient shortages never leak through public offer cancellation and invalid acceptance stays atomic", () => {
  const room = fixture();
  run(room, { ...initialOffer(room), want: { wheat: 1 } });
  const id = room.trade.id;
  reject(room, { type: "respondTrade", accept: true, tradeId: id }, 1);
  assert.equal(room.trade.id, id);
  run(room, { type: "bankTrade", giveResource: "wood", receiveResource: "brick" });
  assert.equal(room.trade.id, id, "Sender still holds offered wood; recipient's hidden wheat must not cause cancellation");
  for (const viewer of room.players) {
    assert.equal(publicState(room, viewer.id).trade.id, id);
    assert.equal(publicState(room, viewer.id).tradeUnavailableReason, null);
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
    assert.equal(view.tradeUnavailableReason, "offered-resources-spent");
    assert.ok(!Object.hasOwn(view.trade, "resources"));
  }
  assert.deepEqual(room, before);
  reject(room, { type: "respondTrade", accept: true, tradeId: room.trade.id }, 1);
});
for (const cardType of ["knight", "roadBuilding"]) test(`${cardType} resolves the pending offer rather than leaving unclickable trade controls`, () => {
  const room = fixture();
  const card = room.developmentDeck.splice(room.developmentDeck.findIndex((card) => card.type === cardType), 1)[0];
  room.players[0].developmentCards.push({ ...card, boughtTurn: 0 });
  run(room, initialOffer(room));
  const offerId = room.trade.id;
  run(room, { type: "playDevelopment", cardId: card.id });
  assert.equal(room.trade, null);
  assert.equal(room.log.findLast((event) => event.type === "tradeCancelled").data.reason, "required-action");
  reject(room, { type: "respondTrade", accept: true, tradeId: offerId }, 1);
  conserve(room);
});

test("only spending the actual offered resources cancels an offer, while failed actions preserve it", () => {
  const room = fixture();
  run(room, { ...initialOffer(room), give: { wood: 8 } });
  const id = room.trade.id;
  reject(room, { type: "bankTrade", giveResource: "ore", receiveResource: "wood" });
  assert.equal(room.trade.id, id);
  run(room, { type: "bankTrade", giveResource: "wood", receiveResource: "ore" });
  assert.equal(room.trade, null);
  assert.equal(room.log.findLast((event) => event.type === "tradeCancelled").data.reason, "offered-resources-spent");
  assert.equal(room.log.filter((event) => event.type === "tradeAccepted").length, 0);
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
  const request = packet(b, { type: "respondTrade", accept: true, tradeId: a.latest.trade.id });
  const before = holdings(await h.read());
  const commit = h.service.storage.commitRoom.bind(h.service.storage);
  h.service.storage.commitRoom = async () => { throw new StorageError("SAVE_FAILED", "Injected write failure"); };
  const failed = await call(b, "gameAction", request);
  assert.equal(failed.ok, false);
  assert.deepEqual(holdings(await h.read()), before);
  assert.equal((await h.read()).trade.id, request.tradeId);
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
  const oldId = a.latest.trade.id;
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
  assert.ok(!room.trade || room.trade.id !== oldId);
});

test("a delayed sequenced counter after cancellation is terminally rejected and replay cannot recreate it", async (t) => {
  const h = await harness(t);
  const a = await h.connect(0), b = await h.connect(1);
  await send(a, initialOffer(h.room));
  const stale = packet(b, { type: "offerTrade", targetId: h.room.players[0].id, give: { ore: 1 }, want: { wood: 2 }, replaceTradeId: a.latest.trade.id });
  await send(a, { type: "cancelTrade", tradeId: a.latest.trade.id });
  assert.equal((await call(b, "gameAction", stale)).ok, false);
  assert.equal((await call(b, "gameAction", stale)).ok, false);
  assert.equal((await h.read()).trade, null);
  assert.equal((await h.history()).filter((event) => event.type === "tradeCounteroffered").length, 0);
});
