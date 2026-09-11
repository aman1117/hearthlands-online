"use strict";

window.MapPresence = class MapPresence {
  constructor({ socket, svg, getState, announce }) {
    this.socket = socket;
    this.svg = svg;
    this.getState = getState;
    this.announce = announce;
    this.enabled = localStorage.getItem("hearthlands-pointers") !== "off";
    this.pingMode = false;
    this.cursors = new Map();
    this.pings = new Map();
    this.lastPoint = null;
    this.lastClientPoint = null;
    this.lastSent = 0;
    this.lastPing = 0;
    this.version = null;
    this.room = null;
    this.pendingTimer = null;
    svg.addEventListener("pointermove", (event) => this.move(event));
    svg.addEventListener("pointerleave", () => this.leave());
    svg.addEventListener("click", (event) => {
      if (!this.pingMode && !event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      const coordinates = this.coordinates(event);
      if (coordinates) this.ping(coordinates);
    }, true);
    svg.addEventListener("keydown", (event) => {
      if (!this.pingMode || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const target = event.target.closest("[data-tile]");
      const tile = this.getState()?.board?.tiles.find((tile) => tile.id === target?.dataset.tile);
      const box = svg.viewBox.baseVal;
      if (tile) this.ping({ x: (tile.x * 100 - box.x) / box.width, y: (tile.y * 100 - box.y) / box.height });
    }, true);
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.leave(); });
    window.addEventListener("blur", () => this.leave());
    socket.on("disconnect", () => this.clear());
    socket.on("sessionReplaced", () => this.clear());
    socket.on("removedFromRoom", () => this.clear());
    socket.on("mapPresence", (message) => this.receive(message));
    this.interval = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, pointer] of this.cursors) if (now - pointer.received > 4000) { this.cursors.delete(id); changed = true; }
      for (const [id, ping] of this.pings) if (now - ping.received > 2500) { this.pings.delete(id); changed = true; }
      if (changed) this.render();
      if (this.lastPoint && this.enabled && !document.hidden && now - this.lastSent > 1000) this.flush();
    }, 400);
    this.observer = new ResizeObserver(() => this.render());
    this.observer.observe(svg);
  }
  ready() {
    const state = this.getState();
    return this.socket.connected && state?.board && state.players.find((p) => p.id === state.viewerId)?.connected;
  }
  coordinates(event) {
    const matrix = this.svg.getScreenCTM();
    const box = this.svg.viewBox.baseVal;
    if (!matrix || !box.width || !box.height) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const x = (point.x - box.x) / box.width;
    const y = (point.y - box.y) / box.height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  }
  move(event) {
    if (!this.enabled || !this.ready()) return;
    this.lastClientPoint = { clientX: event.clientX, clientY: event.clientY };
    const point = this.coordinates(event);
    if (!point) { this.leave(); return; }
    this.lastPoint = point;
    const wait = 85 - (Date.now() - this.lastSent);
    if (wait <= 0) this.flush();
    else if (!this.pendingTimer) this.pendingTimer = setTimeout(() => { this.pendingTimer = null; this.flush(); }, wait);
  }
  flush() {
    if (!this.enabled || !this.lastPoint || !this.ready() || document.hidden) return;
    this.lastSent = Date.now();
    this.socket.volatile.emit("mapPointer", { ...this.lastPoint, visible: true, mapVersion: this.getState().mapVersion ?? 0 });
  }
  refreshPosition() {
    if (this.lastClientPoint) this.move(this.lastClientPoint);
    this.render();
  }
  leave() {
    clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    if (this.lastPoint && this.ready()) this.socket.emit("mapPointer", { visible: false, mapVersion: this.getState().mapVersion ?? 0 });
    this.lastPoint = null;
    this.lastClientPoint = null;
  }
  ping(coordinates) {
    if (!this.ready() || Date.now() - this.lastPing < 650) return;
    this.lastPing = Date.now();
    this.socket.emit("mapPing", { ...coordinates, mapVersion: this.getState().mapVersion ?? 0 });
  }
  setEnabled(enabled) {
    if (!enabled) this.leave();
    this.enabled = enabled;
    localStorage.setItem("hearthlands-pointers", enabled ? "on" : "off");
    this.render();
  }
  setPingMode(enabled) {
    this.pingMode = enabled;
    this.svg.classList.toggle("point-mode", enabled);
  }
  update(state) {
    const version = state.mapVersion ?? 0;
    if (this.version !== version || this.room !== state.code) this.clear();
    this.version = version;
    this.room = state.code;
    for (const id of this.cursors.keys()) {
      if (!state.players.some((p) => p.id === id && p.connected)) this.cursors.delete(id);
    }
  }
  clear() {
    clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.lastPoint = null;
    this.lastClientPoint = null;
    this.cursors.clear();
    this.pings.clear();
    this.render();
  }
  receive(message) {
    const state = this.getState();
    if (!state || !message || message.mapVersion !== (state.mapVersion ?? 0)) return;
    if (message.kind === "clear") { this.clear(); return; }
    if (message.kind === "leave") {
      this.cursors.delete(message.playerId);
      if (message.reason !== "cursor") this.pings.delete(message.playerId);
      this.render();
      return;
    }
    const owner = state.players.find((p) => p.id === message.playerId && p.connected);
    if (!owner || !Number.isFinite(message.x) || !Number.isFinite(message.y) ||
        message.x < 0 || message.x > 1 || message.y < 0 || message.y > 1) return;
    const data = { ...message, name: owner.name, color: owner.color, received: Date.now() };
    if (message.kind === "pointer" && owner.id !== state.viewerId) this.cursors.set(owner.id, data);
    if (message.kind === "ping") {
      this.pings.set(owner.id, data);
      this.announce(`${owner.name} pointed to the map.`);
    }
    this.render();
  }
  render() {
    if (!this.svg.querySelector("#map-scene")) return;
    let layer = this.svg.querySelector("#presence-layer");
    if (!layer) {
      layer = document.createElementNS("http://www.w3.org/2000/svg", "g");
      layer.id = "presence-layer";
      layer.setAttribute("aria-hidden", "true");
      this.svg.appendChild(layer);
    }
    layer.replaceChildren();
    const box = this.svg.viewBox.baseVal;
    const matrix = this.svg.getScreenCTM();
    const scale = matrix ? 1 / Math.max(.1, Math.hypot(matrix.a, matrix.b)) : 1;
    const node = (tag, attributes) => {
      const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
      return element;
    };
    const draw = (data, ping) => {
      const group = node("g", {
        transform: `translate(${box.x + data.x * box.width} ${box.y + data.y * box.height}) scale(${scale})`,
        class: ping ? "shared-ping" : "shared-pointer", "data-player-id": data.playerId,
        "data-map-x": data.x, "data-map-y": data.y,
      });
      if (ping) {
        const age = Date.now() - data.received;
        const ring = node("circle", { r: 15, fill: "none", stroke: data.color, "stroke-width": 2.5, class: "ping-ring", style: `animation-delay:-${age}ms` });
        const echo = node("circle", { r: 15, fill: "none", stroke: data.color, "stroke-width": 1.7, class: "ping-ring ping-echo", style: `animation-delay:${450 - age}ms` });
        group.append(ring, echo, node("circle", { r: 4, fill: data.color, stroke: "#fff", "stroke-width": 1.5, class: "ping-core" }));
      } else {
        group.appendChild(node("path", { d: "M0 0 4 21l5-7 7-2Z", fill: data.color, stroke: "#fff", "stroke-width": 1.6 }));
      }
      const width = data.name.length * 6.5 + 18;
      const x = data.x > .72 ? -width - 8 : 14;
      const y = ping ? -33 : 15;
      group.appendChild(node("rect", { x, y, width, height: 23, rx: 6, fill: data.color, stroke: "#fff", "stroke-width": 1 }));
      const text = node("text", { x: x + 9, y: y + 15, class: "presence-name" });
      text.textContent = data.name;
      group.appendChild(text);
      layer.appendChild(group);
    };
    if (this.enabled) for (const cursor of this.cursors.values()) draw(cursor, false);
    for (const ping of this.pings.values()) draw(ping, true);
  }
};
