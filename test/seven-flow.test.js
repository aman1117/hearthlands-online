"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRoom, addPlayer, startGame, applyAction, publicState } = require("../game");

function fixture() {
  const { room, player } = createRoom("Rowan");
  addPlayer(room, "Mira");
  addPlayer(room, "Ellis");
  startGame(room, player.id, () => .999);
  room.phase = "roll";
  room.turnNumber = 1;
  return room;
}

for (const count of [0, 6, 7, 8, 9, 10, 11, 19]) {
  test(`seven uses resource-only hand size ${count} and rounds the discard down`, () => {
    const room = fixture();
    const actor = room.players[0];
    actor.resources.wood = count;
    room.bank.wood -= count;
    actor.developmentCards = room.developmentDeck.splice(0, 5).map((card) => ({ ...card, boughtTurn: 0 }));
    let calls = 0;
    applyAction(room, actor.id, { type: "roll" }, () => calls++ ? .999 : 0);
    assert.equal(room.pendingDiscards[actor.id] || 0, count > 7 ? Math.floor(count / 2) : 0);
    assert.equal(actor.resources.wood, count, "A seven must not automatically choose or remove cards.");
    assert.equal(actor.developmentCards.length, 5);
    assert.equal(room.phase, count > 7 ? "discard" : "robber");
    assert.equal(publicState(room, actor.id).mustMoveRobber, true);
  });
}

test("stealing samples individual cards, giving a 9:1 resource hand a 90:10 outcome partition", () => {
  const counts = { wood: 0, ore: 0 };
  for (let sample = 0; sample < 100; sample++) {
    const room = fixture();
    const [actor, victim] = room.players;
    victim.resources.wood = 9;
    victim.resources.ore = 1;
    room.bank.wood -= 9;
    room.bank.ore--;
    room.phase = "steal";
    room.robberVictims = [victim.id];
    room.robberReturnPhase = "action";
    const beforeBank = structuredClone(room.bank);
    applyAction(room, actor.id, { type: "steal", targetId: victim.id }, () => (sample + .5) / 100);
    counts.wood += actor.resources.wood;
    counts.ore += actor.resources.ore;
    assert.deepEqual(room.bank, beforeBank);
    assert.equal(Object.values(victim.resources).reduce((a, b) => a + b, 0), 9);
    assert.equal(room.phase, "action");
  }
  assert.deepEqual(counts, { wood: 90, ore: 10 });
});
