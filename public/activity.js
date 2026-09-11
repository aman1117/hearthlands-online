"use strict";

window.ActivityFeed = class ActivityFeed {
  constructor({ socket, getState, warn }) {
    Object.assign(this, { socket, getState, warn });
    this.key = null;
    this.highest = 0;
    this.cues = [];
    this.history = new Map();
    this.before = null;
    this.loading = false;
    this.generation = 0;
    this.storageWarningShown = false;
    this.dialog = document.getElementById("history-dialog");
    document.getElementById("open-history").onclick = () => this.open();
    document.getElementById("close-history").onclick = () => this.dialog.close();
    document.getElementById("history-more").onclick = () => this.load();
  }
  escape(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
  cursorKey(state) { return `hearthlands-activity:${state.code}:${state.viewerId}`; }
  persist(value) {
    try { localStorage.setItem(this.key, String(value)); }
    catch {
      if (!this.storageWarningShown) {
        this.storageWarningShown = true;
        this.warn("Activity notification preferences could not be saved. The server's activity history is unaffected.");
      }
    }
  }
  update(state) {
    const latest = Number(state.eventSequence || 0);
    const key = this.cursorKey(state);
    if (this.key !== key) {
      this.clear();
      this.key = key;
      let remembered = 0;
      try { remembered = Number(localStorage.getItem(key) || 0); }
      catch { this.warn("Local activity preferences are unavailable; server history remains available."); }
      if (Number.isSafeInteger(remembered) && remembered > 0 && latest > remembered) {
        this.show({ id: `catchup-${latest}`, type: "catchup", message: `${latest - remembered} recorded updates while you were away. Open full activity to catch up.`, actorId: null }, state);
      }
      this.highest = latest;
      this.persist(latest);
      return;
    }
    const events = (state.log || []).filter((event) => Number.isSafeInteger(event.seq) && event.seq > this.highest)
      .sort((a, b) => a.seq - b.seq);
    if (events.length) {
      const important = events.filter((event) => /trade|admin|remov|resign|win|victory/i.test(event.type || ""));
      const chosen = important.length ? important : events.filter((event) => !/production|turn/i.test(event.type || ""));
      const display = chosen.length ? chosen : [events[events.length - 1]];
      for (const event of display.slice(-3)) this.show(event, state);
      if (events.length > display.length) {
        const lastCue = this.cues[this.cues.length - 1];
        if (lastCue) {
          const note = document.createElement("small");
          note.textContent = `+${events.length - display.length} related updates in activity`;
          lastCue.appendChild(note);
        }
      }
      if (this.dialog.open) {
        for (const event of events) this.history.set(event.id, event);
        this.renderHistory();
      }
    }
    this.highest = Math.max(this.highest, latest);
    this.persist(this.highest);
  }
  show(event, state) {
    const container = document.getElementById("activity-notifications");
    const cue = document.createElement("article");
    cue.className = "activity-cue";
    cue.dataset.eventId = event.id;
    cue.dataset.eventType = event.type || "game";
    const owner = [...state.players, ...(state.departedPlayers || [])].find((player) => player.id === event.actorId);
    if (owner) cue.style.setProperty("--actor-color", owner.color);
    const title = /trade/i.test(event.type || "") ? "Trade update" :
      /admin|remov|resign/i.test(event.type || "") ? "Table update" :
      /win|victory/i.test(event.type || "") ? "Game complete" : "Game activity";
    cue.innerHTML = `${Tabletop.icon(/trade/i.test(event.type || "") ? "cards" : /admin|win/i.test(event.type || "") ? "crown" : "settlement")}<div><strong>${title}</strong><p>${this.escape(event.message)}</p></div>`;
    container.appendChild(cue);
    this.cues.push(cue);
    while (this.cues.length > 3) this.cues.shift().remove();
    setTimeout(() => {
      cue.remove();
      this.cues = this.cues.filter((item) => item !== cue);
    }, 6200);
  }
  renderRecent(state) {
    document.getElementById("game-log").innerHTML = [...(state.log || [])].reverse().map((event) =>
      `<div class="log-item" data-event-id="${event.id}" data-event-type="${event.type || "legacy"}"><span>${this.escape(event.message)}</span></div>`).join("");
  }
  async open() {
    if (!this.getState()) return;
    this.history.clear();
    this.before = null;
    this.loading = false;
    this.generation++;
    document.getElementById("history-events").replaceChildren();
    document.getElementById("history-status").textContent = "Loading recorded activity...";
    this.dialog.showModal();
    await this.load();
  }
  async load() {
    const state = this.getState();
    if (!state || this.loading) return;
    const room = state.code;
    const generation = this.generation;
    this.loading = true;
    const more = document.getElementById("history-more");
    more.disabled = true;
    try {
      const reply = await this.socket.timeout(8000).emitWithAck("getActivity", { limit: 50, ...(this.before !== null ? { beforeSeq: this.before } : {}) });
      if (generation !== this.generation || this.getState()?.code !== room) return;
      if (!reply?.ok) throw new Error(reply?.error || "Activity could not be loaded.");
      for (const event of reply.events) this.history.set(event.id, event);
      this.before = reply.nextBeforeSeq;
      more.classList.toggle("hidden", !reply.hasMore);
      document.getElementById("history-status").textContent =
        this.history.size ? `${this.history.size} recorded events shown${[...this.history.values()].some((event) => event.type === "legacy") ? ". Older pre-upgrade history may be unavailable." : "."}` : "No recorded activity yet.";
      this.renderHistory();
    } catch (error) {
      if (generation !== this.generation || this.getState()?.code !== room) return;
      document.getElementById("history-status").textContent = error.message;
      more.classList.remove("hidden");
      more.textContent = "Retry loading";
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        more.disabled = false;
      }
    }
  }
  renderHistory() {
    document.getElementById("history-events").innerHTML = [...this.history.values()].sort((a, b) => b.seq - a.seq).map((event) =>
      `<article class="activity-row" data-event-id="${event.id}" data-seq="${event.seq}"><time>${new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><p>${this.escape(event.message)}</p></article>`).join("");
  }
  clear() {
    for (const cue of this.cues) cue.remove();
    this.cues = [];
    this.history.clear();
    this.generation++;
    this.loading = false;
    this.dialog.close();
    this.key = null;
  }
};
