"use strict";

// Header countdown for the per-move turn timer plus the admin's timer settings.
window.TurnClock = class TurnClock {
  static FIELDS = [
    ["setupSettlement", "Starting settlement", 10], ["setupRoad", "Starting road", 5], ["roll", "Roll dice", 5],
    ["discard", "Discard on a 7", 5], ["robber", "Move robber & rob", 5], ["turn", "Build & trade turn", 10], ["bonus", "Bonus per build/trade", 0],
  ];
  static PRESETS = [
    ["off", "Off", "No time limit"], ["30", "30s", "Very fast"], ["60", "60s", "Fast · Colonist default"],
    ["120", "120s", "Normal"], ["240", "240s", "Slow"], ["custom", "Custom", "Set each move"],
  ];
  static STAGES = {
    setupSettlement: "Starting settlement", setupRoad: "Starting road", freeRoads: "Free roads", roll: "Roll",
    discard: "Discard", robber: "Move robber", steal: "Rob a player", action: "Turn",
  };
  constructor({ element, getState, escape, submit, isBusy, isReady, onLowTime }) {
    Object.assign(this, { element, getState, escape, submit, isBusy, isReady, onLowTime });
    this.offset = 0;
    this.warned = null;
    this.drafts = new Map();
    setInterval(() => this.tick(), 250);
  }
  // Server time is attached to every state, so devices with skewed clocks still show the same countdown.
  sync(state) {
    if (Number.isFinite(state?.serverTime)) this.offset = state.serverTime - Date.now();
    this.tick();
  }
  remaining(timer) { return Math.max(0, timer.deadline - (Date.now() + this.offset)); }
  format(ms) {
    const seconds = Math.ceil(ms / 1000);
    return seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : `${seconds}s`;
  }
  tick() {
    const state = this.getState();
    const timer = state?.turnTimer?.timer;
    this.element.classList.toggle("hidden", !timer);
    if (!timer) { this.element.replaceChildren(); this.warned = null; return; }
    const remaining = this.remaining(timer);
    const mine = timer.playerIds.includes(state.viewerId);
    const names = timer.playerIds.map((id) => state.players.find((p) => p.id === id)?.name).filter(Boolean);
    const who = mine ? (names.length > 1 ? `You + ${names.length - 1}` : "You") : names.length > 2 ? `${names.length} players` : names.join(" & ");
    const low = remaining <= Math.min(10_000, Math.max(3000, timer.duration * .25));
    const label = TurnClock.STAGES[timer.kind] || "Move";
    const signature = JSON.stringify([timer.kind, timer.deadline, who]);
    if (this.element.dataset.signature !== signature) {
      this.element.dataset.signature = signature;
      this.element.innerHTML = `<span class="turn-clock-who">${this.escape(who)}</span><span class="turn-clock-stage">${this.escape(label)}</span><strong class="turn-clock-time" data-clock-time></strong><span class="turn-clock-bar" aria-hidden="true"><i></i></span>`;
      this.element.setAttribute("aria-label", `${who}: ${label} timer`);
    }
    this.element.querySelector("[data-clock-time]").textContent = this.format(remaining);
    this.element.querySelector(".turn-clock-bar i").style.width = `${Math.min(100, 100 * remaining / timer.duration)}%`;
    this.element.classList.toggle("mine", mine);
    this.element.classList.toggle("low", low);
    this.element.dataset.timerKind = timer.kind;
    const warnKey = `${timer.kind}:${timer.deadline}`;
    if (mine && low && remaining > 0 && this.warned !== warnKey) { this.warned = warnKey; this.onLowTime?.(); }
  }
  summary(turnTimer) {
    if (!turnTimer || turnTimer.preset === "off" || !turnTimer.durations) return "Turn timer: off";
    const d = turnTimer.durations;
    const name = TurnClock.PRESETS.find(([value]) => value === turnTimer.preset)?.[1] || "Custom";
    return `Turn timer: ${name} · ${d.turn}s turn, ${d.roll}s roll, ${d.robber}s robber, ${d.discard}s discard, +${d.bonus}s per build/trade`;
  }
  // Admins pick a preset or exact seconds per move; everyone else sees the active setting.
  renderSettings(container, { admin }) {
    const state = this.getState();
    if (!container || !state) return;
    const current = state.turnTimer || { preset: "off", durations: null };
    const key = container.id;
    const draft = this.drafts.get(key);
    const selected = draft?.preset ?? current.preset;
    const signature = JSON.stringify([admin, current, selected, this.isBusy(), this.isReady()]);
    if (container.dataset.signature === signature) return;
    const focused = container.contains(document.activeElement) ? document.activeElement.id : null;
    container.dataset.signature = signature;
    if (!admin) {
      container.innerHTML = `<p class="timer-summary" data-timer-summary>${this.escape(this.summary(current))}</p><p class="small-note">Only the administrator can change the turn timer.</p>`;
      return;
    }
    const custom = draft?.durations || current.durations || { setupSettlement: 120, setupRoad: 30, roll: 10, discard: 20, robber: 20, turn: 60, bonus: 10 };
    container.innerHTML = `<fieldset class="timer-presets" role="radiogroup" aria-label="Turn timer"><legend>Turn timer</legend>
      ${TurnClock.PRESETS.map(([value, label, hint]) => `<button type="button" role="radio" class="timer-preset" data-timer-preset="${value}" aria-checked="${value === selected}"><strong>${label}</strong><small>${hint}</small></button>`).join("")}
      </fieldset>
      ${selected === "custom" ? `<div class="timer-custom">${TurnClock.FIELDS.map(([field, label, min]) =>
        `<label for="${key}-${field}"><span>${label}</span><span class="timer-input"><input id="${key}-${field}" data-timer-field="${field}" type="number" inputmode="numeric" min="${min}" max="${field === "bonus" ? 300 : 3600}" step="1" value="${custom[field]}"><small>s</small></span></label>`).join("")}</div>` : ""}
      <p class="small-note timer-note">${this.escape(this.summary(current))}. When a timer runs out, the game makes that move automatically: it places a random starting spot, rolls, discards at random, moves the robber or ends the turn. Timers pause while nobody is connected.</p>
      <p class="timer-error" data-timer-error role="status"></p>
      <button type="button" class="secondary-button timer-apply" data-timer-apply ${this.isBusy() || !this.isReady() || (selected === current.preset && selected !== "custom") ? "disabled" : ""}>${state.phase === "lobby" ? "Use this timer" : "Apply now (restarts the current countdown)"}</button>`;
    container.onclick = (event) => {
      const preset = event.target.closest("[data-timer-preset]");
      if (preset) { this.drafts.set(key, { preset: preset.dataset.timerPreset, durations: this.readCustom(container) || custom }); this.renderSettings(container, { admin }); return; }
      if (event.target.closest("[data-timer-apply]")) this.apply(container, admin);
    };
    container.oninput = () => {
      const draftNow = this.drafts.get(key) || { preset: "custom" };
      this.drafts.set(key, { ...draftNow, durations: this.readCustom(container) });
      const apply = container.querySelector("[data-timer-apply]");
      if (apply) apply.disabled = this.isBusy() || !this.isReady();
    };
    if (focused) document.getElementById(focused)?.focus();
  }
  readCustom(container) {
    const inputs = [...container.querySelectorAll("[data-timer-field]")];
    if (!inputs.length) return null;
    return Object.fromEntries(inputs.map((input) => [input.dataset.timerField, Number(input.value)]));
  }
  async apply(container, admin) {
    const state = this.getState();
    const key = container.id;
    const preset = this.drafts.get(key)?.preset ?? state.turnTimer?.preset ?? "off";
    const settings = preset === "custom" ? { preset, durations: this.readCustom(container) } : { preset };
    if (preset === "custom") {
      const invalid = TurnClock.FIELDS.find(([field, , min]) => !Number.isSafeInteger(settings.durations[field]) ||
        settings.durations[field] < min || settings.durations[field] > (field === "bonus" ? 300 : 3600));
      if (invalid) {
        container.querySelector("[data-timer-error]").textContent = `${invalid[1]} must be ${invalid[2]}-${invalid[0] === "bonus" ? 300 : 3600} seconds.`;
        return;
      }
    }
    if (await this.submit(settings)) {
      this.drafts.delete(key);
      container.dataset.signature = "";
      this.renderSettings(container, { admin });
    }
  }
};
