"use strict";

const socket = io({ autoConnect: false });
const RESOURCES = ["wood", "brick", "sheep", "wheat", "ore"];
const COLORS = { wood: "#57704a", brick: "#b75c43", sheep: "#93ad69", wheat: "#d8a94b", ore: "#697373", desert: "#c9af79" };
const CARDS = {
  knight: ["Knight", "Move the robber, then choose an opponent to rob."],
  roadBuilding: ["Road Building", "Place up to two connected roads without paying resources."],
  yearOfPlenty: ["Year of Plenty", "Choose two resources from the available bank supply."],
  monopoly: ["Monopoly", "Take all resources of one type from every opponent."],
  victoryPoint: ["Victory Point", "One hidden point. Revealed automatically when you win."],
};
const COST_LABELS = { road: "1 wood + 1 brick", settlement: "wood + brick + sheep + wheat", city: "2 wheat + 3 ore" };
const COSTS = { road: { wood: 1, brick: 1 }, settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 }, city: { wheat: 2, ore: 3 }, development: { sheep: 1, wheat: 1, ore: 1 } };
const HEX = "0,-100 86.603,-50 86.603,50 0,100 -86.603,50 -86.603,-50";
const art = window.Tabletop;
const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
let state = null;
let selectedAction = null;
let toastTimer;
let busy = false;
let bound = false;
let seat = null;
let draftContext = "";
let selectedCardId = null;
let zoom = 1;
let panzoom = null;
let layoutKey = "";
let audioEnabled = localStorage.getItem("hearthlands-sound") === "on";
let audioContext = null;
let lastTone = 0;
let suppressMapClick = false;
let diceMotion = null;
let diceTimer = null;
let networkStatus = { kind: "connecting", pending: false, bound: false };
let adminRemoveTarget = null;
elements["art-library"].innerHTML = art.defs();
document.querySelectorAll("[data-icon]").forEach((element) => { element.innerHTML = art.icon(element.dataset.icon); });
elements["resource-reference"].innerHTML = GameCards.reference(COSTS);
const presence = new MapPresence({
  socket, svg: elements.board, getState: () => state,
  announce(message) {
    elements["presence-announcement"].textContent = message;
    tone("ping");
  },
});
const activity = new ActivityFeed({ socket, getState: () => state, warn: notify });
const publicCards = new PublicCardsGallery({ getState: () => state });
const nameplates = new PlayerNameplates({
  root: elements.players, openCards: (id) => publicCards.open(id), removePlayer: openRemoval,
});
const discardDialog = new DiscardDialog({
  getState: () => state, isBusy: () => busy, isReady: () => bound,
  submit: (resources) => action({ type: "discard", resources }),
});
const boardPlacement = new BoardPlacement({
  svg: elements.board, getState: () => state, getPlacement: () => state ? placement() : null,
  isReady: () => bound, isBusy: () => busy, isPointing: () => presence.pingMode,
  isDragging: () => suppressMapClick, submit: (payload) => action(payload),
  cancelBuild() { selectedAction = null; renderActions(); renderBoard(); },
  describe: locationLabel, announce: notify,
});
const trading = new TradePanel({
  getState: () => state, isBusy: () => busy, isReady: () => bound,
  submit: (payload) => action(payload), chooseTab: tradeTab,
  bundleInputs, readBundle, bundleText, escape: escapeHtml, notify,
});
const connection = new GameConnection({
  socket,
  onState: applyState,
  onStatus(status) {
    networkStatus = status;
    bound = connection.bound;
    seat = connection.currentSeat || seat;
    if (status.pending && status.action === "roll" && !diceMotion && state && bound) {
      diceMotion = { active: true, started: performance.now(), turn: state.turnNumber, actor: state.viewerId, requestId: status.requestId };
      renderActions();
    }
    elements["connection-status"].textContent = status.text;
    const showBanner = ["offline", "retrying", "replaced", "error"].includes(status.kind);
    elements["network-banner"].classList.toggle("hidden", !showBanner);
    elements["network-message"].textContent = status.text;
    elements["retry-connection"].classList.toggle("hidden", status.kind === "replaced");
    document.body.classList.toggle("seat-unavailable", status.kind === "replaced");
    document.body.classList.toggle("connection-lost", Boolean(state) && !bound);
    updateBusy();
    settleConfirmedDice();
    if (status.kind === "replaced" && diceMotion) { resetDice(); if (state) renderActions(); }
    if (state) refreshAdminButtons();
    elements["cancel-resign"].disabled = status.pending && ["resignGame", "requestRemoval"].includes(status.operation);
    elements["admin-remove-cancel"].disabled = status.pending && status.operation === "removePlayer";
    elements["admin-transfer-cancel"].disabled = status.pending && status.operation === "transferAdmin";
    document.querySelectorAll(".dialog-network-status").forEach((node) => { node.textContent = status.pending || !bound ? status.text : ""; });
  },
  onSeats: renderSavedSeats,
  onError(message) {
    notify(message);
    if (!state) elements["landing-error"].textContent = message;
  },
  onRetired(event) {
    elements["resign-dialog"].close();
    elements["admin-remove-dialog"].close();
    elements["admin-transfer-dialog"].close();
    activity.clear();
    discardDialog.reset();
    publicCards.close();
    boardPlacement.reset();
    trading.reset();
    presence.clear();
    resetDice();
    state = null;
    bound = false;
    GameControls.close(false);
    elements.game.classList.add("hidden");
    elements.landing.classList.remove("hidden");
    elements["network-banner"].classList.add("hidden");
    notify(event.removed ? "The admin removed your lobby seat." : "Your seat was removed. Holdings were returned so the remaining players can continue.");
  },
});
elements["toggle-pointers"].setAttribute("aria-pressed", String(presence.enabled));
renderWelcomeMap();
updateSoundButton();

function notify(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 4500);
}

async function send(event, payload = {}) {
  const reply = ["createRoom", "joinRoom"].includes(event)
    ? await connection.enter(event, payload)
    : await connection.submit(event, payload);
  seat = connection.currentSeat || seat;
  return reply?.ok ? reply : null;
}

async function action(payload) {
  if (!["setupSettlement", "setupRoad", "buildRoad", "buildSettlement", "buildCity", "moveRobber"].includes(payload.type)) boardPlacement.reset();
  const id = requestId();
  const roll = payload.type === "roll" ? beginDiceRoll(id) : null;
  const result = await send("gameAction", { ...payload, requestId: id });
  if (roll) await finishDiceRoll(roll, Boolean(result));
  if (result) {
    selectedAction = null;
    render();
  }
  return result;
}

function requestId() {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, "0")).join("");
}

function name() {
  const value = elements["player-name"].value.trim();
  if (!value) { elements["landing-error"].textContent = "Enter your name first."; return null; }
  localStorage.setItem("hearthlands-name", value);
  return value;
}

elements["player-name"].value = localStorage.getItem("hearthlands-name") || "";
const invite = new URLSearchParams(location.search).get("room");
if (invite) elements["room-code"].value = invite.toUpperCase().slice(0, 6);

elements["create-room"].onclick = async () => {
  const playerName = name();
  if (playerName) await send("createRoom", { name: playerName });
};
elements["join-room"].onclick = async () => {
  const playerName = name();
  if (!playerName) return;
  const code = elements["room-code"].value.trim().toUpperCase();
  const saved = connection.savedSeats().find((item) => item.roomCode === code && item.status !== "retired" && item.name?.toLowerCase() === playerName.toLowerCase());
  if (saved) await resume(saved);
  else await send("joinRoom", { name: playerName, code });
};
elements["room-code"].onkeydown = (event) => { if (event.key === "Enter") elements["join-room"].click(); };
elements["resume-game"].onclick = () => resume(connection.savedSeats().find((item) => item.status === "active"));
elements["import-session"].onclick = () => resume({ reconnectToken: elements["resume-key"].value.trim() });
elements["start-game"].onclick = () => send("startGame");
elements["shuffle-map"].onclick = () => send("shuffleMap", { requestId: requestId(), expectedMapVersion: state.mapVersion ?? 0 });
elements.rematch.onclick = () => send("rematch");
elements["end-turn"].onclick = () => action({ type: "endTurn" });
elements["buy-development"].onclick = () => action({ type: "buyDevelopment" });
elements["rules-button"].onclick = () => {
  elements["rules-dialog"].showModal();
  elements["rules-dialog"].scrollTop = 0;
};
elements["show-resource-guide"].onclick = () => {
  const heading = elements["resource-reference"].querySelector("h3");
  heading.tabIndex = -1;
  heading.focus();
  heading.scrollIntoView({ block: "start" });
};
elements["show-development-guide"].onclick = () => {
  elements["development-reference-title"].focus();
  elements["development-reference"].scrollIntoView({ block: "start" });
};
elements["close-rules"].onclick = () => elements["rules-dialog"].close();
elements["close-development"].onclick = () => elements["development-dialog"].close();
elements["retry-connection"].onclick = () => connection.retryNow();
elements["resign-game"].onclick = () => {
  if (!state || !(isAdmin() ? legal().canResign : legal().canRequestRemoval) || state.phase === "finished" || busy || !bound) return;
  elements["resign-confirmed"].checked = false;
  GameControls.reset("successor-choice");
  const admin = isAdmin();
  elements["resign-title"].textContent = admin ? "Hand over admin and leave?" : "Ask the admin to remove you?";
  elements["resign-eyebrow"].textContent = admin ? "EXPLICIT ADMIN SUCCESSION" : "REMOVAL REQUEST";
  elements["resign-explanation"].textContent = admin ? "Choose the next admin before leaving. Your removal and the handover happen together."
    : `Your seat and holdings remain until ${player(state.hostId)?.name || "the admin"} approves. You can cancel the request.`;
  elements["resign-confirmation-label"].textContent = admin ? "I confirm the handover and permanent removal of my seat." : "I want the admin to remove my seat.";
  elements["confirm-resign"].textContent = admin ? "Hand over & leave" : "Request removal";
  elements["successor-field"].classList.toggle("hidden", !admin);
  elements["successor-field"].innerHTML = admin ? `${GameControls.playerPicker("successor-choice", "Select the next admin", adminCandidates(), { selected: "", onChange: refreshAdminButtons })}<p>An offline successor remains admin; admin actions wait until they reconnect.</p>` : "";
  renderResignSummary();
  refreshAdminButtons();
  elements["resign-dialog"].showModal();
};
elements["resign-confirmed"].onchange = refreshAdminButtons;
elements["cancel-resign"].onclick = () => elements["resign-dialog"].close();
elements["confirm-resign"].onclick = async () => {
  if (!elements["resign-confirmed"].checked) return;
  const result = isAdmin() ? await send("resignGame", { confirmed: true, successorId: GameControls.read("successor-choice") }) : await send("requestRemoval");
  if (result) elements["resign-dialog"].close();
};
elements["cancel-removal-request"].onclick = () => send("cancelRemovalRequest");
elements["transfer-admin"].onclick = () => {
  if (!isAdmin()) return;
  GameControls.reset("admin-transfer-choice");
  elements["admin-transfer-choices"].innerHTML = GameControls.playerPicker("admin-transfer-choice", "Choose another active player", adminCandidates(), { selected: "", onChange: refreshAdminButtons });
  refreshAdminButtons();
  elements["admin-transfer-dialog"].showModal();
};
elements["admin-transfer-cancel"].onclick = () => elements["admin-transfer-dialog"].close();
elements["admin-transfer-confirm"].onclick = async () => {
  const result = await send("transferAdmin", { playerId: GameControls.read("admin-transfer-choice") });
  if (result) elements["admin-transfer-dialog"].close();
};
elements["admin-remove-checked"].onchange = refreshAdminButtons;
elements["admin-remove-cancel"].onclick = () => elements["admin-remove-dialog"].close();
elements["admin-remove-confirm"].onclick = async () => {
  if (!elements["admin-remove-checked"].checked) return;
  const result = await send("removePlayer", { playerId: adminRemoveTarget, confirmed: true });
  if (result) elements["admin-remove-dialog"].close();
};
elements["toggle-pointers"].onclick = () => {
  presence.setEnabled(!presence.enabled);
  elements["toggle-pointers"].setAttribute("aria-pressed", String(presence.enabled));
  notify(presence.enabled ? "Shared cursors on. Friends can see you pointing on the map." : "Shared cursors off. Click-to-ping remains available.");
};
elements["ping-mode"].onclick = () => setPointMode(!presence.pingMode);
elements["sound-toggle"].onclick = async () => {
  audioEnabled = !audioEnabled;
  try {
    if (audioEnabled) await prepareAudio();
    else if (audioContext) await audioContext.suspend();
  } catch (error) {
    audioEnabled = false;
    notify(`Sound is unavailable: ${error.message}`);
  }
  localStorage.setItem("hearthlands-sound", audioEnabled ? "on" : "off");
  updateSoundButton();
  tone("turn");
};
document.addEventListener("pointerdown", () => {
  if (!audioEnabled) return;
  prepareAudio().catch((error) => {
    audioEnabled = false;
    localStorage.setItem("hearthlands-sound", "off");
    updateSoundButton();
    notify(`Sound is unavailable: ${error.message}`);
  });
}, { once: true });
elements["fullscreen-toggle"].onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await elements.game.requestFullscreen();
  } catch (error) { notify(`Fullscreen is not available: ${error.message}`); }
};
document.addEventListener("fullscreenchange", () => {
  elements["fullscreen-toggle"].setAttribute("aria-label", document.fullscreenElement ? "Exit fullscreen" : "Enter fullscreen");
});
document.addEventListener("keydown", (event) => {
  if (!state || event.target.closest("input, textarea, [role=combobox], [role=radio], [contenteditable], .choice-popup, dialog[open]")) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (boardPlacement.selection) boardPlacement.cancel();
    else boardPlacement.undo();
    return;
  }
  if (event.ctrlKey || event.metaKey) return;
  if (event.key.toLowerCase() === "p") { event.preventDefault(); setPointMode(!presence.pingMode); }
  if (event.key === "Escape") { boardPlacement.cancel(); setPointMode(false); }
});
elements["copy-code"].onclick = () => copy(state.code, "Room code");
elements["copy-invite"].onclick = () => copy(`${location.origin}/?room=${state.code}`, "Invite link");
elements["copy-resume"].onclick = () => copy(seat.reconnectToken, "Private resume key - do not share this");
elements["leave-screen"].onclick = () => {
  presence.leave();
  presence.clear();
  activity.clear();
  discardDialog.reset();
  publicCards.close();
  boardPlacement.reset();
  trading.reset();
  connection.pause();
  resetDice();
  state = null;
  bound = false;
  GameControls.close(false);
  elements.game.classList.add("hidden");
  elements.landing.classList.remove("hidden");
  elements["network-banner"].classList.add("hidden");
  notify("Saved for later. Your seat and holdings have not been surrendered.");
};

async function copy(value, label) {
  try {
    if (!navigator.clipboard) throw new Error("Clipboard requires HTTPS or localhost.");
    await navigator.clipboard.writeText(value);
    notify(`${label} copied.`);
  } catch (error) {
    notify(error.message);
    elements["resume-key"].value = value;
    if (state) {
      const dialog = elements["development-dialog"];
      elements["development-title"].textContent = label;
      elements["development-options"].innerHTML = `<label for="copy-value">Select and copy</label><input id="copy-value" readonly value="${escapeHtml(value)}">`;
      elements["play-development"].classList.add("hidden");
      dialog.showModal();
      document.querySelector("#copy-value").select();
    }
  }
}

async function resume(saved) {
  if (!saved) return;
  presence.leave();
  presence.clear();
  activity.clear();
  discardDialog.reset();
  publicCards.close();
  boardPlacement.reset();
  trading.reset();
  GameControls.close(false);
  resetDice();
  state = null;
  elements.game.classList.add("hidden");
  elements.landing.classList.remove("hidden");
  await connection.resume(saved);
}

function applyState(next) {
  const previous = state;
  state = next;
  seat = connection.currentSeat;
  bound = true;
  if (state.currentPlayerId === state.viewerId && (!previous || previous.currentPlayerId !== state.currentPlayerId ||
      previous.turnNumber !== state.turnNumber ||
      ((["setup", "robber"].includes(state.phase) || state.freeRoadsRemaining) &&
        (previous.phase !== state.phase || previous.setupNeedsRoad !== state.setupNeedsRoad || previous.freeRoadsRemaining !== state.freeRoadsRemaining)))) {
    presence.setPingMode(false);
    elements["ping-mode"].setAttribute("aria-pressed", "false");
  }
  if (diceMotion && (diceMotion.turn !== state.turnNumber || diceMotion.actor !== state.currentPlayerId)) resetDice();
  document.body.classList.remove("seat-unavailable");
  elements["landing-error"].textContent = "";
  elements.landing.classList.add("hidden");
  elements.game.classList.remove("hidden");
  if (state.phase === "finished") {
    elements["development-dialog"].close();
    elements["resign-dialog"].close();
  }
  presence.update(state);
  render();
  activity.update(state);
  if (previous?.phase === "robber" && previous.currentPlayerId === state.viewerId &&
      ["roll", "action"].includes(state.phase) && state.log.at(-1)?.type === "robberMoved") {
    notify("No eligible opponent on that hex had a resource to steal.");
  }
  settleConfirmedDice();
  const newTurn = next.currentPlayerId === next.viewerId &&
    (!previous || previous.currentPlayerId !== next.currentPlayerId || previous.turnNumber !== next.turnNumber);
  if (newTurn && !["lobby", "finished"].includes(next.phase)) tone("turn");
  document.title = `${mine() && state.phase !== "finished" ? "Your turn · " : ""}Hearthlands Online`;
}
connection.start();

function renderSavedSeats(seats) {
  const active = seats.filter((item) => item.status === "active");
  elements["saved-games-section"].classList.toggle("hidden", seats.length === 0);
  elements["resume-game"].classList.toggle("hidden", !active.length);
  elements["saved-games"].innerHTML = seats.map((item) => `<article class="saved-seat ${item.status === "retired" ? "retired" : ""}">
    <div><strong>${escapeHtml(item.roomCode)}</strong><span>${escapeHtml(item.name || "Player")}</span><small>${item.status === "retired" ? "Resigned permanently" : item.pending ? "Action awaiting confirmation" : item.status === "unavailable" ? "Currently unavailable — retry to check" : `${item.phase === "finished" ? "Finished" : item.phase === "lobby" ? "Lobby" : "In progress"}${item.playerCount ? ` · ${item.playerCount} players` : ""} · ${new Date(item.lastUsed || Date.now()).toLocaleDateString()}`}</small></div>
    <button class="secondary-button" data-resume-player="${item.playerId || ""}" data-room="${item.roomCode}" ${item.status === "retired" ? "disabled" : ""}>${item.status === "retired" ? "Resigned" : "Resume"}</button></article>`).join("");
  elements["saved-games"].querySelectorAll("[data-room]").forEach((button) => {
    button.onclick = () => resume(connection.savedSeats().find((item) => item.roomCode === button.dataset.room && (item.playerId || "") === button.dataset.resumePlayer));
  });
}

function updateBusy() {
  busy = networkStatus.pending || (!bound && networkStatus.kind === "connecting" && Boolean(connection.currentSeat)) || Boolean(diceMotion?.active);
  document.body.classList.toggle("request-pending", busy);
  elements.game.setAttribute("aria-busy", String(busy));
  discardDialog.refresh();
  boardPlacement.controls();
  trading.refresh();
}
function beginDiceRoll(id) {
  if (!state || !bound || busy) return null;
  const motion = { active: true, started: performance.now(), turn: state.turnNumber, actor: state.viewerId, requestId: id };
  diceMotion = motion;
  updateBusy();
  renderActions();
  return motion;
}
function settleConfirmedDice() {
  if (!state || !diceMotion?.active || connection.pending) return;
  const outcome = connection.record()?.lastOutcome;
  if (!outcome || outcome.requestId !== diceMotion.requestId) return;
  if (!outcome.ok || state.dice) finishDiceRoll(diceMotion, Boolean(outcome.ok && state.dice));
}
async function finishDiceRoll(motion, success) {
  if (diceMotion !== motion || motion.finishing) return;
  motion.finishing = true;
  if (success && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 650 - (performance.now() - motion.started))));
  }
  if (diceMotion !== motion) return;
  diceMotion = success ? { ...motion, active: false, settled: true } : null;
  updateBusy();
  if (state) renderActions();
  clearTimeout(diceTimer);
  diceTimer = setTimeout(() => {
    if (diceMotion?.started === motion.started) { diceMotion = null; if (state) renderActions(); }
  }, 350);
}
function resetDice() {
  clearTimeout(diceTimer);
  diceMotion = null;
  updateBusy();
}
function renderResignSummary() {
  if (!state) return;
  const self = me();
  elements["resign-summary"].innerHTML = `<span><strong>${self.resourceCount}</strong> resources</span><span><strong>${self.developmentCount}</strong> unplayed cards</span><span><strong>${15 - self.roadsLeft}</strong> roads</span><span><strong>${5 - self.settlementsLeft}</strong> settlements</span><span><strong>${4 - self.citiesLeft}</strong> cities</span>`;
}
function isAdmin() { return Boolean(state && state.hostId === state.viewerId); }
function adminCandidates() {
  return state.players.filter((p) => p.id !== state.viewerId).map((p) => ({ ...p, name: `${p.name}${p.connected ? "" : " (offline)"}` }));
}
function validSuccessor(id) { return state?.players.some((p) => p.id === id && p.id !== state.viewerId); }
function refreshAdminButtons() {
  if (!state) return;
  elements["confirm-resign"].disabled = !elements["resign-confirmed"].checked || !bound || busy ||
    (isAdmin() && !validSuccessor(GameControls.read("successor-choice")));
  elements["admin-remove-confirm"].disabled = !elements["admin-remove-checked"].checked || !isAdmin() || !bound || busy ||
    !state.players.some((p) => p.id === adminRemoveTarget && p.id !== state.viewerId);
  elements["admin-transfer-confirm"].disabled = !isAdmin() || !bound || busy || !validSuccessor(GameControls.read("admin-transfer-choice"));
}
function openRemoval(playerId) {
  if (!isAdmin() || playerId === state.viewerId) return;
  const target = player(playerId);
  if (!target) return;
  adminRemoveTarget = playerId;
  elements["admin-remove-title"].textContent = `Remove ${target.name}?`;
  elements["admin-remove-details"].textContent = state.phase === "lobby" ? "This player will lose their lobby seat." :
    `${target.resourceCount} resources, ${target.developmentCount} unplayed development cards, ${15 - target.roadsLeft} roads, ${5 - target.settlementsLeft} settlements, and ${4 - target.citiesLeft} cities will be returned or removed.`;
  elements["admin-remove-checked"].checked = false;
  refreshAdminButtons();
  elements["admin-remove-dialog"].showModal();
}
function renderAdmin() {
  const requests = (state.removalRequests || []).filter((request) => player(request.playerId));
  const requested = requests.some((request) => request.playerId === state.viewerId);
  elements["resign-game"].textContent = isAdmin() ? "Leave & hand over admin" : "Request removal";
  elements["resign-game"].classList.toggle("hidden", !(isAdmin() ? legal().canResign : legal().canRequestRemoval) || requested || state.phase === "finished");
  elements["cancel-removal-request"].classList.toggle("hidden", !requested);
  elements["transfer-admin"].classList.toggle("hidden", !isAdmin() || state.players.length < 2);
  elements["admin-panel"].classList.toggle("hidden", !isAdmin() || !requests.length || state.phase === "finished");
  elements["admin-requests"].innerHTML = isAdmin() ? requests.map((request) => `<article class="admin-request"><p><strong>${escapeHtml(player(request.playerId).name)}</strong> asked to leave.</p><div class="admin-request-actions"><button class="secondary-button" data-approve-removal="${request.playerId}">Review removal</button><button class="text-button" data-decline-removal="${request.playerId}">Decline</button></div></article>`).join("") : "";
  elements["admin-requests"].querySelectorAll("[data-approve-removal]").forEach((button) => { button.onclick = () => openRemoval(button.dataset.approveRemoval); });
  elements["admin-requests"].querySelectorAll("[data-decline-removal]").forEach((button) => { button.onclick = () => send("declineRemoval", { playerId: button.dataset.declineRemoval }); });
  if (!isAdmin()) {
    elements["admin-remove-dialog"].close();
    elements["admin-transfer-dialog"].close();
  }
  if (elements["resign-dialog"].open && isAdmin()) {
    elements["successor-field"].innerHTML = `${GameControls.playerPicker("successor-choice", "Select the next admin", adminCandidates(), { selected: "", onChange: refreshAdminButtons })}<p>An offline successor remains admin; admin actions wait until they reconnect.</p>`;
  }
  if (elements["admin-transfer-dialog"].open && isAdmin()) {
    elements["admin-transfer-choices"].innerHTML = GameControls.playerPicker("admin-transfer-choice", "Choose another active player", adminCandidates(), { selected: "", onChange: refreshAdminButtons });
  }
  if (elements["admin-remove-dialog"].open && !player(adminRemoveTarget)) elements["admin-remove-dialog"].close();
  refreshAdminButtons();
}

document.querySelectorAll(".trade-tab").forEach((button) => {
  button.onclick = () => tradeTab(button.dataset.tab);
});
function tradeTab(tabName) {
  document.querySelectorAll(".trade-tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tabName));
  elements["bank-trade"].classList.toggle("hidden", tabName !== "bank");
  elements["player-trade"].classList.toggle("hidden", tabName !== "player");
}
elements["zoom-in"].onclick = () => panzoom?.zoom(Math.min(3, panzoom.getScale() + .25), { animate: !matchMedia("(prefers-reduced-motion: reduce)").matches });
elements["zoom-out"].onclick = () => panzoom?.zoom(Math.max(1, panzoom.getScale() - .25), { animate: !matchMedia("(prefers-reduced-motion: reduce)").matches });
elements["zoom-reset"].onclick = () => panzoom?.reset({ animate: false });

function updateSoundButton() {
  elements["sound-toggle"].setAttribute("aria-pressed", String(audioEnabled));
  elements["sound-toggle"].setAttribute("aria-label", audioEnabled ? "Mute sound" : "Enable sound");
}
async function prepareAudio() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) throw new Error("This browser does not support game audio.");
  audioContext ||= new Context();
  await audioContext.resume();
}
function tone(kind) {
  if (!audioEnabled || !audioContext || audioContext.state !== "running" || Date.now() - lastTone < 350) return;
  lastTone = Date.now();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(kind === "ping" ? 660 : 440, audioContext.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(kind === "ping" ? 880 : 660, audioContext.currentTime + .13);
  gain.gain.setValueAtTime(.0001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(.055, audioContext.currentTime + .015);
  gain.gain.exponentialRampToValueAtTime(.0001, audioContext.currentTime + .25);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + .26);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
}
function setPointMode(enabled) {
  if (enabled) boardPlacement.reset();
  presence.setPingMode(enabled);
  elements["ping-mode"].setAttribute("aria-pressed", String(enabled));
  renderActions();
  renderBoard();
}
function initPanzoom() {
  if (panzoom) return;
  const surface = elements["map-transform"];
  const pointers = new Map();
  surface.addEventListener("pointerdown", (event) => {
    if (!pointers.size) suppressMapClick = false;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size > 1) suppressMapClick = true;
  }, true);
  document.addEventListener("pointermove", (event) => {
    const origin = pointers.get(event.pointerId);
    if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 7) suppressMapClick = true;
  }, true);
  document.addEventListener("pointerup", (event) => pointers.delete(event.pointerId), true);
  document.addEventListener("pointercancel", (event) => { pointers.delete(event.pointerId); suppressMapClick = true; }, true);
  window.addEventListener("blur", () => { pointers.clear(); suppressMapClick = true; });
  surface.addEventListener("click", (event) => {
    if (suppressMapClick) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  panzoom = Panzoom(surface, {
    minScale: 1, maxScale: 3, contain: "outside", panOnlyWhenZoomed: true,
    excludeClass: "map-control", cursor: "default", duration: 180,
    handleStartEvent(event) { if (!presence.pingMode && !event.altKey && !event.target.closest("[data-place]")) event.preventDefault(); },
  });
  surface.addEventListener("panzoomchange", (event) => {
    zoom = event.detail.scale;
    elements["zoom-reset"].textContent = `${Math.round(zoom * 100)}%`;
    requestAnimationFrame(() => { presence.refreshPosition(); boardPlacement.render(); });
  });
  elements["map-scroll"].addEventListener("wheel", (event) => {
    if (event.ctrlKey || event.metaKey) { event.preventDefault(); panzoom.zoomWithWheel(event); }
  }, { passive: false });
  const resize = new ResizeObserver(() => {
    const position = panzoom.getPan();
    panzoom.pan(position.x, position.y, { force: true });
    requestAnimationFrame(() => { presence.refreshPosition(); boardPlacement.render(); });
  });
  resize.observe(elements["map-scroll"]);
}

function me() { return state.players.find((player) => player.id === state.viewerId); }
function player(id) { return state.players.find((candidate) => candidate.id === id); }
function mine() { return state.currentPlayerId === state.viewerId; }
function legal() { return state.legal || {}; }
function list(key) { return legal()[key] || []; }

function render() {
  if (!state) return;
  const context = `${state.phase}:${state.currentPlayerId}:${state.trade?.id || ""}:${state.freeRoadsRemaining}`;
  const draft = context === draftContext ? [...elements.game.querySelectorAll("input[id]")].filter((node) => node.type !== "checkbox" && !node.closest("#player-trade")).map((node) => [node.id, node.value]) : [];
  draftContext = context;
  if (!mine() || !["action", "roll"].includes(state.phase)) selectedAction = null;
  elements.game.dataset.phase = state.phase;
  elements["copy-code"].textContent = state.code;
  renderPlayers();
  renderAdmin();
  renderBanner();
  renderLobby();
  renderHand();
  renderRequired();
  renderActions();
  renderDevelopment();
  renderTrade();
  renderBoard();
  renderLog();
  for (const [id, value] of draft) {
    const element = document.getElementById(id);
    if (element) element.value = value;
  }
  updateBankLabel();
  GameControls.syncCounters();
  updateDiscardCount();
  if (elements["resign-dialog"].open) renderResignSummary();
  if (elements["development-dialog"].open) updateDevelopmentChoice();
  publicCards.update();
}

function renderPlayers() {
  elements["connected-count"].textContent = `${state.players.filter((p) => p.connected).length}/${state.players.length}`;
  elements["connected-count"].setAttribute("aria-label", `${state.players.filter((p) => p.connected).length} of ${state.players.length} players online`);
  nameplates.render(state, isAdmin());
  elements["start-game"].classList.toggle("hidden", state.phase !== "lobby" || state.hostId !== state.viewerId);
  elements["start-game"].disabled = state.players.length < 3 || state.players.some((p) => !p.connected);
  elements["start-game"].textContent = state.players.length < 3 ? `Invite ${3 - state.players.length} more players`
    : state.players.some((p) => !p.connected) ? "Waiting for reconnections" : `Begin with ${state.players.length} players`;
  elements.rematch.classList.toggle("hidden", state.phase !== "finished" || state.hostId !== state.viewerId);
  const departed = state.departedPlayers || [];
  elements["departed-players"].classList.toggle("hidden", !departed.length);
  elements["departed-players"].innerHTML = departed.length ? `<h3>Resigned</h3>${departed.map((p) => `<span><i class="seat-chip" style="--seat-color:${p.color}"></i>${escapeHtml(p.name)}</span>`).join("")}` : "";
}

function renderLobby() {
  const lobby = state.phase === "lobby";
  elements["lobby-controls"].classList.toggle("hidden", !lobby);
  elements["lobby-footer"].classList.toggle("hidden", !lobby);
  elements["map-variant"].textContent = state.board ? `${state.board.tiles.length}-hex ${state.board.tiles.length > 19 ? "expanded" : "classic"} island${lobby ? " · Lobby preview" : ""}` : "Preparing the island";
  if (!lobby) return;
  const offline = state.players.filter((p) => !p.connected);
  const needed = Math.max(0, 3 - state.players.length);
  const host = player(state.hostId);
  const hostIsMe = state.hostId === state.viewerId;
  elements["lobby-status"].textContent = needed ? `${needed} more ${needed === 1 ? "friend" : "friends"} needed. Invite up to six players to your private table.`
    : offline.length ? `Waiting for ${offline.map((p) => p.name).join(", ")} to reconnect. Every seated player must be online before starting.`
    : hostIsMe ? "Everyone is here. Find an island you love, then let the game begin."
    : `${host.name} will start the game. Explore the island and point out your favourite spots.`;
  elements["lobby-status"].classList.toggle("waiting", Boolean(needed || offline.length));
  elements["shuffle-map"].disabled = !legal().canShuffleMap;
  elements["shuffle-note"].textContent = hostIsMe ? "Shuffle as often as you like. Starting locks this exact island."
    : `Only ${host.name} can shuffle. Everyone sees the same preview.`;
  elements["map-summary"].innerHTML = RESOURCES.map((r) => `<span title="${r} tiles">${art.icon(r)}${state.board?.tiles.filter((tile) => tile.resource === r).length || 0} tiles</span>`).join("");
}

function renderBanner() {
  const current = player(state.currentPlayerId);
  const descriptions = { setup: state.setupNeedsRoad ? "place a starting road" : "place a starting settlement", roll: "roll or play a development card", action: state.freeRoadsRemaining ? "place free roads" : "trade and build", discard: "players choose discards", robber: "move the robber", steal: "choose an opponent to rob" };
  elements["turn-banner"].textContent = state.phase === "lobby"
    ? `${state.players.filter((p) => p.connected).length} connected · ${state.players.length}/6 seats filled`
    : state.winnerId ? `${player(state.winnerId).name} wins!`
    : `${current?.name}: ${descriptions[state.phase] || state.phase}${state.turnRole === "secondary" ? " (paired turn)" : ""}`;
  elements["turn-banner"].classList.toggle("your-turn", mine() && !["lobby", "finished"].includes(state.phase));
  const guideVisible = !["lobby", "finished"].includes(state.phase);
  elements["turn-guide"].classList.toggle("hidden", !guideVisible);
  if (guideVisible) {
    elements["turn-eyebrow"].textContent = mine() ? state.turnRole === "secondary" ? "YOUR PAIRED TURN" : "YOUR TURN" : `${current?.name}'S TURN`;
    elements["turn-title"].textContent = state.phase === "setup"
      ? state.setupNeedsRoad ? "Place a starting road" : `Place settlement ${state.setupRound + 1} of 2`
      : state.phase === "roll" ? "Roll for production"
      : state.phase === "discard" ? "Discard resources"
      : state.phase === "robber" ? "Move the robber"
      : state.phase === "steal" ? "Choose who to rob"
      : state.freeRoadsRemaining ? `${state.freeRoadsRemaining} free roads remaining` : mine() ? "Trade, build, or play a card" : "Waiting for your turn";
    elements["turn-help"].textContent = !mine() && state.phase !== "discard" ? "You can explore, point, and plan while your friend takes their turn."
      : state.phase === "setup" ? state.setupNeedsRoad ? "Click a glowing path beside your settlement. Your starting road is free." : "Click a glowing junction where hex corners meet. Starting settlements are free."
      : state.phase === "roll" ? "Roll the dice, or play one older development card first."
      : state.turnRole === "secondary" && state.phase === "action" ? "Build, use development cards, or trade with the bank. No player trades or second roll."
      : state.phase === "action" ? "Build your network, negotiate a trade, or invest in a development card."
      : "Follow the highlighted choices below. The table waits until everyone is ready.";
    const steps = state.phase === "setup" ? ["Settlement", "Road", "Next player"] : ["Roll", "Trade & build", "End turn"];
    const activeStep = state.phase === "setup" ? Number(state.setupNeedsRoad) : Number(state.phase !== "roll");
    elements["phase-steps"].innerHTML = steps.map((step, i) => `<span class="${i === activeStep ? "active" : ""}">${i + 1}. ${step}</span>`).join("");
  }
  elements["winner-panel"].classList.toggle("hidden", state.phase !== "finished");
  if (state.phase === "finished") {
    const winner = player(state.winnerId);
    const explanation = state.winReason === "last-player" ? "All other players resigned. The last remaining player wins."
      : state.winReason === "abandoned" ? "No players remain in this game."
      : "10 or more victory points on their own turn. All victory cards are revealed.";
    elements["winner-panel"].innerHTML = `<p class="eyebrow">GAME COMPLETE</p><h2>${winner ? `${escapeHtml(winner.name)} wins` : "Game ended"}</h2><p>${explanation}</p>${[...state.players].sort((a, b) => b.points - a.points).map((p) => `<p>${escapeHtml(p.name)}: <strong>${p.points} points</strong></p>`).join("")}`;
  }
}

function renderHand() {
  const self = me();
  elements["hand-section"].classList.toggle("hidden", state.phase === "lobby");
  elements["hand-total"].textContent = `${self.resourceCount} cards`;
  elements.resources.innerHTML = RESOURCES.map((resource, i) => GameCards.resource(resource, self.resources[resource], i)).join("");
  elements["bank-status"].classList.toggle("hidden", state.phase === "lobby");
  elements["bank-status"].innerHTML = state.bank ? `<h2>Island supply</h2><div class="bank-grid">${RESOURCES.map((r) => `<span class="bank-resource" title="${state.bank[r]} ${r} in the bank">${art.icon(r)}<strong>${state.bank[r]}</strong></span>`).join("")}</div>` : "";
  elements["piece-supply"].textContent = `${self.roadsLeft} roads · ${self.settlementsLeft} homes · ${self.citiesLeft} cities`;
}

function renderRequired() {
  const required = elements["required-action"];
  const discardCount = state.pendingDiscards?.[state.viewerId] || 0;
  const waiting = Object.entries(state.pendingDiscards || {}).filter(([, count]) => count > 0);
  discardDialog.update(state);
  required.classList.toggle("hidden", !discardCount && state.phase !== "discard" && !(mine() && ["robber", "steal"].includes(state.phase)));
  if (discardCount) {
    required.innerHTML = `<h2>Return ${discardCount} resources</h2><p>You have ${me().resourceCount} resource cards. Choose ${discardCount} to return and keep ${me().resourceCount - discardCount}. Development cards stay with you.</p><button id="choose-discard" class="primary-button">Choose cards to return</button>`;
    document.querySelector("#choose-discard").onclick = () => discardDialog.open();
  } else if (state.phase === "discard") {
    required.innerHTML = `<h2>${discardDialog.completedTurn === state.turnNumber ? "Your cards are returned" : "No cards to return"}</h2><p>${discardDialog.completedTurn === state.turnNumber ? "Your selection was confirmed." : `You hold ${me().resourceCount} resources, so you keep them all.`} The robber waits for:</p><ul class="discard-waiting">${waiting.map(([id, count]) => `<li><span>${escapeHtml(player(id).name)}</span><b>${count} cards</b></li>`).join("")}</ul>`;
  } else if (mine() && state.phase === "steal") {
    required.innerHTML = `<h2>Choose an opponent</h2><p>Steal one random <strong>resource</strong> card from a player on this hex. Development cards cannot be stolen.</p><div class="victim-choices">${(state.robberVictims || []).map((id) => `<button class="steal-target" data-target="${id}" style="--victim-color:${player(id).color}" aria-label="Steal one random resource from ${escapeHtml(player(id).name)}"><span class="victim-card-backs" aria-hidden="true"><i></i><i></i><i></i></span><span><strong>${escapeHtml(player(id).name)}</strong><small>${player(id).resourceCount} resource cards</small></span><b>Steal 1</b></button>`).join("")}</div>`;
    required.querySelectorAll(".steal-target").forEach((button) => {
      button.onclick = () => action({ type: "steal", targetId: button.dataset.target });
    });
  } else if (mine() && state.phase === "robber") {
    required.innerHTML = "<h2>Move the robber</h2><p>Choose a highlighted land tile. You will choose an opponent to rob next if one is eligible.</p>";
  }
}

function placement() {
  if (!mine()) return null;
  if (state.phase === "setup") return state.setupNeedsRoad
    ? { type: "setupRoad", key: "edgeId", ids: list("roadEdges"), label: "starting road" }
    : { type: "setupSettlement", key: "vertexId", ids: list("settlementVertices"), label: "starting settlement" };
  if (state.phase === "robber") return { type: "moveRobber", key: "tileId", ids: list("robberTiles"), label: "robber tile" };
  if (state.freeRoadsRemaining) return { type: "buildRoad", key: "edgeId", ids: list("roadEdges"), label: "free road" };
  if (selectedAction === "road") return { type: "buildRoad", key: "edgeId", ids: list("roadEdges"), label: "road" };
  if (selectedAction === "settlement") return { type: "buildSettlement", key: "vertexId", ids: list("settlementVertices"), label: "settlement" };
  if (selectedAction === "city") return { type: "buildCity", key: "vertexId", ids: list("cityVertices"), label: "city" };
  return null;
}

function renderActions() {
  const focusedBuild = document.activeElement?.dataset.build;
  elements["actions-section"].classList.toggle("hidden", ["lobby", "finished"].includes(state.phase));
  const rolling = Boolean(diceMotion?.active);
  elements["dice-area"].innerHTML = rolling || state.dice ? `<div class="dice-result dice-stage ${rolling ? "is-rolling" : diceMotion?.settled ? "just-settled" : ""}" aria-live="polite">${GameControls.dice(rolling ? null : state.dice[0])}${GameControls.dice(rolling ? null : state.dice[1])}<strong>${rolling ? connection.pending ? "Rolling… awaiting result" : "Rolling…" : `Rolled ${state.dice[0] + state.dice[1]}`}</strong></div>` : "";
  if (legal().canRoll && !rolling) {
    elements["dice-area"].innerHTML += '<button id="roll-button" class="primary-button">Roll the dice</button>';
    document.querySelector("#roll-button").onclick = () => action({ type: "roll" });
  }
  const keys = { road: "roadEdges", settlement: "settlementVertices", city: "cityVertices" };
  const regular = ["action", "roll"].includes(state.phase) && !state.freeRoadsRemaining;
  elements["build-actions"].innerHTML = regular && mine() ? Object.keys(keys).map((kind) => `
    <button class="action-button ${selectedAction === kind ? "active" : ""}" data-build="${kind}" title="${escapeHtml(buildReason(kind, list(keys[kind]).length > 0))}" aria-label="Build ${kind}: ${COST_LABELS[kind]}" ${list(keys[kind]).length ? "" : "disabled"}>
    ${art.icon(kind)}<strong>${kind[0].toUpperCase() + kind.slice(1)}</strong><span class="cost-icons" aria-hidden="true">${Object.entries(COSTS[kind]).map(([r, amount]) => `${art.icon(r)}${amount > 1 ? `<span>${amount}</span>` : ""}`).join("")}</span></button>`).join("") : "";
  elements["build-actions"].querySelectorAll("[data-build]").forEach((button) => {
    button.onclick = (event) => {
      presence.setPingMode(false);
      elements["ping-mode"].setAttribute("aria-pressed", "false");
      selectedAction = selectedAction === button.dataset.build ? null : button.dataset.build;
      renderActions();
      renderBoard();
      if (event.detail === 0) elements.board.querySelector('[data-place][tabindex="0"]')?.focus({ preventScroll: true });
    };
  });
  if (legal().canFinishFreeRoads) {
    elements["build-actions"].innerHTML += `<button id="finish-roads" class="action-button">Finish free roads (${state.freeRoadsRemaining} unused)</button>`;
    document.querySelector("#finish-roads").onclick = () => action({ type: "finishFreeRoads" });
  }
  elements["end-turn"].classList.toggle("hidden", !legal().canEndTurn);
  elements["end-turn"].textContent = state.turnRole === "secondary" ? "Finish paired turn" : "End turn";
  const selected = placement();
  elements["placement-directions"].classList.toggle("hidden", !selected || !selected.ids.length);
  if (selected?.ids.length) {
    elements["placement-directions"].innerHTML = presence.pingMode
      ? '<strong>You are pointing, not placing</strong><p>Pointing shares a location with the table. Return to placement to put your piece on the board.</p><button id="resume-placement" class="secondary-button">Return to placement</button>'
      : `<strong>Place directly on the island</strong><p>${selected.key === "edgeId" ? "Tap an outlined path" : selected.key === "tileId" ? "Tap a highlighted hex" : selected.type === "buildCity" ? "Tap one of your outlined settlements" : "Tap a highlighted corner"} to preview your ${selected.label}. Confirm it on the board, or choose another spot.</p><small>Keyboard: Tab to the board, arrows to move, Enter to preview. Escape cancels.</small>`;
    document.getElementById("resume-placement")?.addEventListener("click", () => setPointMode(false));
  }
  boardPlacement.controls();
  if (focusedBuild) elements["build-actions"].querySelector(`[data-build="${focusedBuild}"]:not(:disabled)`)?.focus({ preventScroll: true });
}

function buildReason(kind, available) {
  if (available) return COST_LABELS[kind];
  if (!mine()) return "Wait for your turn.";
  if (state.phase === "roll") return "Roll the dice before building.";
  const self = me();
  const pieces = { road: self.roadsLeft, settlement: self.settlementsLeft, city: self.citiesLeft };
  if (!pieces[kind]) return kind === "settlement" ? "Upgrade a settlement to free a settlement piece." : `No ${kind} pieces remain in your supply.`;
  const missing = Object.entries(COSTS[kind]).filter(([r, amount]) => self.resources[r] < amount)
    .map(([r, amount]) => `${amount - self.resources[r]} ${r}`);
  if (missing.length) return `You need ${missing.join(" and ")}.`;
  return kind === "city" ? "Choose one of your settlements to upgrade." : "No legal location is connected to your network.";
}

function locationLabel(id) {
  const vertex = state.board?.vertices.find((v) => v.id === id);
  const tile = state.board?.tiles.find((t) => t.id === id);
  const edge = state.board?.edges.find((candidate) => candidate.id === id);
  if (tile) return `Tile ${Number(id.slice(1)) + 1} · ${tile.resource} ${tile.number || ""}`;
  if (vertex) return `Junction ${Number(id.slice(1)) + 1} · ${vertex.adjacentTiles.map((tileId) => {
    const terrain = state.board.tiles.find((t) => t.id === tileId);
    return `${terrain.resource} ${terrain.number || "-"}`;
  }).join(" / ")}`;
  return edge ? `Path ${Number(id.slice(1)) + 1} · ${edge.adjacentTiles.map((tileId) => {
    const terrain = state.board.tiles.find((tile) => tile.id === tileId);
    return `${terrain.resource} ${terrain.number || ""}`;
  }).join(" / ")}` : `Path ${Number(id.slice(1)) + 1}`;
}

function renderDevelopment() {
  elements["development-section"].classList.toggle("hidden", ["lobby", "setup"].includes(state.phase));
  elements["development-left"].textContent = `${state.developmentCount || 0} in deck`;
  elements["buy-development"].disabled = !legal().canBuyDevelopment;
  elements["buy-development"].innerHTML = `${art.icon("cards")}<span><strong>Draw a development card</strong><small>1 sheep + 1 wheat + 1 ore</small></span>`;
  elements["development-cards"].innerHTML = Object.keys(CARDS).map((type) => {
    const cards = (me().developmentCards || []).filter((card) => card.type === type);
    return cards.length ? GameCards.development(type, cards, list("playableCardIds"), CARDS[type], state.phase === "finished") : "";
  }).join("") || '<p class="small-note empty-development">Your development cards stay private here. New cards become playable on a later activation.</p>';
  elements["development-cards"].querySelectorAll(".play-card").forEach((button) => {
    button.onclick = () => openCard(button.dataset.card);
  });
}

function openCard(cardId) {
  const card = me().developmentCards.find((candidate) => candidate.id === cardId);
  selectedCardId = cardId;
  elements["development-title"].textContent = CARDS[card.type][0];
  elements["play-development"].classList.remove("hidden");
  elements["development-options"].innerHTML = `<p>${CARDS[card.type][1]}</p>`;
  if (card.type === "monopoly") {
    elements["development-options"].innerHTML += GameControls.resourcePicker("monopoly-resource", "Take this resource from opponents");
  } else if (card.type === "yearOfPlenty") {
    const amount = Math.min(2, Object.values(state.bank).reduce((a, b) => a + b, 0));
    elements["development-options"].innerHTML += `<p>Choose ${amount} ${amount === 1 ? "card" : "cards"}.</p>${bundleInputs("plenty", state.bank)}`;
  }
  elements["development-dialog"].showModal();
  GameControls.syncCounters(elements["development-dialog"]);
  updateDevelopmentChoice();
}

function updateDevelopmentChoice() {
  if (!state || !selectedCardId || elements["play-development"].classList.contains("hidden")) return;
  const card = me().developmentCards.find((candidate) => candidate.id === selectedCardId);
  let permitted = card && list("playableCardIds").includes(card.id) && bound && !busy;
  if (permitted && card.type === "yearOfPlenty") {
    const chosen = readBundle("plenty");
    const total = Object.values(chosen).reduce((sum, value) => sum + value, 0);
    permitted = total === Math.min(2, Object.values(state.bank).reduce((sum, value) => sum + value, 0)) &&
      RESOURCES.every((r) => Number.isInteger(chosen[r]) && chosen[r] >= 0 && chosen[r] <= state.bank[r]);
  }
  elements["play-development"].disabled = !permitted;
}
elements["play-development"].onclick = async () => {
  const card = me().developmentCards.find((candidate) => candidate.id === selectedCardId);
  if (!card) { elements["development-dialog"].close(); return; }
  const payload = { type: "playDevelopment", cardId: card.id };
  if (card.type === "monopoly") payload.resource = GameControls.read("monopoly-resource");
  if (card.type === "yearOfPlenty") payload.resources = readBundle("plenty");
  if (await action(payload)) elements["development-dialog"].close();
};

function bundleInputs(prefix, limits) {
  return `<div class="resource-counters">${RESOURCES.map((r) => GameControls.counter(prefix, r, limits ? limits[r] : state.boardPlayerCount > 4 ? 24 : 19, Boolean(limits))).join("")}</div>`;
}
function readBundle(prefix) { return Object.fromEntries(RESOURCES.map((r) => [r, Number(document.querySelector(`#${prefix}-${r}`).value)])); }
function bundleText(bundle) { return RESOURCES.filter((r) => bundle[r]).map((r) => `${bundle[r]} ${r}`).join(", "); }
function updateDiscardCount() {
  discardDialog.refresh();
}
document.addEventListener("input", (event) => {
  if (event.target.id?.startsWith("discard-")) updateDiscardCount();
  if (event.target.id?.startsWith("plenty-")) updateDevelopmentChoice();
});

function updateBankLabel() {
  const submit = document.querySelector("#bank-submit");
  if (!submit) return;
  const give = GameControls.read("bank-give");
  const receive = GameControls.read("bank-receive");
  const rate = me().tradeRates?.[give] || 4;
  submit.innerHTML = `<span>Give <b>${rate} ${give}</b></span><span aria-hidden="true">→</span><span>Get <b>1 ${receive}</b></span>`;
  submit.disabled = !legal().canBankTrade || give === receive || me().resources[give] < rate || !state.bank?.[receive];
  const help = document.querySelector("#bank-trade-help");
  if (help) {
    const source = rate === 2 ? "Your resource port gives a 2:1 rate." : rate === 3 ? "Your general port gives a 3:1 rate." : "The bank's standard rate is 4:1.";
    help.textContent = !mine() ? "Bank trading is available during your own action phase."
      : state.phase === "roll" ? "Roll the dice before trading with the bank."
      : state.phase !== "action" || state.freeRoadsRemaining ? "Finish the current required action before trading."
      : give === receive ? "Choose a different resource to receive."
      : !state.bank?.[receive] ? `The bank has no ${receive} available.`
      : me().resources[give] < rate ? `${source} You need ${rate - me().resources[give]} more ${give}.` : source;
  }
}

function renderTrade() {
  const visible = !["lobby", "setup", "finished"].includes(state.phase);
  elements["trade-section"].classList.toggle("hidden", !visible);
  if (!visible) { trading.reset(); return; }
  elements["bank-trade"].innerHTML = `${GameControls.resourcePicker("bank-give", "Spend from your hand · best port rate", { counts: me().resources, rates: me().tradeRates, onChange: updateBankLabel })}<div class="trade-divider"><span>EXCHANGE</span></div>${GameControls.resourcePicker("bank-receive", "Take one from the bank", { selected: "brick", counts: state.bank, disabledValues: RESOURCES.filter((r) => !state.bank[r]), onChange: updateBankLabel })}<p id="bank-trade-help" class="trade-feedback" role="status"></p><button id="bank-submit" class="secondary-button exchange-button">Trade</button>`;
  document.querySelector("#bank-submit").onclick = () => action({
    type: "bankTrade", giveResource: GameControls.read("bank-give"), receiveResource: GameControls.read("bank-receive"),
  });
  trading.render();
}

function point(vertex) { return { x: vertex.x * 100, y: vertex.y * 100 }; }
function terrainMarkup(tile, index) {
  const p = point(tile);
  const probability = tile.number ? 6 - Math.abs(7 - tile.number) : 0;
  const hot = [6, 8].includes(tile.number);
  return `<g data-tile="${tile.id}" class="map-static" transform="translate(${p.x} ${p.y})">
    <title>${tile.resource}${tile.number ? `: produces on ${tile.number} (${probability} probability dots)` : ": no production"}</title>
    <polygon class="tile-base" points="${HEX}" transform="translate(0 7)"/>
    <polygon class="tile" points="${HEX}" fill="url(#land-${tile.resource})"/>
    ${art.terrain(tile.resource, index)}
    ${tile.number ? `<circle class="token-shadow" cx="0" cy="7" r="25"/><circle class="number-token" cx="0" cy="3" r="25"/>
      <text class="token-text ${hot ? "hot" : ""}" x="0" y="0" text-rendering="geometricPrecision">${tile.number}</text>
      ${Array.from({ length: probability }, (_, i) => `<circle class="token-pip ${hot ? "hot" : ""}" cx="${(i - (probability - 1) / 2) * 5}" cy="20" r="1.6"/>`).join("")}` : ""}
  </g>`;
}

function renderWelcomeMap() {
  const coordinates = [[0, 0], [Math.sqrt(3), 0], [Math.sqrt(3) / 2, 1.5], [-Math.sqrt(3) / 2, 1.5], [-Math.sqrt(3), 0], [-Math.sqrt(3) / 2, -1.5], [Math.sqrt(3) / 2, -1.5]];
  const resources = ["wheat", "sheep", "ore", "brick", "wood", "sheep", "wheat"];
  const numbers = [6, 8, 4, 10, 5, 9, 11];
  elements["hero-map"].innerHTML = `<svg viewBox="-340 -315 680 630" aria-hidden="true">
    ${coordinates.map(([x, y], i) => terrainMarkup({ id: `sample-${i}`, x, y, resource: resources[i], number: numbers[i] }, i)).join("")}
    <g transform="translate(-86 -50)">${art.building("settlement", "#c66545")}</g>
    <g transform="translate(173 100)">${art.building("city", "#d6b765")}</g>
    <g transform="translate(86 -150)">${art.building("settlement", "#457ba4")}</g>
  </svg>`;
}

function renderBoard() {
  if (!state) return;
  if (!state.board) {
    boardPlacement.reset();
    elements.board.innerHTML = `<text x="0" y="0" text-anchor="middle" fill="#e7dfc4" font-family="Georgia,serif" font-size="24">Your island is being prepared.</text>`;
    elements["board-prompt"].textContent = "The host will start when everyone is here.";
    return;
  }
  const board = state.board;
  const selected = placement();
  const vertices = new Map(board.vertices.map((v) => [v.id, v]));
  const xs = board.vertices.map((v) => v.x * 100);
  const ys = board.vertices.map((v) => v.y * 100);
  const bounds = [Math.min(...xs) - 110, Math.min(...ys) - 110, Math.max(...xs) - Math.min(...xs) + 220, Math.max(...ys) - Math.min(...ys) + 220];
  const nextKey = `${state.code}:${state.mapVersion ?? 0}:${JSON.stringify(board.tiles.map((t) => [t.id, t.x, t.y, t.resource, t.number]))}:${JSON.stringify(board.ports)}`;
  if (layoutKey !== nextKey || !elements.board.querySelector("#map-scene")) {
    layoutKey = nextKey;
    elements.board.setAttribute("viewBox", bounds.join(" "));
    const coast = board.edges.filter((edge) => edge.adjacentTiles?.length === 1).map((edge) => {
      const a = point(vertices.get(edge.vertices[0]));
      const b = point(vertices.get(edge.vertices[1]));
      return `<path d="M${a.x} ${a.y}L${b.x} ${b.y}" fill="none" stroke="#73b2b140" stroke-width="39" stroke-linecap="round"/>`;
    }).join("");
    const ports = (board.ports || []).map((port) => {
      const a = point(vertices.get(port.vertices[0]));
      const b = point(vertices.get(port.vertices[1]));
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const magnitude = Math.hypot(mid.x, mid.y) || 1;
      const p = { x: mid.x + mid.x / magnitude * 61, y: mid.y + mid.y / magnitude * 61 };
      const resource = RESOURCES.includes(port.resource) ? port.resource : null;
      return `<g class="port"><title>${resource ? `2:1 ${resource} port` : "3:1 general port"}</title>
        <path d="M${a.x} ${a.y}L${p.x} ${p.y}L${b.x} ${b.y}" fill="none" stroke="#d8c18a" stroke-width="5" stroke-linejoin="round"/>
        <rect x="${p.x - 32}" y="${p.y - 15}" width="64" height="30" rx="8" fill="#f3e8ce" stroke="#b9a274" stroke-width="1.5"/>
        <g class="port-glyph" transform="translate(${p.x - 25} ${p.y - 10}) scale(.65)">${art.glyph(resource || "cards")}</g>
        <text class="port-label" x="${p.x + 11}" y="${p.y + 5}">${resource ? "2:1" : "3:1"}</text></g>`;
    }).join("");
    elements.board.innerHTML = `<g id="map-scene"><g class="ocean-decoration">${coast}</g><g id="terrain-layer">${board.tiles.map(terrainMarkup).join("")}</g><g id="port-layer">${ports}</g><g id="robber-layer"></g><g id="roads-layer"></g><g id="buildings-layer"></g><g id="placement-layer"></g></g>`;
    initPanzoom();
    panzoom.reset({ animate: false });
  }
  for (const tile of board.tiles) {
    const node = elements.board.querySelector(`[data-tile="${tile.id}"]`);
    node.setAttribute("class", "map-static");
    for (const attribute of ["role", "tabindex", "data-place", "aria-label"]) node.removeAttribute(attribute);
    node.classList.toggle("blocked-tile", tile.robber);
    if (presence.pingMode) {
      node.setAttribute("class", "map-ping-target");
      node.setAttribute("role", "button");
      node.setAttribute("tabindex", "0");
      node.setAttribute("aria-label", `Point to ${tile.resource} ${tile.number || ""}`);
    }
  }
  const robber = board.tiles.find((tile) => tile.robber);
  const r = point(robber);
  elements.board.querySelector("#robber-layer").innerHTML = `<g class="robber" transform="translate(${r.x + (robber.number ? 49 : 0)} ${r.y - 14})">
    <ellipse cy="38" rx="19" ry="7" fill="#173b3580"/><path d="M-16 34Q-17 9-7 0H7q10 9 9 34Z" fill="#263f42" stroke="#dac282" stroke-width="1.5"/><circle cy="-7" r="11" fill="#2a4244" stroke="#dac282" stroke-width="1.5"/><path d="M-11 13H11" stroke="#bba56b" stroke-width="3"/><path d="M-10 27q7 5 20 0" fill="none" stroke="#6a7771" opacity=".5"/></g>`;
  const edges = board.edges.map((edge) => {
    const a = point(vertices.get(edge.vertices[0]));
    const b = point(vertices.get(edge.vertices[1]));
    return `<g data-edge="${edge.id}" class="map-static">
      ${edge.road ? `<g class="piece-road" stroke-linecap="round"><line stroke="#29382c" stroke-width="15" x1="${a.x}" y1="${a.y + 4}" x2="${b.x}" y2="${b.y + 4}"/><line stroke="${player(edge.road.playerId).color}" stroke-width="13" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/><line stroke="#fff6d5" opacity=".3" stroke-width="2.5" x1="${a.x - 1}" y1="${a.y - 3}" x2="${b.x - 1}" y2="${b.y - 3}"/></g>` : ""}
    </g>`;
  }).join("");
  const structures = board.vertices.map((vertex) => {
    const p = point(vertex);
    const shape = vertex.structure ? `<g transform="translate(${p.x} ${p.y})">${art.building(vertex.structure.kind, player(vertex.structure.playerId).color)}</g>` : "";
    return `<g data-vertex="${vertex.id}" class="map-static">${shape}</g>`;
  }).join("");
  elements.board.querySelector("#roads-layer").innerHTML = edges;
  elements.board.querySelector("#buildings-layer").innerHTML = structures;
  boardPlacement.render();
  presence.render();
  elements["board-prompt"].textContent = presence.pingMode ? "Point mode: tap a spot. Turn Point off to build." : state.phase === "lobby" ? "A shared preview. Pick your favourite starting spots." : selected
    ? `Tap the board to preview a ${selected.label}.${state.freeRoadsRemaining ? ` ${state.freeRoadsRemaining} free remaining.` : ""}`
    : state.winnerId ? "The expedition is complete." : mine() ? "Choose an action from the side panel." : `Waiting for ${player(state.currentPlayerId)?.name}.`;
}

function renderLog() {
  activity.renderRecent(state);
}
function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
