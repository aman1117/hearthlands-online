"use strict";

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGameServer } = require("../server");
const { createRoom, addPlayer, startGame, applyAction, publicState } = require("../game");
const { choose } = require("./ui.cjs");

class WireGate {
  constructor() {
    this.holdRequests = false;
    this.holdResponses = false;
    this.buffer = [];
    this.requests = [];
  }
  async attach(context) {
    await context.routeWebSocket(/\/socket\.io\//, (client) => {
      const upstream = client.connectToServer();
      client.onMessage((message) => {
        let action = null;
        if (typeof message === "string" && message.startsWith("42") && message.includes("[")) {
          const packet = JSON.parse(message.slice(message.indexOf("[")));
          if (["gameAction", "resignGame", "createRoom", "joinRoom"].includes(packet[0])) {
            action = { event: packet[0], ...packet[1] };
            this.requests.push(action);
          }
        }
        if (action && this.holdRequests) this.buffer.push({ target: upstream, message });
        else upstream.send(message);
      });
      upstream.onMessage((message) => {
        const appMessage = typeof message === "string" && (message.startsWith("42") || message.startsWith("43") || message === "41");
        if (this.holdResponses && appMessage) this.buffer.push({ target: client, message });
        else client.send(message);
      });
    });
  }
  release() {
    this.holdRequests = false;
    this.holdResponses = false;
    const buffered = this.buffer.splice(0);
    for (const item of buffered) item.target.send(item.message);
  }
}

function buildFixture(count, inventory, lobby = false) {
  const { room, player: host } = createRoom("Rowan");
  ["Mira", "Ellis", "Noa", "Sage", "Ash"].slice(0, count - 1).forEach((name) => addPlayer(room, name));
  if (lobby) {
    room.code = "NETEST";
    room.updatedAt = Date.now();
    return room;
  }
  startGame(room, host.id, () => .999);
  while (room.phase === "setup") {
    const actor = room.players[room.turnIndex];
    const view = publicState(room, actor.id);
    applyAction(room, actor.id, view.setupNeedsRoad
      ? { type: "setupRoad", edgeId: view.legal.roadEdges[0] }
      : { type: "setupSettlement", vertexId: view.legal.settlementVertices[0] });
  }
  if (inventory) {
    applyAction(room, host.id, { type: "roll" }, () => .1);
    for (const [resource, amount] of Object.entries({ wood: 3, brick: 2, sheep: 2, wheat: 4, ore: 5 })) {
      room.bank[resource] -= amount;
      host.resources[resource] += amount;
    }
    applyAction(room, host.id, { type: "buyDevelopment" });
    applyAction(room, host.id, { type: "buyDevelopment" });
    const site = room.board.vertices.find((vertex) => vertex.structure?.playerId === host.id);
    applyAction(room, host.id, { type: "buildCity", vertexId: site.id });
  }
  room.code = "NETEST";
  room.updatedAt = Date.now();
  return room;
}

async function setup(browser, { count = 3, inventory = false, gate, lobby = false } = {}) {
  const initial = buildFixture(count, inventory, lobby);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-resilience-"));
  fs.writeFileSync(path.join(dataDir, "NETEST.json"), JSON.stringify({ version: 2, room: initial }));
  const service = createGameServer({ dataDir, random: () => .1 });
  const port = await service.listen();
  const services = [service];
  const contexts = [];
  const pages = [];
  async function connect(index, { storageState, root = false, useGate = false } = {}) {
    const context = await browser.newContext({ storageState });
    contexts.push(context);
    if (useGate && gate) await gate.attach(context);
    const page = await context.newPage();
    pages.push(page);
    await page.goto(`http://127.0.0.1:${port}/${storageState && !root ? "?room=NETEST" : ""}`);
    await page.waitForFunction(() => socket.connected);
    if (!storageState) {
      await page.locator(".resume-details > summary").click();
      await page.locator("#resume-key").fill(initial.players[index].reconnectToken);
      await page.locator("#import-session").click();
    }
    if (!root) await page.waitForFunction(() => Boolean(state) && bound && !busy);
    await page.waitForFunction(() => socket.io.engine.transport.name === "websocket");
    return { page, context };
  }
  const actor = await connect(0, { useGate: Boolean(gate) });
  const others = [];
  for (let i = 1; i < count; i++) others.push(await connect(i));
  const read = () => services[services.length - 1].storage.getRoom("NETEST");
  return {
    initial, actor, others, contexts, pages, services, dataDir, port, service, read, connect,
    async restart(days = 0) {
      await services[services.length - 1].close();
      const now = Date.now() + days * 24 * 60 * 60 * 1000;
      const replacement = createGameServer({ dataDir, random: () => .1, now: () => now });
      services.push(replacement);
      await replacement.listen(port);
    },
    async close() {
      for (const context of contexts) await context.close();
      for (const item of services) await item.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function rolls(room) { return room.log.filter((entry) => entry.message.includes(" rolled ")).length; }
async function pendingId(page) {
  return page.evaluate(() => connection.record()?.pending?.payload.requestId);
}
async function clickResign(page) {
  await page.locator(".room-settings").evaluate((node) => { node.open = true; });
  await page.locator("#resign-game").click();
  await expect(page.locator("#confirm-resign")).toBeDisabled();
  if (await page.locator("#successor-field").isVisible()) {
    const successor = await page.evaluate(() => state.players.find((p) => p.id !== state.viewerId).id);
    await choose(page, "successor-choice", successor);
  }
  await page.locator("#resign-confirmed").check();
  await page.locator("#confirm-resign").click();
}

test("slow responses retry the same roll, animate while pending, and apply exactly once", async ({ browser }) => {
  const gate = new WireGate();
  const t = await setup(browser, { gate });
  try {
    const page = t.actor.page;
    const before = rolls(await t.read());
    gate.holdResponses = true;
    await page.locator("#roll-button").click();
    await expect(page.locator(".dice-stage")).toHaveClass(/is-rolling/);
    const id = await pendingId(page);
    expect(id).toBeTruthy();
    await expect.poll(() => gate.requests.filter((request) => request.type === "roll").length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    expect(new Set(gate.requests.map((request) => request.requestId)).size).toBe(1);
    expect(await pendingId(page)).toBe(id);
    expect(rolls(await t.read()) - before).toBe(1);
    await expect(page.locator(".dice-space").first()).toHaveAttribute("aria-label", "Rolling die");
    gate.release();
    await page.waitForFunction(() => !busy && state.phase === "action");
    expect(await pendingId(page)).toBeUndefined();
    await expect(page.locator(".dice-stage")).toContainText("Rolled 2");
    await page.locator("#end-turn").click();
    await page.waitForFunction(() => !busy && state.currentPlayerId !== state.viewerId);
    expect(rolls(await t.read()) - before).toBe(1);
  } finally { await t.close(); }
});

for (const committed of [false, true]) {
  test(`browser closure ${committed ? "after" : "before"} commit recovers the saved request without a duplicate roll`, async ({ browser }) => {
    const gate = new WireGate();
    const t = await setup(browser, { gate });
    try {
      const before = rolls(await t.read());
      gate.holdRequests = !committed;
      gate.holdResponses = committed;
      await t.actor.page.locator("#roll-button").click();
      await expect.poll(() => gate.requests.length).toBeGreaterThan(0);
      if (committed) await expect.poll(async () => rolls(await t.read())).toBe(before + 1);
      const id = await pendingId(t.actor.page);
      const storageState = await t.actor.context.storageState();
      await t.actor.context.close();
      await expect.poll(async () => (await t.read()).players[0].connected).toBe(false);
      const reopened = await t.connect(0, { storageState });
      await reopened.page.waitForFunction(() => !busy && state.phase === "action");
      expect(rolls(await t.read()) - before).toBe(1);
      expect(await pendingId(reopened.page)).toBeUndefined();
      const outcome = await reopened.page.evaluate(() => connection.record().lastOutcome);
      expect(outcome.requestId).toBe(id);
      expect(outcome.ok).toBe(true);
    } finally { await t.close(); }
  });
}

test("closing browsers preserves holdings and a game can be resumed two weeks later after restart", async ({ browser }) => {
  const t = await setup(browser, { inventory: true });
  try {
    const before = await t.read();
    const storageStates = [];
    for (const context of t.contexts) storageStates.push(await context.storageState());
    for (const context of t.contexts) await context.close();
    await expect.poll(async () => (await t.read()).players.filter((player) => player.connected).length).toBe(0);
    const offline = await t.read();
    expect(offline.players[0].resigned || false).toBe(false);
    expect(offline.players[0].resources).toEqual(before.players[0].resources);
    expect(offline.players[0].developmentCards).toEqual(before.players[0].developmentCards);
    expect(offline.board).toEqual(before.board);
    await t.restart(14);
    const restored = await t.connect(0, { storageState: storageStates[0], root: true });
    await expect(restored.page.locator("#saved-games")).toContainText("NETEST");
    await restored.page.locator('[data-room="NETEST"]').click();
    await restored.page.waitForFunction(() => bound && !busy && state?.code === "NETEST");
    const view = await restored.page.evaluate(() => state);
    expect(view.board).toEqual(before.board);
    expect(view.players.find((player) => player.id === view.viewerId).resources).toEqual(before.players[0].resources);
    expect(view.players.find((player) => player.id === view.viewerId).developmentCount).toBe(before.players[0].developmentCards.length);
    expect(view.phase).toBe(before.phase);
  } finally { await t.close(); }
});

test("save-and-exit retains multiple tables without surrendering either seat", async ({ browser }) => {
  const t = await setup(browser, { inventory: true });
  try {
    const page = t.actor.page;
    const original = await page.evaluate(() => ({ board: state.board, resources: state.players.find((p) => p.id === state.viewerId).resources }));
    await page.locator(".room-settings").evaluate((node) => { node.open = true; });
    await page.locator("#leave-screen").click();
    await expect(page.locator("#landing")).toBeVisible();
    await page.waitForFunction(() => socket.connected);
    await page.locator("#player-name").fill("Second table");
    await page.locator("#create-room").click();
    await page.waitForFunction(() => state?.code && state.code !== "NETEST" && !busy);
    const otherCode = await page.evaluate(() => state.code);
    await page.locator(".room-settings").evaluate((node) => { node.open = true; });
    await page.locator("#leave-screen").click();
    await expect(page.locator("#saved-games")).toContainText("NETEST");
    await expect(page.locator("#saved-games")).toContainText(otherCode);
    await page.locator('[data-room="NETEST"]').click();
    await page.waitForFunction(() => state?.code === "NETEST" && bound && !busy);
    expect(await page.evaluate(() => state.board)).toEqual(original.board);
    expect(await page.evaluate(() => state.players.find((p) => p.id === state.viewerId).resources)).toEqual(original.resources);
    expect((await t.read()).players[0].resigned || false).toBe(false);
  } finally { await t.close(); }
});

test("joining again with a stored room and name restores the existing seat", async ({ browser }) => {
  const t = await setup(browser, { inventory: true });
  try {
    const page = t.actor.page;
    const before = await page.evaluate(() => ({ id: state.viewerId, resources: state.players.find((p) => p.id === state.viewerId).resources }));
    await page.locator(".room-settings").evaluate((node) => { node.open = true; });
    await page.locator("#leave-screen").click();
    await page.waitForFunction(() => socket.connected);
    await page.locator("#player-name").fill("Rowan");
    await page.locator("#room-code").fill("NETEST");
    await page.locator("#join-room").click();
    await page.waitForFunction((id) => state?.viewerId === id && bound && !busy, before.id);
    expect(await page.evaluate(() => state.players.length)).toBe(3);
    expect(await page.evaluate(() => state.players.find((p) => p.id === state.viewerId).resources)).toEqual(before.resources);
  } finally { await t.close(); }
});

test("resignation returns holdings and pieces, supports two-player continuation, and ends by last survivor", async ({ browser }) => {
  const t = await setup(browser, { count: 4, inventory: true });
  try {
    const before = await t.read();
    const leaving = before.players[0];
    await clickResign(t.actor.page);
    await expect(t.actor.page.locator("#landing")).toBeVisible();
    const observer = t.others[0].page;
    await observer.waitForFunction(() => state.players.length === 3);
    const view = await observer.evaluate(() => state);
    expect(view.board.tiles).toEqual(before.board.tiles);
    expect(view.board.edges.filter((edge) => edge.road?.playerId === leaving.id)).toHaveLength(0);
    expect(view.board.vertices.filter((vertex) => vertex.structure?.playerId === leaving.id)).toHaveLength(0);
    for (const resource of ["wood", "brick", "sheep", "wheat", "ore"]) expect(view.bank[resource]).toBe(before.bank[resource] + leaving.resources[resource]);
    expect(view.developmentCount).toBe(before.developmentDeck.length + leaving.developmentCards.length);
    expect(view.players.some((player) => player.id === leaving.id)).toBe(false);
    expect(view.departedPlayers.some((player) => player.id === leaving.id)).toBe(true);
    await observer.waitForFunction(() => state.currentPlayerId === state.viewerId);
    await observer.locator("#roll-button").click();
    await observer.waitForFunction(() => !busy && state.phase === "action");
    await clickResign(observer);
    const third = t.others[1].page;
    await third.waitForFunction(() => state.players.length === 2);
    expect((await third.evaluate(() => state.board.tiles)).length).toBe(19);
    await clickResign(third);
    const survivor = t.others[2].page;
    await survivor.waitForFunction(() => state.phase === "finished");
    expect(await survivor.evaluate(() => state.winReason)).toBe("last-player");
    await expect(survivor.locator("#winner-panel")).toContainText("last remaining");
    expect(await t.actor.page.evaluate(() => connection.savedSeats().find((seat) => seat.roomCode === "NETEST").status)).toBe("retired");
  } finally { await t.close(); }
});

test("lost resignation confirmation is resolved as retired after the browser reopens", async ({ browser }) => {
  const gate = new WireGate();
  const t = await setup(browser, { count: 4, inventory: true, gate });
  try {
    gate.holdResponses = true;
    await clickResign(t.actor.page);
    await expect.poll(async () => Boolean((await t.read()).players[0].resigned)).toBe(true);
    const after = await t.read();
    const storageState = await t.actor.context.storageState();
    await t.actor.context.close();
    const reopened = await t.connect(0, { storageState, root: true });
    await reopened.page.locator('[data-room="NETEST"]').click();
    await expect(reopened.page.locator("#saved-games")).toContainText("Resigned permanently");
    expect((await t.read()).bank).toEqual(after.bank);
    expect((await t.read()).developmentDeck).toEqual(after.developmentDeck);
    expect(await reopened.page.evaluate(() => connection.savedSeats().find((seat) => seat.roomCode === "NETEST").pending)).toBeNull();
  } finally { await t.close(); }
});

test("newer browser ownership supersedes the old tab without making the new seat offline", async ({ browser }) => {
  const t = await setup(browser);
  try {
    const before = rolls(await t.read());
    const storageState = await t.actor.context.storageState();
    const replacement = await t.connect(0, { storageState });
    await expect(t.actor.page.locator("#network-banner")).toContainText("another tab");
    expect(await t.actor.page.evaluate(() => connection.blocked)).toBe(true);
    await t.actor.page.evaluate(() => connection.submit("gameAction", { type: "roll" }));
    expect(rolls(await t.read())).toBe(before);
    await t.actor.context.close();
    expect((await t.read()).players[0].connected).toBe(true);
    await replacement.page.locator("#roll-button").click();
    await replacement.page.waitForFunction(() => !busy && state.phase === "action");
    expect(rolls(await t.read())).toBe(before + 1);
  } finally { await t.close(); }
});

test("browser-storage failure prevents sending an unrecoverable move", async ({ browser }) => {
  const t = await setup(browser);
  try {
    const page = t.actor.page;
    const before = rolls(await t.read());
    await page.evaluate(() => {
      window.originalStorageSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("hearthlands-seat-v3:") && JSON.parse(value).pending) {
          throw new DOMException("Test storage capacity reached", "QuotaExceededError");
        }
        return window.originalStorageSet.call(this, key, value);
      };
    });
    await page.locator("#roll-button").click();
    await expect(page.locator("#toast")).toContainText("not sent");
    expect(rolls(await t.read())).toBe(before);
    await page.evaluate(() => { Storage.prototype.setItem = window.originalStorageSet; });
    await page.waitForFunction(() => !busy);
    await page.locator("#roll-button").click();
    await page.waitForFunction(() => !busy && state.phase === "action");
    expect(rolls(await t.read())).toBe(before + 1);
  } finally { await t.close(); }
});

test("a rejected move is terminal and does not block the next valid sequenced action", async ({ browser }) => {
  const t = await setup(browser);
  try {
    const page = t.actor.page;
    const result = await page.evaluate(() => connection.submit("gameAction", { type: "buildRoad", edgeId: "not-a-path" }));
    expect(result.ok).toBe(false);
    expect(await pendingId(page)).toBeUndefined();
    expect(await page.evaluate(() => state.phase)).toBe("roll");
    await page.locator("#roll-button").click();
    await page.waitForFunction(() => !busy && state.phase === "action");
    expect(rolls(await t.read())).toBe(1);
  } finally { await t.close(); }
});

for (const event of ["createRoom", "joinRoom"]) {
  test(`${event} confirmation lost across browser closure does not create duplicate seats`, async ({ browser }) => {
    const t = await setup(browser, { count: 1, lobby: true });
    const gate = new WireGate();
    const context = await browser.newContext();
    t.contexts.push(context);
    try {
      await gate.attach(context);
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${t.port}/`);
      await page.waitForFunction(() => socket.connected && socket.io.engine.transport.name === "websocket");
      await page.locator("#player-name").fill("Guest");
      if (event === "joinRoom") await page.locator("#room-code").fill("NETEST");
      gate.holdResponses = true;
      await page.locator(event === "createRoom" ? "#create-room" : "#join-room").click();
      await expect.poll(() => gate.requests.length).toBeGreaterThan(0);
      let expectedCode = "NETEST";
      if (event === "joinRoom") await expect.poll(async () => (await t.read()).players.length).toBe(2);
      else {
        const firstState = () => gate.buffer.map((item) => item.message).filter((message) => typeof message === "string" && message.startsWith("42") && message.includes("["))
          .map((message) => JSON.parse(message.slice(message.indexOf("[")))).find((packet) => packet[0] === "state")?.[1];
        await expect.poll(() => firstState()?.code).toBeTruthy();
        expectedCode = firstState().code;
      }
      const storageState = await context.storageState();
      await context.close();
      const restored = await t.connect(0, { storageState, root: true });
      await restored.page.waitForFunction((code) => state?.code === code && bound && !busy, expectedCode);
      const room = await t.services[t.services.length - 1].storage.getRoom(expectedCode);
      expect(room.players.filter((p) => p.name === "Guest")).toHaveLength(1);
      expect(await restored.page.evaluate(() => state.code)).toBe(expectedCode);
    } finally { await t.close(); }
  });
}
