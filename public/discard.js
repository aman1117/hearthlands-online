"use strict";

window.DiscardDialog = class DiscardDialog {
  constructor({ getState, isBusy, isReady, submit }) {
    Object.assign(this, { getState, isBusy, isReady, submit });
    this.dialog = document.getElementById("discard-dialog");
    this.key = null;
    this.minimized = false;
    this.completedTurn = null;
    document.getElementById("discard-form").onsubmit = async (event) => {
      event.preventDefault();
      this.refresh();
      if (document.getElementById("submit-discard").disabled) return;
      await this.submit(this.bundle());
    };
    document.getElementById("discard-view-board").onclick = () => this.minimize();
    this.dialog.addEventListener("cancel", (event) => { event.preventDefault(); this.minimize(); });
    this.dialog.addEventListener("input", () => this.refresh());
  }
  bundle() {
    return Object.fromEntries(["wood", "brick", "sheep", "wheat", "ore"].map((resource) => [
      resource, Number(document.getElementById(`discard-${resource}`).value),
    ]));
  }
  update(state) {
    const required = state.pendingDiscards?.[state.viewerId] || 0;
    const self = state.players.find((player) => player.id === state.viewerId);
    if (!required || !self) {
      if (this.key && self) this.completedTurn = state.turnNumber;
      this.key = null;
      this.minimized = false;
      this.dialog.close();
      document.getElementById("discard-selection").replaceChildren();
      return;
    }
    const key = `${state.code}:${state.viewerId}:${required}:${["wood", "brick", "sheep", "wheat", "ore"].map((resource) => self.resources[resource]).join(":")}`;
    if (key !== this.key) {
      this.key = key;
      this.completedTurn = null;
      this.minimized = false;
      document.getElementById("discard-required").textContent = String(required);
      document.getElementById("discard-total").textContent = String(self.resourceCount);
      document.getElementById("discard-keep").textContent = String(self.resourceCount - required);
      document.getElementById("discard-selection").innerHTML = ["wood", "brick", "sheep", "wheat", "ore"]
        .map((resource) => GameControls.counter("discard", resource, self.resources[resource], true)).join("");
      this.open();
    }
    this.refresh();
  }
  open() {
    if (!this.key) return;
    this.minimized = false;
    GameControls.close(false);
    document.querySelectorAll("dialog[open]").forEach((dialog) => { if (dialog !== this.dialog) dialog.close(); });
    // Disable unavailable steppers before the dialog chooses its initial focus target.
    this.refresh();
    if (!this.dialog.open) this.dialog.showModal();
  }
  minimize() { this.minimized = true; this.dialog.close(); }
  refresh() {
    const state = this.getState();
    const required = state?.pendingDiscards?.[state.viewerId];
    if (!this.key || !required || !document.getElementById("discard-wood")) return;
    const self = state.players.find((player) => player.id === state.viewerId);
    if (!self) return;
    const bundle = this.bundle();
    const selected = Object.values(bundle).reduce((sum, count) => sum + count, 0);
    const valid = Object.entries(bundle).every(([resource, count]) =>
      Number.isInteger(count) && count >= 0 && count <= self.resources[resource]);
    const missing = required - selected;
    const summary = !valid ? "Choose whole amounts from the cards you hold." : missing > 0
      ? `Choose ${missing} more ${missing === 1 ? "card" : "cards"}.` : missing < 0
        ? `Deselect ${-missing} ${missing === -1 ? "card" : "cards"}.` : "Ready to return these cards.";
    document.getElementById("discard-count").textContent = `${valid ? `${selected} of ${required} selected. ` : ""}${summary}`;
    const progress = document.getElementById("discard-progress");
    progress.max = required;
    progress.value = valid ? Math.max(0, Math.min(selected, required)) : 0;
    const button = document.getElementById("submit-discard");
    button.disabled = !valid || selected !== required || this.isBusy() || !this.isReady();
    button.textContent = this.isBusy() ? "Waiting for confirmation…" : `Return ${required} cards to bank`;
    this.dialog.dataset.selection = valid && selected === required ? "ready" : !valid || selected > required ? "invalid" : "choosing";
    this.dialog.querySelectorAll("#discard-selection input").forEach((input) => { input.disabled = this.isBusy() || !this.isReady(); });
    for (const [resource, count] of Object.entries(bundle)) {
      document.getElementById(`discard-${resource}`).closest(".resource-counter").classList.toggle("selected-for-discard", count > 0);
    }
    GameControls.syncCounters(this.dialog);
  }
  reset() {
    this.key = null;
    this.completedTurn = null;
    this.minimized = false;
    this.dialog.close();
    document.getElementById("discard-selection").replaceChildren();
  }
};
