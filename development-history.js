"use strict";

const PROGRESS_TYPES = ["roadBuilding", "yearOfPlenty", "monopoly"];
const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
const emptyProgressCounts = () => Object.fromEntries(PROGRESS_TYPES.map((type) => [type, 0]));
const hasProgressCounts = (player) => player.playedProgressCards &&
  !Array.isArray(player.playedProgressCards) &&
  PROGRESS_TYPES.every((type) => validCount(player.playedProgressCards[type]));
const hasProgressHistory = (player) => hasProgressCounts(player) &&
  typeof player.playedProgressHistoryComplete === "boolean";

function progressCounts(player) {
  return Object.fromEntries(PROGRESS_TYPES.map((type) => [
    type, validCount(player.playedProgressCards?.[type]) ? player.playedProgressCards[type] : 0,
  ]));
}

function recordProgressPlay(player, type) {
  if (!PROGRESS_TYPES.includes(type)) return;
  const counts = progressCounts(player);
  if (!Number.isSafeInteger(counts[type] + 1)) throw new Error("Played development card count is exhausted.");
  const historyComplete = hasProgressCounts(player) && player.playedProgressHistoryComplete === true;
  counts[type] += 1;
  player.playedProgressCards = counts;
  player.playedProgressHistoryComplete = Boolean(historyComplete);
}

function revealedDevelopment(player, finished) {
  return {
    knight: player.knightsPlayed,
    ...progressCounts(player),
    historyComplete: Boolean(hasProgressCounts(player) && player.playedProgressHistoryComplete === true),
    ...(finished ? { victoryPoint: player.developmentCards.filter((card) => card.type === "victoryPoint").length } : {}),
  };
}

async function currentMatchProgress(storage, room) {
  const counts = new Map(room.players.map((player) => [player.id, emptyProgressCounts()]));
  let beforeSeq = room.eventSequence < Number.MAX_SAFE_INTEGER ? room.eventSequence + 1 : undefined;
  let previousSeq = Infinity;
  let expectedSeq = room.eventSequence;
  let complete = true;
  while (true) {
    const events = await storage.listEvents(room.code, { ...(beforeSeq ? { beforeSeq } : {}), limit: 1000 });
    if (!events.length) return { counts, complete: false };
    for (const event of events) {
      if (!Number.isSafeInteger(event.seq) || event.seq <= 0 || event.seq >= previousSeq) {
        throw new Error("Development history pagination is not strictly descending.");
      }
      previousSeq = event.seq;
      if (event.seq !== expectedSeq) complete = false;
      expectedSeq = event.seq - 1;
      if (event.type === "gameStarted" || event.type === "game.rematched") return { counts, complete };
      if (event.type === "legacy") return { counts, complete: false };
      if (event.type !== "developmentPlayed" || !PROGRESS_TYPES.includes(event.data?.cardType)) continue;
      if (typeof event.actorId !== "string") {
        complete = false;
        continue;
      }
      const playerCounts = counts.get(event.actorId);
      if (playerCounts) playerCounts[event.data.cardType] += 1;
    }
    if (events.length < 1000) return { counts, complete: false };
    beforeSeq = events.at(-1).seq;
  }
}

// Startup-only additive migration: no activity event or TTL refresh for a derived public statistic.
async function migratePublicDevelopmentHistory(storage) {
  const migrated = [];
  for (const original of await storage.listRooms()) {
    if (original.archivedAt != null || original.players.every(hasProgressHistory)) continue;
    const room = structuredClone(original);
    const emptyMatch = room.phase === "lobby" || room.phase === "setup";
    const history = emptyMatch ? null : await currentMatchProgress(storage, room);
    for (const player of room.players) {
      if (hasProgressHistory(player)) continue;
      const recorded = history?.counts.get(player.id) || emptyProgressCounts();
      player.playedProgressCards = Object.fromEntries(PROGRESS_TYPES.map((type) => [
        type, validCount(player.playedProgressCards?.[type]) ? player.playedProgressCards[type] : recorded[type],
      ]));
      player.playedProgressHistoryComplete = player.playedProgressHistoryComplete !== false &&
        (emptyMatch || history.complete) && PROGRESS_TYPES.every((type) => player.playedProgressCards[type] === recorded[type]);
    }
    room.revision += 1;
    const saved = await storage.commitRoom(room, { expectedRevision: original.revision });
    migrated.push(saved);
  }
  return migrated;
}

module.exports = { emptyProgressCounts, recordProgressPlay, revealedDevelopment, migratePublicDevelopmentHistory };
