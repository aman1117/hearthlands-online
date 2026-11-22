"use strict";

// Colonist-style per-move turn timers (values from Colonist's published speed table), configurable per room.
const TIMER_FIELDS = Object.freeze(["setupSettlement", "setupRoad", "roll", "discard", "robber", "turn", "bonus"]);
const TIMER_BOUNDS = Object.freeze({
  setupSettlement: [10, 3600], setupRoad: [5, 3600], roll: [5, 3600], discard: [5, 3600],
  robber: [5, 3600], turn: [10, 3600], bonus: [0, 300],
});
const TIMER_PRESETS = Object.freeze({
  off: null,
  "30": Object.freeze({ setupSettlement: 60, setupRoad: 15, roll: 10, discard: 15, robber: 10, turn: 30, bonus: 5 }),
  "60": Object.freeze({ setupSettlement: 120, setupRoad: 30, roll: 10, discard: 20, robber: 20, turn: 60, bonus: 10 }),
  "120": Object.freeze({ setupSettlement: 180, setupRoad: 45, roll: 20, discard: 40, robber: 40, turn: 120, bonus: 20 }),
  "240": Object.freeze({ setupSettlement: 360, setupRoad: 90, roll: 60, discard: 80, robber: 80, turn: 240, bonus: 60 }),
});
const STAGE_FIELD = Object.freeze({
  setupSettlement: "setupSettlement", setupRoad: "setupRoad", freeRoads: "setupRoad", roll: "roll",
  discard: "discard", robber: "robber", steal: "robber", action: "turn",
});
const BONUS_ACTIONS = new Set(["buildRoad", "buildSettlement", "buildCity", "buyDevelopment", "playDevelopment", "confirmTrade"]);
const MIN_RESUME_MS = 3000;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function normalizeTimerSettings(input) {
  if (!isRecord(input) || typeof input.preset !== "string") throw new Error("Choose a turn timer setting.");
  if (input.preset === "custom") {
    if (!isRecord(input.durations)) throw new Error("Custom timers need a time for every move.");
    const durations = {};
    for (const field of TIMER_FIELDS) {
      const value = input.durations[field];
      const [min, max] = TIMER_BOUNDS[field];
      if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`Custom ${field} time must be a whole number of seconds from ${min} to ${max}.`);
      }
      durations[field] = value;
    }
    return { preset: "custom", durations };
  }
  if (!Object.hasOwn(TIMER_PRESETS, input.preset)) throw new Error("Unknown turn timer setting.");
  return { preset: input.preset };
}
// Rooms saved before timers existed have no setting and stay untimed.
function timerSettings(room) {
  try { return room.turnTimer ? normalizeTimerSettings(room.turnTimer) : { preset: "off" }; }
  catch { return { preset: "off" }; }
}
function timerDurations(room) {
  const settings = timerSettings(room);
  return settings.preset === "custom" ? settings.durations : TIMER_PRESETS[settings.preset];
}
function timerStage(room) {
  if (!room.board || room.winnerId || ["lobby", "finished"].includes(room.phase)) return null;
  const current = room.players?.[room.turnIndex];
  if (!current || current.resigned) return null;
  const own = [current.id];
  switch (room.phase) {
    case "setup": return { kind: room.setupNeedsRoad ? "setupRoad" : "setupSettlement", playerIds: own };
    case "roll": return { kind: room.freeRoadsRemaining ? "freeRoads" : "roll", playerIds: own };
    case "discard": return { kind: "discard", playerIds: Object.keys(room.pendingDiscards || {}) };
    case "robber": return { kind: "robber", playerIds: own };
    case "steal": return { kind: "steal", playerIds: own };
    case "action": return { kind: "action", playerIds: own };
    default: return null;
  }
}
function stageSignature(room, stage = timerStage(room)) {
  return stage ? [stage.kind, room.turnNumber, room.turnIndex, room.turnRole, room.setupRound].join("|") : null;
}
function turnKey(room) {
  return [room.turnNumber, room.turnIndex, room.turnRole].join("|");
}
// Starts a fresh countdown whenever the stage changes. Time left on a turn is banked while a robber/Knight interrupts it.
function syncTimer(room, now) {
  const durations = timerDurations(room);
  const stage = durations && timerStage(room);
  const previous = isRecord(room.timer) ? room.timer : null;
  if (!stage) { room.timer = null; return; }
  const signature = stageSignature(room, stage);
  if (previous?.signature === signature) { previous.playerIds = stage.playerIds; return; }
  const key = turnKey(room);
  let banked = previous?.banked?.turnKey === key ? previous.banked : null;
  if (previous?.kind === "action" && previous.turnKey === key) {
    banked = { turnKey: key, remainingMs: Math.max(0, previous.deadline - now) };
  }
  const full = durations[STAGE_FIELD[stage.kind]] * 1000;
  let ms = full;
  if (stage.kind === "action" && banked) ms = Math.min(full, Math.max(MIN_RESUME_MS, banked.remainingMs + durations.bonus * 1000));
  room.timer = {
    kind: stage.kind, signature, turnKey: key, deadline: now + ms, duration: full, playerIds: stage.playerIds,
    ...(stage.kind !== "action" && banked ? { banked } : {}),
  };
}
// Building and trading earn extra time (capped at a full turn); undoing a placement gives that bonus back.
function adjustTimerAfterAction(room, action, signatureBefore, now) {
  const timer = isRecord(room.timer) ? room.timer : null;
  const durations = timerDurations(room);
  if (!timer || !durations || timer.kind !== "action" || stageSignature(room) !== signatureBefore) return;
  const bonus = durations.bonus * 1000;
  const earned = BONUS_ACTIONS.has(action.type) || (action.type === "respondTrade" && action.accept === true);
  if (earned) timer.deadline = Math.min(timer.deadline + bonus, now + timer.duration);
  else if (action.type === "undoPlacement") timer.deadline = Math.max(now + 1000, timer.deadline - bonus);
}
function publicTurnTimer(room) {
  const settings = timerSettings(room);
  const timer = isRecord(room.timer) && timerDurations(room) ? room.timer : null;
  return {
    preset: settings.preset, durations: timerDurations(room),
    timer: timer ? { kind: timer.kind, deadline: timer.deadline, duration: timer.duration, playerIds: timer.playerIds } : null,
  };
}

module.exports = {
  TIMER_FIELDS, TIMER_BOUNDS, TIMER_PRESETS, normalizeTimerSettings, timerSettings, timerDurations, timerStage,
  stageSignature, syncTimer, adjustTimerAfterAction, publicTurnTimer,
};
