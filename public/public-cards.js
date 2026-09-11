"use strict";

window.PublicCardsGallery = class PublicCardsGallery {
  constructor({ getState }) {
    this.getState = getState;
    this.dialog = document.getElementById("public-cards-dialog");
    this.playerId = null;
    this.rosterSignature = null;
    document.getElementById("close-public-cards").onclick = () => this.close();
    document.getElementById("public-cards-done").onclick = () => this.close();
    this.dialog.addEventListener("close", () => {
      const openerId = this.openerId;
      this.playerId = null;
      const nextDialog = document.querySelector("dialog[open]");
      if (!nextDialog) {
        document.querySelector(`[data-public-player="${openerId}"]`)?.focus();
      } else if (!nextDialog.contains(document.activeElement)) {
        nextDialog.querySelector("button:not(:disabled), input:not(:disabled), [tabindex='0']")?.focus();
      }
    });
  }
  counts(player) {
    // Older servers/saves can always report Knights, but cannot invent discarded cards.
    return player.revealedDevelopment || {
      knight: player.knightsPlayed || 0,
      roadBuilding: 0, yearOfPlenty: 0, monopoly: 0, historyComplete: false,
    };
  }
  open(playerId) {
    const state = this.getState();
    if (!state || state.phase === "lobby" || !state.players.some((player) => player.id === playerId)) return;
    this.playerId = playerId;
    this.openerId = playerId;
    GameControls.close(false);
    GameControls.reset("public-player-choice");
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
  }
  close() { this.dialog.close(); this.playerId = null; }
  update() { if (this.dialog.open) this.render(); }
  render() {
    const state = this.getState();
    const player = state?.players.find((candidate) => candidate.id === this.playerId);
    if (!player || state.phase === "lobby") { this.close(); return; }
    const counts = this.counts(player);
    document.getElementById("public-cards-title").textContent = `${player.name}'s public cards`;
    this.dialog.style.setProperty("--public-player-color", player.color);
    const picker = GameControls.playerPicker(
      "public-player-choice", "View a player", state.players,
      { selected: player.id, onChange: (id) => { this.playerId = id; this.render(); } },
    );
    const rosterSignature = JSON.stringify(state.players.map(({ id, name, color }) => [id, name, color]));
    if (rosterSignature !== this.rosterSignature) {
      const focusedPlayer = document.activeElement?.dataset.picker === "public-player-choice";
      document.getElementById("public-card-players").innerHTML = picker;
      this.rosterSignature = rosterSignature;
      if (focusedPlayer) this.dialog.querySelector(`[data-value="${player.id}"]`)?.focus();
    }
    GameControls.set("public-player-choice", player.id);
    const revealedVictory = state.phase === "finished" ? counts.victoryPoint || 0 : 0;
    const privateCount = Math.max(0, player.developmentCount - revealedVictory);
    document.getElementById("public-card-privacy").textContent =
      `${privateCount} unplayed ${privateCount === 1 ? "card remains" : "cards remain"} private. This view never exposes anyone's unrevealed hand.`;
    document.getElementById("public-knights").innerHTML = counts.knight > 0
      ? GameCards.revealed("knight", counts.knight, "Knight", "Face-up · counts toward Largest Army")
      : '<div class="public-cards-empty"><span aria-hidden="true">—</span>No Knights played.</div>';
    document.getElementById("public-knight-caption").textContent =
      `${counts.knight} played ${counts.knight === 1 ? "Knight" : "Knights"}${state.largestArmyHolderId === player.id ? " · Largest Army +2 VP" : ""}`;
    const names = { roadBuilding: "Road Building", yearOfPlenty: "Year of Plenty", monopoly: "Monopoly" };
    document.getElementById("public-progress").innerHTML = Object.entries(names)
      .filter(([type]) => counts[type] > 0)
      .map(([type, name]) => GameCards.revealed(type, counts[type], name, "Used · already in the discard pile"))
      .join("") || `<div class="public-cards-empty"><span aria-hidden="true">—</span>${counts.historyComplete ? "No progress cards played this match." : "No progress-card plays are recorded."}</div>`;
    document.getElementById("public-history-warning").classList.toggle("hidden", counts.historyComplete);
    const victoryVisible = state.phase === "finished" && Object.hasOwn(counts, "victoryPoint");
    document.getElementById("public-victory-section").classList.toggle("hidden", !victoryVisible);
    document.getElementById("public-victory").innerHTML = victoryVisible && counts.victoryPoint > 0
      ? GameCards.revealed("victoryPoint", counts.victoryPoint, "Victory Point", "Revealed at game end")
      : '<div class="public-cards-empty">No victory-point cards revealed.</div>';
  }
};
