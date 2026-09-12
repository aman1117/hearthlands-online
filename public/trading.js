"use strict";

window.TradePanel = class TradePanel {
  constructor({ getState, isBusy, isReady, submit, chooseTab, bundleInputs, readBundle, bundleText, escape, notify }) {
    Object.assign(this, { getState, isBusy, isReady, submit, chooseTab, bundleInputs, readBundle, bundleText, escape, notify });
    this.root = document.getElementById("player-trade");
    this.scope = null;
    this.offerSignature = null;
    this.rosterSignature = null;
    this.tradeId = null;
    this.draftTradeId = null;
    this.root.addEventListener("input", () => this.refresh());
  }
  reset() {
    this.scope = this.offerSignature = this.rosterSignature = this.tradeId = this.draftTradeId = null;
    this.root.replaceChildren();
    GameControls.reset("trade-target");
  }
  phaseReason(state) {
    if (state.turnRole === "secondary") return "Paired turns allow bank trades only, not player trades.";
    if (state.phase === "roll") return "The active player must roll the dice before anyone can trade.";
    if (state.phase === "discard") return "Trading waits until all discards, the robber move and any theft are finished.";
    if (state.phase === "robber" || state.phase === "steal") return "Finish moving the robber and any theft before trading.";
    if (state.freeRoadsRemaining) return "Finish placing free roads before trading.";
    return state.phase !== "action" ? "Trading is unavailable in this phase." : "";
  }
  offerCard(trade, from, target, viewerId) {
    const recipient = trade.targetId === viewerId;
    const sender = trade.fromId === viewerId;
    const party = recipient || sender;
    const receive = recipient || !party ? trade.give : trade.want;
    const give = recipient || !party ? trade.want : trade.give;
    const side = (label, bundle, direction) => {
      const total = ["wood", "brick", "sheep", "wheat", "ore"].reduce((sum, resource) => sum + (bundle[resource] || 0), 0);
      return `<section class="offer-side offer-side-${direction}" data-trade-direction="${direction}" aria-label="${this.escape(label)}">
        <div class="offer-side-heading"><h4>${this.escape(label)}</h4><span>${total} ${total === 1 ? "card" : "cards"}</span></div>
        <ul class="trade-resource-list">${GameCards.tradeResources(bundle)}</ul>
      </section>`;
    };
    return `<article id="trade-offer-card" class="trade-offer table-trade-card" aria-labelledby="trade-offer-title">
      <header class="offer-heading"><span class="offer-seal" aria-hidden="true">${Tabletop.icon("cards")}</span>
        <div><span class="offer-eyebrow">TRADING POST</span><h3 id="trade-offer-title">Trade offer</h3></div>
        <span class="offer-badge">${recipient ? "For you" : sender ? "Your offer" : "At the table"}</span>
      </header>
      <div class="offer-participants" aria-label="${this.escape(`${from.name} offers ${target.name}`)}">
        <span class="offer-player"><i style="--seat-color:${this.escape(from.color)}" aria-hidden="true"></i><strong>${sender ? "You" : this.escape(from.name)}</strong></span>
        <span class="offer-to" aria-hidden="true">→</span>
        <span class="offer-player"><i style="--seat-color:${this.escape(target.color)}" aria-hidden="true"></i><strong>${recipient ? "You" : this.escape(target.name)}</strong></span>
      </div>
      <div class="offer-exchange">
        ${side(party ? "You receive" : `${from.name} gives`, receive, "receive")}
        <div class="offer-divider" aria-hidden="true"><span>⇅</span></div>
        ${side(party ? "You give" : `${target.name} gives`, give, "give")}
      </div>
      <footer class="offer-footer">
        <p id="trade-response-status" class="trade-feedback" role="status"></p>
        ${recipient ? '<div class="trade-response"><button id="decline-trade" class="action-button trade-decline">Decline</button><button id="accept-trade" class="primary-button trade-accept" aria-describedby="trade-response-status">Accept trade</button></div>' : ""}
        ${sender ? '<button id="cancel-trade" class="secondary-button trade-cancel">Withdraw offer</button>' : ""}
      </footer>
    </article>`;
  }
  render() {
    const state = this.getState();
    if (!state) { this.reset(); return; }
    const scope = `${state.code}:${state.viewerId}:${state.turnNumber}`;
    if (scope !== this.scope) {
      this.reset();
      this.scope = scope;
      this.root.innerHTML = '<div id="current-trade"></div><p id="trade-status" class="trade-feedback" role="status"></p><div id="trade-targets"></div>' +
        `<h3 class="trade-side-heading">You give</h3>${this.bundleInputs("give", state.players.find((p) => p.id === state.viewerId).resources)}` +
        `<h3 class="trade-side-heading">You receive</h3>${this.bundleInputs("want")}` +
        '<p id="trade-draft-status" class="trade-feedback" role="status"></p><button id="offer-submit" class="secondary-button">Send offer</button>';
      document.getElementById("offer-submit").onclick = () => this.sendOffer();
    }
    const trade = state.trade;
    // Keep controls alive through routine state/presence updates so pointer presses and focus survive.
    // Replacing the actual offer replaces its controls: an in-progress click must not accept new terms.
    const signature = trade ? JSON.stringify([
      trade.id, trade.fromId, trade.targetId,
      ...["give", "want"].map((side) => ["wood", "brick", "sheep", "wheat", "ore"].map((resource) => trade[side][resource] || 0)),
    ]) : "null";
    if (signature !== this.offerSignature) {
      const previousId = this.tradeId;
      this.offerSignature = signature;
      this.tradeId = trade?.id || null;
      const from = state.players.find((p) => p.id === trade?.fromId);
      const target = state.players.find((p) => p.id === trade?.targetId);
      const recipient = trade?.targetId === state.viewerId;
      const sender = trade?.fromId === state.viewerId;
      const offer = document.getElementById("current-trade");
      offer.innerHTML = trade && from && target
        ? this.offerCard(trade, from, target, state.viewerId)
        : previousId ? '<p class="trade-feedback">The previous offer has closed. No further response can be sent.</p>' : "";
      if (trade) {
        const accept = document.getElementById("accept-trade"), decline = document.getElementById("decline-trade");
        if (accept) accept.onclick = () => this.respond(trade.id, true);
        if (decline) decline.onclick = () => this.respond(trade.id, false);
        const cancel = document.getElementById("cancel-trade");
        if (cancel) cancel.onclick = () => this.cancel(trade.id);
      }
      if (this.tradeId !== previousId) {
        for (const prefix of ["give", "want"]) for (const resource of ["wood", "brick", "sheep", "wheat", "ore"]) {
          document.getElementById(`${prefix}-${resource}`).value = "0";
        }
        this.draftTradeId = this.tradeId;
        this.rosterSignature = null;
        GameControls.reset("trade-target");
        if (trade && (sender || recipient)) {
          document.getElementById("trade-details").open = true;
          this.chooseTab("player");
        }
      }
    }
    const targets = state.players.filter((p) => p.id !== state.viewerId &&
      (state.currentPlayerId === state.viewerId || p.id === state.currentPlayerId));
    const rosterSignature = JSON.stringify(targets.map(({ id, name, color }) => [id, name, color]));
    const selected = trade?.targetId === state.viewerId ? trade.fromId : trade?.fromId === state.viewerId ? trade.targetId : targets[0]?.id;
    const picker = GameControls.playerPicker("trade-target", "Trade with", targets, { selected, onChange: () => this.refresh() });
    if (rosterSignature !== this.rosterSignature) {
      document.getElementById("trade-targets").innerHTML = picker;
      this.rosterSignature = rosterSignature;
    }
    this.refresh();
  }
  refresh() {
    const state = this.getState();
    if (!state || !document.getElementById("offer-submit")) return;
    const self = state.players.find((p) => p.id === state.viewerId);
    if (!self) return;
    const phase = this.phaseReason(state);
    const connection = !this.isReady() ? "Reconnecting. Wait for your saved seat before responding." :
      this.isBusy() ? "Waiting for server confirmation. Your saved request will retry safely." : "";
    const trade = state.trade;
    document.getElementById("trade-status").textContent = phase ||
      "Trades happen after rolling and must involve the active player. Both players must agree.";
    const resources = ["wood", "brick", "sheep", "wheat", "ore"];
    for (const resource of resources) {
      const give = document.getElementById(`give-${resource}`);
      give.max = String(self.resources[resource]);
      give.closest(".resource-counter").querySelector(".counter-limit").textContent = `${self.resources[resource]} available`;
    }
    const party = trade && [trade.fromId, trade.targetId].includes(state.viewerId);
    const unavailable = connection || phase || (trade && !party ? "Another offer is pending. Wait for it to close." : "");
    for (const input of this.root.querySelectorAll(".counter-input input")) input.disabled = Boolean(unavailable);
    for (const radio of this.root.querySelectorAll('[data-picker="trade-target"]')) radio.disabled = Boolean(unavailable);
    const give = this.readBundle("give"), want = this.readBundle("want");
    const valid = [give, want].every((bundle) => resources.every((r) => Number.isSafeInteger(bundle[r]) && bundle[r] >= 0 && bundle[r] <= (state.boardPlayerCount > 4 ? 24 : 19)));
    const giveTotal = Object.values(give).reduce((a, b) => a + b, 0), wantTotal = Object.values(want).reduce((a, b) => a + b, 0);
    const missing = resources.filter((r) => give[r] > self.resources[r]).map((r) => `${give[r] - self.resources[r]} more ${r}`);
    const draftReason = unavailable || (!valid ? "Choose whole amounts within the card supply." :
      !giveTotal || !wantTotal ? "Choose at least one resource on each side." :
      resources.some((r) => give[r] && want[r]) ? "A resource cannot appear on both sides of a trade." :
      missing.length ? `You need ${missing.join(", ")} to offer this trade.` :
      !state.legal.canOfferTrade ? "No eligible trading partner is available right now." : "");
    document.getElementById("trade-draft-status").textContent = draftReason ||
      `${this.bundleText(give)} for ${this.bundleText(want)}. Only these terms will be sent.`;
    const submit = document.getElementById("offer-submit");
    submit.disabled = Boolean(draftReason);
    submit.textContent = trade && party ? "Send counteroffer" : "Send offer";
    const responseStatus = document.getElementById("trade-response-status");
    if (responseStatus && trade) {
      const offerReason = state.tradeUnavailableReason === "offered-resources-spent"
        ? "The sender no longer holds the offered cards. Decline or send a new counteroffer."
        : state.tradeUnavailableReason === "trading-player-unavailable" ? "A trading player is no longer available." : "";
      const required = trade.targetId === state.viewerId ? trade.want : trade.give;
      const shortage = party ? resources.filter((r) => required[r] > self.resources[r]).map((r) => `${required[r] - self.resources[r]} more ${r}`) : [];
      const responseReason = connection || phase || offerReason || (shortage.length ? `You need ${shortage.join(", ")} for this offer.` :
        trade.targetId === state.viewerId ? "Both sides exchange together. Review the cards before accepting." :
          trade.fromId === state.viewerId ? `Waiting for the recipient. ${state.players.find((p) => p.id === trade.targetId)?.connected ? "" : "Their seat is offline; the offer stays saved."}` :
            "This offer is between the named players.");
      responseStatus.textContent = responseReason;
      document.getElementById("trade-offer-card").dataset.tradeState = !this.isReady() ? "offline" : this.isBusy() ? "pending" :
        phase || offerReason || shortage.length ? "blocked" : trade.targetId === state.viewerId ? "ready" : party ? "waiting" : "observing";
      const accept = document.getElementById("accept-trade");
      if (accept) {
        accept.disabled = Boolean(connection || phase || offerReason || shortage.length);
        accept.textContent = this.isBusy() ? "Confirming..." : "Accept trade";
      }
      const decline = document.getElementById("decline-trade"), cancel = document.getElementById("cancel-trade");
      if (decline) decline.disabled = Boolean(connection || phase);
      if (cancel) cancel.disabled = Boolean(connection || phase);
    }
    GameControls.syncCounters(this.root);
  }
  respond(id, accept) {
    this.refresh();
    const button = document.getElementById(accept ? "accept-trade" : "decline-trade");
    if (!button || button.disabled) return;
    if (this.getState().trade?.id !== id) { this.notify("The offer changed. Review its new terms before responding."); return; }
    this.submit({ type: "respondTrade", accept, tradeId: id });
  }
  cancel(id) {
    this.refresh();
    if (document.getElementById("cancel-trade")?.disabled || this.getState().trade?.id !== id) return;
    this.submit({ type: "cancelTrade", tradeId: id });
  }
  sendOffer() {
    this.refresh();
    if (document.getElementById("offer-submit").disabled) return;
    if ((this.getState().trade?.id || null) !== this.draftTradeId) {
      this.notify("The offer changed. Review your draft before sending."); return;
    }
    this.submit({ type: "offerTrade", targetId: GameControls.read("trade-target"),
      give: this.readBundle("give"), want: this.readBundle("want"), replaceTradeId: this.draftTradeId });
  }
};
