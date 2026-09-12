"use strict";

window.PlayerNameplates = class PlayerNameplates {
  constructor({ root, openCards, removePlayer }) {
    Object.assign(this, { root, openCards, removePlayer });
    this.plates = new Map();
    root.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button || !root.contains(button) || button.disabled) return;
      if (button.dataset.publicPlayer) this.openCards(button.dataset.publicPlayer);
      else if (button.dataset.player) this.removePlayer(button.dataset.player);
    });
  }
  create(playerId) {
    const node = document.createElement("article");
    node.className = "player-card player-nameplate nameplate-plaque";
    node.dataset.nameplatePlayer = playerId;
    node.innerHTML = `<div class="nameplate-heading">
        <span class="seat-number"><b></b></span>
        <div class="nameplate-identity"><span class="player-name"></span><span class="nameplate-tags"><span class="nameplate-you">You</span><span class="admin-chip">${Tabletop.icon("crown")}Admin</span></span></div>
        <span class="player-score"><strong></strong><small>VP</small></span>
      </div>
      <div class="nameplate-presence"><span class="player-sub"><i class="status-dot" aria-hidden="true"></i><span></span></span><span class="role-label"></span></div>
      <div class="player-stats nameplate-metrics"></div>
      <div class="player-awards"></div>
      <div class="nameplate-alerts"></div>
      <div class="nameplate-footer"></div>`;
    const plate = {
      node, seat: node.querySelector(".seat-number"), number: node.querySelector(".seat-number b"),
      name: node.querySelector(".player-name"), tags: node.querySelector(".nameplate-tags"),
      you: node.querySelector(".nameplate-you"), admin: node.querySelector(".admin-chip"),
      score: node.querySelector(".player-score"), scoreValue: node.querySelector(".player-score strong"),
      status: node.querySelector(".player-sub > span"), dot: node.querySelector(".status-dot"),
      role: node.querySelector(".role-label"), metrics: node.querySelector(".nameplate-metrics"),
      awards: node.querySelector(".player-awards"), alerts: node.querySelector(".nameplate-alerts"),
      footer: node.querySelector(".nameplate-footer"), values: {},
    };
    const metrics = [
      ["resources", "Resources", "resources", "Resource cards in hand; resource types remain private"],
      ["development", "Dev cards", "cards", "Unplayed development cards; faces remain private"],
      ["road", "Longest road", "road", "Length of the player's longest unbroken road"],
      ["knights", "Played knights", "knight", "Publicly played Knights counted toward Largest Army"],
    ];
    for (const [key, label, icon, title] of metrics) {
      const metric = document.createElement("div");
      metric.className = "player-metric";
      metric.dataset.stat = key;
      metric.title = title;
      metric.innerHTML = `${Tabletop.icon(icon)}<b></b><span class="metric-label">${label}</span>`;
      plate.metrics.appendChild(metric);
      plate.values[key] = metric.querySelector("b");
    }
    return plate;
  }
  badges(container, values) {
    const signature = JSON.stringify(values);
    if (container.dataset.signature !== signature) {
      container.replaceChildren(...values.map(([className, text, icon]) => {
        const badge = document.createElement("span");
        badge.className = className;
        if (icon) badge.innerHTML = Tabletop.icon(icon);
        badge.appendChild(document.createTextNode(text));
        return badge;
      }));
      container.dataset.signature = signature;
    }
    container.classList.toggle("hidden", values.length === 0);
  }
  render(state, isAdmin) {
    const ids = new Set(state.players.map((player) => player.id));
    for (const [id, plate] of this.plates) {
      if (!ids.has(id)) { plate.node.remove(); this.plates.delete(id); }
    }
    state.players.forEach((player, index) => {
      let plate = this.plates.get(player.id);
      if (!plate) { plate = this.create(player.id); this.plates.set(player.id, plate); }
      // Preserve buttons through routine updates: a peer event must not swallow clicks or focus.
      if (this.root.children[index] !== plate.node) this.root.insertBefore(plate.node, this.root.children[index] || null);
      const self = player.id === state.viewerId;
      const admin = player.id === state.hostId;
      const active = !["lobby", "finished"].includes(state.phase) && state.currentPlayerId === player.id;
      const winner = state.phase === "finished" && state.winnerId === player.id;
      plate.node.style.setProperty("--player-color", player.color);
      plate.node.classList.toggle("current", active);
      plate.node.classList.toggle("offline", !player.connected);
      plate.node.classList.toggle("winner", winner);
      plate.node.classList.toggle("own-seat", self);
      plate.node.setAttribute("aria-label", `${player.name}${self ? ", your seat" : ""}`);
      if (active) plate.node.setAttribute("aria-current", "true");
      else plate.node.removeAttribute("aria-current");
      plate.number.textContent = String(index + 1);
      plate.seat.setAttribute("aria-label", `Seat ${index + 1}`);
      plate.name.textContent = player.name;
      plate.name.title = player.name;
      plate.you.classList.toggle("hidden", !self);
      plate.admin.classList.toggle("hidden", !admin);
      plate.tags.classList.toggle("hidden", !self && !admin);
      plate.scoreValue.textContent = state.phase === "lobby" ? "–" : String(player.points);
      plate.score.title = self ? "Your total, including hidden victory cards" : "Visible victory points";
      plate.score.setAttribute("aria-label", state.phase === "lobby" ? "Score starts when the game begins" : `${player.points} victory points`);
      plate.status.textContent = player.connected ? "Online" : "Offline · seat saved";
      plate.dot.classList.toggle("online", player.connected);
      plate.role.classList.toggle("hidden", !active && !winner);
      plate.role.textContent = winner ? "Winner" : active ? `${self ? "Your turn" : "Playing"}${state.turnRole === "secondary" ? " · paired" : ""}` : "";
      plate.metrics.classList.toggle("hidden", state.phase === "lobby");
      for (const [key, value] of Object.entries({
        resources: player.resourceCount, development: player.developmentCount || 0,
        road: player.longestRoad || 0, knights: player.knightsPlayed || 0,
      })) plate.values[key].textContent = String(value);
      const awards = [];
      if (player.id === state.longestRoadHolderId) awards.push(["bonus-label", "Longest Road +2", "road"]);
      if (player.id === state.largestArmyHolderId) awards.push(["bonus-label", "Largest Army +2", "knight"]);
      this.badges(plate.awards, awards);
      const alerts = [];
      if (state.pendingDiscards?.[player.id]) alerts.push(["discard-owed-badge", `Must return ${state.pendingDiscards[player.id]} cards`]);
      if ((state.removalRequests || []).some((request) => request.playerId === player.id)) alerts.push(["pending-removal-badge", "Removal requested"]);
      this.badges(plate.alerts, alerts);
      if (state.phase !== "lobby" && !plate.cards) {
        plate.cards = document.createElement("button");
        plate.cards.type = "button";
        plate.cards.className = "public-cards-link";
        plate.cards.dataset.publicPlayer = player.id;
        plate.cards.innerHTML = `${Tabletop.icon("cards")}<span>Public cards</span><span aria-hidden="true">↗</span>`;
        plate.footer.prepend(plate.cards);
      } else if (state.phase === "lobby" && plate.cards) {
        plate.cards.remove(); plate.cards = null;
      }
      plate.cards?.setAttribute("aria-label", `View ${player.name}'s public development cards`);
      const canRemove = state.phase !== "finished" && isAdmin && !self;
      if (canRemove && !plate.remove) {
        plate.remove = document.createElement("button");
        plate.remove.type = "button";
        plate.remove.className = "text-button remove-player";
        plate.remove.dataset.player = player.id;
        plate.remove.textContent = "Remove";
        plate.footer.appendChild(plate.remove);
      } else if (!canRemove && plate.remove) {
        plate.remove.remove(); plate.remove = null;
      }
      plate.remove?.setAttribute("aria-label", `Review removal of ${player.name}`);
      plate.footer.classList.toggle("hidden", !plate.cards && !plate.remove);
    });
  }
};
