"use strict";

const TRADE_RESOURCES = ["wood", "brick", "sheep", "wheat", "ore"];
const AUTO_DECLINE_KEY = "hearthlands-auto-decline";

window.TradePanel = class TradePanel {
  constructor({ getState, isBusy, isReady, submit, chooseTab, bundleInputs, readBundle, bundleText, escape, notify, socket }) {
    Object.assign(this, { getState, isBusy, isReady, submit, chooseTab, bundleInputs, readBundle, bundleText, escape, notify, socket });
    this.root = document.getElementById("player-trade");
    this.autoDeclineMs = 20000;
    this.draftingTtl = 10000;
    this.cards = new Map();
    this.drafting = new Map();
    this.reset();
    this.root.addEventListener("input", (event) => {
      if (event.target.id === "trade-auto-decline") this.setAutoDecline(event.target.checked);
      this.refresh();
    });
    this.root.addEventListener("click", (event) => this.onClick(event));
    socket?.on("tradeDrafting", (hint) => {
      if (!hint || typeof hint.playerId !== "string") return;
      this.drafting.set(hint.playerId, { tradeId: typeof hint.tradeId === "string" ? hint.tradeId : null, at: Date.now() });
      this.refresh();
    });
    setInterval(() => this.tick(), 500);
  }
  reset() {
    if (this.mode?.kind === "counter") this.announceDrafting(null);
    clearInterval(this.draftingTimer);
    this.scope = this.rosterSignature = this.mode = null;
    this.cards.clear();
    this.seenAt = new Map();
    this.pinned = new Set();
    this.autoDeclined = new Set();
    this.countered = new Set();
    this.root.replaceChildren();
    GameControls.reset("trade-target");
  }
  get autoDecline() {
    try { return localStorage.getItem(AUTO_DECLINE_KEY) !== "off"; } catch { return true; }
  }
  setAutoDecline(enabled) {
    try { localStorage.setItem(AUTO_DECLINE_KEY, enabled ? "on" : "off"); } catch { /* the in-page checkbox still applies */ }
  }
  phaseReason(state) {
    if (state.turnRole === "secondary") return "Paired turns allow bank trades only, not player trades.";
    if (state.phase === "roll") return "The active player must roll the dice before anyone can trade.";
    if (state.phase === "discard") return "Trading waits until all discards, the robber move and any theft are finished.";
    if (state.phase === "robber" || state.phase === "steal") return "Finish moving the robber and any theft before trading.";
    if (state.freeRoadsRemaining) return "Finish placing free roads before trading.";
    return state.phase !== "action" ? "Trading is unavailable in this phase." : "";
  }
  player(state, id) { return state.players.find((p) => p.id === id); }
  name(state, id) { return this.player(state, id)?.name || "A departed player"; }
  trades(state) { return Array.isArray(state.trades) ? state.trades : []; }
  isHost(state) { return state.currentPlayerId === state.viewerId && state.turnRole === "primary"; }
  blocked(state, blockerId, otherId) { return (state.embargoes?.[blockerId] || []).includes(otherId); }
  // Originals first, each followed by its live counteroffers, as at a real table.
  ordered(trades) {
    const ids = new Set(trades.map((trade) => trade.id));
    const result = [];
    for (const trade of trades.filter((candidate) => !candidate.counterTo || !ids.has(candidate.counterTo))) {
      result.push(trade, ...trades.filter((candidate) => candidate.counterTo === trade.id));
    }
    return result;
  }
  perspective(state, trade) {
    const sender = trade.fromId === state.viewerId;
    const responder = (trade.responders || []).includes(state.viewerId);
    return { sender, responder, party: sender || responder, open: trade.targetId === null, counter: Boolean(trade.counterTo) };
  }
  meTooAllowed(state, trade) {
    return !this.perspective(state, trade).party && trade.targetId === state.currentPlayerId && state.viewerId !== state.currentPlayerId &&
      !trade.anyGive && !trade.anyWant && !this.blocked(state, state.currentPlayerId, state.viewerId);
  }
  side(label, bundle, any, direction) {
    const total = TRADE_RESOURCES.reduce((sum, resource) => sum + (bundle[resource] || 0), 0) + (any || 0);
    const anyCard = any ? `<li class="trade-resource-card trade-any-card" data-trade-resource="any" data-count="${any}">
        <span class="trade-resource-count"><span aria-hidden="true">×</span><b>${any}</b></span>
        <span class="trade-resource-art" aria-hidden="true">?</span><strong class="trade-resource-name">Any</strong></li>` : "";
    return `<section class="offer-side offer-side-${direction}" data-trade-direction="${direction}" aria-label="${this.escape(label)}">
      <div class="offer-side-heading"><h4>${this.escape(label)}</h4><span>${total} ${total === 1 ? "card" : "cards"}</span></div>
      <ul class="trade-resource-list">${GameCards.tradeResources(bundle)}${anyCard}</ul>
    </section>`;
  }
  cardMarkup(state, trade) {
    const view = this.perspective(state, trade);
    const from = this.player(state, trade.fromId);
    const target = view.open ? null : this.player(state, trade.targetId);
    const viewerGives = !view.sender && view.party;
    const receive = view.sender ? trade.want : trade.give, give = view.sender ? trade.give : trade.want;
    const anyReceive = view.sender ? trade.anyWant : trade.anyGive, anyGive = view.sender ? trade.anyGive : trade.anyWant;
    const receiveLabel = view.party ? "You receive" : `${from?.name || "Sender"} gives`;
    const giveLabel = view.party ? "You give" : view.open ? "The taker gives" : `${target?.name || "Recipient"} gives`;
    const original = view.counter ? this.trades(state).find((candidate) => candidate.id === trade.counterTo) : null;
    const eyebrow = view.counter ? "COUNTEROFFER" : view.open ? "OPEN TO ALL PLAYERS" : "NOT THE BANK";
    const title = view.counter ? "Counteroffer" : view.open ? "Open trade offer" : "Trade offer";
    const badge = view.sender ? "Your offer" : view.responder ? (view.open ? "Open to you" : "For you") : "At the table";
    const openEnded = Boolean(trade.anyGive || trade.anyWant);
    const actions = view.sender
      ? '<div class="trade-owner-actions"><button type="button" class="secondary-button trade-edit" data-trade-action="edit">Edit offer</button><button type="button" class="secondary-button trade-cancel" data-trade-action="withdraw">Withdraw offer</button></div>'
      : view.responder
        ? `<div class="trade-response">${openEnded ? "" : '<button type="button" class="action-button trade-decline" data-trade-action="decline">Decline</button><button type="button" class="primary-button trade-accept" data-trade-action="accept">Accept trade</button>'}${openEnded ? '<button type="button" class="action-button trade-decline" data-trade-action="decline">Decline</button>' : ""}<button type="button" class="secondary-button trade-counter" data-trade-action="counter">${openEnded ? "Choose cards & counter" : "Counteroffer"}</button></div>`
        : this.meTooAllowed(state, trade) ? '<button type="button" class="secondary-button trade-metoo" data-trade-action="metoo">Me too: offer the same</button>' : "";
    return `<article class="trade-offer table-trade-card${view.counter && original ? " is-counter" : ""}" data-trade-id="${this.escape(trade.id)}" aria-labelledby="trade-title-${this.escape(trade.id)}">
      <header class="offer-heading"><span class="offer-seal" aria-hidden="true">${Tabletop.icon("cards")}</span>
        <div><span class="offer-eyebrow">PLAYER TRADE &middot; ${eyebrow}</span><h3 id="trade-title-${this.escape(trade.id)}" class="offer-title">${title}</h3></div>
        <span class="offer-badge">${badge}</span>
      </header>
      ${view.counter ? `<p class="offer-counter-note">${original ? `Counter to ${this.escape(this.name(state, original.fromId))}'s offer` : "Counter to an earlier offer"}</p>` : ""}
      <div class="offer-participants" aria-label="${this.escape(`${from?.name || "Sender"} offers ${view.open ? "every player" : target?.name || "a player"}`)}">
        <span class="offer-player"><i style="--seat-color:${this.escape(from?.color || "#999")}" aria-hidden="true"></i><strong>${view.sender ? "You" : this.escape(from?.name || "Sender")}</strong></span>
        <span class="offer-to" aria-hidden="true">→</span>
        ${view.open ? '<span class="offer-player offer-everyone"><i aria-hidden="true"></i><strong>All players</strong></span>'
          : `<span class="offer-player"><i style="--seat-color:${this.escape(target?.color || "#999")}" aria-hidden="true"></i><strong>${trade.targetId === state.viewerId ? "You" : this.escape(target?.name || "Recipient")}</strong></span>`}
      </div>
      <div class="offer-exchange">
        ${this.side(receiveLabel, receive, anyReceive, "receive")}
        <div class="offer-divider" aria-hidden="true"><span>⇅</span></div>
        ${this.side(giveLabel, give, anyGive, "give")}
      </div>
      <footer class="offer-footer">
        ${view.open ? '<div class="trade-responses" data-trade-responses></div>' : ""}
        <p class="trade-drafting" data-trade-drafting hidden></p>
        <p class="trade-feedback trade-response-status" data-trade-status role="status"></p>
        ${viewerGives && view.open ? '<div class="trade-countdown" data-trade-countdown hidden><span class="countdown-track" aria-hidden="true"><i></i></span><span data-countdown-text></span><button type="button" class="text-button" data-trade-action="pin">Keep thinking</button></div>' : ""}
        ${actions}
        ${!view.party && this.blocked(state, state.viewerId, trade.fromId) ? `<button type="button" class="text-button trade-unblock" data-trade-action="unblock">Unblock ${this.escape(from?.name || "player")}</button>` : ""}
      </footer>
    </article>`;
  }
  cardSignature(state, trade) {
    const view = this.perspective(state, trade);
    return JSON.stringify([trade.id, trade.fromId, trade.targetId, trade.counterTo, trade.anyGive || 0, trade.anyWant || 0,
      ...["give", "want"].map((side) => TRADE_RESOURCES.map((resource) => trade[side][resource] || 0)),
      view.sender, view.responder, this.meTooAllowed(state, trade), this.blocked(state, state.viewerId, trade.fromId),
      Boolean(this.trades(state).find((candidate) => candidate.id === trade.counterTo))]);
  }
  composerMarkup(state) {
    const host = this.isHost(state);
    const guide = host ? "This is not a bank exchange. Offer to all players at once, or choose one player. Cards move only when you complete a trade with someone who accepts."
      : "This is not a bank exchange. Choose who receives your offer; cards move only if they accept.";
    const anyCounter = (prefix) => `<div class="resource-counters any-counters"><label class="resource-counter any-counter" for="${prefix}-any"><span class="counter-resource"><span class="any-icon" aria-hidden="true">?</span>Any card</span><span class="counter-input"><button type="button" data-step="-1" data-input="${prefix}-any" aria-label="Remove one Any card">−</button><input id="${prefix}-any" type="number" min="0" max="4" step="1" value="0" inputmode="numeric" aria-label="Any card amount"><button type="button" data-step="1" data-input="${prefix}-any" aria-label="Add one Any card">+</button></span><span class="counter-limit">their choice</span></label></div>`;
    return `<div class="trade-offers-head"><h3>Active offers <span id="trade-offer-count" class="trade-offer-count">0</span></h3></div>
      <div id="trade-offers" class="trade-offer-stack"></div>
      <p id="trade-offers-empty" class="trade-feedback trade-offers-empty">No open offers.</p>
      <section id="trade-composer" class="trade-composer" aria-label="Create a player offer">
        <div class="trade-destination player-destination"><strong>Trading with a player</strong><p>${guide}</p></div>
        <p id="trade-status" class="trade-feedback" role="status"></p>
        <div id="trade-mode" class="trade-mode-banner hidden" role="status"><span id="trade-mode-text"></span><button type="button" id="trade-mode-cancel" class="text-button">Cancel</button></div>
        <div id="trade-targets"></div>
        <p id="trade-recipient" class="trade-recipient" role="status"></p>
        <h3 id="trade-give-heading" class="trade-side-heading">You give</h3>${this.bundleInputs("give", this.player(state, state.viewerId).resources)}${anyCounter("give")}
        <h3 id="trade-want-heading" class="trade-side-heading">You receive</h3>${this.bundleInputs("want")}${anyCounter("want")}
        <p id="trade-draft-status" class="trade-feedback" role="status"></p>
        <div class="offer-submit-row">
          <button id="offer-submit" class="secondary-button" aria-describedby="trade-recipient trade-draft-status">Choose a player first</button>
          <button id="offer-all-submit" class="secondary-button hidden" aria-describedby="trade-draft-status">Offer to all players</button>
          <button id="offer-bank-submit" class="secondary-button hidden" aria-describedby="trade-draft-status">Trade with bank instead</button>
        </div>
        <details id="trade-settings" class="trade-settings"><summary>Trade settings &amp; blocks</summary>
          <label class="trade-setting"><input id="trade-auto-decline" type="checkbox"> Auto-decline open offers I have not answered after ${Math.round(this.autoDeclineMs / 1000)} seconds</label>
          <div id="trade-blocks" class="trade-blocks"></div>
        </details>
      </section>`;
  }
  render() {
    const state = this.getState();
    if (!state) { this.reset(); return; }
    const scope = `${state.code}:${state.viewerId}:${state.turnNumber}`;
    if (scope !== this.scope) {
      this.reset();
      this.scope = scope;
      this.root.innerHTML = this.composerMarkup(state);
      document.getElementById("offer-submit").onclick = () => this.sendOffer("named");
      document.getElementById("offer-all-submit").onclick = () => this.sendOffer("all");
      document.getElementById("offer-bank-submit").onclick = () => this.sendBank();
      document.getElementById("trade-mode-cancel").onclick = () => this.exitMode(true);
      document.getElementById("trade-auto-decline").checked = this.autoDecline;
    }
    this.renderCards(state);
    const targets = state.players.filter((p) => p.id !== state.viewerId &&
      (state.currentPlayerId === state.viewerId || p.id === state.currentPlayerId));
    const rosterSignature = JSON.stringify([this.mode?.kind, this.mode?.targetId, targets.map(({ id, name, color }) => [id, name, color])]);
    if (rosterSignature !== this.rosterSignature) {
      const host = this.isHost(state);
      const title = this.mode?.kind === "counter" ? "1. Your counteroffer goes to" : host ? "1. Choose one player, or offer to all players below" : "1. Choose the player who gets your offer";
      if (this.mode) GameControls.reset("trade-target");
      const selected = this.mode ? this.mode.targetId || "" : GameControls.read("trade-target");
      document.getElementById("trade-targets").innerHTML = GameControls.playerPicker("trade-target", title, targets,
        { selected, disabled: this.mode?.kind === "counter", onChange: () => this.refresh() });
      this.rosterSignature = rosterSignature;
    }
    this.renderBlocks(state);
    this.refresh();
  }
  renderCards(state) {
    const stack = document.getElementById("trade-offers");
    const trades = this.ordered(this.trades(state));
    const live = new Set(trades.map((trade) => trade.id));
    for (const [id, card] of this.cards) if (!live.has(id)) { card.element.remove(); this.cards.delete(id); }
    let opened = false;
    trades.forEach((trade, index) => {
      // Keep controls alive through routine updates so pointer presses and focus survive.
      // New terms replace a card's controls, so an in-progress click can never accept them.
      const signature = this.cardSignature(state, trade);
      let card = this.cards.get(trade.id);
      if (!card || card.signature !== signature) {
        const holder = document.createElement("div");
        holder.innerHTML = this.cardMarkup(state, trade).trim();
        const element = holder.firstElementChild;
        if (!card) element.classList.add("is-new");
        if (card) card.element.replaceWith(element);
        card = { element, signature };
        this.cards.set(trade.id, card);
      }
      if (stack.children[index] !== card.element) stack.insertBefore(card.element, stack.children[index] || null);
      if (!this.seenAt.has(trade.id)) {
        this.seenAt.set(trade.id, Date.now());
        const view = this.perspective(state, trade);
        if (view.responder && !opened) opened = true;
      }
    });
    if (opened) {
      document.getElementById("trade-details").open = true;
      this.chooseTab("player");
    }
    if (this.mode && !live.has(this.mode.tradeId)) {
      const kind = this.mode.kind;
      this.exitMode(false);
      this.notify(kind === "counter" ? "The offer you were countering has closed. Your draft is kept as a new offer." : "Your offer closed before the edit was sent. Your draft is kept as a new offer.");
    }
    document.getElementById("trade-offer-count").textContent = String(trades.length);
    document.getElementById("trade-offers-empty").classList.toggle("hidden", trades.length > 0);
  }
  renderBlocks(state) {
    const node = document.getElementById("trade-blocks");
    const others = state.players.filter((p) => p.id !== state.viewerId);
    const signature = JSON.stringify([others.map((p) => [p.id, p.name, this.blocked(state, state.viewerId, p.id)])]);
    if (node.dataset.signature === signature) return;
    node.dataset.signature = signature;
    node.innerHTML = `<p class="small-note">Blocking stops that player's offers reaching you. You can still offer to them. Everyone can see blocks.</p>${others.map((p) => {
      const blocked = this.blocked(state, state.viewerId, p.id);
      return `<button type="button" class="secondary-button trade-block-toggle" data-embargo-player="${this.escape(p.id)}" aria-pressed="${blocked}"><span class="seat-chip" style="--seat-color:${this.escape(p.color)}"></span>${blocked ? "Unblock" : "Block"} ${this.escape(p.name)}</button>`;
    }).join("")}`;
  }
  draft() {
    const any = (prefix) => Number(document.getElementById(`${prefix}-any`).value);
    return { give: this.readBundle("give"), want: this.readBundle("want"), anyGive: any("give"), anyWant: any("want") };
  }
  bankDraftReason(state, self, draft) {
    if (!this.isHost(state) || this.mode?.kind === "counter" || !state.legal.canBankTrade) return "hidden";
    if (draft.anyGive || draft.anyWant) return "hidden";
    const rates = self.tradeRates || {};
    const sets = TRADE_RESOURCES.reduce((sum, r) => sum + (draft.give[r] && draft.give[r] % (rates[r] || 4) === 0 ? draft.give[r] / (rates[r] || 4) : 0), 0);
    const wanted = TRADE_RESOURCES.reduce((sum, r) => sum + draft.want[r], 0);
    if (!wanted || TRADE_RESOURCES.some((r) => draft.give[r] % (rates[r] || 4)) || sets !== wanted ||
        TRADE_RESOURCES.some((r) => draft.give[r] && draft.want[r]) || TRADE_RESOURCES.some((r) => draft.give[r] > self.resources[r]) ||
        TRADE_RESOURCES.some((r) => draft.want[r] > (state.bank?.[r] || 0))) return "hidden";
    return "";
  }
  refresh() {
    const state = this.getState();
    if (!state || !document.getElementById("offer-submit")) return;
    const self = this.player(state, state.viewerId);
    if (!self) return;
    const phase = this.phaseReason(state);
    const connection = !this.isReady() ? "Reconnecting. Wait for your saved seat before responding." :
      this.isBusy() ? "Waiting for server confirmation. Your saved request will retry safely." : "";
    document.getElementById("trade-status").textContent = phase ||
      "Trades happen after rolling and must involve the active player. Both players must agree.";
    for (const resource of TRADE_RESOURCES) {
      const give = document.getElementById(`give-${resource}`);
      give.max = String(self.resources[resource]);
      give.closest(".resource-counter").querySelector(".counter-limit").textContent = `${self.resources[resource]} available`;
    }
    const host = this.isHost(state);
    const unavailable = connection || phase;
    for (const input of document.querySelectorAll("#trade-composer .counter-input input")) input.disabled = Boolean(unavailable);
    for (const radio of this.root.querySelectorAll('[data-picker="trade-target"]')) radio.disabled = Boolean(unavailable) || this.mode?.kind === "counter";
    const draft = this.draft();
    const { give, want, anyGive, anyWant } = draft;
    const selectedId = this.mode?.kind === "counter" ? this.mode.targetId : GameControls.read("trade-target");
    const target = state.players.find((p) => p.id === selectedId && p.id !== state.viewerId &&
      (state.currentPlayerId === state.viewerId || p.id === state.currentPlayerId));
    document.getElementById("trade-recipient").textContent = target ? `Offer to: ${target.name}${target.connected ? "" : " (offline)"}`
      : host ? "No player selected. Choose one above, or offer to all players." : "No player selected. Choose a recipient above.";
    document.getElementById("trade-give-heading").textContent = target ? `You give to ${target.name}` : "You give";
    document.getElementById("trade-want-heading").textContent = target ? `You receive from ${target.name}` : "You receive";
    const limit = state.boardPlayerCount > 4 ? 24 : 19;
    const valid = [give, want].every((bundle) => TRADE_RESOURCES.every((r) => Number.isSafeInteger(bundle[r]) && bundle[r] >= 0 && bundle[r] <= limit)) &&
      [anyGive, anyWant].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= (state.tradeLimits?.maxAny ?? 4));
    const giveTotal = TRADE_RESOURCES.reduce((a, r) => a + (give[r] || 0), 0), wantTotal = TRADE_RESOURCES.reduce((a, r) => a + (want[r] || 0), 0);
    const missing = TRADE_RESOURCES.filter((r) => give[r] > self.resources[r]).map((r) => `${give[r] - self.resources[r]} more ${r}`);
    const spare = TRADE_RESOURCES.reduce((sum, r) => sum + (want[r] ? 0 : Math.max(0, self.resources[r] - give[r])), 0);
    const mine = this.trades(state).filter((trade) => trade.fromId === state.viewerId);
    const activeLimit = host ? state.tradeLimits?.activeTurnPlayer ?? 5 : state.tradeLimits?.activeOther ?? 3;
    const blockedBy = target && this.blocked(state, target.id, state.viewerId) ? `${target.name} blocked trading with you.` : "";
    const termsReason = !valid ? "Choose whole amounts within the card supply." :
      anyGive && anyWant ? "Use Any cards on only one side of a trade." :
      !(giveTotal + anyGive) || !(wantTotal + anyWant) ? "Choose at least one resource on each side." :
      TRADE_RESOURCES.some((r) => give[r] && want[r]) ? "A resource cannot appear on both sides of a trade." :
      missing.length ? `You need ${missing.join(", ")} to offer this trade.` :
      anyGive > spare ? "You do not hold enough other cards to offer Any cards." :
      this.mode?.kind !== "edit" && mine.length >= activeLimit ? `You have ${activeLimit} active offers. Withdraw or edit one first.` :
      !state.legal.canOfferTrade && this.mode?.kind !== "edit" ? "No eligible trading partner is available right now." : "";
    const draftReason = unavailable || (!target ? "Choose a player before sending an offer." : blockedBy || termsReason);
    const terms = `${[this.bundleText(give), anyGive ? `any ${anyGive}` : ""].filter(Boolean).join(" + ")} for ${[this.bundleText(want), anyWant ? `any ${anyWant}` : ""].filter(Boolean).join(" + ")}`;
    document.getElementById("trade-draft-status").textContent = !draftReason
      ? `You give ${[this.bundleText(give), anyGive ? `any ${anyGive} of your choice` : ""].filter(Boolean).join(" + ")} to ${target.name} and receive ${[this.bundleText(want), anyWant ? `any ${anyWant} of their choice` : ""].filter(Boolean).join(" + ")} from ${target.name} if they accept.`
      : !unavailable && !target && host && this.mode?.kind !== "counter" ? termsReason || `Choose a player, or offer ${terms} to all players.`
        : draftReason;
    const submit = document.getElementById("offer-submit");
    submit.disabled = Boolean(draftReason);
    submit.textContent = !target ? "Choose a player first" : this.mode?.kind === "counter" ? `Send counteroffer to ${target.name}`
      : this.mode?.kind === "edit" ? `Update offer to ${target.name}` : `Send offer to ${target.name}`;
    const offerAll = document.getElementById("offer-all-submit");
    offerAll.classList.toggle("hidden", !host || this.mode?.kind === "counter");
    offerAll.disabled = !host || Boolean(unavailable || termsReason);
    offerAll.textContent = this.mode?.kind === "edit" ? "Update offer to all players" : "Offer to all players";
    const bank = document.getElementById("offer-bank-submit");
    const bankReason = unavailable ? "hidden" : this.bankDraftReason(state, self, draft);
    bank.classList.toggle("hidden", bankReason === "hidden");
    bank.disabled = Boolean(bankReason);
    bank.textContent = `Trade with bank instead: ${this.bundleText(give)} → ${this.bundleText(want)}`;
    const modeTrade = this.mode && this.trades(state).find((trade) => trade.id === this.mode.tradeId);
    document.getElementById("trade-mode").classList.toggle("hidden", !modeTrade);
    if (modeTrade) {
      document.getElementById("trade-mode-text").textContent = this.mode.kind === "counter"
        ? `Countering ${this.name(state, modeTrade.fromId)}'s offer. ${modeTrade.anyGive || modeTrade.anyWant ? "Replace each Any card with the exact cards you want to trade." : "Adjust the cards, then send."}`
        : "Editing your offer. Sending replaces it, and players answer the new terms afresh.";
    }
    for (const trade of this.trades(state)) {
      const card = this.cards.get(trade.id);
      if (card) this.refreshCard(state, trade, card.element, { connection, phase, self });
    }
    GameControls.syncCounters(this.root);
  }
  refreshCard(state, trade, element, { connection, phase, self }) {
    const view = this.perspective(state, trade);
    const myResponse = view.open && view.responder ? trade.responses?.[state.viewerId] || null : null;
    const offerReason = trade.unavailableReason === "offered-resources-spent"
      ? "The sender no longer holds the offered cards. Decline or send a new counteroffer."
      : trade.unavailableReason === "trading-player-unavailable" ? "A trading player is no longer available." : "";
    const required = view.responder ? trade.want : trade.give;
    const shortage = view.party ? TRADE_RESOURCES.filter((r) => required[r] > self.resources[r]).map((r) => `${required[r] - self.resources[r]} more ${r}`) : [];
    const from = this.name(state, trade.fromId);
    const openEnded = Boolean(trade.anyGive || trade.anyWant);
    const responders = (trade.responders || []).map((id) => trade.responses?.[id] || "waiting");
    const count = (status) => responders.filter((response) => response === status).length;
    const status = connection || phase || offerReason || (
      openEnded && view.responder ? `${from} left part of this offer open. Counter with the exact cards you would trade.` :
      shortage.length && !(view.open && view.sender) ? `You need ${shortage.join(", ")} for this offer.` :
      view.open && view.sender ? `${count("accepted")} accepted · ${count("declined")} declined · ${count("waiting")} waiting. ${count("accepted") ? "Choose who to trade with; cards move only then." : "Cards move only when you choose a player who accepted."}` :
      view.open && view.responder && !myResponse && this.countered.has(trade.id) ? `You sent a counteroffer. ${from} can still trade with you on either offer.` :
      view.open && view.responder ? (myResponse === "accepted" ? `You accepted. ${from} chooses who completes the trade; you can still decline.`
        : myResponse === "declined" ? "You declined. You can still accept while the offer is open."
          : `${from} offered this to every player. Accept to show interest; ${from} then chooses one trading partner.`) :
      view.responder ? "Both sides exchange together. Review the cards before accepting." :
      view.sender ? `Waiting for ${this.name(state, trade.targetId)}. ${this.player(state, trade.targetId)?.connected ? "" : "Their seat is offline; the offer stays saved."}` :
      view.open ? "This offer is open to the other players." : "This offer is between the named players.");
    element.querySelector("[data-trade-status]").textContent = status;
    element.dataset.tradeState = !this.isReady() ? "offline" : this.isBusy() ? "pending" :
      phase || offerReason || shortage.length ? "blocked" : view.responder && myResponse !== "accepted" ? "ready" : view.party ? "waiting" : "observing";
    const button = (action) => element.querySelector(`[data-trade-action="${action}"]`);
    const accept = button("accept");
    if (accept) {
      accept.disabled = Boolean(connection || phase || offerReason || shortage.length || myResponse === "accepted");
      accept.textContent = this.isBusy() ? "Confirming..." : myResponse === "accepted" ? "Accepted" : `Accept trade with ${from}`;
    }
    const decline = button("decline");
    if (decline) {
      decline.disabled = Boolean(connection || phase || myResponse === "declined");
      decline.textContent = myResponse === "declined" ? "Declined" : "Decline";
    }
    const counter = button("counter");
    if (counter) {
      counter.disabled = Boolean(connection || phase);
      counter.setAttribute("aria-pressed", String(this.mode?.kind === "counter" && this.mode.tradeId === trade.id));
    }
    for (const action of ["withdraw", "edit", "unblock"]) if (button(action)) button(action).disabled = Boolean(connection || (action !== "unblock" && phase));
    const metoo = button("metoo");
    if (metoo) {
      const lacking = TRADE_RESOURCES.some((r) => trade.give[r] > self.resources[r]);
      metoo.disabled = Boolean(connection || phase || lacking);
      metoo.textContent = lacking ? "Me too: you lack these cards" : `Me too: offer the same to ${this.name(state, trade.targetId)}`;
    }
    this.renderResponses(state, trade, element);
    for (const node of element.querySelectorAll('[data-trade-action="complete"]')) node.disabled = Boolean(connection || phase || offerReason);
    const drafters = [...this.drafting].filter(([playerId, hint]) => hint.tradeId === trade.id && Date.now() - hint.at < this.draftingTtl &&
      playerId !== state.viewerId && state.players.some((p) => p.id === playerId)).map(([playerId]) => this.name(state, playerId));
    const drafting = element.querySelector("[data-trade-drafting]");
    drafting.hidden = !drafters.length;
    drafting.textContent = drafters.length ? `${drafters.join(", ")} ${drafters.length === 1 ? "is" : "are"} preparing a counteroffer…` : "";
    this.refreshCountdown(state, trade, element, { connection, phase, offerReason, myResponse });
  }
  renderResponses(state, trade, element) {
    const node = element.querySelector("[data-trade-responses]");
    if (!node) return;
    const sender = trade.fromId === state.viewerId;
    const drafting = (id) => { const hint = this.drafting.get(id); return hint?.tradeId === trade.id && Date.now() - hint.at < this.draftingTtl; };
    const rows = [...(trade.responders || []).map((id) => [id, trade.responses?.[id] || (drafting(id) ? "countering" : "waiting")]),
      ...(trade.blockedBy || []).map((id) => [id, "blocked"])]
      .map(([id, status]) => [id, this.name(state, id), this.player(state, id)?.color || "#999", status]);
    const signature = JSON.stringify([sender, state.viewerId, rows]);
    if (node.dataset.signature === signature) return;
    node.dataset.signature = signature;
    const labels = { accepted: "Accepted", declined: "Declined", waiting: "Thinking", countering: "Countering…", blocked: "Blocked" };
    node.innerHTML = `<h4 class="trade-responses-title">Table responses</h4><ul class="trade-response-list">${rows.map(([id, name, color, status]) =>
      `<li class="trade-response-row" data-player="${this.escape(id)}" data-response="${status}">
        <span class="offer-player"><i style="--seat-color:${this.escape(color)}" aria-hidden="true"></i><strong>${id === state.viewerId ? "You" : this.escape(name)}</strong></span>
        <span class="trade-response-state" title="${this.escape(status === "blocked" ? `${name} blocked trading with ${this.name(state, trade.fromId)}` : `${name}: ${labels[status]}`)}">${labels[status]}</span>
        ${sender && status === "accepted" ? `<button type="button" class="primary-button trade-confirm" data-trade-action="complete" data-partner="${this.escape(id)}">Trade with ${this.escape(name)}</button>` : ""}
      </li>`).join("")}</ul>`;
  }
  refreshCountdown(state, trade, element, { connection, phase, offerReason, myResponse }) {
    const node = element.querySelector("[data-trade-countdown]");
    if (!node) return;
    const countering = this.mode?.kind === "counter" && this.mode.tradeId === trade.id;
    const active = this.autoDecline && !myResponse && !this.pinned.has(trade.id) && !countering && !this.countered.has(trade.id) &&
      !connection && !phase && !offerReason;
    const pinned = !myResponse && this.pinned.has(trade.id);
    node.hidden = !(active || pinned);
    const remaining = Math.max(0, this.autoDeclineMs - (Date.now() - (this.seenAt.get(trade.id) ?? Date.now())));
    node.querySelector("i").style.width = `${pinned ? 100 : Math.round(100 * remaining / this.autoDeclineMs)}%`;
    node.querySelector("[data-countdown-text]").textContent = pinned ? "You're still thinking; this offer stays open until you answer."
      : `Auto-declines in ${Math.ceil(remaining / 1000)}s`;
    node.querySelector('[data-trade-action="pin"]').hidden = pinned;
    if (active && remaining <= 0 && !this.autoDeclined.has(trade.id) && !this.isBusy()) {
      this.autoDeclined.add(trade.id);
      this.submit({ type: "respondTrade", accept: false, tradeId: trade.id });
    }
  }
  tick() {
    const state = this.getState();
    if (!state || !this.scope) return;
    for (const [playerId, hint] of this.drafting) if (Date.now() - hint.at >= this.draftingTtl) this.drafting.delete(playerId);
    if (this.trades(state).length) this.refresh();
  }
  onClick(event) {
    const embargo = event.target.closest("[data-embargo-player]");
    if (embargo) { this.toggleBlock(embargo.dataset.embargoPlayer); return; }
    const control = event.target.closest("[data-trade-action]");
    const element = control?.closest("[data-trade-id]");
    if (!control || !element || control.disabled) return;
    const state = this.getState();
    const trade = this.trades(state).find((candidate) => candidate.id === element.dataset.tradeId);
    if (!trade) { this.notify("That offer has closed. No further response can be sent."); return; }
    const action = control.dataset.tradeAction;
    if (action === "accept" || action === "decline") this.respond(trade.id, action === "accept");
    else if (action === "withdraw") this.withdraw(trade.id);
    else if (action === "complete") this.complete(trade.id, control.dataset.partner);
    else if (action === "counter") this.enterMode("counter", trade);
    else if (action === "edit") this.enterMode("edit", trade);
    else if (action === "metoo") this.meToo(trade);
    else if (action === "unblock") this.toggleBlock(trade.fromId);
    else if (action === "pin") { this.pinned.add(trade.id); this.refresh(); }
  }
  // Re-read state after refresh so a stale click can never act on replaced terms.
  current(id, selector) {
    this.refresh();
    const card = this.cards.get(id)?.element;
    const button = card?.querySelector(selector);
    if (!button || button.disabled) return null;
    if (!this.trades(this.getState()).some((trade) => trade.id === id)) {
      this.notify("The offer changed. Review its new terms before responding.");
      return null;
    }
    return button;
  }
  respond(id, accept) {
    if (this.current(id, `[data-trade-action="${accept ? "accept" : "decline"}"]`)) this.submit({ type: "respondTrade", accept, tradeId: id });
  }
  withdraw(id) {
    if (this.current(id, '[data-trade-action="withdraw"]')) this.submit({ type: "cancelTrade", tradeId: id });
  }
  complete(id, partnerId) {
    const button = this.current(id, `[data-trade-action="complete"][data-partner="${CSS.escape(partnerId)}"]`);
    if (button) this.submit({ type: "confirmTrade", tradeId: id, partnerId });
  }
  async meToo(trade) {
    if (!this.current(trade.id, '[data-trade-action="metoo"]')) return;
    const state = this.getState();
    const original = this.trades(state).find((candidate) => candidate.id === trade.counterTo);
    const linked = original && (original.responders || []).includes(state.viewerId);
    await this.submit({ type: "offerTrade", targetId: trade.targetId, give: { ...trade.give }, want: { ...trade.want }, ...(linked ? { counterTo: original.id } : {}) });
  }
  async toggleBlock(playerId) {
    const state = this.getState();
    if (!this.isReady() || this.isBusy() || !this.player(state, playerId)) return;
    const blocked = !this.blocked(state, state.viewerId, playerId);
    if (await this.submit({ type: "setEmbargo", playerId, blocked })) {
      this.notify(blocked ? `You blocked trading with ${this.name(state, playerId)}.` : `You unblocked trading with ${this.name(state, playerId)}.`);
    }
  }
  fill({ give = {}, want = {}, anyGive = 0, anyWant = 0 }) {
    for (const resource of TRADE_RESOURCES) {
      document.getElementById(`give-${resource}`).value = String(give[resource] || 0);
      document.getElementById(`want-${resource}`).value = String(want[resource] || 0);
    }
    document.getElementById("give-any").value = String(anyGive);
    document.getElementById("want-any").value = String(anyWant);
  }
  enterMode(kind, trade) {
    if (this.mode?.kind === "counter") this.announceDrafting(null);
    clearInterval(this.draftingTimer);
    this.mode = { kind, tradeId: trade.id, targetId: kind === "counter" ? trade.fromId : trade.targetId };
    // A counter swaps sides; Any cards must become the exact cards the counterparty will trade.
    if (kind === "counter") this.fill({ give: trade.want, want: trade.give });
    else this.fill(trade);
    this.rosterSignature = null;
    document.getElementById("trade-details").open = true;
    this.chooseTab("player");
    this.render();
    if (kind === "counter") {
      this.announceDrafting(trade.id);
      this.draftingTimer = setInterval(() => this.announceDrafting(this.mode?.kind === "counter" ? this.mode.tradeId : null), 6000);
    }
    const composer = document.getElementById("trade-composer");
    composer.scrollIntoView?.({ block: "nearest" });
    document.getElementById("give-wood")?.focus({ preventScroll: true });
  }
  exitMode(clear) {
    if (this.mode?.kind === "counter") this.announceDrafting(null);
    clearInterval(this.draftingTimer);
    this.mode = null;
    this.rosterSignature = null;
    if (clear && document.getElementById("give-any")) this.fill({});
    GameControls.reset("trade-target");
    if (this.scope) this.render();
  }
  announceDrafting(tradeId) {
    if (this.isReady()) this.socket?.emit("tradeDrafting", { tradeId }, () => {});
  }
  addFromHand(resource) {
    const state = this.getState();
    const self = state && this.player(state, state.viewerId);
    const input = document.getElementById(`give-${resource}`);
    if (!self || !input || input.disabled) return false;
    const next = Math.min(self.resources[resource], (Number(input.value) || 0) + 1);
    if (next === Number(input.value)) { this.notify(`All your ${resource} is already in the offer.`); return false; }
    input.value = String(next);
    this.refresh();
    return true;
  }
  async sendOffer(kind) {
    this.refresh();
    const button = document.getElementById(kind === "all" ? "offer-all-submit" : "offer-submit");
    if (button.disabled) return;
    const state = this.getState();
    if (this.mode && !this.trades(state).some((trade) => trade.id === this.mode.tradeId)) {
      this.notify("The offer changed. Review your draft before sending."); return;
    }
    const { give, want, anyGive, anyWant } = this.draft();
    const payload = { type: "offerTrade", give, want, ...(anyGive ? { anyGive } : {}), ...(anyWant ? { anyWant } : {}) };
    const countering = this.mode?.kind === "counter" ? this.mode.tradeId : null;
    if (countering) payload.counterTo = countering;
    else {
      payload.targetId = kind === "all" ? null : GameControls.read("trade-target");
      if (this.mode?.kind === "edit") payload.replaceTradeId = this.mode.tradeId;
    }
    if (await this.submit(payload)) {
      if (countering) this.countered.add(countering);
      this.exitMode(true);
    }
  }
  async sendBank() {
    this.refresh();
    if (document.getElementById("offer-bank-submit").disabled) return;
    const { give, want } = this.draft();
    const compact = (bundle) => Object.fromEntries(TRADE_RESOURCES.filter((r) => bundle[r]).map((r) => [r, bundle[r]]));
    if (await this.submit({ type: "bankTrade", give: compact(give), want: compact(want) })) this.exitMode(true);
  }
};
