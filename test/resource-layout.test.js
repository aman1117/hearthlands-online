"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeBoard, createRoom, addPlayer, ensureMapPreview, shuffleMap, startGame, RESOURCES } = require("../game");
const { spreadResources } = require("../resource-layout");

function rng(seed) {
  return () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
function topology(board) {
  const indices = new Map(board.tiles.map((tile, index) => [tile.id, index]));
  const neighbours = board.tiles.map(() => []);
  for (const edge of board.edges) {
    if (edge.adjacentTiles.length !== 2) continue;
    const [a, b] = edge.adjacentTiles.map((id) => indices.get(id));
    neighbours[a].push(b); neighbours[b].push(a);
  }
  return neighbours;
}
function valid(board, expanded) {
  const expected = expanded ? [6, 5, 6, 6, 5, 2] : [4, 3, 4, 4, 3, 1];
  const types = [...RESOURCES, "desert"];
  assert.deepEqual(types.map((type) => board.tiles.filter((tile) => tile.resource === type).length), expected);
  const tiles = new Map(board.tiles.map((tile) => [tile.id, tile]));
  assert.equal(board.tiles.filter((tile) => tile.robber).length, 1);
  assert.ok(board.tiles.filter((tile) => tile.resource === "desert").every((tile) => tile.number === null));
  assert.equal(board.tiles.find((tile) => tile.robber).resource, "desert");
  for (const edge of board.edges) {
    if (edge.adjacentTiles.length !== 2) continue;
    const [a, b] = edge.adjacentTiles.map((id) => tiles.get(id));
    assert.notEqual(a.resource, b.resource, `Matching resources at ${a.id}/${b.id}`);
    assert.ok(!([6, 8].includes(a.number) && [6, 8].includes(b.number)), "Adjacent red numbers");
  }
  for (const vertex of board.vertices) {
    const resources = vertex.adjacentTiles.map((id) => tiles.get(id).resource);
    assert.equal(new Set(resources).size, resources.length, "A junction should not have repeated resources");
    assert.equal(vertex.structure, null);
  }
  for (const number of [2, 3, 4, 5, 6, 8, 9, 10, 11, 12]) {
    const expectedCount = [2, 12].includes(number) ? expanded ? 2 : 1 : expanded ? 3 : 2;
    assert.equal(board.tiles.filter((tile) => tile.number === number).length, expectedCount);
  }
}

for (const players of [4, 6]) test(`${players}-player constrained shuffles eliminate identical neighbours without losing map variety or pinning deserts`, () => {
  const layouts = new Set();
  const deserts = new Set();
  const resourcePositions = new Map([...RESOURCES, "desert"].map((resource) => [resource, new Set()]));
  for (let seed = 1; seed <= 1000; seed++) {
    let draws = 0;
    const random = rng(seed);
    const board = makeBoard(() => { assert.ok(++draws <= 1000, "Random consumption must remain bounded"); return random(); }, players);
    valid(board, players > 4);
    layouts.add(board.tiles.map((tile) => tile.resource).join(","));
    for (const tile of board.tiles) {
      resourcePositions.get(tile.resource).add(tile.id);
      if (tile.resource === "desert") deserts.add(tile.id);
    }
  }
  assert.ok(layouts.size >= 990, `Expected at least 990 distinct layouts, received ${layouts.size}`);
  assert.equal(deserts.size, players > 4 ? 30 : 19, "Deserts may occur across the entire board");
  for (const positions of resourcePositions.values()) assert.equal(positions.size, players > 4 ? 30 : 19);
});

for (const players of [3, 4, 5, 6]) test(`${players}-player constant random sources and deterministic replay preserve every layout constraint`, () => {
  for (const value of [0, .1, .42, .5, .999999999]) valid(makeBoard(() => value, players), players > 4);
  assert.deepEqual(makeBoard(rng(712), players), makeBoard(rng(712), players));
});

for (const expanded of [false, true]) test(`bounded fallback is valid for the ${expanded ? "expanded" : "standard"} island and does not mutate its inputs`, () => {
  const board = makeBoard(rng(13), expanded ? 6 : 4);
  const neighbours = topology(board);
  const counts = expanded ? [6, 5, 6, 6, 5, 2] : [4, 3, 4, 4, 3, 1];
  const before = structuredClone({ neighbours, counts });
  for (const row of neighbours) Object.freeze(row);
  Object.freeze(neighbours); Object.freeze(counts);
  for (const budget of [0, 1, 10]) {
    const result = spreadResources(neighbours, counts, (values) => [...values].reverse(), budget);
    assert.deepEqual(counts.map((_, resource) => result.filter((value) => value === resource).length), counts);
    for (let index = 0; index < result.length; index++) {
      for (const other of neighbours[index]) assert.notEqual(result[index], result[other]);
    }
  }
  assert.deepEqual({ neighbours, counts }, before);
});

test("invalid inventory and impossible topology fail explicitly instead of returning a clustered layout", () => {
  assert.throws(() => spreadResources([[], []], [1], (values) => values), /inventory/);
  assert.throws(() => spreadResources([[]], [1], (values) => values, Infinity), /search limit/);
  assert.throws(() => spreadResources([[1], [0]], [2], (values) => values), /Unable to arrange/);
});

test("existing lobby previews and started games are not changed until the host explicitly shuffles", () => {
  const { room, player } = createRoom("Host");
  addPlayer(room, "Second"); addPlayer(room, "Third");
  ensureMapPreview(room, rng(11));
  const originalResources = room.board.tiles.map((tile) => tile.resource).sort();
  room.board.tiles.forEach((tile, i) => { tile.resource = originalResources[i]; });
  const olderPreview = structuredClone(room.board);
  assert.equal(ensureMapPreview(room, () => { throw new Error("Unexpected random draw"); }), false);
  assert.deepEqual(room.board, olderPreview);
  shuffleMap(room, player.id, room.mapVersion, rng(12));
  valid(room.board, false);
  const preview = structuredClone(room.board);
  startGame(room, player.id, rng(3));
  assert.deepEqual(room.board, preview);
  for (const phase of ["setup", "roll", "action", "robber", "finished"]) {
    room.phase = phase;
    const before = structuredClone(room);
    assert.equal(ensureMapPreview(room, () => { throw new Error("Unexpected generation"); }), false);
    assert.throws(() => shuffleMap(room, player.id, room.mapVersion, rng(4)));
    assert.deepEqual(room, before);
  }
});
