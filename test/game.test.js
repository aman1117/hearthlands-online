"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  addPlayer,
  applyAction,
  createRoom,
  makeBoard,
  publicState,
  startGame,
} = require("../game");

function fixedRandom(value = 0.42) {
  return () => value;
}

function fullRoom() {
  const { room, player: host } = createRoom("Ada");
  room.code = "ABCDEF";
  addPlayer(room, "Bert");
  addPlayer(room, "Cy");
  addPlayer(room, "Dee");
  return { room, host };
}

test("expanded board has 30 tiles and shared topology", () => {
  const board = makeBoard(fixedRandom());
  assert.equal(board.tiles.length, 30);
  assert.equal(board.vertices.length, 80);
  assert.equal(board.edges.length, 109);
  assert.equal(board.vertices.length - board.edges.length + board.tiles.length, 1);
  assert.equal(board.tiles.filter((tile) => tile.robber).length, 1);
  assert.equal(board.tiles.filter((tile) => tile.resource === "desert").length, 2);
});

test("game requires at least three players and starts in setup", () => {
  const { room, player: host } = createRoom("Ada");
  assert.throws(() => startGame(room, host.id), /3-6/);
  addPlayer(room, "Bert");
  assert.throws(() => startGame(room, host.id), /3-6/);
  addPlayer(room, "Cy");
  addPlayer(room, "Dee");
  startGame(room, host.id, fixedRandom());
  assert.equal(room.phase, "setup");
  assert.equal(room.players.length, 4);
  assert.equal(room.board.tiles.length, 19);
});

test("setup settlement and road advance the turn", () => {
  const { room, host } = fullRoom();
  startGame(room, host.id, fixedRandom());
  const actor = room.players[0];
  const vertex = room.board.vertices[0];
  applyAction(room, actor.id, { type: "setupSettlement", vertexId: vertex.id });
  assert.equal(vertex.structure.playerId, actor.id);
  assert.equal(room.setupNeedsRoad, true);
  const edge = room.board.edges.find((candidate) => candidate.vertices.includes(vertex.id));
  applyAction(room, actor.id, { type: "setupRoad", edgeId: edge.id });
  assert.equal(edge.road.playerId, actor.id);
  assert.equal(room.turnIndex, 1);
});

test("public state hides other players' resource cards", () => {
  const { room, host } = fullRoom();
  room.players[0].resources.wood = 3;
  room.players[1].resources.ore = 5;
  const view = publicState(room, host.id);
  assert.deepEqual(view.players.find((player) => player.id === host.id).resources, room.players[0].resources);
  assert.equal(view.players[1].resources, undefined);
  assert.equal(view.players[1].resourceCount, 5);
});

test("bank trade exchanges four matching resources for one", () => {
  const { room, host } = fullRoom();
  startGame(room, host.id, fixedRandom());
  room.phase = "action";
  room.turnIndex = room.players.findIndex((player) => player.id === host.id);
  host.resources.wood = 4;
  applyAction(room, host.id, { type: "bankTrade", giveResource: "wood", receiveResource: "ore" });
  assert.equal(host.resources.wood, 0);
  assert.equal(host.resources.ore, 1);
});

test("direct trade transfers only after target accepts", () => {
  const { room, host } = fullRoom();
  startGame(room, host.id, fixedRandom());
  room.phase = "action";
  room.turnIndex = room.players.findIndex((player) => player.id === host.id);
  const target = room.players.find((player) => player.id !== host.id);
  host.resources.wood = 1;
  target.resources.ore = 1;
  applyAction(room, host.id, {
    type: "offerTrade",
    targetId: target.id,
    give: { wood: 1 },
    want: { ore: 1 },
  });
  applyAction(room, target.id, { type: "respondTrade", accept: true });
  assert.equal(host.resources.wood, 0);
  assert.equal(host.resources.ore, 1);
  assert.equal(target.resources.wood, 1);
  assert.equal(target.resources.ore, 0);
});
