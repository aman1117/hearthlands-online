"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { Server } = require("socket.io");
const {
  activePlayers, addPlayer, appendPublicEvent, applyAction, createRoom, ensureMapPreview,
  normalizePublicEvents, publicState, resignPlayer, shuffleMap, startGame,
} = require("./game");
const { createStorage, StorageError } = require("./storage");
const { migratePublicDevelopmentHistory } = require("./development-history");

const PROTOCOL_VERSION = 3;
const RECEIPT_LIMIT = 2048;
const REQUEST_ID = /^[a-zA-Z0-9-]{8,80}$/;
const RESUME_KEY = /^[a-f0-9]{64}$/;

class RequestError extends Error {
  constructor(code, message, retryable = false, details = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(payload) {
  const body = Object.fromEntries(Object.entries(payload).filter(([key]) => !["requestId", "clientSeq"].includes(key)));
  return crypto.createHash("sha256").update(canonical(body)).digest("hex");
}

function createGameServer(options = {}) {
  const app = express();
  const server = http.createServer(app);
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, "data");
  const publicDir = options.publicDir || process.env.HEARTHLANDS_PUBLIC_DIR || path.join(__dirname, "public");
  const retentionDays = Number(options.retentionDays ?? process.env.ROOM_RETENTION_DAYS ?? 90);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error("ROOM_RETENTION_DAYS must be an integer between 1 and 3650.");
  }
  const roomLifetime = retentionDays * 24 * 60 * 60 * 1000;
  const now = options.now || Date.now;
  const storage = createStorage({
    dataDir,
    databaseUrl: options.databaseUrl ?? (options.dataDir ? undefined : process.env.DATABASE_URL),
    databaseSchema: options.databaseSchema ?? process.env.DATABASE_SCHEMA,
    databaseSsl: options.databaseSsl ?? process.env.DATABASE_SSL,
    databaseCa: options.databaseCa,
  });
  const random = options.random || (() => crypto.randomInt(0, 2 ** 48 - 1) / (2 ** 48 - 1));
  const maxRooms = options.maxRooms || 200;
  const rooms = new Map();
  const uncertainRooms = new Set();
  const sockets = new Map();
  const ipRates = new Map();
  const connections = new Set();
  const queues = new Map();
  let shuttingDown = false;
  let initialized = false;
  server.on("connection", (connection) => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
  });
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean);

  const io = new Server(server, {
    maxHttpBufferSize: 16_384,
    allowRequest(request, callback) {
      if (shuttingDown || !initialized) return callback(null, false);
      const origin = request.headers.origin;
      if (!origin) return callback(null, true);
      let sameHost = false;
      try {
        sameHost = new URL(origin).host === request.headers.host;
      } catch {
        return callback(null, false);
      }
      callback(null, sameHost || allowedOrigins.includes(origin));
    },
  });

  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      "Cache-Control": "no-cache",
    });
    next();
  });
  app.get("/health", async (_request, response) => {
    try {
      await storage.health();
      response.json({ ok: initialized && !shuttingDown });
    } catch {
      response.status(503).json({ ok: false });
    }
  });
  app.get("/vendor/panzoom.min.js", (_request, response) =>
    response.sendFile(require.resolve("@panzoom/panzoom/dist/panzoom.min.js")));
  app.use(express.static(publicDir, { extensions: ["html"], dotfiles: "deny" }));

  function enqueue(key, operation) {
    const work = (queues.get(key) || Promise.resolve()).then(operation);
    const settled = work.then(() => undefined, () => undefined);
    queues.set(key, settled);
    settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
    return work;
  }

  async function drain() {
    while (queues.size) await Promise.all([...queues.values()]);
  }

  async function freshRoom(code) {
    const room = await storage.getRoom(code);
    uncertainRooms.delete(code);
    if (room) {
      rooms.set(code, room);
      for (const player of allSeats(room)) {
        if ((player.resigned || player.removed) && sockets.has(player.reconnectToken)) {
          retireConnection(room, player, player.retirementRequestId);
        }
      }
    }
    return room;
  }

  async function refreshRooms() {
    for (const room of await storage.listRooms({ includeArchived: true })) {
      if (!rooms.has(room.code) || rooms.get(room.code).revision <= room.revision) rooms.set(room.code, room);
    }
  }

  function roomKey(socket) {
    return `room:${socket.data.roomCode || socket.data.retiredSeat?.roomCode || socket.id}`;
  }

  function allSeats(room) {
    return [...room.players, ...(room.retiredPlayers || []), ...(room.removedPlayers || [])];
  }

  function recipientFor(room, player) {
    if (player.resigned || player.removed || uncertainRooms.has(room.code)) return undefined;
    const recipient = io.sockets.sockets.get(sockets.get(player.reconnectToken));
    return recipient?.connected && recipient.data.roomCode === room.code &&
      recipient.data.token === player.reconnectToken ? recipient : undefined;
  }

  function nextSequence(room, playerId) {
    const highWater = room.clientSequences?.[playerId] || 0;
    return highWater < Number.MAX_SAFE_INTEGER ? highWater + 1 : null;
  }

  function ownReceipt(room, playerId) {
    const receipt = room.lastReceipts?.[playerId] ||
      room.requests?.findLast((request) => request.playerId === playerId && request.clientSeq);
    if (!receipt) return null;
    const result = receipt.result;
    return {
      requestId: receipt.id, event: receipt.event, ok: result.ok,
      ...(!result.ok ? { code: result.code, error: result.error } : {}),
      revision: result.revision, nextSequence: result.nextSequence,
    };
  }

  function protocolState(room, playerId) {
    return {
      protocolVersion: PROTOCOL_VERSION, revision: room.revision,
      nextSequence: nextSequence(room, playerId), ownReceipt: ownReceipt(room, playerId),
      savedAt: room.updatedAt, expiresAt: room.updatedAt + roomLifetime,
      adminId: room.hostId,
      removalRequests: (room.removalRequests || []).filter((request) =>
        activePlayers(room).some((player) => player.id === request.playerId))
        .map(({ playerId: id, requestedAt }) => ({ playerId: id, requestedAt })),
    };
  }

  function publish(room) {
    const visibleRoom = {
      ...room, players: room.players.map((player) => ({ ...player, connected: Boolean(recipientFor(room, player)) })),
    };
    for (const player of activePlayers(room)) {
      const view = publicState(visibleRoom, player.id);
      const administrator = room.hostId === player.id;
      view.legal = {
        ...view.legal,
        canResign: view.legal.canResign && administrator,
        canRequestRemoval: !administrator && room.phase !== "finished",
        canTransferAdmin: administrator && activePlayers(room).length > 1,
        canRemovePlayer: administrator && room.phase !== "finished" && activePlayers(room).length > 1,
      };
      recipientFor(room, player)?.emit("state", {
        ...view, ...protocolState(room, player.id),
      });
    }
  }

  function publishPresence(room, event) {
    const message = { ...event, at: now(), mapVersion: room.mapVersion ?? 0 };
    for (const player of activePlayers(room)) {
      recipientFor(room, player)?.emit("mapPresence", message);
    }
  }

  async function commit(room) {
    const previous = rooms.get(room.code);
    room.updatedAt = now();
    room.revision = (room.revision || 0) + 1;
    normalizePublicEvents(room);
    let saved;
    try {
      saved = await storage.commitRoom(room, { expectedRevision: previous?.revision ?? null });
    } catch (error) {
      uncertainRooms.add(room.code);
      throw error;
    }
    uncertainRooms.delete(room.code);
    rooms.set(saved.code, saved);
    if (previous && (previous.mapVersion ?? 0) !== (saved.mapVersion ?? 0)) {
      publishPresence(saved, { kind: "clear" });
    }
    return saved;
  }

  async function expireRooms() {
    for (const code of await storage.archiveRooms(now() - roomLifetime, now())) {
      const room = await freshRoom(code);
      allSeats(room).forEach((player) => {
        const socketId = sockets.get(player.reconnectToken);
        if (socketId) io.sockets.sockets.get(socketId)?.disconnect(true);
        sockets.delete(player.reconnectToken);
      });
    }
    for (const [ip, rate] of ipRates) {
      if (now() - rate.at > 60_000) ipRates.delete(ip);
    }
  }

  function roomCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    let code;
    do {
      code = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
    } while (rooms.has(code));
    return code;
  }

  function retiredError(room, player) {
    return new RequestError("SEAT_RETIRED", "This seat has resigned and cannot rejoin the match.", false, {
      roomCode: room.code, playerId: player.id,
    });
  }

  function session(socket, allowRetired = false) {
    const token = socket.data.token || socket.data.retiredSeat?.token;
    const code = socket.data.roomCode || socket.data.retiredSeat?.roomCode;
    const room = rooms.get(code);
    if (uncertainRooms.has(code)) {
      throw new RequestError("SESSION_REQUIRED", "The saved room outcome is being reconciled. Retry after reconnecting.", true);
    }
    const player = room && allSeats(room).find((candidate) => candidate.reconnectToken === token);
    if ((player?.resigned || player?.removed) && socket.data.retiredSeat?.token === token) {
      if (allowRetired) return { room, player };
      if (player.resigned) throw retiredError(room, player);
      throw new RequestError("ROOM_NOT_FOUND", "This lobby seat was removed.");
    }
    if (!player || sockets.get(player.reconnectToken) !== socket.id) {
      throw new RequestError(room || !code ? "SESSION_REQUIRED" : "ROOM_NOT_FOUND",
        room || !code ? "Reconnect to this room before taking an action." : "Saved game not found or expired.",
        Boolean(room || !code));
    }
    if (player.resigned && !allowRetired) throw retiredError(room, player);
    return { room, player };
  }

  function requireUnbound(socket, token) {
    if (socket.data.token && socket.data.token !== token) {
      throw new RequestError("REJECTED", "You are already seated. Leave this screen before joining another room.");
    }
  }

  function chooseHost(room) {
    const remaining = activePlayers(room);
    if (!remaining.some((player) => player.id === room.hostId)) {
      room.hostId = remaining[0]?.id || null;
    }
  }

  function findSeat(token) {
    for (const room of rooms.values()) {
      const player = allSeats(room).find((candidate) => candidate.reconnectToken === token);
      if (player) return { room, player };
    }
    return null;
  }

  function bind(socket, room, player) {
    if (player.resigned) throw retiredError(room, player);
    const previousId = sockets.get(player.reconnectToken);
    // Transfer ownership before disconnect: an old tab must not disconnect the new one.
    if (socket.connected) sockets.set(player.reconnectToken, socket.id);
    socket.data.token = player.reconnectToken;
    socket.data.roomCode = room.code;
    delete socket.data.retiredSeat;
    if (previousId && previousId !== socket.id) {
      publishPresence(room, { kind: "leave", reason: "replace", playerId: player.id });
      const previous = io.sockets.sockets.get(previousId);
      previous?.emit("sessionReplaced");
      previous?.disconnect(true);
    }
    if (!socket.connected) queueDisconnect(room.code, player.reconnectToken);
    publish(room);
    return {
      ok: true, roomCode: room.code, playerId: player.id, reconnectToken: player.reconnectToken,
      ...protocolState(room, player.id),
    };
  }

  async function resume(socket, original, originalPlayer) {
    if (originalPlayer.resigned) throw retiredError(original, originalPlayer);
    if (originalPlayer.removed) throw new RequestError("ROOM_NOT_FOUND", "This lobby seat was removed. Join with a new resume key.");
    requireUnbound(socket, originalPlayer.reconnectToken);
    const sameBinding = recipientFor(original, originalPlayer)?.id === socket.id;
    if (sameBinding &&
        original.players.every((candidate) => candidate.connected === Boolean(recipientFor(original, candidate))) &&
        activePlayers(original).some((candidate) => candidate.id === original.hostId)) {
      return bind(socket, original, originalPlayer);
    }
    let room = structuredClone(original);
    room.players.forEach((candidate) => { candidate.connected = Boolean(recipientFor(room, candidate)); });
    const player = room.players.find((candidate) => candidate.id === originalPlayer.id);
    player.connected = true;
    chooseHost(room);
    ensureMapPreview(room, random);
    if (!sameBinding) {
      appendPublicEvent(room, { type: "player.reconnected", actorId: player.id, message: `${player.name} reconnected.`, data: { playerId: player.id } }, now());
    }
    room = await commit(room);
    return bind(socket, room, player);
  }

  function rateLimit(socket, event) {
    const at = now();
    if (!socket.data.rate || at - socket.data.rate.at >= 1000) socket.data.rate = { at, count: 0 };
    if (++socket.data.rate.count > 40) {
      throw new RequestError("RATE_LIMITED", "Too many requests. Wait a moment and try again.", true,
        { retryAfterMs: Math.max(1, socket.data.rate.at + 1000 - at) });
    }
    if (["createRoom", "joinRoom", "reconnectRoom"].includes(event)) {
      const ip = socket.handshake.address;
      let rate = ipRates.get(ip);
      if (!rate || at - rate.at >= 60_000) {
        rate = { at, count: 0 };
        ipRates.set(ip, rate);
      }
      if (++rate.count > 120) {
        throw new RequestError("RATE_LIMITED", "Too many room requests. Try again in a minute.", true,
          { retryAfterMs: Math.max(1, rate.at + 60_000 - at) });
      }
    }
  }

  function failure(error) {
    if (error instanceof StorageError) {
      return { ok: false, code: "SAVE_FAILED", retryable: true,
        error: "The saved outcome could not be confirmed. Reconnect and retry the same request." };
    }
    return error instanceof RequestError
      ? { ok: false, error: error.message, code: error.code, retryable: error.retryable, ...error.details }
      : { ok: false, error: error.message, code: "REJECTED", retryable: false };
  }

  function validateRequestId(requestId, required = false) {
    if ((requestId !== undefined || required) && (typeof requestId !== "string" || !REQUEST_ID.test(requestId))) {
      throw new RequestError("REJECTED", "This request requires a valid request ID.");
    }
  }

  function requireAvailable(room) {
    if (!room || room.archivedAt !== undefined || now() - room.updatedAt > roomLifetime) {
      throw new RequestError("ROOM_NOT_FOUND", "Saved game not found or expired.");
    }
  }

  async function entry(socket, event, payload) {
    const { name, resumeKey, requestId } = payload;
    validateRequestId(requestId, resumeKey !== undefined);
    if (resumeKey !== undefined && (typeof resumeKey !== "string" || !RESUME_KEY.test(resumeKey))) {
      throw new RequestError("REJECTED", "A resume key must contain exactly 64 lowercase hexadecimal characters.");
    }
    if (typeof name !== "string") throw new RequestError("REJECTED", "A player name must be text.");
    const code = event === "joinRoom" && typeof payload.code === "string" ? payload.code.trim().toUpperCase() : null;
    if (event === "joinRoom" && (!code || !/^[A-Z]{6}$/.test(code))) {
      throw new RequestError("REJECTED", "Enter a six-letter room code.");
    }
    const hash = payloadHash({ name: name.trim(), ...(code ? { code } : {}) });
    await refreshRooms();
    const existing = findSeat(resumeKey || socket.data.token);
    if (existing && (resumeKey || requestId)) {
      requireAvailable(existing.room);
      const { room, player } = existing;
      if (player.resigned) throw retiredError(room, player);
      if (player.removed) throw new RequestError("ROOM_NOT_FOUND", "This lobby seat was removed. Join with a new resume key.");
      if (player.entry?.event !== event || player.entry.id !== requestId || player.entry.payloadHash !== hash) {
        throw new RequestError("REQUEST_CONFLICT", "This resume key was already used for a different room request.");
      }
      return enqueue(`room:${room.code}`, async () => {
        const fresh = await freshRoom(room.code);
        requireAvailable(fresh);
        return { ...await resume(socket, fresh, allSeats(fresh).find((candidate) => candidate.id === player.id)), requestId };
      });
    }
    requireUnbound(socket);
    let room;
    let player;
    if (event === "createRoom") {
      await expireRooms();
      if ([...rooms.values()].filter((candidate) => candidate.archivedAt === undefined).length >= maxRooms) {
        throw new RequestError("RATE_LIMITED", "This server is full. Please try again later.", true, { retryAfterMs: 60_000 });
      }
      ({ room, player } = createRoom(name));
      room.code = roomCode();
      room.createdAt = now();
      if (resumeKey) player.reconnectToken = resumeKey;
    } else {
      return enqueue(`room:${code}`, async () => {
        const original = await freshRoom(code);
        requireAvailable(original);
        const joined = structuredClone(original);
        joined.players.forEach((candidate) => { candidate.connected = Boolean(recipientFor(joined, candidate)); });
        const added = addPlayer(joined, name, resumeKey);
        if (findSeat(added.reconnectToken)) throw new RequestError("REQUEST_CONFLICT", "This resume key is already assigned to another seat.");
        if (requestId) added.entry = { event, id: requestId, payloadHash: hash };
        chooseHost(joined);
        ensureMapPreview(joined, random);
        const saved = await commit(joined);
        return { ...bind(socket, saved, added), ...(requestId ? { requestId } : {}) };
      });
    }
    if (findSeat(player.reconnectToken)) {
      throw new RequestError("REQUEST_CONFLICT", "This resume key is already assigned to another seat.");
    }
    if (requestId) player.entry = { event, id: requestId, payloadHash: hash };
    chooseHost(room);
    ensureMapPreview(room, random);
    room = await commit(room);
    return { ...bind(socket, room, player), ...(requestId ? { requestId } : {}) };
  }

  async function mutation(socket, event, payload, operation) {
    const { room: original, player } = session(socket, true);
    requireAvailable(original);
    const { requestId, clientSeq } = payload;
    const sequenced = clientSeq !== undefined;
    validateRequestId(requestId, sequenced || [
      "gameAction", "shuffleMap", "resignGame", "requestRemoval", "cancelRemovalRequest", "declineRemoval", "transferAdmin",
    ].includes(event));
    if (sequenced && (!Number.isSafeInteger(clientSeq) || clientSeq <= 0)) {
      throw new RequestError("REJECTED", "clientSeq must be a positive safe integer.");
    }
    const hash = payloadHash(payload);
    const matches = (request) => request.id === requestId && request.playerId === player.id &&
      (!request.event || request.event === event);
    const previous = requestId && (original.requests?.find(matches) ||
      (original.lastReceipts?.[player.id] && matches(original.lastReceipts[player.id]) ? original.lastReceipts[player.id] : null));
    if ((player.resigned || player.removed) && !(["resignGame", "removePlayer"].includes(event) && previous)) {
      if (player.resigned) throw retiredError(original, player);
      throw new RequestError("ROOM_NOT_FOUND", "This lobby seat was removed.");
    }
    if (previous) {
      if (previous.payloadHash && previous.payloadHash !== hash) {
        throw new RequestError("REQUEST_CONFLICT", "This request ID was already used with different data.");
      }
      publish(original);
      // Version-2 receipts have no payload fingerprint. They must never be reapplied.
      return {
        ...(previous.result || { ok: true, processed: true, revision: original.revision,
          ...(previous.mapVersion !== undefined ? { mapVersion: previous.mapVersion } : {}) }),
        requestId, nextSequence: nextSequence(original, player.id),
      };
    }
    const expected = nextSequence(original, player.id);
    if (sequenced && (expected === null || clientSeq < expected)) {
      throw new RequestError("STALE_REQUEST", "This sequence was already processed; refresh your saved state.", false,
        { processed: true, nextSequence: expected });
    }
    if (sequenced && clientSeq > expected) {
      throw new RequestError("SEQUENCE_GAP", "An earlier request is missing. Retry it before this request.", false,
        { nextSequence: expected });
    }
    let room = structuredClone(original);
    let result;
    let afterCommit;
    try {
      const outcome = operation(room, player.id);
      room = outcome?.room || room;
      afterCommit = outcome?.afterCommit;
      result = { ok: true, ...outcome?.reply };
    } catch (error) {
      result = failure(error);
      if (!sequenced || result.retryable) throw error;
      // A rejected transaction only saves its receipt, never partial engine mutations.
      room = structuredClone(original);
    }
    const revision = (original.revision || 0) + 1;
    if (sequenced) {
      room.clientSequences = { ...room.clientSequences, [player.id]: clientSeq };
    }
    result = { ...result, ...(requestId ? { requestId } : {}), revision, nextSequence: nextSequence(room, player.id) };
    if (requestId) {
      const receipt = {
        id: requestId, playerId: player.id, event, payloadHash: hash,
        ...(sequenced ? { clientSeq } : {}), result,
      };
      room.requests = [...(room.requests || []), receipt].slice(-RECEIPT_LIMIT);
      if (sequenced) room.lastReceipts = { ...room.lastReceipts, [player.id]: receipt };
    }
    room = await commit(room);
    afterCommit?.(room);
    publish(room);
    return result;
  }

  function requireAdmin(room, actorId) {
    if (room.hostId !== actorId) throw new RequestError("ADMIN_REQUIRED", "Only the room administrator can do this.");
  }

  function retireConnection(room, player, requestId) {
    const recipient = io.sockets.sockets.get(sockets.get(player.reconnectToken));
    sockets.delete(player.reconnectToken);
    if (!recipient) return;
    recipient.data.retiredSeat = { roomCode: room.code, token: player.reconnectToken };
    recipient.data.token = null;
    recipient.data.roomCode = null;
    if (player.resigned) recipient.emit("seatRetired", { roomCode: room.code, playerId: player.id, requestId });
    else recipient.emit("removedFromRoom", { roomCode: room.code, playerId: player.id, requestId });
  }

  function removeSeat(room, actorId, payload) {
    requireAdmin(room, actorId);
    if (payload.confirmed !== true) throw new RequestError("REJECTED", "Confirm this removal explicitly.");
    if (room.phase === "finished") throw new RequestError("REJECTED", "Start a rematch before removing a finished-game seat.");
    const target = activePlayers(room).find((player) => player.id === payload.playerId);
    if (!target) throw new RequestError("REJECTED", "Choose an active member of this room.");
    const administrator = activePlayers(room).find((player) => player.id === actorId);
    const reason = target.id === actorId ? "adminDeparture" :
      (room.removalRequests || []).some((request) => request.playerId === target.id) ? "requestApproved" : "adminRemoval";
    const location = room.phase === "lobby" ? "lobby" : "match";
    const removalMessage = reason === "adminDeparture"
      ? `${administrator.name} left the ${location} after transferring administration.`
      : reason === "requestApproved"
        ? `${administrator.name} approved ${target.name}'s request to leave the ${location}.`
        : `${administrator.name} removed ${target.name} from the ${location}.`;
    if (target.id === actorId) {
      const successor = activePlayers(room).find((player) => player.id === payload.successorId && player.id !== actorId);
      if (!successor) throw new RequestError("SUCCESSOR_REQUIRED", "Choose another active player to become administrator before you leave.");
      room.hostId = successor.id;
      appendPublicEvent(room, {
        type: "admin.transferred", actorId, message: `${target.name} transferred administration to ${successor.name}.`,
        data: { fromPlayerId: actorId, toPlayerId: successor.id },
      }, now());
    }
    const adminId = room.hostId;
    if (room.phase === "lobby") {
      room.players = room.players.filter((player) => player.id !== target.id);
      room.removedPlayers = [...(room.removedPlayers || []), {
        id: target.id, reconnectToken: target.reconnectToken, removed: true, connected: false, retirementRequestId: payload.requestId,
      }];
      ensureMapPreview(room, random);
      appendPublicEvent(room, {
        type: "player.removed", actorId, message: removalMessage,
        data: { playerId: target.id, reason },
      }, now());
    } else {
      if (target.id !== actorId) {
        appendPublicEvent(room, {
          type: "player.removed", actorId, message: removalMessage,
          data: { playerId: target.id, reason },
        }, now());
      }
      resignPlayer(room, target.id, random);
      Object.assign(room.players.find((player) => player.id === target.id), {
        resignedAt: now(), retirementRequestId: payload.requestId,
      });
    }
    // The engine repairs turn flow; server policy, not socket presence, owns administration.
    room.hostId = adminId;
    room.removalRequests = (room.removalRequests || []).filter((request) => request.playerId !== target.id);
    return { afterCommit(saved) {
      const removed = allSeats(saved).find((player) => player.id === target.id);
      publishPresence(saved, { kind: "leave", reason: removed.resigned ? "resign" : "remove", playerId: target.id });
      retireConnection(saved, removed, payload.requestId);
    } };
  }

  function queueDisconnect(code, token) {
    const work = enqueue(`room:${code}`, async () => {
      const original = await freshRoom(code);
      if (!original || original.archivedAt !== undefined || now() - original.updatedAt > roomLifetime) return;
      const departed = original.players.find((player) => player.reconnectToken === token);
      if (!departed || departed.resigned || !departed.connected || recipientFor(original, departed)) return;
      const room = structuredClone(original);
      room.players.forEach((player) => { player.connected = Boolean(recipientFor(room, player)); });
      appendPublicEvent(room, {
        type: "player.disconnected", actorId: departed.id, message: `${departed.name} disconnected; their seat is saved.`,
        data: { playerId: departed.id },
      }, now());
      publish(await commit(room));
    });
    work.catch(() => console.error("Unable to persist the disconnected seat; reconnect to reconcile the saved state."));
    return work;
  }

  io.on("connection", (socket) => {
    function handlePresence(event, kind, limit) {
      socket.on(event, (payload, callback) => {
        const at = now();
        socket.data.presenceRates ||= {};
        const budget = (socket.data.presenceRates[kind] || []).filter((sentAt) => at - sentAt < 1000);
        socket.data.presenceRates[kind] = budget;
        if (budget.length >= limit) {
          if (typeof callback === "function") {
            callback({ ok: false, throttled: true, error: "Map presence rate limit exceeded." });
          }
          return;
        }
        budget.push(at);
        try {
          if (shuttingDown) throw new RequestError("SESSION_REQUIRED", "The server is restarting.", true);
          const { room, player } = session(socket);
          requireAvailable(room);
          if (!room.board) throw new Error("No map is available.");
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Error("Map presence requires a valid object.");
          }
          if (!Number.isSafeInteger(payload.mapVersion) || payload.mapVersion < 0 ||
              payload.mapVersion !== (room.mapVersion ?? 0)) {
            throw new Error("This map presence refers to an old or invalid map version.");
          }
          if (kind === "pointer" && payload.visible !== undefined && typeof payload.visible !== "boolean") {
            throw new Error("Pointer visibility must be a boolean.");
          }
          const leaving = kind === "pointer" && payload.visible === false;
          if (!leaving || payload.x !== undefined || payload.y !== undefined) {
            if (![payload.x, payload.y].every((coordinate) =>
              typeof coordinate === "number" && Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1)) {
              throw new Error("Map coordinates must be finite numbers between 0 and 1.");
            }
          }
          publishPresence(room, {
            kind: leaving ? "leave" : kind, playerId: player.id, name: player.name, color: player.color,
            ...(!leaving ? { x: payload.x, y: payload.y } : {}),
            ...(leaving ? { reason: "cursor" } : {}),
          });
          if (typeof callback === "function") callback({ ok: true });
        } catch (error) {
          const result = failure(error);
          if (typeof callback === "function") callback(result);
          else if (!socket.data.presenceErrorAt || at - socket.data.presenceErrorAt >= 1000) {
            socket.data.presenceErrorAt = at;
            socket.emit("requestError", result.error);
          }
        }
      });
    }
    handlePresence("mapPointer", "pointer", 20);
    handlePresence("mapPing", "ping", 2);

    function handle(event, operation) {
      socket.on(event, async (payload, callback) => {
        let result;
        try {
          rateLimit(socket, event);
          if (shuttingDown) {
            throw new RequestError("SESSION_REQUIRED", "The server is restarting. Reconnect to resume your saved position.", true);
          }
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Error("A request must contain a valid object.");
          }
          const entryEvent = ["createRoom", "joinRoom", "reconnectRoom"].includes(event);
          const identity = {
            code: socket.data.roomCode || socket.data.retiredSeat?.roomCode,
            token: socket.data.token || socket.data.retiredSeat?.token,
          };
          const requireSameSeat = () => {
            if (identity.code !== (socket.data.roomCode || socket.data.retiredSeat?.roomCode) ||
                identity.token !== (socket.data.token || socket.data.retiredSeat?.token)) {
              throw new RequestError("SESSION_REQUIRED", "This queued request belongs to an earlier seat. Reconnect before taking a new action.", true);
            }
          };
          result = await enqueue(entryEvent ? "entries" : roomKey(socket), async () => {
            if (!entryEvent) {
              requireSameSeat();
              if (identity.code) await freshRoom(identity.code);
              requireSameSeat();
            }
            return await operation(payload) || { ok: true };
          });
        } catch (error) {
          result = failure(error);
          const code = socket.data.roomCode || socket.data.retiredSeat?.roomCode;
          if (error instanceof StorageError && code) {
            const previousRevision = rooms.get(code)?.revision;
            try {
              const reconciled = await freshRoom(code);
              if (reconciled && reconciled.revision !== previousRevision) publish(reconciled);
            } catch {
              // Keep this room quarantined until an authoritative read succeeds.
              uncertainRooms.add(code);
            }
          }
          const room = rooms.get(socket.data.roomCode || socket.data.retiredSeat?.roomCode);
          const player = room && allSeats(room).find((candidate) =>
            candidate.reconnectToken === (socket.data.token || socket.data.retiredSeat?.token));
          if (player) result.nextSequence = nextSequence(room, player.id);
        }
        let delivered = false;
        const deliver = () => {
          if (delivered) return;
          delivered = true;
          if (typeof callback === "function") callback(result);
          else if (!result.ok) socket.emit("requestError", result.error);
        };
        if (options.ackInterceptor) options.ackInterceptor(event, payload, result, deliver, socket);
        else deliver();
      });
    }

    handle("createRoom", (payload) => entry(socket, "createRoom", payload));
    handle("joinRoom", (payload) => entry(socket, "joinRoom", payload));

    handle("reconnectRoom", async ({ reconnectToken, code }) => {
      if (typeof reconnectToken !== "string" || !RESUME_KEY.test(reconnectToken)) {
        throw new RequestError("REJECTED", "Invalid resume key.");
      }
      if (code !== undefined && (typeof code !== "string" || !/^[A-Z]{6}$/.test(code.trim().toUpperCase()))) {
        throw new RequestError("REJECTED", "Enter a six-letter room code.");
      }
      await refreshRooms();
      const existing = findSeat(reconnectToken);
      requireAvailable(existing?.room);
      if (code && existing.room.code !== code.trim().toUpperCase()) {
        throw new RequestError("ROOM_NOT_FOUND", "That resume key does not belong to this room.");
      }
      return enqueue(`room:${existing.room.code}`, async () => {
        const room = await freshRoom(existing.room.code);
        requireAvailable(room);
        return resume(socket, room, allSeats(room).find((player) => player.reconnectToken === reconnectToken));
      });
    });

    handle("startGame", (payload) => mutation(socket, "startGame", payload, (room, actorId) => {
      if (activePlayers(room).some((candidate) => !recipientFor(room, candidate))) {
        throw new Error("Wait for all seated players to reconnect, or remove absent players in the lobby.");
      }
      startGame(room, actorId, random);
    }));

    handle("shuffleMap", (payload) => mutation(socket, "shuffleMap", payload, (room, actorId) => {
      shuffleMap(room, actorId, payload.expectedMapVersion, random);
      return { reply: { mapVersion: room.mapVersion } };
    }));

    handle("gameAction", (action) => mutation(socket, "gameAction", action, (room, actorId) => {
      if (action.expectedTurnNumber !== undefined && action.expectedTurnNumber !== room.turnNumber) {
        throw new RequestError("STALE_TURN", "This action belongs to an earlier or different turn. Review the current turn before acting.");
      }
      if (["respondTrade", "cancelTrade"].includes(action.type) && action.tradeId !== room.trade?.id) {
        throw new Error("This trade offer has changed. Review the new offer.");
      }
      applyAction(room, actorId, action, random);
    }));

    handle("removePlayer", (payload) => mutation(socket, "removePlayer", payload,
      (room, actorId) => removeSeat(room, actorId, payload)));

    handle("requestRemoval", (payload) => mutation(socket, "requestRemoval", payload, (room, actorId) => {
      if (room.phase === "finished") throw new RequestError("REJECTED", "The match is complete. Return home or start a new lobby before requesting removal.");
      if (room.hostId === actorId) throw new RequestError("SUCCESSOR_REQUIRED", "Administrators must choose a successor when leaving.");
      const player = activePlayers(room).find((candidate) => candidate.id === actorId);
      room.removalRequests ||= [];
      if (!room.removalRequests.some((request) => request.playerId === actorId)) {
        room.removalRequests.push({ playerId: actorId, requestedAt: now() });
        appendPublicEvent(room, {
          type: "removal.requested", actorId, message: `${player.name} asked the administrator to approve their departure.`,
          data: { playerId: actorId },
        }, now());
      }
    }));

    handle("cancelRemovalRequest", (payload) => mutation(socket, "cancelRemovalRequest", payload, (room, actorId) => {
      if ((room.removalRequests || []).some((request) => request.playerId === actorId)) {
        room.removalRequests = room.removalRequests.filter((request) => request.playerId !== actorId);
        const player = activePlayers(room).find((candidate) => candidate.id === actorId);
        appendPublicEvent(room, {
          type: "removal.cancelled", actorId, message: `${player.name} cancelled their departure request.`,
          data: { playerId: actorId },
        }, now());
      }
    }));

    handle("declineRemoval", (payload) => mutation(socket, "declineRemoval", payload, (room, actorId) => {
      requireAdmin(room, actorId);
      const player = activePlayers(room).find((candidate) => candidate.id === payload.playerId);
      if (!player || !(room.removalRequests || []).some((request) => request.playerId === player.id)) {
        throw new RequestError("REJECTED", "That player has no pending departure request.");
      }
      room.removalRequests = room.removalRequests.filter((request) => request.playerId !== player.id);
      appendPublicEvent(room, {
        type: "removal.declined", actorId, message: `The administrator declined ${player.name}'s departure request.`,
        data: { playerId: player.id },
      }, now());
    }));

    handle("transferAdmin", (payload) => mutation(socket, "transferAdmin", payload, (room, actorId) => {
      requireAdmin(room, actorId);
      const player = activePlayers(room).find((candidate) => candidate.id === payload.playerId && candidate.id !== actorId);
      if (!player) throw new RequestError("REJECTED", "Choose another active member to become administrator.");
      room.hostId = player.id;
      appendPublicEvent(room, {
        type: "admin.transferred", actorId, message: `Administration was transferred to ${player.name}.`,
        data: { fromPlayerId: actorId, toPlayerId: player.id },
      }, now());
    }));

    handle("getActivity", async ({ beforeSeq, afterSeq, limit = 50 }) => {
      const { room } = session(socket, true);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
          (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) ||
          (afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < 0)) ||
          (beforeSeq !== undefined && afterSeq !== undefined)) {
        throw new RequestError("REJECTED", "Choose an activity limit of 1-100 and one valid sequence cursor.");
      }
      const rows = await storage.listEvents(room.code, { beforeSeq, afterSeq, limit: limit + 1 });
      const hasMore = rows.length > limit;
      const events = rows.slice(0, limit);
      if (afterSeq === undefined) events.reverse();
      return { ok: true, events, hasMore, nextBeforeSeq: hasMore ? events[0]?.seq ?? null : null, latestSeq: room.eventSequence || 0 };
    });

    handle("rematch", (payload) => mutation(socket, "rematch", payload, (original, actorId) => {
      if (original.phase !== "finished" || original.hostId !== actorId) {
        throw new Error("Only the host can start a rematch after victory.");
      }
      const remaining = activePlayers(original);
      if (!remaining.length) throw new Error("A rematch requires at least one remaining player.");
      const { room } = createRoom(remaining[0].name);
      remaining.slice(1).forEach((oldPlayer) => addPlayer(room, oldPlayer.name));
      room.players.forEach((newPlayer, index) => {
        const oldPlayer = remaining[index];
        Object.assign(newPlayer, {
          id: oldPlayer.id, reconnectToken: oldPlayer.reconnectToken, color: oldPlayer.color,
          connected: Boolean(recipientFor(original, oldPlayer)),
          ...(oldPlayer.entry ? { entry: oldPlayer.entry } : {}),
        });
      });
      room.retiredPlayers = [...(original.retiredPlayers || []), ...original.players.filter((candidate) => candidate.resigned)];
      room.removedPlayers = original.removedPlayers || [];
      room.requests = original.requests;
      room.clientSequences = original.clientSequences;
      room.lastReceipts = original.lastReceipts;
      room.eventSequence = original.eventSequence || 0;
      room.eventOutbox = [];
      room.log = original.log;
      room.removalRequests = (original.removalRequests || []).filter((request) => remaining.some((candidate) => candidate.id === request.playerId));
      room.hostId = original.hostId;
      chooseHost(room);
      room.code = original.code;
      room.createdAt = original.createdAt;
      room.revision = original.revision;
      room.mapVersion = original.mapVersion ?? 0;
      ensureMapPreview(room, random);
      appendPublicEvent(room, { type: "game.rematched", actorId, message: "The administrator opened a rematch lobby.", data: {} }, now());
      return { room };
    }));

    handle("resignGame", (payload) => mutation(socket, "resignGame", payload, (room, actorId) => {
      if (room.hostId !== actorId) throw new RequestError("ADMIN_APPROVAL_REQUIRED", "Ask the administrator to approve your departure.");
      return removeSeat(room, actorId, { ...payload, playerId: actorId });
    }));

    socket.on("disconnect", () => {
      if (!socket.data.token || sockets.get(socket.data.token) !== socket.id) return;
      sockets.delete(socket.data.token);
      const original = rooms.get(socket.data.roomCode);
      if (!original) return;
      const departed = original.players.find((candidate) => candidate.reconnectToken === socket.data.token);
      if (departed && !departed.resigned) publishPresence(original, { kind: "leave", reason: "disconnect", playerId: departed.id });
      queueDisconnect(original.code, socket.data.token);
    });
  });

  const cleanup = setInterval(() => {
    if (!initialized || shuttingDown) return;
    enqueue("expiry", expireRooms).catch(() => console.error("Unable to archive expired game rooms."));
  }, 60_000);
  cleanup.unref();
  let closePromise;
  return {
    app, server, io, storage,
    async listen(port = 0, host = "127.0.0.1") {
      try {
        await storage.init();
        await refreshRooms();
        await expireRooms();
        for (const room of await migratePublicDevelopmentHistory(storage)) rooms.set(room.code, room);
        initialized = true;
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, host, resolve);
        });
      } catch (error) {
        initialized = false;
        await storage.close();
        throw error;
      }
      return server.address().port;
    },
    async close() {
      clearInterval(cleanup);
      closePromise ||= (async () => {
        shuttingDown = true;
        await new Promise((resolve) => {
          const deadline = setTimeout(() => {
            for (const connection of connections) connection.destroy();
          }, 1500);
          deadline.unref();
          io.close(() => {
            clearTimeout(deadline);
            resolve();
          });
        });
        await drain();
        await storage.close();
      })();
      await closePromise;
    },
  };
}

if (require.main === module) {
  require("dotenv").config({ quiet: true });
  const gameServer = createGameServer();
  gameServer.listen(Number(process.env.PORT) || 3000, process.env.HOST || "0.0.0.0")
    .then((port) => console.log(`Hearthlands listening on http://localhost:${port}`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      await gameServer.close();
    });
  }
}

module.exports = { createGameServer };
