"use strict";
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createGameServer } = require("../server");
const { createRoom, addPlayer, startGame, applyAction, publicState } = require("../game");
const { choose, perform } = require("./ui.cjs");

async function table(browser, { preRoll = false, shortRecipient = false } = {}) {
  const { room, player: host } = createRoom("Rowan");
  addPlayer(room, "Mira"); addPlayer(room, "Ellis");
  startGame(room, host.id, () => .999);
  while (room.phase === "setup") {
    const id = room.players[room.turnIndex].id;
    const view = publicState(room, id);
    applyAction(room, id, view.setupNeedsRoad ? { type: "setupRoad", edgeId: view.legal.roadEdges[0] }
      : { type: "setupSettlement", vertexId: view.legal.settlementVertices[0] });
  }
  if (!preRoll) applyAction(room, host.id, { type: "roll" }, () => .1);
  for (const [index, player] of room.players.entries()) {
    for (const resource of Object.keys(player.resources)) { room.bank[resource] += player.resources[resource]; player.resources[resource] = 0; }
    const bundle = index === 0 ? { wood: 8, brick: 4, ore: 2, sheep: 2, wheat: 2 }
      : index === 1 ? { ore: shortRecipient ? 0 : 4, sheep: 2 } : { wheat: 3 };
    for (const [resource, count] of Object.entries(bundle)) { room.bank[resource] -= count; player.resources[resource] += count; }
  }
  const card = room.developmentDeck.splice(room.developmentDeck.findIndex((card) => card.type === "knight"), 1)[0];
  host.developmentCards.push({ ...card, boughtTurn: 0 });
  room.code = "TRADED"; room.updatedAt = Date.now();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-trade-"));
  fs.writeFileSync(path.join(dataDir, "TRADED.json"), JSON.stringify({ version: 2, room }));
  let service = createGameServer({ dataDir, random: () => .1 });
  const port = await service.listen();
  const contexts = [], pages = [], errors = [], wires = [];
  for (const player of room.players) {
    const context = await browser.newContext();
    contexts.push(context);
    const wire = { holdRequests: false, holdResponses: false, buffered: [], requests: [],
      release() { this.holdRequests = this.holdResponses = false; for (const { target, message } of this.buffered.splice(0)) target.send(message); } };
    wires.push(wire);
    await context.routeWebSocket(/\/socket\.io\//, (client) => {
      const upstream = client.connectToServer();
      client.onMessage((message) => {
        const packet = typeof message === "string" && /^42\d*\[/.test(message) ? JSON.parse(message.slice(message.indexOf("["))) : null;
        if (packet?.[0] === "gameAction") {
          wire.requests.push(packet[1]);
          if (wire.holdRequests) { wire.buffered.push({ target: upstream, message }); return; }
        }
        upstream.send(message);
      });
      upstream.onMessage((message) => {
        if (wire.holdResponses && typeof message === "string" && /^(42|43)/.test(message)) wire.buffered.push({ target: client, message });
        else client.send(message);
      });
    });
    const page = await context.newPage();
    pages.push(page);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => socket.connected);
    await page.locator(".resume-details > summary").click();
    await page.locator("#resume-key").fill(player.reconnectToken);
    await page.locator("#import-session").click();
    await page.waitForFunction(() => bound && state && !busy && socket.io.engine.transport.name === "websocket");
  }
  return { room, pages, wires, contexts, errors, card,
    read: () => service.storage.getRoom(room.code),
    history: () => service.storage.listEvents(room.code, { limit: 1000 }),
    async restart() { await service.close(); service = createGameServer({ dataDir, random: () => .1 }); await service.listen(port); },
    async close() { for (const context of contexts) await context.close(); await service.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}
async function draft(page, target, give = { wood: 1 }, want = { ore: 1 }) {
  await page.locator("#trade-details").evaluate((node) => { node.open = true; });
  await page.locator('[data-tab="player"]').click();
  await choose(page, "trade-target", target);
  for (const resource of ["wood", "brick", "sheep", "wheat", "ore"]) {
    await page.locator(`#give-${resource}`).fill(String(give[resource] || 0));
    await page.locator(`#want-${resource}`).fill(String(want[resource] || 0));
  }
}
async function offer(t, give, want) {
  await draft(t.pages[0], t.room.players[1].id, give, want);
  await t.pages[0].locator("#offer-submit").click();
  await t.pages[0].waitForFunction(() => state.trade && !busy);
  await t.pages[1].waitForFunction(() => state.trade?.targetId === state.viewerId);
}
function holdings(room) { return { bank: room.bank, players: room.players.map((player) => player.resources) }; }

test("Accept survives a peer update between pointer down and pointer up", async ({ browser }) => {
  const t = await table(browser);
  try {
    await offer(t);
    const page = t.pages[1];
    const button = page.locator("#accept-trade");
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const revision = await page.evaluate(() => state.revision);
    await t.pages[2].reload();
    await page.waitForFunction((revision) => state.revision > revision, revision);
    await page.mouse.up();
    await expect.poll(async () => (await t.history()).filter((event) => event.type === "tradeAccepted").length).toBe(1);
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("pre-roll trades are blocked for every player and bank, with a visible reason", async ({ browser }) => {
  const t = await table(browser, { preRoll: true });
  try {
    for (const page of t.pages) {
      await page.locator('[data-tab="player"]').click();
      await expect(page.locator("#offer-submit")).toBeDisabled();
      await expect(page.locator("#trade-status")).toContainText(/roll/i);
      expect(await page.evaluate(() => state.legal.canOfferTrade || state.legal.canBankTrade)).toBe(false);
    }
    await perform(t.pages[0], { type: "roll" });
    await offer(t);
    await expect(t.pages[1].locator("#accept-trade")).toBeEnabled();
  } finally { await t.close(); }
});

test("incoming offers explain insufficient resources and counteroffers select the sender", async ({ browser }) => {
  const t = await table(browser, { shortRecipient: true });
  try {
    await offer(t);
    const page = t.pages[1];
    await expect(page.locator("#accept-trade")).toBeDisabled();
    await expect(page.locator("#trade-response-status")).toContainText("1 more ore");
    expect(await page.evaluate(() => GameControls.read("trade-target"))).toBe(t.room.players[0].id);
    await draft(page, t.room.players[0].id, { sheep: 1 }, { wood: 1 });
    await page.locator("#offer-submit").click();
    await t.pages[0].waitForFunction(() => state.trade?.targetId === state.viewerId && !busy);
    await t.pages[0].locator("#accept-trade").click();
    await t.pages[0].waitForFunction(() => !state.trade && !busy);
    expect((await t.history()).filter((event) => event.type === "tradeAccepted")).toHaveLength(1);
  } finally { await t.close(); }
});

test("slow acceptance retries one saved request and survives browser reload without a second exchange", async ({ browser }) => {
  const t = await table(browser);
  try {
    await offer(t);
    const before = holdings(await t.read());
    const page = t.pages[1], wire = t.wires[1];
    wire.holdResponses = true;
    await page.locator("#accept-trade").click();
    await expect(page.locator("#accept-trade")).toBeDisabled();
    await expect(page.locator("#trade-response-status")).toContainText(/confirm/i);
    await expect.poll(() => wire.requests.filter((request) => request.type === "respondTrade").length, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    expect(new Set(wire.requests.filter((request) => request.type === "respondTrade").map((request) => request.requestId)).size).toBe(1);
    wire.holdResponses = false;
    wire.buffered = [];
    await page.reload();
    await page.waitForFunction(() => bound && !busy && !state.trade);
    const after = holdings(await t.read());
    expect(after.bank).toEqual(before.bank);
    expect(after.players[0].ore).toBe(before.players[0].ore + 1);
    expect(after.players[1].ore).toBe(before.players[1].ore - 1);
    expect((await t.history()).filter((event) => event.type === "tradeAccepted")).toHaveLength(1);
  } finally { await t.close(); }
});

test("delayed acceptance cannot accept replaced terms and replacement during a pointer press cannot accept them either", async ({ browser }) => {
  const t = await table(browser);
  try {
    await offer(t);
    const first = (await t.read()).trade.id;
    const before = holdings(await t.read());
    t.wires[1].holdRequests = true;
    await t.pages[1].locator("#accept-trade").click();
    await expect.poll(() => t.wires[1].buffered.length).toBeGreaterThan(0);
    await draft(t.pages[0], t.room.players[1].id, { wood: 2 }, { ore: 2 });
    await t.pages[0].locator("#offer-submit").click();
    await t.pages[0].waitForFunction((id) => state.trade?.id !== id && !busy, first);
    const replaced = (await t.read()).trade.id;
    t.wires[1].release();
    await t.pages[1].waitForFunction(() => !busy);
    expect(holdings(await t.read())).toEqual(before);
    expect((await t.read()).trade.id).toBe(replaced);
    const button = t.pages[1].locator("#accept-trade");
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    await t.pages[1].mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await t.pages[1].mouse.down();
    await draft(t.pages[0], t.room.players[1].id, { wood: 3 }, { ore: 3 });
    await t.pages[0].locator("#offer-submit").click();
    await t.pages[1].waitForFunction((id) => state.trade?.id !== id, replaced);
    await t.pages[1].mouse.up();
    expect((await t.read()).trade).not.toBeNull();
    expect(holdings(await t.read())).toEqual(before);
    await t.pages[1].locator("#accept-trade").click();
    await t.pages[1].waitForFunction(() => !state.trade && !busy);
    expect((await t.history()).filter((event) => event.type === "tradeAccepted")).toHaveLength(1);
  } finally { await t.close(); }
});

test("a pending offer persists through server restart and expires visibly when the sender spends its resources", async ({ browser }) => {
  const t = await table(browser);
  try {
    await offer(t, { wood: 8 }, { ore: 1 });
    const initial = await t.read();
    await t.restart();
    await t.pages[1].waitForFunction((revision) => bound && socket.connected && state.revision > revision, initial.revision);
    expect((await t.read()).trade).toEqual(initial.trade);
    await expect(t.pages[1].locator("#accept-trade")).toBeEnabled();
    await perform(t.pages[0], { type: "bankTrade", giveResource: "wood", receiveResource: "brick" });
    await t.pages[1].waitForFunction(() => !state.trade);
    await expect(t.pages[1].locator("#accept-trade")).toHaveCount(0);
    const cancelled = (await t.history()).find((event) => event.type === "tradeCancelled");
    expect(cancelled.data.reason).toBe("offered-resources-spent");
    expect((await t.history()).filter((event) => event.type === "tradeAccepted")).toHaveLength(0);
  } finally { await t.close(); }
});

test("a Knight interrupts trading and stale offers no longer display an unusable Accept button", async ({ browser }) => {
  const t = await table(browser);
  try {
    await offer(t);
    await perform(t.pages[0], { type: "playDevelopment", cardId: t.card.id });
    await t.pages[1].waitForFunction(() => state.phase === "robber");
    await expect(t.pages[1].locator("#accept-trade")).toHaveCount(0);
    await expect(t.pages[1].locator("#trade-status")).toContainText(/robber/i);
    expect((await t.read()).trade).toBeNull();
  } finally { await t.close(); }
});

test("incoming counteroffer defaults to its actual sender and editing survives unrelated presence changes", async ({ browser }) => {
  const t = await table(browser);
  try {
    const sender = t.pages[2], actor = t.pages[0];
    await draft(sender, t.room.players[0].id, { wheat: 1 }, { wood: 1 });
    await sender.locator("#offer-submit").click();
    await actor.waitForFunction(() => state.trade?.targetId === state.viewerId);
    expect(await actor.evaluate(() => GameControls.read("trade-target"))).toBe(t.room.players[2].id);
    await actor.locator("#give-wood").fill("2");
    await actor.locator("#want-wheat").fill("1");
    await actor.locator("#give-wood").focus();
    const revision = await actor.evaluate(() => state.revision);
    await t.pages[1].reload();
    await actor.waitForFunction((revision) => state.revision > revision, revision);
    await expect(actor.locator("#give-wood")).toBeFocused();
    await expect(actor.locator("#give-wood")).toHaveValue("2");
    await actor.locator("#offer-submit").click();
    await sender.waitForFunction(() => state.trade?.targetId === state.viewerId && !busy);
    expect((await t.read()).trade.targetId).toBe(t.room.players[2].id);
    await sender.locator("#accept-trade").click();
    await sender.waitForFunction(() => !state.trade && !busy);
    expect((await t.history()).filter((event) => event.type === "tradeAccepted")).toHaveLength(1);
  } finally { await t.close(); }
});

test("a delayed counteroffer cannot revive a declined offer and offline recipients can reconnect to valid offers", async ({ browser }) => {
  const t = await table(browser);
  try {
    await offer(t);
    await draft(t.pages[1], t.room.players[0].id, { ore: 2 }, { wood: 2 });
    t.wires[1].holdRequests = true;
    await t.pages[1].locator("#offer-submit").click();
    await expect.poll(() => t.wires[1].buffered.length).toBeGreaterThan(0);
    await t.pages[0].locator("#cancel-trade").click();
    await t.pages[0].waitForFunction(() => !state.trade && !busy);
    t.wires[1].release();
    await t.pages[1].waitForFunction(() => !busy);
    expect((await t.read()).trade).toBeNull();
    expect((await t.history()).filter((event) => event.type === "tradeCounteroffered")).toHaveLength(0);
    await offer(t);
    const id = (await t.read()).trade.id;
    await t.contexts[1].setOffline(true);
    await t.pages[1].waitForFunction(() => !bound);
    await expect(t.pages[1].locator("#accept-trade")).toBeDisabled();
    await expect(t.pages[1].locator("#trade-response-status")).toContainText("Reconnecting");
    await t.contexts[1].setOffline(false);
    await t.pages[1].waitForFunction(() => bound && !busy);
    expect((await t.read()).trade.id).toBe(id);
    await t.pages[1].setViewportSize({ width: 390, height: 844 });
    await t.pages[1].locator("#accept-trade").click();
    await t.pages[1].waitForFunction(() => !state.trade && !busy);
    expect((await t.history()).filter((event) => event.type === "tradeAccepted")).toHaveLength(1);
  } finally { await t.close(); }
});
