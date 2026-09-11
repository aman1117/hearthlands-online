"use strict";

const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const PLACEMENTS = new Set(["buildRoad", "buildSettlement", "buildCity", "setupSettlement", "moveRobber"]);
const RESOURCES = ["wood", "brick", "sheep", "wheat", "ore"];
const STOCKS = { roadsLeft: 15, settlementsLeft: 5, citiesLeft: 4 };
const CONTROLS = ["phase", "setupNeedsRoad", "lastSetupVertex", "freeRoadsRemaining", "freeRoadsReturnPhase",
  "mustMoveRobber", "robberReturnPhase", "robberVictims"];
const MAX_PLACEMENTS = 32;
const LABELS = {
  buildRoad: "Undo road", buildSettlement: "Undo settlement", buildCity: "Undo city upgrade",
  setupSettlement: "Undo setup settlement", moveRobber: "Undo robber move",
};

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function context(room) {
  return {
    actorId: room.players[room.turnIndex]?.id ?? null, turnNumber: room.turnNumber ?? 0,
    turnRole: room.turnRole, primaryIndex: room.primaryIndex, setupRound: room.setupRound,
    mapVersion: room.mapVersion ?? 0,
  };
}

function controls(room) {
  return Object.fromEntries(CONTROLS.map((key) => [
    key, { present: Object.hasOwn(room, key), value: structuredClone(room[key] ?? null) },
  ]));
}

// Dependency fingerprints are canonical across JSON/JSONB key ordering. They exclude
// receipts, history, administration, connectivity and derived face-up-card backfills.
function fingerprint(room) {
  return crypto.createHash("sha256").update(canonical({
    context: context(room), controls: controls(room), board: room.board, bank: room.bank,
    pendingDiscards: room.pendingDiscards ?? {}, dice: room.dice ?? null,
    developmentPlayed: room.developmentPlayed, developmentCount: room.developmentDeck.length,
    awards: { road: room.longestRoadHolderId ?? null, army: room.largestArmyHolderId ?? null },
    players: room.players.map((player) => ({
      id: player.id, resigned: Boolean(player.resigned), removed: Boolean(player.removed),
      resources: player.resources, roadsLeft: player.roadsLeft, settlementsLeft: player.settlementsLeft,
      citiesLeft: player.citiesLeft, knightsPlayed: player.knightsPlayed, developmentCount: player.developmentCards.length,
    })),
  })).digest("hex");
}

function validJournal(room, actorId) {
  const journal = room.placementUndoJournal;
  if (!journal || journal.version !== 1 || room.phase === "finished" || room.winnerId ||
      !room.board || room.phase === "lobby" || !Array.isArray(journal.entries) ||
      journal.entries.length < 1 || journal.entries.length > MAX_PLACEMENTS ||
      room.players[room.turnIndex]?.resigned || actorId !== room.players[room.turnIndex]?.id ||
      !isDeepStrictEqual(journal.context, context(room))) return null;
  const latest = journal.entries.at(-1);
  if (!latest || !PLACEMENTS.has(latest.type) || typeof latest.id !== "string" ||
      typeof latest.label !== "string" || typeof latest.targetId !== "string" || !latest.inverse ||
      latest.afterGuard !== fingerprint(room)) return null;
  return journal;
}

function undoOpportunity(room, actorId) {
  const journal = validJournal(room, actorId);
  if (!journal) return null;
  const { id, type, label, targetId } = journal.entries.at(-1);
  return { id, type, label, targetId, count: journal.entries.length };
}

function invalidatePlacementUndo(room) {
  room.placementUndoJournal = null;
}

function capturePlacement(room, actorId, action) {
  if (!PLACEMENTS.has(action?.type) || !room.board || room.players[room.turnIndex]?.id !== actorId) return null;
  const player = room.players[room.turnIndex];
  const targetId = action.type === "buildRoad" ? action.edgeId
    : action.type === "moveRobber" ? action.tileId : action.vertexId;
  const previousRobber = room.board.tiles.filter((tile) => tile.robber);
  if (action.type === "moveRobber" && previousRobber.length !== 1) return null;
  const targetBefore = action.type === "buildRoad"
    ? room.board.edges.find((edge) => edge.id === targetId)?.road ?? null
    : action.type === "moveRobber" ? previousRobber[0].id
      : room.board.vertices.find((vertex) => vertex.id === targetId)?.structure ?? null;
  const journal = validJournal(room, actorId);
  return {
    context: context(room), type: action.type, targetId, targetBefore: structuredClone(targetBefore),
    controls: controls(room), resources: { ...player.resources },
    stocks: Object.fromEntries(Object.keys(STOCKS).map((key) => [key, player[key]])),
    awards: { longestRoadHolderId: room.longestRoadHolderId ?? null, largestArmyHolderId: room.largestArmyHolderId ?? null },
    // Robber relocation becomes final when another placement follows it.
    entries: journal && !journal.entries.some((entry) => entry.type === "moveRobber") ? journal.entries : [],
  };
}

function recordPlacement(room, before) {
  if (room.phase === "finished" || room.winnerId || !isDeepStrictEqual(before.context, context(room))) {
    invalidatePlacementUndo(room);
    return;
  }
  const player = room.players[room.turnIndex];
  const afterControls = controls(room);
  const entry = {
    id: crypto.randomBytes(16).toString("hex"), type: before.type, targetId: before.targetId,
    label: before.type === "buildRoad" && before.controls.freeRoadsRemaining.value > 0 ? "Undo free road" : LABELS[before.type],
    inverse: {
      targetBefore: before.targetBefore,
      resources: Object.fromEntries(RESOURCES.map((key) => [key, before.resources[key] - player.resources[key]])
        .filter(([, amount]) => amount !== 0)),
      stocks: Object.fromEntries(Object.keys(STOCKS).map((key) => [key, before.stocks[key] - player[key]])
        .filter(([, amount]) => amount !== 0)),
      controls: Object.fromEntries(CONTROLS.filter((key) => !isDeepStrictEqual(before.controls[key], afterControls[key]))
        .map((key) => [key, before.controls[key]])),
      awards: before.awards,
    },
    afterGuard: fingerprint(room),
  };
  room.placementUndoJournal = { version: 1, context: before.context, entries: [...before.entries, entry].slice(-MAX_PLACEMENTS) };
}

function preserveAfterAction(action) {
  return action.type === "offerTrade" || action.type === "cancelTrade" ||
    (action.type === "respondTrade" && action.accept === false) || action.type === "undoPlacement";
}

// House rule: apply only the newest bounded inverse patch, never a room snapshot.
function undoLatestPlacement(room, actorId, placementId) {
  const journal = validJournal(room, actorId);
  const entry = journal?.entries.at(-1);
  if (!entry || typeof placementId !== "string" || entry.id !== placementId) {
    throw new Error("That placement is no longer the latest undoable placement.");
  }
  const player = room.players[room.turnIndex];
  const inverse = entry.inverse;
  const supply = room.players.length > 4 ? 24 : 19;
  for (const [resource, amount] of Object.entries(inverse.resources)) {
    if (!RESOURCES.includes(resource) || !Number.isSafeInteger(amount) ||
        !Number.isSafeInteger(player.resources[resource] + amount) ||
        !Number.isSafeInteger(room.bank[resource] - amount) ||
        player.resources[resource] + amount < 0 || player.resources[resource] + amount > supply ||
        room.bank[resource] - amount < 0 || room.bank[resource] - amount > supply) {
      throw new Error("The placement refund no longer matches the available resources.");
    }
  }
  for (const [stock, amount] of Object.entries(inverse.stocks)) {
    if (!Object.hasOwn(STOCKS, stock) || !Number.isSafeInteger(amount) ||
        !Number.isSafeInteger(player[stock] + amount) ||
        player[stock] + amount < 0 || player[stock] + amount > STOCKS[stock]) {
      throw new Error("The placement pieces no longer match.");
    }
  }
  if (Object.keys(inverse.controls).some((key) => !CONTROLS.includes(key))) {
    throw new Error("The placement continuation is invalid.");
  }
  if (entry.type === "moveRobber") {
    if (!room.board.tiles.some((tile) => tile.id === inverse.targetBefore)) throw new Error("The previous robber tile is unavailable.");
    for (const tile of room.board.tiles) tile.robber = tile.id === inverse.targetBefore;
  } else if (entry.type === "buildRoad") {
    room.board.edges.find((edge) => edge.id === entry.targetId).road = structuredClone(inverse.targetBefore);
  } else {
    room.board.vertices.find((vertex) => vertex.id === entry.targetId).structure = structuredClone(inverse.targetBefore);
  }
  for (const [resource, amount] of Object.entries(inverse.resources)) {
    player.resources[resource] += amount;
    room.bank[resource] -= amount;
  }
  for (const [stock, amount] of Object.entries(inverse.stocks)) player[stock] += amount;
  for (const [key, previous] of Object.entries(inverse.controls)) {
    if (previous.present) room[key] = structuredClone(previous.value);
    else delete room[key];
  }
  journal.entries.pop();
  if (!journal.entries.length) invalidatePlacementUndo(room);
  return { type: entry.type, targetId: entry.targetId, label: entry.label, awards: inverse.awards };
}

module.exports = {
  capturePlacement, recordPlacement, invalidatePlacementUndo, preserveAfterAction, undoOpportunity, undoLatestPlacement,
};
