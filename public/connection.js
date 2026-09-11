"use strict";

window.GameConnection = class GameConnection {
  constructor({ socket, onState, onStatus, onSeats, onError, onRetired }) {
    Object.assign(this, { socket, onState, onStatus, onSeats, onError, onRetired });
    this.prefix = "hearthlands-seat-v3:";
    this.entryPrefix = "hearthlands-entry-v3:";
    this.activeKey = "hearthlands-active-seat-v3";
    this.currentSeat = null;
    this.entry = null;
    this.bound = false;
    this.blocked = false;
    this.paused = false;
    this.revision = -1;
    this.generation = 0;
    this.inflight = false;
    this.attempts = 0;
    this.timer = null;
    this.waiter = null;
    this.warnings = [];
    this.status = { kind: "connecting", pending: false, text: "Connecting to the game server..." };
    this.socket.on("connect", () => this.connected());
    this.socket.on("disconnect", (reason) => this.disconnected(reason));
    this.socket.on("connect_error", () => this.statusChanged("offline", "Server unavailable. Your saved seat and unconfirmed request are kept."));
    this.socket.on("state", (state) => this.receiveState(state));
    this.socket.on("requestError", (error) => this.onError(error));
    this.socket.on("sessionReplaced", () => {
      this.blocked = true;
      this.bound = false;
      this.cancelTimers();
      this.resolve({ ok: false, code: "SESSION_REPLACED" });
      this.statusChanged("replaced", "This seat is open in another tab or device. Resume explicitly to take control.");
    });
    this.socket.on("seatRetired", (event) => this.retired(event));
    this.socket.on("removedFromRoom", () => this.retired({ removed: true }));
  }

  uuid() {
    return crypto.randomUUID ? crypto.randomUUID() :
      [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join("");
  }
  resumeKey() {
    return [...crypto.getRandomValues(new Uint8Array(32))].map((n) => n.toString(16).padStart(2, "0")).join("");
  }
  key(token) { return this.prefix + token; }
  read(key) {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object") throw new Error("Invalid record");
      return value;
    } catch {
      this.warnings.push("A saved browser record is unreadable. It was not deleted; you can also use your private resume key.");
      return null;
    }
  }
  write(record) {
    // One atomic browser-storage write holds both seat metadata and its pending intent.
    localStorage.setItem(this.key(record.reconnectToken), JSON.stringify(record));
    return record;
  }
  savedSeats() {
    const seats = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(this.prefix)) continue;
      const record = this.read(key);
      if (record?.reconnectToken && record.roomCode) seats.push(record);
    }
    return seats.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  }
  notifySeats() { this.onSeats(this.savedSeats()); }
  record() {
    if (!this.currentSeat) return null;
    return this.read(this.key(this.currentSeat.reconnectToken)) || this.currentSeat;
  }
  get pending() { return this.entry?.pending || this.record()?.pending || null; }
  cancelTimers() {
    clearTimeout(this.timer);
    this.timer = null;
    this.inflight = false;
    this.generation++;
  }
  statusChanged(kind, text) {
    this.status = { kind, text, pending: Boolean(this.pending), bound: this.bound, operation: this.pending?.event, action: this.pending?.payload?.type, requestId: this.pending?.payload?.requestId };
    this.onStatus(this.status);
  }
  resolve(result) {
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) waiter(result);
  }
  start() {
    try {
      const legacy = this.read("hearthlands-seat-v2");
      if (legacy?.reconnectToken && legacy.roomCode && !this.read(this.key(legacy.reconnectToken))) {
        this.write({ ...legacy, name: localStorage.getItem("hearthlands-name") || "Player", status: "active", nextSequence: 1, lastUsed: Date.now() });
      }
      this.notifySeats();
      const invite = new URLSearchParams(location.search).get("room")?.toUpperCase();
      const active = sessionStorage.getItem(this.activeKey);
      const saved = this.savedSeats();
      this.currentSeat = saved.find((seat) => seat.status === "active" && seat.reconnectToken === active && (!invite || seat.roomCode === invite)) ||
        (invite ? saved.find((seat) => seat.roomCode === invite && seat.status === "active") : null);
      if (!this.currentSeat) {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith(this.entryPrefix)) {
            const entry = this.read(key);
            if (entry?.pending && (!this.entry || entry.pending.queuedAt > this.entry.pending.queuedAt)) this.entry = entry;
          }
        }
      }
      if (this.warnings.length) this.onError(this.warnings[0]);
    } catch (error) {
      this.onError(`Browser storage is unavailable: ${error.message}. Requests will not be sent without a saved recovery record.`);
    }
    this.socket.connect();
  }
  connected() {
    if (this.blocked || this.paused) { this.statusChanged("idle", "Connected. Choose a saved game or join a table."); return; }
    this.inflight = false;
    if (this.entry) this.attemptEntry();
    else if (this.currentSeat) {
      this.statusChanged("connecting", "Restoring your saved position...");
      this.attemptResume();
    }
    else this.statusChanged("online", "Connected");
  }
  disconnected(reason) {
    this.bound = false;
    this.inflight = false;
    clearTimeout(this.timer);
    if (this.blocked || this.paused) return;
    this.statusChanged("offline", this.pending
      ? "Connection lost. Your action is saved locally and will be confirmed after reconnection."
      : "Connection lost. Your game is saved; reconnecting does not surrender your seat.");
    if (reason === "io server disconnect") {
      this.timer = setTimeout(() => { if (!this.blocked && !this.paused) this.socket.connect(); }, 1500);
    }
  }
  schedule(attempt, message) {
    if (this.blocked || this.paused) return;
    this.inflight = false;
    this.attempts++;
    this.statusChanged("retrying", message);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.socket.connected || this.blocked || this.paused) return;
      attempt();
    }, Math.min(8000, 500 * 2 ** Math.min(4, this.attempts - 1)));
  }
  rpc(event, payload, handler) {
    if (this.inflight || !this.socket.connected || this.blocked || this.paused) return;
    this.inflight = true;
    const generation = this.generation;
    this.socket.timeout(3000).emit(event, payload, (error, response) => {
      if (generation !== this.generation) return;
      this.inflight = false;
      handler(error ? { ok: false, retryable: true, code: "ACK_TIMEOUT", error: "Waiting for server confirmation." } : response);
    });
  }
  enter(event, payload) {
    if (this.currentSeat && !this.blocked) {
      this.onError("Finish restoring this seat, or save and exit the table, before joining another.");
      return Promise.resolve(null);
    }
    if (this.entry) {
      this.onError("A table request is awaiting confirmation. It will be recovered without creating another seat.");
      return Promise.resolve(null);
    }
    try {
      const resumeKey = this.resumeKey();
      const pending = { event, payload: { ...payload, resumeKey, requestId: this.uuid() }, queuedAt: Date.now() };
      this.entry = { resumeKey, pending };
      localStorage.setItem(this.entryPrefix + resumeKey, JSON.stringify(this.entry));
      if (this.currentSeat) {
        this.paused = true;
        this.socket.disconnect();
      }
      this.currentSeat = null;
      this.revision = -1;
      this.blocked = false;
      this.paused = false;
      this.cancelTimers();
      const promise = new Promise((resolve) => { this.waiter = resolve; });
      this.statusChanged("pending", "Securing your seat...");
      if (this.socket.connected) this.attemptEntry();
      else this.socket.connect();
      return promise;
    } catch (error) {
      this.entry = null;
      this.onError(`Your recovery key could not be saved, so the request was not sent: ${error.message}`);
      return Promise.resolve(null);
    }
  }
  attemptEntry() {
    const entry = this.entry;
    if (!entry) return;
    this.rpc(entry.pending.event, entry.pending.payload, (reply) => {
      if (!this.entry || this.entry.resumeKey !== entry.resumeKey) return;
      if (!reply?.ok && reply?.retryable) {
        this.schedule(() => this.attemptEntry(), "Joining is taking longer than usual. Retrying the same saved request.");
      } else if (reply?.ok) {
        this.bindMetadata(reply);
        this.finishEntry(reply);
      } else {
        localStorage.removeItem(this.entryPrefix + entry.resumeKey);
        this.entry = null;
        this.onError(reply?.error || "The table request was rejected.");
        this.resolve(reply || null);
        this.statusChanged("error", "Could not join this table.");
      }
    });
  }
  resume(saved) {
    if (!saved?.reconnectToken) return Promise.resolve(null);
    this.cancelTimers();
    this.resolve({ ok: false, code: "PAUSED" });
    this.paused = true;
    this.socket.disconnect();
    this.currentSeat = this.read(this.key(saved.reconnectToken)) || { ...saved, nextSequence: 1, status: "active" };
    this.entry = null;
    this.bound = false;
    this.blocked = false;
    this.paused = false;
    this.revision = -1;
    this.attempts = 0;
    const promise = new Promise((resolve) => { this.waiter = resolve; });
    this.statusChanged("connecting", "Restoring your saved position...");
    this.socket.connect();
    return promise;
  }
  attemptResume() {
    if (!this.currentSeat || this.bound) { if (this.bound) this.attemptPending(); return; }
    const token = this.currentSeat.reconnectToken;
    this.rpc("reconnectRoom", { reconnectToken: token, code: this.currentSeat.roomCode }, (reply) => {
      if (!this.currentSeat || this.currentSeat.reconnectToken !== token) return;
      if (this.bound) { this.attemptPending(); return; }
      if (reply?.ok) {
        this.bindMetadata(reply);
        this.bound = true;
        this.inflight = false;
        this.attempts = 0;
        this.resolve(reply);
        this.statusChanged("online", "Saved position restored");
        this.attemptPending();
      } else if (reply?.code === "SEAT_RETIRED") this.retired(reply);
      else if (reply?.retryable || reply?.code === "ACK_TIMEOUT") {
        this.schedule(() => this.attemptResume(), "Reconnecting to your saved seat...");
      } else {
        const record = this.record();
        if (record?.roomCode) this.write({ ...record, status: "unavailable" });
        this.onError(reply?.error || "That saved game is unavailable.");
        this.resolve(reply || null);
        this.currentSeat = null;
        this.bound = false;
        this.notifySeats();
        this.statusChanged("error", "Saved seat could not be restored.");
      }
    });
  }
  bindMetadata(reply, state) {
    const token = reply.reconnectToken || this.entry?.resumeKey || this.currentSeat?.reconnectToken;
    if (!token) return;
    const previous = this.read(this.key(token)) || {};
    const self = state?.players.find((p) => p.id === state.viewerId);
    const record = {
      ...previous, reconnectToken: token, roomCode: reply.roomCode || state?.code || previous.roomCode,
      playerId: reply.playerId || state?.viewerId || previous.playerId,
      name: self?.name || previous.name || this.entry?.pending.payload.name || "Player",
      status: "active", lastUsed: Date.now(), savedAt: reply.savedAt || state?.savedAt || previous.savedAt,
      phase: state?.phase || previous.phase, playerCount: state?.players.length || previous.playerCount,
      turnNumber: state?.turnNumber ?? previous.turnNumber,
      expiresAt: state?.expiresAt || previous.expiresAt,
      nextSequence: Math.max(previous.nextSequence || 1, reply.nextSequence || state?.nextSequence || 1),
    };
    this.write(record);
    this.currentSeat = record;
    sessionStorage.setItem(this.activeKey, token);
    localStorage.setItem("hearthlands-seat-v2", JSON.stringify({ reconnectToken: token, roomCode: record.roomCode }));
    history.replaceState(null, "", `/?room=${encodeURIComponent(record.roomCode)}`);
    this.notifySeats();
  }
  finishEntry(reply) {
    if (!this.entry) return;
    localStorage.removeItem(this.entryPrefix + this.entry.resumeKey);
    this.entry = null;
    this.cancelTimers();
    this.bound = true;
    this.attempts = 0;
    this.resolve(reply);
    this.statusChanged("online", "Your seat is saved");
  }
  receiveState(state) {
    if (this.paused || this.blocked || (!this.currentSeat && !this.entry)) return;
    if (this.currentSeat?.roomCode && state.code !== this.currentSeat.roomCode) return;
    if (this.currentSeat?.playerId && state.viewerId !== this.currentSeat.playerId) return;
    if (state.revision < this.revision) return;
    try {
      const restoring = !this.bound;
      this.revision = state.revision;
      this.bindMetadata({}, state);
      this.bound = true;
      if (restoring && !this.entry) this.cancelTimers();
      if (this.entry) {
        this.finishEntry({ ok: true, roomCode: state.code, playerId: state.viewerId, reconnectToken: this.currentSeat.reconnectToken });
      } else if (this.record()?.pending && state.ownReceipt?.requestId === this.record().pending.payload.requestId) {
        this.finishPending({ ...state.ownReceipt, ok: state.ownReceipt.ok, nextSequence: state.nextSequence });
      } else if (!this.record()?.pending) {
        this.inflight = false;
        clearTimeout(this.timer);
        this.resolve({ ok: true, roomCode: state.code, playerId: state.viewerId });
        this.statusChanged("online", "Connected · Saved automatically");
      }
    } catch (error) {
      if (!["QuotaExceededError", "SecurityError"].includes(error.name)) throw error;
      this.onError(`The server saved your game, but browser recovery storage failed: ${error.message}. Keep your private resume key.`);
      this.statusChanged("error", "Browser storage must be available before continuing.");
      return;
    }
    this.onState(state);
    if (this.record()?.pending && !this.inflight) this.attemptPending();
  }
  submit(event, payload) {
    if (!this.bound || !this.currentSeat || this.blocked) {
      this.onError("Wait until your saved seat has reconnected before taking another action.");
      return Promise.resolve(null);
    }
    if (this.pending) {
      this.onError("Your previous action is still awaiting confirmation. It will not be sent as a new action.");
      return Promise.resolve(null);
    }
    try {
      const record = this.record();
      const pending = {
        event, payload: { ...payload, ...(event === "gameAction" ? { expectedTurnNumber: record.turnNumber } : {}), requestId: payload.requestId || this.uuid(), clientSeq: record.nextSequence || 1 },
        queuedAt: Date.now(),
      };
      this.write({ ...record, pending });
      this.attempts = 0;
      const promise = new Promise((resolve) => { this.waiter = resolve; });
      this.statusChanged("pending", event === "resignGame" ? "Confirming your resignation..." : "Sending your move...");
      this.attemptPending();
      return promise;
    } catch (error) {
      this.onError(`The action was not sent because its recovery record could not be saved: ${error.message}`);
      return Promise.resolve(null);
    }
  }
  attemptPending() {
    const operation = this.record()?.pending;
    if (!operation || !this.bound || this.inflight) return;
    this.statusChanged("pending", "Confirming the saved action...");
    this.rpc(operation.event, operation.payload, (reply) => {
      if (this.record()?.pending?.payload.requestId !== operation.payload.requestId) return;
      if (reply?.ok) this.finishPending(reply);
      else if (reply?.code === "SEAT_RETIRED") this.retired(reply);
      else if (reply?.code === "SESSION_REQUIRED") {
        this.bound = false;
        this.schedule(() => this.attemptResume(), "Restoring your session before retrying the saved action.");
      } else if (reply?.retryable) {
        this.schedule(() => this.attemptPending(), "Waiting for confirmation. Your original action is saved and will be retried safely.");
      } else this.finishPending(reply || { ok: false, error: "The server rejected this request." });
    });
  }
  finishPending(reply) {
    const record = this.record();
    if (!record?.pending) return;
    const operation = record.pending;
    this.write({
      ...record, pending: null,
      nextSequence: Math.max(record.nextSequence || 1, reply.nextSequence || 1),
      lastOutcome: { requestId: operation.payload.requestId, ok: reply.ok, code: reply.code, at: Date.now() },
    });
    this.cancelTimers();
    this.attempts = 0;
    this.resolve(reply);
    if (!reply.ok) this.onError(reply.error || "The request was not applied. Your saved position is shown.");
    this.notifySeats();
    this.statusChanged("online", reply.ok ? "Move confirmed · Game saved" : "Saved position restored");
  }
  retired(event) {
    const record = this.record();
    if (record) {
      this.write({ ...record, pending: null, status: "retired", lastUsed: Date.now() });
      if (sessionStorage.getItem(this.activeKey) === record.reconnectToken) sessionStorage.removeItem(this.activeKey);
    }
    this.cancelTimers();
    this.blocked = true;
    this.bound = false;
    this.resolve({ ok: true, retired: true });
    this.notifySeats();
    this.statusChanged("retired", event.removed ? "The host removed your lobby seat." : "You resigned. Your pieces and holdings were returned.");
    this.onRetired(event);
  }
  pause() {
    this.paused = true;
    this.bound = false;
    this.cancelTimers();
    this.resolve({ ok: false, code: "PAUSED" });
    sessionStorage.removeItem(this.activeKey);
    this.socket.disconnect();
    this.currentSeat = null;
    this.revision = -1;
    history.replaceState(null, "", "/");
    this.notifySeats();
    this.statusChanged("paused", "Saved for later. Choose a table when you are ready.");
    this.socket.connect();
  }
  retryNow() {
    if (this.blocked) return;
    clearTimeout(this.timer);
    this.inflight = false;
    if (!this.socket.connected) this.socket.connect();
    else if (this.entry) this.attemptEntry();
    else if (!this.bound) this.attemptResume();
    else this.attemptPending();
  }
};
