"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  RESOURCES, createRoom, addPlayer, startGame, applyAction, publicState, resourceTotal,
} = require("../game");

// Sources reviewed: 2025 CN3081 pp. 3, 6-10, 12 and CN3082 pp. 1-4.
// https://www.catan.com/sites/default/files/2025-03/CN3081%20CATAN%E2%80%93The%20Game%20Rulebook%20secure%20%281%29.pdf
// https://www.catan.com/sites/default/files/2025-03/CN3082%20CATAN%20%E2%80%93%205-6%20Rulebook%202025%20reduced.pdf
// Official FAQ confirms circular routes and own-building continuity: https://www.catan.com/faq/basegame

for (const count of [3, 4, 5, 6]) {
  test(`official ${count}-player deck can be exhausted exactly once with conserved cards and no purchase-face events`, () => {
    const { room, player: host } = createRoom("Host");
    for (let i = 1; i < count; i += 1) addPlayer(room, `Guest${i}`);
    startGame(room, host.id, () => 0.42);
    room.phase = "action";
    room.turnNumber = 1;
    const player = room.players[0];
    const expected = count > 4
      ? { knight: 20, victoryPoint: 5, monopoly: 3, roadBuilding: 3, yearOfPlenty: 3 }
      : { knight: 14, victoryPoint: 5, monopoly: 2, roadBuilding: 2, yearOfPlenty: 2 };
    const total = count > 4 ? 34 : 25;
    const supply = count > 4 ? 24 : 19;
    const originalIds = room.developmentDeck.map((card) => card.id).sort();
    for (let index = 0; index < total; index += 1) {
      for (const resource of ["sheep", "wheat", "ore"]) {
        room.bank[resource] -= 1;
        player.resources[resource] += 1;
      }
      applyAction(room, player.id, { type: "buyDevelopment" });
      assert.equal(room.developmentDeck.length + player.developmentCards.length, total);
      assert.equal(room.eventOutbox.at(-1).type, "developmentBought");
      assert.deepEqual(room.eventOutbox.at(-1).data, { count: 1 });
      for (const resource of RESOURCES) {
        assert.equal(room.bank[resource] + room.players.reduce((sum, p) => sum + p.resources[resource], 0), supply);
      }
    }
    assert.deepEqual(player.developmentCards.map((card) => card.id).sort(), originalIds);
    for (const [type, number] of Object.entries(expected)) {
      assert.equal(player.developmentCards.filter((card) => card.type === type).length, number);
    }
    assert.equal(room.developmentDeck.length, 0);
    assert.equal(resourceTotal(player), 0);
    assert.equal(publicState(room, player.id).legal.canBuyDevelopment, false);
    assert.equal(publicState(room, room.players[1].id).players[0].points, 0);
    assert.equal(publicState(room, player.id).players[0].points, 5);
    const before = structuredClone(room);
    assert.throws(() => applyAction(room, player.id, { type: "buyDevelopment" }), /No development/);
    assert.deepEqual(room, before);
  });
}

test("official counteroffers remain available to primary counterparties but not between inactive seats", () => {
  const { room, player: host } = createRoom("Host");
  for (let i = 1; i < 5; i += 1) addPlayer(room, `Guest${i}`);
  startGame(room, host.id, () => 0.42);
  room.phase = "action";
  room.turnNumber = 1;
  const [primary, first, second] = room.players;
  for (const [player, resource] of [[primary, "ore"], [first, "wood"], [second, "wheat"]]) {
    room.bank[resource] -= 2;
    player.resources[resource] = 2;
  }
  applyAction(room, first.id, { type: "offerTrade", targetId: primary.id, give: { wood: 1 }, want: { ore: 1 } });
  applyAction(room, primary.id, {
    type: "offerTrade", replaceTradeId: room.trade.id, targetId: first.id, give: { ore: 1 }, want: { wood: 2 },
  });
  assert.equal(room.trade.fromId, primary.id);
  assert.throws(() => applyAction(room, second.id, {
    type: "offerTrade", replaceTradeId: room.trade.id, targetId: first.id, give: { wheat: 1 }, want: { wood: 1 },
  }));
  applyAction(room, first.id, { type: "respondTrade", tradeId: room.trade.id, accept: true });
  applyAction(room, primary.id, { type: "endTurn" });
  assert.equal(room.turnRole, "secondary");
  assert.equal(room.turnIndex, 3);
  assert.equal(publicState(room, room.players[3].id).legal.canOfferTrade, false);
});
