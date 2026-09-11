"use strict";

window.BoardPlacement = class BoardPlacement {
  constructor({ svg, getState, getPlacement, isReady, isBusy, isPointing, isDragging, submit, cancelBuild, describe, announce }) {
    Object.assign(this, { svg, getState, getPlacement, isReady, isBusy, isPointing, isDragging, submit, cancelBuild, describe, announce });
    this.selection = null;
    this.context = null;
    this.focusedId = null;
    this.targets = [];
    this.submitting = false;
    this.toolbar = document.getElementById("placement-toolbar");
    this.confirmButton = document.getElementById("confirm-placement");
    this.cancelButton = document.getElementById("cancel-placement");
    this.undoButton = document.getElementById("undo-placement");
    this.confirmButton.onclick = () => this.confirm();
    this.cancelButton.onclick = () => this.cancel();
    this.undoButton.onclick = () => this.undo();
    svg.addEventListener("click", (event) => {
      if (this.isPointing() || this.isDragging() || event.altKey || !this.isReady() || this.isBusy()) return;
      const target = this.hitTest(event.clientX, event.clientY);
      if (target) this.preview(target.id);
    });
    svg.addEventListener("keydown", (event) => this.keydown(event));
  }
  reset() {
    this.selection = null;
    this.context = null;
    this.focusedId = null;
    this.targets = [];
    this.toolbar.classList.add("hidden");
    document.body.classList.remove("placement-preview-active");
  }
  cancel() {
    if (this.submitting || this.isBusy()) return;
    this.selection = null;
    this.cancelBuild();
  }
  preview(id) {
    const placement = this.getPlacement();
    if (!this.isReady() || this.isBusy() || !placement?.ids.includes(id)) return;
    this.selection = { id, type: placement.type, key: placement.key, context: this.context };
    this.focusedId = id;
    this.render();
  }
  async confirm() {
    const placement = this.getPlacement();
    const selected = this.selection;
    if (this.submitting || !this.isReady() || this.isBusy() || !selected) return;
    if (selected.context !== this.context || placement?.type !== selected.type || !placement.ids.includes(selected.id)) {
      this.selection = null;
      this.announce("That placement is no longer available. Choose a highlighted location.");
      this.render();
      return;
    }
    this.submitting = true;
    this.controls();
    try {
      if (await this.submit({ type: selected.type, [selected.key]: selected.id })) this.selection = null;
    } finally {
      this.submitting = false;
      this.render();
    }
  }
  async undo() {
    const state = this.getState();
    if (this.isBusy() || !this.isReady() || !state?.legal.canUndoPlacement || !state.undoPlacement) return;
    this.selection = null;
    await this.submit({ type: "undoPlacement", placementId: state.undoPlacement.id });
  }
  controls() {
    const state = this.getState();
    const placement = state && this.getPlacement();
    const waiting = !this.isReady() || this.isBusy() || this.submitting;
    this.toolbar.classList.toggle("hidden", !this.selection);
    this.confirmButton.disabled = waiting || !this.selection;
    this.cancelButton.disabled = this.isBusy() || this.submitting;
    document.getElementById("end-turn").disabled = waiting || Boolean(this.selection);
    this.confirmButton.textContent = this.submitting ? "Placing..." : placement?.type === "moveRobber" ? "Move robber here" : "Confirm placement";
    if (this.selection && placement) {
      document.getElementById("placement-title").textContent = placement.type === "moveRobber" ? "Move the robber here?" : `Place ${placement.label} here?`;
      document.getElementById("placement-detail").textContent = this.describe(this.selection.id);
      document.getElementById("placement-warning").textContent = state.phase === "setup" && state.setupNeedsRoad
        ? "Confirming this road finishes your setup turn."
        : placement.type === "moveRobber" ? "Choose a victim next, if eligible. Theft cannot be undone."
          : "Preview only. Tap another location to change it.";
    }
    const undo = state?.undoPlacement;
    this.undoButton.classList.toggle("hidden", !state || ["lobby", "finished"].includes(state.phase));
    this.undoButton.disabled = waiting || !state?.legal.canUndoPlacement;
    this.undoButton.querySelector("span").textContent = undo?.type === "setupSettlement" ? "Undo settlement" :
      undo?.type === "buildCity" ? "Undo city" : undo ? undo.label : "Undo";
    this.undoButton.setAttribute("aria-label", undo ? undo.label : "Undo last placement");
    this.undoButton.title = undo ? `${undo.label} (Ctrl+Z / Cmd+Z)` : "Undo becomes available after a placement, until a turn handoff or irreversible action.";
    document.body.classList.toggle("placement-preview-active", Boolean(this.selection));
    if (this.selection) document.body.style.setProperty("--placement-tray-height", `${Math.ceil(this.toolbar.getBoundingClientRect().height)}px`);
  }
  targetGeometry(placement, state) {
    const vertices = new Map(state.board.vertices.map((vertex) => [vertex.id, vertex]));
    const edges = new Map(state.board.edges.map((edge) => [edge.id, edge]));
    const tiles = new Map(state.board.tiles.map((tile) => [tile.id, tile]));
    return placement.ids.map((id) => {
      if (placement.key === "edgeId") {
        const edge = edges.get(id);
        const a = vertices.get(edge.vertices[0]);
        const b = vertices.get(edge.vertices[1]);
        return { id, x: (a.x + b.x) * 50, y: (a.y + b.y) * 50,
          a: { x: (a.x * .8 + b.x * .2) * 100, y: (a.y * .8 + b.y * .2) * 100 },
          b: { x: (a.x * .2 + b.x * .8) * 100, y: (a.y * .2 + b.y * .8) * 100 } };
      }
      const point = (placement.key === "tileId" ? tiles : vertices).get(id);
      return { id, x: point.x * 100, y: point.y * 100 };
    });
  }
  hitTest(x, y) {
    if (!this.targets.length) return null;
    const matrix = this.svg.getScreenCTM();
    if (!matrix) return null;
    const placement = this.getPlacement();
    const pointer = new DOMPoint(x, y).matrixTransform(matrix.inverse());
    if (placement?.key === "tileId") {
      return this.targets.find((target) => {
        const dx = Math.abs(pointer.x - target.x);
        const dy = Math.abs(pointer.y - target.y);
        return dx <= 86.603 && dy <= 100 && dx / 1.73206 + dy <= 100;
      }) || null;
    }
    let nearest = null;
    let distance = 23;
    for (const target of this.targets) {
      let point = new DOMPoint(target.x, target.y).matrixTransform(matrix);
      if (target.a) {
        const a = new DOMPoint(target.a.x, target.a.y).matrixTransform(matrix);
        const b = new DOMPoint(target.b.x, target.b.y).matrixTransform(matrix);
        const dx = b.x - a.x, dy = b.y - a.y;
        const fraction = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)));
        point = { x: a.x + fraction * dx, y: a.y + fraction * dy };
      }
      const candidate = Math.hypot(point.x - x, point.y - y);
      if (candidate < distance) { nearest = target; distance = candidate; }
    }
    return nearest;
  }
  keydown(event) {
    const node = event.target.closest("[data-place]");
    if (!node || this.isPointing()) return;
    if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      this.preview(node.dataset.place);
    } else if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const index = this.targets.findIndex((target) => target.id === node.dataset.place);
      const next = event.key === "Home" ? 0 : event.key === "End" ? this.targets.length - 1 :
        (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + this.targets.length) % this.targets.length;
      this.focusedId = this.targets[next].id;
      this.svg.querySelectorAll("[data-place]").forEach((target) => { target.tabIndex = target.dataset.place === this.focusedId ? 0 : -1; });
      this.svg.querySelector(`[data-place="${this.focusedId}"]`).focus({ preventScroll: true });
    }
  }
  render() {
    const state = this.getState();
    const placement = state && !this.isPointing() ? this.getPlacement() : null;
    const context = state && `${state.code}:${state.viewerId}:${state.currentPlayerId}:${state.turnNumber}:${state.phase}:${placement?.type}:${state.setupNeedsRoad}:${state.freeRoadsRemaining}`;
    if (this.selection && (context !== this.context || !placement?.ids.includes(this.selection.id))) this.selection = null;
    this.context = context;
    this.controls();
    const layer = this.svg.querySelector("#placement-layer");
    if (!layer) return;
    const focused = document.activeElement?.closest?.("[data-place]")?.dataset.place;
    this.targets = placement ? this.targetGeometry(placement, state) : [];
    if (!this.targets.some((target) => target.id === this.focusedId)) this.focusedId = this.targets[0]?.id || null;
    const color = state?.players.find((player) => player.id === state.viewerId)?.color || "#c7a75e";
    layer.style.setProperty("--placement-color", color);
    const matrix = this.svg.getScreenCTM();
    const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 1;
    const radius = Math.min(36, Math.max(16, 9 / scale));
    const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    layer.innerHTML = this.targets.map((target) => {
      const selected = this.selection?.id === target.id;
      let marker;
      if (target.a) {
        marker = `<line class="placement-road-outline" x1="${target.a.x}" y1="${target.a.y}" x2="${target.b.x}" y2="${target.b.y}"/><line class="placement-road-mark" x1="${target.a.x}" y1="${target.a.y}" x2="${target.b.x}" y2="${target.b.y}"/>`;
      } else if (placement.key === "tileId") {
        marker = `<polygon class="placement-hex" transform="translate(${target.x} ${target.y})" points="0,-100 86.603,-50 86.603,50 0,100 -86.603,50 -86.603,-50"/>`;
        if (selected) {
          const tile = state.board.tiles.find((tile) => tile.id === target.id);
          marker += `<g class="placement-ghost" transform="translate(${target.x + (tile.number ? 49 : 0)} ${target.y - 14})">${this.svg.querySelector("#robber-layer .robber").innerHTML}</g>`;
        }
      } else {
        const kind = placement.type === "buildCity" ? "city" : "settlement";
        marker = `<circle class="placement-node" cx="${target.x}" cy="${target.y}" r="${radius}"/><path class="placement-plus" d="M${target.x - radius * .4} ${target.y}h${radius * .8}M${target.x} ${target.y - radius * .4}v${radius * .8}"/><g class="placement-piece" transform="translate(${target.x} ${target.y})">${Tabletop.building(kind, color)}</g>`;
      }
      return `<g class="map-choice placement-target ${selected ? "placement-selected" : ""}" data-place="${target.id}" role="button" tabindex="${this.focusedId === target.id ? 0 : -1}" aria-pressed="${selected}" aria-label="${escape(`Preview ${placement.label}: ${this.describe(target.id)}`)}">${marker}</g>`;
    }).join("");
    if (focused) this.svg.querySelector(`[data-place="${focused}"]`)?.focus({ preventScroll: true });
  }
};
