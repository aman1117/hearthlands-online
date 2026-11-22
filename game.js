"use strict";

const crypto = require("node:crypto");
const { emptyProgressCounts, recordProgressPlay, revealedDevelopment } = require("./development-history");
const { spreadResources } = require("./resource-layout");
const {
  capturePlacement, recordPlacement, invalidatePlacementUndo, preserveAfterAction, undoOpportunity, undoLatestPlacement,
} = require("./placement-undo");

const RESOURCES = ["wood", "brick", "sheep", "wheat", "ore"];
const COLORS = ["#de5b43", "#2d82c7", "#f2b84b", "#6d9f4f", "#8357a5", "#20a398"];
const COSTS = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  development: { sheep: 1, wheat: 1, ore: 1 },
};
const RESIGN_PHASES = ["setup", "roll", "action", "discard", "robber", "steal"];
const id = () => crypto.randomBytes(8).toString("hex");
const emptyResources = () => Object.fromEntries(RESOURCES.map((resource) => [resource, 0]));
const totalBundle = (bundle) => RESOURCES.reduce((sum, resource) => sum + bundle[resource], 0);
const resourceTotal = (player) => totalBundle(player.resources);
const currentPlayer = (room) => room.players[room.turnIndex];
const activePlayers = (room) => room.players.filter((player) => !player.resigned);
const hasBundle = (player, bundle) =>
  Object.entries(bundle).every(([resource, amount]) => player.resources[resource] >= amount);

function nextActiveIndex(room, fromIndex, steps = 1) {
  if (!activePlayers(room).length) return -1;
  let index = fromIndex;
  for (let step = 0; step < steps; step += 1) {
    do { index = (index + 1) % room.players.length; } while (room.players[index].resigned);
  }
  return index;
}

function randomIndex(random, length) {
  const value = random();
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error("Random source must return a number from 0 (inclusive) to 1 (exclusive).");
  }
  return Math.floor(value * length);
}

function shuffle(items, random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomIndex(random, i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function makeBoard(random = Math.random, playerCount = 6) {
  const expanded = playerCount > 4;
  const rows = expanded ? [3, 4, 5, 6, 5, 4, 3] : [3, 4, 5, 4, 3];
  const counts = expanded ? [6, 5, 6, 6, 5, 2] : [4, 3, 4, 4, 3, 1];
  const vertices = [];
  const edges = [];
  const tiles = [];
  const verticesByCoordinate = new Map();
  const edgesByVertices = new Map();
  // Integer lattice coordinates avoid floating-point seams, including "-0".
  const corners = [[1, -1], [1, 1], [0, 2], [-1, 1], [-1, -1], [0, -2]];
  rows.forEach((length, row) => {
    for (let column = 0; column < length; column += 1) {
      const ix = 2 * column - (length - 1);
      const iy = 3 * (row - (rows.length - 1) / 2);
      const tile = {
        id: `t${tiles.length}`, q: column, r: row - (rows.length - 1) / 2,
        x: ix * Math.sqrt(3) / 2, y: iy / 2,
        resource: null, number: null, vertices: [], edges: [], robber: false,
      };
      for (const [dx, dy] of corners) {
        const key = `${ix + dx},${iy + dy}`;
        let vertex = verticesByCoordinate.get(key);
        if (!vertex) {
          vertex = {
            id: `v${vertices.length}`, x: (ix + dx) * Math.sqrt(3) / 2, y: (iy + dy) / 2,
            adjacentTiles: [], adjacentVertices: [], structure: null,
          };
          vertices.push(vertex);
          verticesByCoordinate.set(key, vertex);
        }
        vertex.adjacentTiles.push(tile.id);
        tile.vertices.push(vertex.id);
      }
      for (let corner = 0; corner < 6; corner += 1) {
        const ends = [tile.vertices[corner], tile.vertices[(corner + 1) % 6]];
        const key = [...ends].sort().join(":");
        let edge = edgesByVertices.get(key);
        if (!edge) {
          edge = { id: `e${edges.length}`, vertices: ends, road: null, adjacentTiles: [] };
          edges.push(edge);
          edgesByVertices.set(key, edge);
        }
        edge.adjacentTiles.push(tile.id);
        tile.edges.push(edge.id);
      }
      // A proper three-colouring of the hex-center triangular lattice.
      tile.numberColor = (((ix - row) / 2 - row) % 3 + 3) % 3;
      tiles.push(tile);
    }
  });
  const vertexMap = new Map(vertices.map((vertex) => [vertex.id, vertex]));
  edges.forEach(({ vertices: [a, b] }) => {
    vertexMap.get(a).adjacentVertices.push(b);
    vertexMap.get(b).adjacentVertices.push(a);
  });
  const tileIndices = new Map(tiles.map((tile, index) => [tile.id, index]));
  const adjacent = tiles.map(() => []);
  for (const edge of edges) {
    if (edge.adjacentTiles.length !== 2) continue;
    const [a, b] = edge.adjacentTiles.map((tileId) => tileIndices.get(tileId));
    adjacent[a].push(b);
    adjacent[b].push(a);
  }
  const terrainTypes = [...RESOURCES, "desert"];
  const terrain = spreadResources(adjacent, counts, (items) => shuffle(items, random));
  tiles.forEach((tile, index) => { tile.resource = terrainTypes[terrain[index]]; });
  tiles.find((tile) => tile.resource === "desert").robber = true;

  const numbers = expanded
    ? [2, 2, 12, 12, ...[3, 4, 5, 6, 8, 9, 10, 11].flatMap((n) => [n, n, n])]
    : [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11];
  const edgeMap = new Map(edges.map((edge) => [edge.id, edge]));
  const tileMap = new Map(tiles.map((tile) => [tile.id, tile]));
  const neighbours = (tile) => tile.edges.flatMap((edgeId) =>
    edgeMap.get(edgeId).adjacentTiles.filter((tileId) => tileId !== tile.id));
  // Traverse outside-in rings for the standard variable-map sequence.
  const remaining = new Set(tiles.map((tile) => tile.id));
  const spiral = [];
  while (remaining.size) {
    const ring = tiles.filter((tile) => remaining.has(tile.id) &&
      neighbours(tile).filter((tileId) => remaining.has(tileId)).length < 6);
    ring.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
    for (const tile of ring) { spiral.push(tile); remaining.delete(tile.id); }
  }
  let numberIndex = 0;
  const initialNumbers = expanded ? shuffle(numbers, random) : numbers;
  for (const tile of spiral) {
    if (tile.resource !== "desert") tile.number = initialNumbers[numberIndex++];
  }
  const hot = (number) => number === 6 || number === 8;
  if (tiles.some((tile) => hot(tile.number) &&
      neighbours(tile).some((tileId) => hot(tileMap.get(tileId).number)))) {
    const hotNumbers = shuffle(numbers.filter(hot), random);
    const otherNumbers = shuffle(numbers.filter((n) => !hot(n)), random);
    const groups = [0, 1, 2].map((color) =>
      tiles.filter((tile) => tile.resource !== "desert" && tile.numberColor === color));
    const choices = groups.filter((group) => group.length >= hotNumbers.length);
    const selected = new Set(shuffle(choices[randomIndex(random, choices.length)], random)
      .slice(0, hotNumbers.length).map((tile) => tile.id));
    for (const tile of spiral) {
      if (tile.resource !== "desert") {
        tile.number = selected.has(tile.id) ? hotNumbers.pop() : otherNumbers.pop();
      }
    }
  }
  for (const tile of tiles) delete tile.numberColor;

  const boundary = edges.filter((edge) => edge.adjacentTiles.length === 1);
  const orderedBoundary = [];
  let boundaryVertex = boundary[0].vertices[0];
  let previousEdge = null;
  do {
    const edge = boundary.find((candidate) => candidate.id !== previousEdge &&
      candidate.vertices.includes(boundaryVertex));
    orderedBoundary.push(edge);
    previousEdge = edge.id;
    boundaryVertex = edge.vertices.find((vertexId) => vertexId !== boundaryVertex);
  } while (boundaryVertex !== boundary[0].vertices[0]);
  const portTypes = shuffle(expanded
    ? [null, null, null, null, null, ...RESOURCES, "sheep"]
    : [null, null, null, null, ...RESOURCES], random);
  const ports = portTypes.map((resource, index) => ({
    id: `p${index}`, resource,
    vertices: [...orderedBoundary[Math.floor(index * orderedBoundary.length / portTypes.length)].vertices],
  }));
  return { tiles, vertices, edges, ports };
}

const PUBLIC_EVENT_FIELDS = {
  playerJoined: ["playerId"],
  mapShuffled: ["mapVersion", "boardPlayerCount"],
  gameStarted: ["playerCount", "boardPlayerCount", "firstPlayerId"],
  setupTurnStarted: ["round"],
  turnStarted: ["turnNumber", "role", "primaryPlayerId"],
  roadBuilt: ["edgeId", "free", "setup"],
  settlementBuilt: ["vertexId", "setup"],
  cityBuilt: ["vertexId"],
  diceRolled: ["dice", "total"],
  production: ["source", "total", "recipients"],
  productionShortage: ["resource", "requested", "available", "recipientCount", "distributed"],
  discarded: ["count"],
  robberMoved: ["tileId"],
  resourceStolen: ["victimId", "count"],
  bankTrade: ["give", "want", "ratio"],
  tradeOffered: ["tradeId", "fromId", "targetId", "give", "want", "anyGive", "anyWant", "counterTo", "replacesTradeId"],
  tradeCounteroffered: ["tradeId", "fromId", "targetId", "give", "want", "anyGive", "anyWant", "counterTo", "replacesTradeId"],
  tradeAccepted: ["tradeId", "fromId", "targetId", "give", "want"],
  tradeResponded: ["tradeId", "fromId", "playerId", "response"],
  tradeDeclined: ["tradeId", "fromId", "targetId", "give", "want"],
  tradeCancelled: ["tradeId", "fromId", "targetId", "give", "want", "anyGive", "anyWant", "counterTo", "reason"],
  developmentBought: ["count"],
  developmentPlayed: ["cardType", "resource", "count"],
  freeRoadsForfeited: ["count"],
  bonusChanged: ["bonus", "fromId", "toId", "points"],
  gameFinished: ["winnerId", "reason", "points"],
  playerResigned: ["resourceCount", "developmentCount", "roadCount", "settlementCount", "cityCount"],
  placementUndone: ["placementType", "targetId", "count"],
  legacy: [],
};
const isRecord = (value) => value !== null && typeof value === "object" &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isSequence = (value) => Number.isSafeInteger(value) && value >= 0;
const isPublicEventType = (value) => typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/.test(value);

function safePublicData(value, depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 8) return false;
  if (Array.isArray(value)) return Object.keys(value).length === value.length &&
    Array.from(value).every((item) => safePublicData(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, item]) =>
    !/(token|password|secret|hash|payload|clientSeq|developmentCards|developmentDeck|cardId)/i.test(key) &&
    !["__proto__", "prototype", "constructor", "request", "requests", "requestid"].includes(key.toLowerCase()) &&
    safePublicData(item, depth + 1));
}

function eventData(type, data) {
  if (!isRecord(data)) return null;
  const fields = Object.hasOwn(PUBLIC_EVENT_FIELDS, type) ? PUBLIC_EVENT_FIELDS[type] : null;
  const selected = Object.fromEntries(Object.entries(data).filter(([key]) => !fields || fields.includes(key)));
  if (type === "developmentPlayed" && selected.cardType !== "monopoly") delete selected.resource;
  return safePublicData(selected) ? structuredClone(selected) : null;
}

function safeStoredEvent(entry) {
  if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id ||
      !isSequence(entry.seq) || entry.seq === 0 || !isSequence(entry.at) ||
      !isPublicEventType(entry.type) || typeof entry.message !== "string" ||
      !(entry.actorId === null || typeof entry.actorId === "string")) return null;
  const data = eventData(entry.type, entry.data);
  if (data === null) return null;
  return {
    id: entry.id, seq: entry.seq, at: entry.at, type: entry.type,
    actorId: entry.actorId, message: entry.message, data,
  };
}

// Returns room. Legacy history is imported once, not re-enqueued as newly generated activity.
function normalizePublicEvents(room) {
  let sequence = 0;
  let legacy = !isSequence(room.eventSequence);
  const log = (Array.isArray(room.log) ? room.log : []).map((entry, index) => {
    const existing = safeStoredEvent(entry);
    if (existing && existing.seq > sequence) {
      sequence = existing.seq;
      return existing;
    }
    legacy = true;
    if (!Number.isSafeInteger(sequence + 1)) throw new Error("Public event sequence is exhausted.");
    sequence += 1;
    return {
      id: typeof entry?.id === "string" && entry.id ? entry.id : `legacy-${index + 1}`,
      seq: sequence, at: isSequence(entry?.at) ? entry.at : 0, type: "legacy", actorId: null,
      message: typeof entry?.message === "string" ? entry.message : "Imported legacy activity.", data: {},
    };
  });
  const outbox = legacy || !Array.isArray(room.eventOutbox) ? [] : room.eventOutbox.map((entry) => {
    const event = safeStoredEvent(entry);
    if (!event) throw new Error("A pending public event is malformed; it cannot be discarded silently.");
    return event;
  });
  room.eventSequence = outbox.reduce((highest, event) => Math.max(highest, event.seq),
    Math.max(isSequence(room.eventSequence) ? room.eventSequence : 0, sequence));
  room.log = log.slice(-80);
  room.eventOutbox = outbox;
  return room;
}

function appendPublicEvent(room, { type, actorId = null, message, data = {} }, at = Date.now()) {
  if (!isPublicEventType(type) || typeof message !== "string" ||
      !(actorId === null || typeof actorId === "string") || !isSequence(at)) {
    throw new Error("A public event requires a valid type, actor, message and timestamp.");
  }
  const publicData = eventData(type, data);
  if (publicData === null) throw new Error("Public event data must be safe JSON without private credentials or payloads.");
  const initialized = isSequence(room.eventSequence) && Array.isArray(room.log) && Array.isArray(room.eventOutbox) &&
    (!room.log.length || (isSequence(room.log.at(-1).seq) && room.log.at(-1).seq <= room.eventSequence)) &&
    (!room.eventOutbox.length || (isSequence(room.eventOutbox.at(-1).seq) && room.eventOutbox.at(-1).seq <= room.eventSequence));
  const state = initialized
    ? room : normalizePublicEvents({ log: room.log, eventSequence: room.eventSequence, eventOutbox: room.eventOutbox });
  const sequence = state.eventSequence + 1;
  if (!Number.isSafeInteger(sequence)) throw new Error("Public event sequence is exhausted.");
  const event = { id: id(), seq: sequence, at, type, actorId, message, data: publicData };
  room.eventSequence = sequence;
  room.log = [...state.log, event].slice(-80);
  room.eventOutbox = [...state.eventOutbox, event];
  return event;
}

function appendLog(room, message, details = {}) {
  return appendPublicEvent(room, { type: "legacy", ...details, message });
}

function resourceDescription(bundle) {
  return RESOURCES.filter((resource) => bundle[resource] > 0)
    .map((resource) => `${bundle[resource]} ${resource}`).join(", ");
}

// Colonist-parity limits: active offers per player and identical re-offers per turn curb spam.
const TRADE_LIMITS = Object.freeze({ activeTurnPlayer: 5, activeOther: 3, identicalTurnPlayer: 3, identicalOther: 2, maxAny: 4 });

function publicTrade(trade) {
  return {
    tradeId: trade.id, fromId: trade.fromId, targetId: trade.targetId, give: trade.give, want: trade.want,
    ...(trade.anyGive ? { anyGive: trade.anyGive } : {}), ...(trade.anyWant ? { anyWant: trade.anyWant } : {}),
    ...(trade.counterTo ? { counterTo: trade.counterTo } : {}),
  };
}
// An open offer (targetId null) is addressed to every other active player; the offerer chooses among acceptances.
function isOpenTrade(trade) {
  return Boolean(trade) && trade.targetId === null;
}
function isOpenEnded(trade) {
  return Boolean(trade?.anyGive || trade?.anyWant);
}
function compactBundle(bundle) {
  return Object.fromEntries(RESOURCES.filter((resource) => bundle[resource] > 0).map((resource) => [resource, bundle[resource]]));
}
function storedTrade(trade) {
  return {
    id: trade.id, fromId: trade.fromId, targetId: trade.targetId ?? null, give: trade.give, want: trade.want,
    anyGive: Number.isSafeInteger(trade.anyGive) ? trade.anyGive : 0, anyWant: Number.isSafeInteger(trade.anyWant) ? trade.anyWant : 0,
    counterTo: trade.counterTo ?? null, responses: isRecord(trade.responses) ? trade.responses : {},
  };
}
// Read-only view of active offers, including saves from before multiple offers existed (single `room.trade`).
function tradeList(room) {
  if (Array.isArray(room.trades)) return room.trades;
  return room.trade ? [storedTrade(structuredClone(room.trade))] : [];
}
function migrateTrades(room) {
  room.trades = tradeList(room).map(storedTrade);
  delete room.trade;
  room.embargoes = isRecord(room.embargoes) ? room.embargoes : {};
}
function blocksTrading(room, blockerId, otherId) {
  return Array.isArray(room.embargoes?.[blockerId]) && room.embargoes[blockerId].includes(otherId);
}
// Players who may answer a trade: its named target, or every active non-owner who has not blocked the owner.
function tradeResponders(room, trade) {
  if (!isOpenTrade(trade)) return [trade.targetId];
  return activePlayers(room).filter((player) => player.id !== trade.fromId && !blocksTrading(room, player.id, trade.fromId))
    .map((player) => player.id);
}
function describeSide(bundle, any = 0) {
  return [resourceDescription(bundle), any ? `any ${any} ${any === 1 ? "card" : "cards"}` : ""].filter(Boolean).join(" + ");
}

function closeTrade(room, trade, reason, actorId = null) {
  const index = room.trades.indexOf(trade);
  if (index < 0) return;
  room.trades.splice(index, 1);
  const from = room.players.find((player) => player.id === trade.fromId);
  appendLog(room, `${from?.name || "A player"}'s trade was cancelled (${reason}).`, {
    type: "tradeCancelled", actorId, data: { ...publicTrade(trade), reason },
  });
}
function cancelAllTrades(room, reason, actorId = null) {
  migrateTrades(room);
  for (const trade of [...room.trades]) closeTrade(room, trade, reason, actorId);
}

function isMapPreview(board, playerCount) {
  const expanded = playerCount > 4;
  return Array.isArray(board?.tiles) && board.tiles.length === (expanded ? 30 : 19) &&
    Array.isArray(board.vertices) && board.vertices.length === (expanded ? 80 : 54) &&
    Array.isArray(board.edges) && board.edges.length === (expanded ? 109 : 72) &&
    Array.isArray(board.ports) && board.ports.length === (expanded ? 11 : 9) &&
    board.vertices.every((vertex) => !vertex.structure) && board.edges.every((edge) => !edge.road);
}

function ensureMapPreview(room, random = Math.random) {
  if (room.phase !== "lobby" || isMapPreview(room.board, room.players.length)) return false;
  const board = makeBoard(random, room.players.length > 4 ? 6 : 4);
  room.board = board;
  room.mapVersion = (room.mapVersion ?? 0) + 1;
  return true;
}

function shuffleMap(room, actorId, expectedMapVersion, random = Math.random) {
  if (room.phase !== "lobby" || room.hostId !== actorId ||
      !room.players.some((player) => player.id === actorId)) {
    throw new Error("Only the lobby host can shuffle the map.");
  }
  if (expectedMapVersion !== undefined && (!Number.isSafeInteger(expectedMapVersion) ||
      expectedMapVersion < 0 || expectedMapVersion !== (room.mapVersion ?? 0))) {
    throw new Error("The map has changed. Review the current map before shuffling.");
  }
  const board = makeBoard(random, room.players.length > 4 ? 6 : 4);
  room.board = board;
  room.mapVersion = (room.mapVersion ?? 0) + 1;
  appendLog(room, `${room.players.find((player) => player.id === actorId).name} shuffled the map.`, {
    type: "mapShuffled", actorId, data: { mapVersion: room.mapVersion, boardPlayerCount: room.players.length > 4 ? 6 : 4 },
  });
}

function createRoom(hostName) {
  const room = {
    code: "", hostId: "", phase: "lobby", revision: 0, mapVersion: 0, players: [], board: null,
    turnIndex: 0, primaryIndex: 0, turnRole: "primary", turnNumber: 0, placementUndoJournal: null,
    setupRound: 0, setupNeedsRoad: false, lastSetupVertex: null,
    dice: null, mustMoveRobber: false, pendingDiscards: {}, robberVictims: [],
    robberReturnPhase: null, freeRoadsRemaining: 0, freeRoadsReturnPhase: null,
    developmentPlayed: false, developmentDeck: [], bank: emptyResources(),
    longestRoadHolderId: null, largestArmyHolderId: null,
    trades: [], embargoes: {}, winnerId: null, winReason: null, log: [], eventSequence: 0, eventOutbox: [], createdAt: Date.now(),
  };
  const player = addPlayer(room, hostName);
  room.hostId = player.id;
  return { room, player };
}

function addPlayer(room, name, reconnectToken = crypto.randomBytes(32).toString("hex")) {
  if (room.phase !== "lobby") throw new Error("This expedition has already begun.");
  if (room.players.length >= 6) throw new Error("This room already has six players.");
  if (typeof name !== "string" || !name.trim()) throw new Error("Enter a player name.");
  if (name.length > 20) throw new Error("Player names must be 20 characters or fewer.");
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
    throw new Error("Player names cannot contain control or invisible formatting characters.");
  }
  const normalizedName = name.trim();
  if (room.players.some((player) => player.name.toLowerCase() === normalizedName.toLowerCase())) {
    throw new Error("That name is already in this room.");
  }
  const player = {
    id: id(), reconnectToken, name: normalizedName,
    color: COLORS.find((color) => !room.players.some((other) => other.color === color)),
    resources: emptyResources(), roadsLeft: 15, settlementsLeft: 5, citiesLeft: 4,
    points: 0, knightsPlayed: 0, longestRoad: 0, developmentCards: [], connected: true,
    playedProgressCards: emptyProgressCounts(), playedProgressHistoryComplete: true,
  };
  room.players.push(player);
  appendLog(room, `${player.name} joined the expedition.`, {
    type: "playerJoined", actorId: player.id, data: { playerId: player.id },
  });
  return player;
}

function startGame(room, actorId, random = Math.random) {
  if (room.hostId !== actorId) throw new Error("Only the host can start.");
  if (room.phase !== "lobby") throw new Error("The game has already started.");
  if (room.players.length < 3 || room.players.length > 6) {
    throw new Error("Hearthlands requires 3-6 players.");
  }
  const expanded = room.players.length > 4;
  const players = shuffle(room.players, random);
  const board = isMapPreview(room.board, players.length) ? room.board : makeBoard(random, players.length);
  const counts = expanded ? [20, 3, 3, 3, 5] : [14, 2, 2, 2, 5];
  const developmentDeck = shuffle(
    ["knight", "roadBuilding", "yearOfPlenty", "monopoly", "victoryPoint"]
      .flatMap((type, index) => Array.from({ length: counts[index] }, () => ({ id: id(), type }))),
    random,
  );
  room.players = players;
  room.board = board;
  room.mapVersion = (room.mapVersion ?? 0) + 1;
  room.developmentDeck = developmentDeck;
  room.bank = Object.fromEntries(RESOURCES.map((resource) => [resource, expanded ? 24 : 19]));
  room.phase = "setup";
  room.turnIndex = 0;
  room.primaryIndex = 0;
  room.setupRound = 0;
  room.setupNeedsRoad = false;
  invalidatePlacementUndo(room);
  appendLog(room, `${currentPlayer(room).name} begins the first settlement round.`, {
    type: "gameStarted", actorId,
    data: { playerCount: players.length, boardPlayerCount: expanded ? 6 : 4, firstPlayerId: currentPlayer(room).id },
  });
}

function getVertex(room, vertexId) {
  const vertex = room.board?.vertices.find((candidate) => candidate.id === vertexId);
  if (!vertex) throw new Error("That junction does not exist.");
  return vertex;
}
function getEdge(room, edgeId) {
  const edge = room.board?.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) throw new Error("That path does not exist.");
  return edge;
}
function getTile(room, tileId) {
  const tile = room.board?.tiles.find((candidate) => candidate.id === tileId);
  if (!tile) throw new Error("That land tile does not exist.");
  return tile;
}
function assertTurn(room, actorId) {
  if (currentPlayer(room)?.id !== actorId) throw new Error("Wait for your turn.");
}
function assertActionPhase(room) {
  if (room.phase !== "action" || room.freeRoadsRemaining) {
    throw new Error("Finish the current action first.");
  }
}
function normalizeBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(bundle))) {
    throw new Error("Resources must be an object of whole-number amounts.");
  }
  if (Object.keys(bundle).some((key) => !RESOURCES.includes(key))) {
    throw new Error("Unknown resource.");
  }
  const result = emptyResources();
  for (const resource of RESOURCES) {
    const amount = Object.hasOwn(bundle, resource) ? bundle[resource] : 0;
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 24) {
      throw new Error("Resource amounts must be whole numbers from 0 to 24.");
    }
    result[resource] = amount;
  }
  return result;
}
function pay(room, player, cost) {
  if (!hasBundle(player, cost)) throw new Error("You do not have the required resources.");
  for (const [resource, amount] of Object.entries(cost)) {
    player.resources[resource] -= amount;
    room.bank[resource] += amount;
  }
}
function settlementIsSpaced(room, vertex) {
  return !vertex.structure && vertex.adjacentVertices.every((vertexId) =>
    !getVertex(room, vertexId).structure);
}
function vertexTouchesPlayerRoad(room, vertex, playerId) {
  return room.board.edges.some((edge) =>
    edge.road?.playerId === playerId && edge.vertices.includes(vertex.id));
}
function edgeConnectsToNetwork(room, edge, playerId) {
  return edge.vertices.some((vertexId) => {
    const vertex = getVertex(room, vertexId);
    if (vertex.structure) return vertex.structure.playerId === playerId;
    return vertexTouchesPlayerRoad(room, vertex, playerId);
  });
}
function availableRoads(room, player) {
  if (!room.board || player.roadsLeft <= 0) return [];
  return room.board.edges.filter((edge) =>
    !edge.road && edgeConnectsToNetwork(room, edge, player.id));
}
function tradeRates(room, playerId) {
  const rates = Object.fromEntries(RESOURCES.map((resource) => [resource, 4]));
  for (const port of room.board?.ports || []) {
    if (!port.vertices.some((vertexId) => getVertex(room, vertexId).structure?.playerId === playerId)) continue;
    for (const resource of RESOURCES) {
      if (port.resource === null) rates[resource] = Math.min(rates[resource], 3);
      if (port.resource === resource) rates[resource] = 2;
    }
  }
  return rates;
}

function longestRoad(room, playerId) {
  const roads = room.board.edges.filter((edge) => edge.road?.playerId === playerId);
  const incident = new Map();
  for (const edge of roads) {
    for (const vertexId of edge.vertices) {
      if (!incident.has(vertexId)) incident.set(vertexId, []);
      incident.get(vertexId).push(edge);
    }
  }
  const used = new Set();
  function walk(vertexId) {
    if (used.size && getVertex(room, vertexId).structure &&
        getVertex(room, vertexId).structure.playerId !== playerId) return 0;
    let best = 0;
    for (const edge of incident.get(vertexId) || []) {
      if (used.has(edge.id)) continue;
      used.add(edge.id);
      best = Math.max(best, 1 + walk(edge.vertices.find((other) => other !== vertexId)));
      used.delete(edge.id);
    }
    return best;
  }
  let result = 0;
  for (const vertexId of incident.keys()) result = Math.max(result, walk(vertexId));
  return result;
}
function awardHolder(room, field, minimum, incumbent) {
  const players = activePlayers(room);
  const maximum = Math.max(...players.map((player) => player[field]));
  if (maximum < minimum) return null;
  const leaders = players.filter((player) => player[field] === maximum);
  if (leaders.some((player) => player.id === incumbent)) return incumbent;
  return leaders.length === 1 ? leaders[0].id : null;
}
function publicPoints(room, player) {
  if (player.resigned) return 0;
  return (room.board?.vertices || []).reduce((sum, vertex) => sum +
    (vertex.structure?.playerId === player.id ? (vertex.structure.kind === "city" ? 2 : 1) : 0), 0) +
    (room.longestRoadHolderId === player.id ? 2 : 0) +
    (room.largestArmyHolderId === player.id ? 2 : 0);
}
function updateScores(room, tieHolders = null) {
  if (!room.board) return;
  const previousRoad = room.longestRoadHolderId ?? null;
  const previousArmy = room.largestArmyHolderId ?? null;
  for (const player of room.players) player.longestRoad = player.resigned ? 0 : longestRoad(room, player.id);
  room.longestRoadHolderId = awardHolder(room, "longestRoad", 5, tieHolders ? tieHolders.longestRoadHolderId : room.longestRoadHolderId);
  room.largestArmyHolderId = awardHolder(room, "knightsPlayed", 3, tieHolders ? tieHolders.largestArmyHolderId : room.largestArmyHolderId);
  for (const player of room.players) {
    player.points = player.resigned ? 0 : publicPoints(room, player) +
      player.developmentCards.filter((card) => card.type === "victoryPoint").length;
  }
  for (const [bonus, label, fromId, toId] of [
    ["longestRoad", "Longest Road", previousRoad, room.longestRoadHolderId],
    ["largestArmy", "Largest Army", previousArmy, room.largestArmyHolderId],
  ]) {
    if (fromId === toId) continue;
    const from = room.players.find((player) => player.id === fromId);
    const to = room.players.find((player) => player.id === toId);
    const message = to
      ? `${to.name} received ${label} (+2 points)${from ? ` from ${from.name}` : ""}.`
      : `${from?.name || "The previous holder"} lost ${label}; the bonus is unclaimed.`;
    appendLog(room, message, { type: "bonusChanged", data: { bonus, fromId, toId, points: 2 } });
  }
}
function finishGame(room, winnerId, reason) {
  invalidatePlacementUndo(room);
  room.winnerId = winnerId;
  room.winReason = reason;
  room.phase = "finished";
  cancelAllTrades(room, "game-finished", winnerId);
  room.pendingDiscards = {};
  room.robberVictims = [];
  room.mustMoveRobber = false;
  room.robberReturnPhase = null;
  room.discardReturnPhase = null;
  room.freeRoadsRemaining = 0;
  room.freeRoadsReturnPhase = null;
  room.setupNeedsRoad = false;
  room.lastSetupVertex = null;
}
function checkWinner(room) {
  if (["setup", "lobby", "finished"].includes(room.phase) || room.winnerId) return;
  const player = currentPlayer(room);
  if (player && !player.resigned && player.points >= 10) {
    finishGame(room, player.id, "points");
    appendLog(room, `${player.name} united the Hearthlands!`, {
      type: "gameFinished", actorId: player.id, data: { winnerId: player.id, reason: "points", points: player.points },
    });
  }
}
function beginActivation(room) {
  room.turnNumber += 1;
  room.developmentPlayed = false;
  cancelAllTrades(room, "turn-ended");
  room.phase = room.turnRole === "secondary" ? "action" : "roll";
  if (room.turnRole === "primary") room.dice = null;
  appendLog(room, `${currentPlayer(room).name}'s ${room.turnRole} turn begins.`, {
    type: "turnStarted", actorId: currentPlayer(room).id,
    data: { turnNumber: room.turnNumber, role: room.turnRole, primaryPlayerId: room.players[room.primaryIndex]?.id || null },
  });
  updateScores(room);
  checkWinner(room);
}
function advanceSetup(room) {
  const indices = room.players.map((player, index) => player.resigned ? -1 : index).filter((index) => index >= 0);
  if (room.setupRound === 0) {
    const next = indices.find((index) => index > room.turnIndex);
    if (next !== undefined) room.turnIndex = next;
    else {
      room.setupRound = 1;
      room.turnIndex = indices.at(-1);
    }
  } else {
    const next = indices.filter((index) => index < room.turnIndex).at(-1);
    if (next !== undefined) room.turnIndex = next;
    else {
      room.turnIndex = indices[0];
      room.primaryIndex = room.turnIndex;
      room.turnRole = "primary";
      beginActivation(room);
    }
  }
  if (room.phase === "setup") {
    appendLog(room, `${currentPlayer(room).name} begins settlement round ${room.setupRound + 1}.`, {
      type: "setupTurnStarted", actorId: currentPlayer(room).id, data: { round: room.setupRound + 1 },
    });
  }
}
function placeSetupSettlement(room, player, vertexId) {
  if (room.phase !== "setup" || room.setupNeedsRoad) throw new Error("Place the required road first.");
  const vertex = getVertex(room, vertexId);
  if (!settlementIsSpaced(room, vertex)) throw new Error("Settlements must be at least two paths apart.");
  if (player.settlementsLeft <= 0) throw new Error("You have no settlements remaining.");
  vertex.structure = { playerId: player.id, kind: "settlement" };
  player.settlementsLeft -= 1;
  room.setupNeedsRoad = true;
  room.lastSetupVertex = vertex.id;
  appendLog(room, `${player.name} founded a settlement at ${vertex.id}.`, {
    type: "settlementBuilt", actorId: player.id, data: { vertexId: vertex.id, setup: true },
  });
  if (room.setupRound === 1) {
    const resources = emptyResources();
    for (const tileId of vertex.adjacentTiles) {
      const resource = getTile(room, tileId).resource;
      if (RESOURCES.includes(resource) && room.bank[resource] > 0) {
        room.bank[resource] -= 1;
        player.resources[resource] += 1;
        resources[resource] += 1;
      }
    }
    if (totalBundle(resources)) {
      appendLog(room, `${player.name} received starting resources: ${resourceDescription(resources)}.`, {
        type: "production", actorId: player.id, data: { source: "setup", recipients: [{ playerId: player.id, resources }] },
      });
    }
  }
}
function placeSetupRoad(room, player, edgeId) {
  if (room.phase !== "setup" || !room.setupNeedsRoad) throw new Error("Place a settlement first.");
  const edge = getEdge(room, edgeId);
  if (edge.road) throw new Error("That path is occupied.");
  if (player.roadsLeft <= 0) throw new Error("You have no roads remaining.");
  if (!edge.vertices.includes(room.lastSetupVertex)) throw new Error("Your setup road must touch the new settlement.");
  edge.road = { playerId: player.id };
  player.roadsLeft -= 1;
  room.setupNeedsRoad = false;
  room.lastSetupVertex = null;
  appendLog(room, `${player.name} charted a road at ${edge.id}.`, {
    type: "roadBuilt", actorId: player.id, data: { edgeId: edge.id, free: true, setup: true },
  });
  advanceSetup(room);
}
function distributeResources(room, total) {
  const claims = Object.fromEntries(RESOURCES.map((resource) => [resource, {}]));
  const paid = new Map();
  for (const tile of room.board.tiles) {
    if (tile.number !== total || tile.robber || !RESOURCES.includes(tile.resource)) continue;
    for (const vertexId of tile.vertices) {
      const structure = getVertex(room, vertexId).structure;
      if (!structure || !activePlayers(room).some((player) => player.id === structure.playerId)) continue;
      const resourceClaims = claims[tile.resource];
      resourceClaims[structure.playerId] = (resourceClaims[structure.playerId] || 0) +
        (structure.kind === "city" ? 2 : 1);
    }
  }
  for (const resource of RESOURCES) {
    const recipients = Object.entries(claims[resource]);
    const requested = recipients.reduce((sum, [, amount]) => sum + amount, 0);
    const available = room.bank[resource];
    if (requested > available) {
      const distributed = recipients.length === 1 ? available : 0;
      appendLog(room, recipients.length > 1
        ? `The bank has only ${available} ${resource} for ${requested} requested; none is distributed to the ${recipients.length} recipients.`
        : `The bank has only ${available} ${resource} for ${requested} requested; the sole recipient receives ${distributed}.`, {
        type: "productionShortage",
        data: { resource, requested, available, recipientCount: recipients.length, distributed },
      });
      if (recipients.length > 1) continue;
    }
    for (const [playerId, count] of recipients) {
      const amount = Math.min(count, room.bank[resource]);
      room.players.find((player) => player.id === playerId).resources[resource] += amount;
      room.bank[resource] -= amount;
      if (amount) {
        if (!paid.has(playerId)) paid.set(playerId, emptyResources());
        paid.get(playerId)[resource] += amount;
      }
    }
  }
  const recipients = [...paid].map(([playerId, resources]) => ({ playerId, resources }));
  const message = recipients.length
    ? `Production for ${total}: ${recipients.map(({ playerId, resources }) =>
      `${room.players.find((player) => player.id === playerId).name} received ${resourceDescription(resources)}`).join("; ")}.`
    : `No resources were produced for ${total}.`;
  appendLog(room, message, { type: "production", data: { source: "roll", total, recipients } });
}
function rollDice(room, player, random) {
  if (room.phase !== "roll" || room.freeRoadsRemaining || room.turnRole !== "primary") {
    throw new Error("You cannot roll the dice now.");
  }
  const dice = [1 + randomIndex(random, 6), 1 + randomIndex(random, 6)];
  room.dice = dice;
  const total = dice[0] + dice[1];
  appendLog(room, `${player.name} rolled ${total}.`, {
    type: "diceRolled", actorId: player.id, data: { dice, total },
  });
  if (total !== 7) {
    distributeResources(room, total);
    room.phase = "action";
  } else {
    room.pendingDiscards = Object.fromEntries(activePlayers(room).filter((other) => resourceTotal(other) > 7)
      .map((other) => [other.id, Math.floor(resourceTotal(other) / 2)]));
    room.discardReturnPhase = null;
    room.robberReturnPhase = "action";
    room.mustMoveRobber = true;
    room.phase = Object.keys(room.pendingDiscards).length ? "discard" : "robber";
  }
  return total;
}
function discard(room, player, resources) {
  if (room.phase !== "discard" || !Object.hasOwn(room.pendingDiscards, player.id)) {
    throw new Error("You do not need to discard.");
  }
  const bundle = normalizeBundle(resources);
  if (totalBundle(bundle) !== room.pendingDiscards[player.id]) throw new Error("Discard exactly the required number of cards.");
  if (!hasBundle(player, bundle)) throw new Error("You do not hold those resources.");
  pay(room, player, bundle);
  delete room.pendingDiscards[player.id];
  appendLog(room, `${player.name} discarded ${totalBundle(bundle)} resource cards.`, {
    type: "discarded", actorId: player.id, data: { count: totalBundle(bundle) },
  });
  if (!Object.keys(room.pendingDiscards).length) finishDiscards(room);
}
function finishDiscards(room) {
  room.phase = room.discardReturnPhase || "robber";
  room.discardReturnPhase = null;
}
function finishRobber(room) {
  room.phase = room.robberReturnPhase;
  room.robberReturnPhase = null;
  room.robberVictims = [];
  room.mustMoveRobber = false;
}
function moveRobber(room, player, tileId) {
  if (room.phase !== "robber") throw new Error("Finish all discards before moving the robber.");
  const tile = getTile(room, tileId);
  if (tile.robber) throw new Error("Choose a different tile.");
  room.board.tiles.forEach((other) => { other.robber = other.id === tile.id; });
  room.robberVictims = [...new Set(tile.vertices.map((vertexId) =>
    getVertex(room, vertexId).structure?.playerId).filter((playerId) =>
    playerId && playerId !== player.id &&
    activePlayers(room).some((p) => p.id === playerId && resourceTotal(p) > 0)))];
  appendLog(room, `${player.name} moved the robber to ${tile.id}.`, {
    type: "robberMoved", actorId: player.id, data: { tileId: tile.id },
  });
  if (room.robberVictims.length) room.phase = "steal";
  else finishRobber(room);
}
function steal(room, player, targetId, random) {
  if (room.phase !== "steal" || !room.robberVictims.includes(targetId)) {
    throw new Error("Choose an eligible player to steal from.");
  }
  const victim = activePlayers(room).find((other) => other.id === targetId);
  if (!victim || !resourceTotal(victim)) throw new Error("Choose an eligible player to steal from.");
  let chosen = randomIndex(random, resourceTotal(victim));
  const resource = RESOURCES.find((candidate) => {
    chosen -= victim.resources[candidate];
    return chosen < 0;
  });
  victim.resources[resource] -= 1;
  player.resources[resource] += 1;
  appendLog(room, `${player.name} stole a resource from ${victim.name}.`, {
    type: "resourceStolen", actorId: player.id, data: { victimId: victim.id, count: 1 },
  });
  finishRobber(room);
}
function finishFreeRoads(room) {
  room.freeRoadsRemaining = 0;
  room.phase = room.freeRoadsReturnPhase;
  room.freeRoadsReturnPhase = null;
}
function buildRoad(room, player, edgeId) {
  const free = room.freeRoadsRemaining > 0;
  if (!room.freeRoadsRemaining) assertActionPhase(room);
  else if (!["roll", "action"].includes(room.phase)) throw new Error("Finish the current action first.");
  const edge = getEdge(room, edgeId);
  if (edge.road) throw new Error("That path is occupied.");
  if (player.roadsLeft <= 0) throw new Error("You have no roads remaining.");
  if (!edgeConnectsToNetwork(room, edge, player.id)) throw new Error("Connect the road to your network.");
  if (!room.freeRoadsRemaining) pay(room, player, COSTS.road);
  edge.road = { playerId: player.id };
  player.roadsLeft -= 1;
  if (room.freeRoadsRemaining) {
    room.freeRoadsRemaining -= 1;
    if (!room.freeRoadsRemaining || !availableRoads(room, player).length) finishFreeRoads(room);
  }
  appendLog(room, `${player.name} built ${free ? "a free road" : "a road"} at ${edge.id}.`, {
    type: "roadBuilt", actorId: player.id, data: { edgeId: edge.id, free, setup: false },
  });
}
function buildSettlement(room, player, vertexId) {
  assertActionPhase(room);
  const vertex = getVertex(room, vertexId);
  if (!settlementIsSpaced(room, vertex)) throw new Error("Settlements must be at least two paths apart.");
  if (!vertexTouchesPlayerRoad(room, vertex, player.id)) throw new Error("Connect the settlement to one of your roads.");
  if (player.settlementsLeft <= 0) throw new Error("You have no settlements remaining.");
  pay(room, player, COSTS.settlement);
  vertex.structure = { playerId: player.id, kind: "settlement" };
  player.settlementsLeft -= 1;
  appendLog(room, `${player.name} founded a settlement at ${vertex.id}.`, {
    type: "settlementBuilt", actorId: player.id, data: { vertexId: vertex.id, setup: false },
  });
}
function buildCity(room, player, vertexId) {
  assertActionPhase(room);
  const vertex = getVertex(room, vertexId);
  if (vertex.structure?.playerId !== player.id || vertex.structure.kind !== "settlement") {
    throw new Error("Upgrade one of your settlements.");
  }
  if (player.citiesLeft <= 0) throw new Error("You have no cities remaining.");
  pay(room, player, COSTS.city);
  vertex.structure.kind = "city";
  player.citiesLeft -= 1;
  player.settlementsLeft += 1;
  appendLog(room, `${player.name} raised a city at ${vertex.id}.`, {
    type: "cityBuilt", actorId: player.id, data: { vertexId: vertex.id },
  });
}
// Accepts one legacy batch ({giveResource, receiveResource}) or explicit bundles ({give, want}) of whole rate-sized sets.
function bankTrade(room, player, action) {
  assertActionPhase(room);
  const rates = tradeRates(room, player.id);
  let give;
  let want;
  if (action.give === undefined && action.want === undefined) {
    const { giveResource, receiveResource } = action;
    if (!RESOURCES.includes(giveResource) || !RESOURCES.includes(receiveResource) || giveResource === receiveResource) {
      throw new Error("Choose two different resources.");
    }
    give = { ...emptyResources(), [giveResource]: rates[giveResource] };
    want = { ...emptyResources(), [receiveResource]: 1 };
  } else {
    give = normalizeBundle(action.give);
    want = normalizeBundle(action.want);
  }
  const received = totalBundle(want);
  if (!received || !totalBundle(give)) throw new Error("Choose resources to give and to receive.");
  if (RESOURCES.some((resource) => give[resource] && want[resource])) {
    throw new Error("Choose two different resources.");
  }
  const uneven = RESOURCES.find((resource) => give[resource] % rates[resource]);
  if (uneven) throw new Error(`Give ${uneven} in sets of ${rates[uneven]} (your ${rates[uneven]}:1 rate).`);
  const sets = RESOURCES.reduce((sum, resource) => sum + give[resource] / rates[resource], 0);
  if (sets !== received) {
    throw new Error(`Each full set buys one card: ${sets} ${sets === 1 ? "set buys" : "sets buy"} ${sets} ${sets === 1 ? "card" : "cards"}, not ${received}.`);
  }
  if (RESOURCES.some((resource) => room.bank[resource] < want[resource])) {
    throw new Error(received === 1 ? "The bank has no cards of that resource." : "The bank does not have enough of those resources.");
  }
  if (!hasBundle(player, give)) throw new Error(`This bank trade costs ${resourceDescription(give)}.`);
  pay(room, player, compactBundle(give));
  for (const resource of RESOURCES) {
    room.bank[resource] -= want[resource];
    player.resources[resource] += want[resource];
  }
  const ratios = [...new Set(RESOURCES.filter((resource) => give[resource]).map((resource) => rates[resource]))];
  appendLog(room, `${player.name} traded with the bank: ${resourceDescription(give)} for ${resourceDescription(want)}.`, {
    type: "bankTrade", actorId: player.id,
    data: { give: compactBundle(give), want: compactBundle(want), ratio: ratios.length === 1 ? ratios[0] : null },
  });
}
function assertDomesticTrade(room) {
  assertActionPhase(room);
  if (room.turnRole !== "primary") throw new Error("Player trading is not allowed during a secondary turn.");
}
function findTrade(room, tradeId, fallback) {
  if (tradeId !== undefined) {
    const trade = room.trades.find((candidate) => candidate.id === tradeId);
    if (!trade) throw new Error("That trade is no longer current.");
    return trade;
  }
  // Older clients omitted tradeId when only one offer could exist; accept that only when it is unambiguous.
  const candidates = room.trades.filter(fallback);
  if (candidates.length !== 1) throw new Error(candidates.length ? "Choose which trade you mean." : "There is no trade for you.");
  return candidates[0];
}
function normalizeAny(value) {
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > TRADE_LIMITS.maxAny) {
    throw new Error(`Any cards must be a whole number from 0 to ${TRADE_LIMITS.maxAny}.`);
  }
  return value;
}
function tradeKey(trade) {
  return JSON.stringify([trade.fromId, trade.targetId, RESOURCES.map((r) => trade.give[r]), RESOURCES.map((r) => trade.want[r]),
    trade.anyGive, trade.anyWant]);
}
function canFundTrade(player, trade) {
  if (!player || !hasBundle(player, trade.give)) return false;
  if (!trade.anyGive) return true;
  const spare = RESOURCES.reduce((sum, resource) => sum + (trade.want[resource] ? 0 : player.resources[resource] - trade.give[resource]), 0);
  return spare >= trade.anyGive;
}
function exchange(from, to, trade) {
  for (const resource of RESOURCES) {
    from.resources[resource] += trade.want[resource] - trade.give[resource];
    to.resources[resource] += trade.give[resource] - trade.want[resource];
  }
}
function offerTrade(room, player, action) {
  assertDomesticTrade(room);
  const current = currentPlayer(room);
  const turnPlayer = player.id === current.id;
  const replaceId = action.replaceTradeId ?? null;
  const counterId = action.counterTo ?? null;
  if (replaceId !== null && counterId !== null) throw new Error("Choose either to edit an offer or to counter it.");
  let replacing = null;
  let countering = null;
  const referencedId = replaceId ?? counterId;
  if (referencedId !== null) {
    const referenced = room.trades.find((trade) => trade.id === referencedId);
    if (!referenced) throw new Error("This trade offer has closed or changed. Review the current trade before sending another.");
    if (replaceId !== null && referenced.fromId === player.id) replacing = referenced;
    else if (tradeResponders(room, referenced).includes(player.id)) countering = referenced;
    else throw new Error("Resolve or cancel the existing trade first.");
  }
  let targetId = action.targetId;
  if (countering) {
    if (targetId !== undefined && targetId !== countering.fromId) throw new Error("A counteroffer goes to the player who made the offer.");
    targetId = countering.fromId;
  }
  const open = targetId === null;
  const target = open ? null : activePlayers(room).find((other) => other.id === targetId);
  if (open) {
    if (!turnPlayer) throw new Error("Only the active player can offer a trade to everyone.");
    if (!activePlayers(room).some((other) => other.id !== player.id && !blocksTrading(room, other.id, player.id))) {
      throw new Error("Everyone blocked trading with you.");
    }
  } else {
    if (!target || target.id === player.id) throw new Error("Choose another player.");
    if (!turnPlayer && target.id !== current.id) throw new Error("Trades must involve the active primary player.");
    if (blocksTrading(room, target.id, player.id)) throw new Error(`${target.name} blocked trading with you.`);
  }
  const trade = {
    id: id(), fromId: player.id, targetId: open ? null : target.id, give: normalizeBundle(action.give), want: normalizeBundle(action.want),
    anyGive: normalizeAny(action.anyGive), anyWant: normalizeAny(action.anyWant), counterTo: countering?.id ?? null, responses: {},
  };
  if (trade.anyGive && trade.anyWant) throw new Error("Use Any cards on only one side of a trade.");
  if (!(totalBundle(trade.give) + trade.anyGive) || !(totalBundle(trade.want) + trade.anyWant)) {
    throw new Error("Both sides of a trade need at least one resource.");
  }
  if (RESOURCES.some((resource) => trade.give[resource] && trade.want[resource])) {
    throw new Error("The same resource cannot be on both sides of a trade.");
  }
  if (!hasBundle(player, trade.give)) throw new Error("You cannot offer resources you do not hold.");
  if (!canFundTrade(player, trade)) throw new Error("You do not hold enough other cards to offer Any cards.");
  const own = room.trades.filter((other) => other.fromId === player.id && other !== replacing);
  const activeLimit = turnPlayer ? TRADE_LIMITS.activeTurnPlayer : TRADE_LIMITS.activeOther;
  if (own.length >= activeLimit) throw new Error(`You can have at most ${activeLimit} active offers. Withdraw one first.`);
  const key = tradeKey(trade);
  if (own.some((other) => tradeKey(other) === key)) throw new Error("You already have this exact offer open.");
  const created = isRecord(room.tradeCreations) && room.tradeCreations.turn === room.turnNumber && isRecord(room.tradeCreations.counts)
    ? room.tradeCreations : { turn: room.turnNumber, counts: {} };
  const identicalLimit = turnPlayer ? TRADE_LIMITS.identicalTurnPlayer : TRADE_LIMITS.identicalOther;
  if ((created.counts[key] || 0) >= identicalLimit) throw new Error("You have offered this exact trade too many times this turn.");
  room.tradeCreations = { turn: created.turn, counts: { ...created.counts, [key]: (created.counts[key] || 0) + 1 } };
  if (replacing) room.trades.splice(room.trades.indexOf(replacing), 1, trade);
  else room.trades.push(trade);
  const terms = `${describeSide(trade.give, trade.anyGive)} for ${describeSide(trade.want, trade.anyWant)}`;
  const recipient = open ? "everyone" : target.name;
  appendLog(room, countering ? `${player.name} counteroffered ${recipient}: ${terms}.`
    : replacing ? `${player.name} updated their offer to ${recipient}: ${terms}.` : `${player.name} offered a trade to ${recipient}: ${terms}.`, {
    type: countering ? "tradeCounteroffered" : "tradeOffered", actorId: player.id,
    data: { ...publicTrade(trade), ...(replacing ? { replacesTradeId: replacing.id } : {}) },
  });
}
function respondTrade(room, player, action) {
  assertDomesticTrade(room);
  if (typeof action.accept !== "boolean") throw new Error("Accept must be a boolean.");
  const trade = findTrade(room, action.tradeId, (candidate) => tradeResponders(room, candidate).includes(player.id));
  if (!tradeResponders(room, trade).includes(player.id)) throw new Error("There is no trade for you.");
  const from = activePlayers(room).find((other) => other.id === trade.fromId);
  if (!from) throw new Error("That trading player has left the match.");
  if (isOpenTrade(trade)) {
    // Responses to an open offer only signal intent; the offerer completes the exchange with confirmTrade.
    const response = action.accept ? "accepted" : "declined";
    if (trade.responses[player.id] === response) throw new Error(`You already ${response} this offer.`);
    if (action.accept && isOpenEnded(trade)) {
      throw new Error("Open-ended offers cannot be accepted directly. Counteroffer with the exact cards you would trade.");
    }
    if (action.accept && !hasBundle(player, trade.want)) {
      throw new Error(`You need ${resourceDescription(trade.want)} to accept this offer.`);
    }
    trade.responses[player.id] = response;
    appendLog(room, `${player.name} ${response} ${from.name}'s offer to everyone: ${describeSide(trade.give, trade.anyGive)} for ${describeSide(trade.want, trade.anyWant)}.`, {
      type: "tradeResponded", actorId: player.id,
      data: { tradeId: trade.id, fromId: from.id, playerId: player.id, response },
    });
    return;
  }
  if (action.accept) {
    if (isOpenEnded(trade)) throw new Error("Open-ended offers cannot be accepted directly. Counteroffer with the exact cards you would trade.");
    if (!hasBundle(from, trade.give) || !hasBundle(player, trade.want)) {
      throw new Error("One player no longer has the offered resources.");
    }
    exchange(from, player, trade);
    appendLog(room, `${player.name} accepted ${from.name}'s trade: ${from.name} gave ${resourceDescription(trade.give)} for ${resourceDescription(trade.want)}.`, {
      type: "tradeAccepted", actorId: player.id, data: publicTrade(trade),
    });
  } else appendLog(room, `${player.name} declined ${from.name}'s trade: ${describeSide(trade.give, trade.anyGive)} for ${describeSide(trade.want, trade.anyWant)}.`, {
    type: "tradeDeclined", actorId: player.id, data: publicTrade(trade),
  });
  room.trades.splice(room.trades.indexOf(trade), 1);
}
function confirmTrade(room, player, action) {
  assertDomesticTrade(room);
  const trade = findTrade(room, action.tradeId, (candidate) => isOpenTrade(candidate) && candidate.fromId === player.id);
  if (!isOpenTrade(trade) || trade.fromId !== player.id) throw new Error("You have no open offer to complete.");
  const partner = activePlayers(room).find((other) => other.id === action.partnerId && other.id !== player.id);
  if (!partner || trade.responses[partner.id] !== "accepted" || !tradeResponders(room, trade).includes(partner.id)) {
    throw new Error("Choose a player who accepted this offer.");
  }
  if (!hasBundle(player, trade.give) || !hasBundle(partner, trade.want)) {
    throw new Error("One player no longer has the offered resources.");
  }
  exchange(player, partner, trade);
  appendLog(room, `${player.name} traded with ${partner.name}: ${player.name} gave ${resourceDescription(trade.give)} for ${resourceDescription(trade.want)}.`, {
    type: "tradeAccepted", actorId: player.id, data: { ...publicTrade(trade), targetId: partner.id },
  });
  room.trades.splice(room.trades.indexOf(trade), 1);
}
function withdrawTrade(room, player, action) {
  assertDomesticTrade(room);
  const trade = findTrade(room, action.tradeId, (candidate) => candidate.fromId === player.id);
  if (trade.fromId !== player.id) throw new Error("You have no trade to cancel.");
  closeTrade(room, trade, "cancelled", player.id);
}
// House rule matching Colonist's embargo: a blocker stops the other player's offers reaching them.
function setEmbargo(room, player, action) {
  if (!room.board || ["lobby", "finished"].includes(room.phase)) throw new Error("Trading blocks apply only during a game.");
  if (typeof action.blocked !== "boolean") throw new Error("Blocked must be a boolean.");
  const other = activePlayers(room).find((candidate) => candidate.id === action.playerId && candidate.id !== player.id);
  if (!other) throw new Error("Choose another active player.");
  const blocked = new Set(Array.isArray(room.embargoes[player.id]) ? room.embargoes[player.id] : []);
  if (blocked.has(other.id) === action.blocked) {
    throw new Error(action.blocked ? `You already block trading with ${other.name}.` : `You are not blocking ${other.name}.`);
  }
  if (action.blocked) blocked.add(other.id);
  else blocked.delete(other.id);
  if (blocked.size) room.embargoes[player.id] = [...blocked];
  else delete room.embargoes[player.id];
}

function tradeUnavailableReason(room, trade) {
  const from = activePlayers(room).find((player) => player.id === trade.fromId);
  const target = isOpenTrade(trade) ? null : activePlayers(room).find((player) => player.id === trade.targetId);
  const current = currentPlayer(room)?.id;
  if (!from || (!isOpenTrade(trade) && !target) || (from.id !== current && target?.id !== current)) {
    return "trading-player-unavailable";
  } else if (room.phase !== "action" || room.freeRoadsRemaining || room.turnRole !== "primary") {
    return "required-action";
  } else if (!canFundTrade(from, trade)) {
    // The sender's offer is public; never infer or announce the recipient's hidden hand.
    return "offered-resources-spent";
  } else if (target && blocksTrading(room, target.id, from.id)) {
    return "blocked";
  }
  const responders = tradeResponders(room, trade);
  if (!responders.length) return "blocked";
  if (isOpenTrade(trade) && responders.every((playerId) => trade.responses[playerId] === "declined")) return "declined-by-all";
  return null;
}
// Acceptances already revealed the cards; drop any that public events (e.g. Monopoly) made unfulfillable.
function pruneResponses(room, trade) {
  const responders = tradeResponders(room, trade);
  for (const [playerId, response] of Object.entries(trade.responses)) {
    const responder = activePlayers(room).find((player) => player.id === playerId);
    if (!responder || !responders.includes(playerId) || !["accepted", "declined"].includes(response) ||
        (response === "accepted" && !hasBundle(responder, trade.want))) delete trade.responses[playerId];
  }
}
function reconcileTrades(room) {
  migrateTrades(room);
  for (const trade of [...room.trades]) {
    pruneResponses(room, trade);
    const reason = tradeUnavailableReason(room, trade);
    if (reason) closeTrade(room, trade, reason);
  }
}
function buyDevelopment(room, player) {
  assertActionPhase(room);
  if (!room.developmentDeck.length) throw new Error("No development cards remain.");
  pay(room, player, COSTS.development);
  player.developmentCards.push({ ...room.developmentDeck.pop(), boughtTurn: room.turnNumber });
  appendLog(room, `${player.name} bought a development card.`, {
    type: "developmentBought", actorId: player.id, data: { count: 1 },
  });
}
function cardCanBePlayed(room, player, card) {
  if (player.resigned || currentPlayer(room)?.id !== player.id || !["roll", "action"].includes(room.phase) ||
      room.freeRoadsRemaining || room.developmentPlayed ||
      card.boughtTurn >= room.turnNumber || card.type === "victoryPoint") return false;
  if (card.type === "roadBuilding") return availableRoads(room, player).length > 0;
  if (card.type === "yearOfPlenty") return totalBundle(room.bank) > 0;
  return card.type === "knight" || card.type === "monopoly";
}
function playDevelopment(room, player, action) {
  const card = player.developmentCards.find((candidate) => candidate.id === action.cardId);
  if (!card || !cardCanBePlayed(room, player, card)) throw new Error("That development card cannot be played now.");
  let bundle;
  if (card.type === "monopoly" && !RESOURCES.includes(action.resource)) throw new Error("Choose a resource.");
  if (card.type === "yearOfPlenty") {
    bundle = normalizeBundle(action.resources);
    if (totalBundle(bundle) !== Math.min(2, totalBundle(room.bank))) {
      throw new Error("Choose exactly two resources, or all that remain in the bank.");
    }
    if (!RESOURCES.every((resource) => room.bank[resource] >= bundle[resource])) {
      throw new Error("The bank does not have those resources.");
    }
  }
  player.developmentCards.splice(player.developmentCards.indexOf(card), 1);
  room.developmentPlayed = true;
  let count = 0;
  switch (card.type) {
    case "knight":
      player.knightsPlayed += 1;
      room.robberReturnPhase = room.phase;
      room.phase = "robber";
      room.mustMoveRobber = true;
      room.robberVictims = [];
      break;
    case "roadBuilding":
      room.freeRoadsReturnPhase = room.phase;
      room.freeRoadsRemaining = Math.min(2, player.roadsLeft);
      break;
    case "yearOfPlenty":
      count = totalBundle(bundle);
      for (const resource of RESOURCES) {
        room.bank[resource] -= bundle[resource];
        player.resources[resource] += bundle[resource];
      }
      break;
    case "monopoly":
      for (const other of activePlayers(room)) {
        if (other.id === player.id) continue;
        count += other.resources[action.resource];
        player.resources[action.resource] += other.resources[action.resource];
        other.resources[action.resource] = 0;
      }
      break;
  }
  recordProgressPlay(player, card.type);
  const detail = card.type === "monopoly" ? ` and collected ${count} ${action.resource}` :
    card.type === "yearOfPlenty" ? ` and received ${count} resource cards` : "";
  appendLog(room, `${player.name} played ${card.type === "yearOfPlenty" ? "Invention" : card.type}${detail}.`, {
    type: "developmentPlayed", actorId: player.id, data: {
      cardType: card.type,
      ...(card.type === "monopoly" ? { resource: action.resource, count } : {}),
      ...(card.type === "yearOfPlenty" ? { count } : {}),
    },
  });
}
function endTurn(room) {
  assertActionPhase(room);
  nextActivation(room);
}
function nextActivation(room) {
  if (activePlayers(room).length > 4 && room.turnRole === "primary") {
    room.turnRole = "secondary";
    room.turnIndex = nextActiveIndex(room, room.primaryIndex, 3);
  } else {
    room.primaryIndex = nextActiveIndex(room, room.primaryIndex);
    room.turnIndex = room.primaryIndex;
    room.turnRole = "primary";
  }
  beginActivation(room);
}

function executeAction(room, actorId, action, random) {
  if (room.phase === "finished" || room.winnerId) throw new Error("The game is over.");
  const player = room.players.find((candidate) => candidate.id === actorId);
  if (!player || player.resigned) throw new Error("You are not an active player in this room.");
  if (!action || typeof action !== "object" || Array.isArray(action) || typeof action.type !== "string") {
    throw new Error("Unknown game action.");
  }
  if (!["offerTrade", "respondTrade", "cancelTrade", "discard", "setEmbargo"].includes(action.type)) assertTurn(room, actorId);
  migrateTrades(room);
  let result;
  let restoredAwards = null;
  switch (action.type) {
    case "undoPlacement": {
      const undone = undoLatestPlacement(room, actorId, action.placementId);
      restoredAwards = undone.awards;
      appendLog(room, `${player.name} undid the ${undone.label.slice(5).toLowerCase()} at ${undone.targetId}.`, {
        type: "placementUndone", actorId,
        data: { placementType: undone.type, targetId: undone.targetId, count: 1 },
      });
      break;
    }
    case "setupSettlement": placeSetupSettlement(room, player, action.vertexId); break;
    case "setupRoad": placeSetupRoad(room, player, action.edgeId); break;
    case "roll": result = rollDice(room, player, random); break;
    case "discard": discard(room, player, action.resources); break;
    case "moveRobber": moveRobber(room, player, action.tileId); break;
    case "steal": steal(room, player, action.targetId, random); break;
    case "buildRoad": buildRoad(room, player, action.edgeId); break;
    case "buildSettlement": buildSettlement(room, player, action.vertexId); break;
    case "buildCity": buildCity(room, player, action.vertexId); break;
    case "bankTrade": bankTrade(room, player, action); break;
    case "offerTrade": offerTrade(room, player, action); break;
    case "respondTrade": respondTrade(room, player, action); break;
    case "confirmTrade": confirmTrade(room, player, action); break;
    case "cancelTrade": withdrawTrade(room, player, action); break;
    case "setEmbargo": setEmbargo(room, player, action); break;
    case "buyDevelopment": buyDevelopment(room, player); break;
    case "playDevelopment": playDevelopment(room, player, action); break;
    case "finishFreeRoads":
      if (!room.freeRoadsRemaining) throw new Error("No free roads are pending.");
      appendLog(room, `${player.name} forfeited ${room.freeRoadsRemaining} unused free roads.`, {
        type: "freeRoadsForfeited", actorId, data: { count: room.freeRoadsRemaining },
      });
      finishFreeRoads(room);
      break;
    case "endTurn":
      assertActionPhase(room);
      updateScores(room);
      checkWinner(room);
      if (!room.winnerId) endTurn(room);
      break;
    default: throw new Error("Unknown game action.");
  }
  updateScores(room, restoredAwards);
  checkWinner(room);
  reconcileTrades(room);
  return result;
}

// Commit only successful transitions, retaining existing object references for callers.
function commitState(target, source) {
  for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) delete target[key];
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value && typeof value === "object" && target[key] && typeof target[key] === "object" &&
        Array.isArray(value) === Array.isArray(target[key]) &&
        (!Object.hasOwn(value, "id") || value.id === target[key].id)) commitState(target[key], value);
    else target[key] = value;
  }
  if (Array.isArray(target)) target.length = source.length;
}
function applyAction(room, actorId, action, random = Math.random) {
  const next = structuredClone(room);
  const placement = capturePlacement(next, actorId, action);
  const result = executeAction(next, actorId, action, random);
  if (placement) recordPlacement(next, placement);
  else if (!preserveAfterAction(action, tradeList(room).find((trade) => trade.id === action.tradeId) || null)) invalidatePlacementUndo(next);
  commitState(room, next);
  return result;
}

function resignPlayer(room, actorId, random = Math.random) {
  if (!RESIGN_PHASES.includes(room.phase) || room.winnerId || !room.board) {
    throw new Error("You can only resign from an unfinished match.");
  }
  const original = activePlayers(room).find((player) => player.id === actorId);
  if (!original) throw new Error("You are not an active player in this room.");
  const next = structuredClone(room);
  invalidatePlacementUndo(next);
  const player = next.players.find((candidate) => candidate.id === actorId);
  const wasCurrent = currentPlayer(next)?.id === actorId;
  const wasSetup = next.phase === "setup";
  const returned = {
    resourceCount: resourceTotal(player), developmentCount: player.developmentCards.length,
    roadCount: next.board.edges.filter((edge) => edge.road?.playerId === actorId).length,
    settlementCount: next.board.vertices.filter((vertex) =>
      vertex.structure?.playerId === actorId && vertex.structure.kind === "settlement").length,
    cityCount: next.board.vertices.filter((vertex) =>
      vertex.structure?.playerId === actorId && vertex.structure.kind === "city").length,
  };
  if (player.developmentCards.length) {
    // House rule: only unplayed cards rejoin the deck; spent cards and effects stay spent.
    next.developmentDeck = shuffle([...next.developmentDeck,
      ...player.developmentCards.map((card) => ({ id: card.id, type: card.type }))], random);
  }
  for (const resource of RESOURCES) {
    next.bank[resource] += player.resources[resource];
    player.resources[resource] = 0;
  }
  for (const vertex of next.board.vertices) {
    if (vertex.structure?.playerId === actorId) vertex.structure = null;
  }
  for (const edge of next.board.edges) {
    if (edge.road?.playerId === actorId) edge.road = null;
  }
  Object.assign(player, {
    resigned: true, connected: false, resignedAt: Date.now(), developmentCards: [],
    knightsPlayed: 0, longestRoad: 0, points: 0, roadsLeft: 15, settlementsLeft: 5, citiesLeft: 4,
  });
  migrateTrades(next);
  for (const trade of [...next.trades]) {
    if ([trade.fromId, trade.targetId].includes(actorId)) closeTrade(next, trade, "player-left", actorId);
    else delete trade.responses[actorId];
  }
  delete next.embargoes[actorId];
  for (const [blockerId, blocked] of Object.entries(next.embargoes)) {
    const remaining = Array.isArray(blocked) ? blocked.filter((id) => id !== actorId) : [];
    if (remaining.length) next.embargoes[blockerId] = remaining;
    else delete next.embargoes[blockerId];
  }
  delete next.pendingDiscards[actorId];
  next.robberVictims = next.robberVictims.filter((id) => id !== actorId);
  const survivors = activePlayers(next);
  if (next.hostId === actorId) {
    const from = next.players.findIndex((candidate) => candidate.id === actorId);
    const clockwise = Array.from({ length: survivors.length }, (_, index) =>
      next.players[nextActiveIndex(next, from, index + 1)]);
    next.hostId = (clockwise.find((candidate) => candidate.connected) || clockwise[0])?.id || null;
  }
  appendLog(next, `${player.name} left the match; ${returned.resourceCount} resource cards, ${returned.developmentCount} development cards, and ${returned.roadCount + returned.settlementCount + returned.cityCount} pieces were returned.`, {
    type: "playerResigned", actorId, data: returned,
  });
  updateScores(next);
  if (survivors.length <= 1) {
    const survivor = survivors[0];
    if (survivor) next.turnIndex = next.players.findIndex((candidate) => candidate.id === survivor.id);
    next.primaryIndex = next.turnIndex;
    next.turnRole = "primary";
    finishGame(next, survivor?.id || null, survivor ? "last-player" : "abandoned");
    appendLog(next, survivor ? `${survivor.name} is the last remaining player.` : "The match was abandoned.", {
      type: "gameFinished", actorId: survivor?.id || null,
      data: { winnerId: survivor?.id || null, reason: next.winReason, ...(survivor ? { points: survivor.points } : {}) },
    });
  } else if (wasCurrent) {
    if (wasSetup) {
      next.setupNeedsRoad = false;
      next.lastSetupVertex = null;
      advanceSetup(next);
    } else {
      const pending = { ...next.pendingDiscards };
      next.pendingDiscards = {};
      next.robberVictims = [];
      next.mustMoveRobber = false;
      next.robberReturnPhase = null;
      next.discardReturnPhase = null;
      next.freeRoadsRemaining = 0;
      next.freeRoadsReturnPhase = null;
      nextActivation(next);
      if (!next.winnerId && Object.keys(pending).length) {
        // The departing actor forfeits robber/free-road choices, but survivors still owe their discards.
        next.pendingDiscards = pending;
        next.discardReturnPhase = next.phase;
        next.phase = "discard";
      }
    }
  } else if (next.phase === "discard" && !Object.keys(next.pendingDiscards).length) {
    finishDiscards(next);
  } else if (next.phase === "steal" && !next.robberVictims.length) {
    finishRobber(next);
  }
  checkWinner(next);
  commitState(room, next);
}

function legalActions(room, viewerId) {
  const legal = {
    roadEdges: [], settlementVertices: [], cityVertices: [], robberTiles: [],
    canRoll: false, canEndTurn: false, canBuyDevelopment: false,
    playableCardIds: [], canBankTrade: false, canOfferTrade: false, canFinishFreeRoads: false,
    canShuffleMap: false, canResign: false, canRestartGame: false, canUndoPlacement: false,
  };
  const player = activePlayers(room).find((candidate) => candidate.id === viewerId);
  if (player && room.phase === "lobby" && !room.winnerId) {
    legal.canShuffleMap = room.hostId === viewerId;
  }
  if (player && room.hostId === viewerId && !["lobby", "finished"].includes(room.phase)) {
    legal.canRestartGame = true;
  }
  if (!player || !room.board || room.winnerId || ["finished", "lobby"].includes(room.phase)) return legal;
  legal.canUndoPlacement = undoOpportunity(room, viewerId) !== null;
  legal.canResign = RESIGN_PHASES.includes(room.phase);
  const active = currentPlayer(room)?.id === viewerId;
  const actionPhase = room.phase === "action" && !room.freeRoadsRemaining;
  legal.canOfferTrade = actionPhase && room.turnRole === "primary" && resourceTotal(player) > 0 &&
    tradeList(room).filter((trade) => trade.fromId === viewerId).length < (active ? TRADE_LIMITS.activeTurnPlayer : TRADE_LIMITS.activeOther) &&
    activePlayers(room).some((other) => other.id !== player.id && resourceTotal(other) > 0 &&
      (active || other.id === currentPlayer(room).id) && !blocksTrading(room, other.id, viewerId));
  if (!active) return legal;
  if (room.phase === "setup") {
    if (room.setupNeedsRoad && player.roadsLeft > 0) {
      legal.roadEdges = room.board.edges.filter((edge) =>
        !edge.road && edge.vertices.includes(room.lastSetupVertex)).map((edge) => edge.id);
    } else if (!room.setupNeedsRoad && player.settlementsLeft > 0) {
      legal.settlementVertices = room.board.vertices.filter((vertex) =>
        settlementIsSpaced(room, vertex)).map((vertex) => vertex.id);
    }
    return legal;
  }
  legal.canRoll = room.phase === "roll" && !room.freeRoadsRemaining && room.turnRole === "primary";
  legal.canEndTurn = actionPhase;
  legal.canFinishFreeRoads = room.freeRoadsRemaining > 0;
  legal.playableCardIds = player.developmentCards.filter((card) =>
    cardCanBePlayed(room, player, card)).map((card) => card.id);
  if (room.phase === "robber") {
    legal.robberTiles = room.board.tiles.filter((tile) => !tile.robber).map((tile) => tile.id);
  }
  if (room.freeRoadsRemaining || (actionPhase && hasBundle(player, COSTS.road))) {
    legal.roadEdges = availableRoads(room, player).map((edge) => edge.id);
  }
  if (actionPhase) {
    if (player.settlementsLeft > 0 && hasBundle(player, COSTS.settlement)) {
      legal.settlementVertices = room.board.vertices.filter((vertex) =>
        settlementIsSpaced(room, vertex) && vertexTouchesPlayerRoad(room, vertex, viewerId)).map((vertex) => vertex.id);
    }
    if (player.citiesLeft > 0 && hasBundle(player, COSTS.city)) {
      legal.cityVertices = room.board.vertices.filter((vertex) =>
        vertex.structure?.playerId === viewerId && vertex.structure.kind === "settlement").map((vertex) => vertex.id);
    }
    legal.canBuyDevelopment = room.developmentDeck.length > 0 && hasBundle(player, COSTS.development);
    const rates = tradeRates(room, viewerId);
    legal.canBankTrade = RESOURCES.some((give) => player.resources[give] >= rates[give] &&
      RESOURCES.some((receive) => give !== receive && room.bank[receive] > 0));
  }
  return legal;
}

function publicState(room, viewerId) {
  const active = room.phase !== "lobby" && !currentPlayer(room)?.resigned ? currentPlayer(room)?.id || null : null;
  const players = activePlayers(room);
  const events = normalizePublicEvents({ log: room.log, eventSequence: room.eventSequence, eventOutbox: [] });
  const state = {
    code: room.code, hostId: room.hostId, phase: room.phase, revision: room.revision ?? 0,
    eventSequence: events.eventSequence,
    mapVersion: room.mapVersion ?? 0,
    boardPlayerCount: (room.board ? room.board.tiles.length === 30 : room.players.length > 4) ? 6 : 4,
    activePlayerCount: players.length,
    undoPlacement: undoOpportunity(room, viewerId),
    departedPlayers: room.players.filter((player) => player.resigned).map((player) => ({
      id: player.id, name: player.name, color: player.color, resignedAt: player.resignedAt ?? null,
    })),
    winReason: room.winReason ?? (room.phase === "finished" && room.winnerId ? "points" : null),
    players: players.map((player) => ({
      id: player.id, name: player.name, color: player.color, connected: player.connected,
      points: player.id === viewerId || room.phase === "finished"
        ? publicPoints(room, player) + player.developmentCards.filter((card) => card.type === "victoryPoint").length
        : publicPoints(room, player),
      resourceCount: resourceTotal(player),
      ...(player.id === viewerId ? {
        resources: player.resources, tradeRates: tradeRates(room, player.id),
        developmentCards: player.developmentCards.map((card) => ({
          id: card.id, type: card.type, playable: cardCanBePlayed(room, player, card),
        })),
      } : {}),
      roadsLeft: player.roadsLeft, settlementsLeft: player.settlementsLeft, citiesLeft: player.citiesLeft,
      knightsPlayed: player.knightsPlayed, longestRoad: player.longestRoad,
      developmentCount: player.developmentCards.length,
      revealedDevelopment: revealedDevelopment(player, room.phase === "finished"),
      ...(room.phase === "finished" && player.id !== viewerId ? {
        revealedVictoryPoints: player.developmentCards.filter((card) => card.type === "victoryPoint").length,
      } : {}),
    })),
    board: room.board, currentPlayerId: active,
    primaryPlayerId: room.phase !== "lobby" && players.length ? room.players[room.primaryIndex]?.id || null : null,
    secondaryPlayerId: room.phase !== "lobby"
      ? (room.turnRole === "secondary" ? active
        : players.length > 4 ? room.players[nextActiveIndex(room, room.primaryIndex, 3)].id : null)
      : null,
    turnRole: room.turnRole, turnNumber: room.turnNumber,
    setupRound: room.setupRound, setupNeedsRoad: room.setupNeedsRoad,
    dice: room.dice, mustMoveRobber: room.mustMoveRobber, pendingDiscards: room.pendingDiscards,
    robberVictims: room.robberVictims, freeRoadsRemaining: room.freeRoadsRemaining,
    bank: room.bank, developmentCount: room.developmentDeck.length,
    longestRoadHolderId: room.longestRoadHolderId, largestArmyHolderId: room.largestArmyHolderId,
    trades: tradeList(room).map((trade) => ({
      ...storedTrade(trade), responders: tradeResponders(room, trade),
      blockedBy: isOpenTrade(trade) ? activePlayers(room).filter((other) => other.id !== trade.fromId &&
        blocksTrading(room, other.id, trade.fromId)).map((other) => other.id) : [],
      unavailableReason: tradeUnavailableReason(room, trade),
    })),
    embargoes: isRecord(room.embargoes) ? room.embargoes : {}, tradeLimits: TRADE_LIMITS,
    winnerId: room.winnerId, log: events.log, viewerId,
    legal: legalActions(room, viewerId),
  };
  return structuredClone(state);
}

module.exports = {
  RESOURCES, COSTS, activePlayers, addPlayer, appendPublicEvent, applyAction, createRoom, ensureMapPreview, makeBoard,
  normalizePublicEvents, publicState, resignPlayer, resourceTotal, shuffleMap, startGame, TRADE_LIMITS, tradeList,
};
