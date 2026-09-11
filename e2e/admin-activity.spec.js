"use strict";

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRoom, addPlayer, startGame, applyAction, publicState } = require("../game");
const { createGameServer } = require("../server");
const { choose } = require("./ui.cjs");

async function fixture(browser, { lobby = false } = {}) {
  const { room, player: admin } = createRoom("Rowan");
  ["Mira", "Ellis", "Noa"].forEach((name) => addPlayer(room, name));
  if (!lobby) {
    startGame(room, admin.id, () => .999);
    while (room.phase === "setup") {
      const actor = room.players[room.turnIndex];
      const view = publicState(room, actor.id);
      applyAction(room, actor.id, view.setupNeedsRoad ? { type: "setupRoad", edgeId: view.legal.roadEdges[0] }
        : { type: "setupSettlement", vertexId: view.legal.settlementVertices[0] });
    }
    applyAction(room, admin.id, { type: "roll" }, () => .1);
    for (const [resource, amount] of Object.entries({ wood: 4, brick: 2, sheep: 3, wheat: 3, ore: 3 })) {
      room.bank[resource] -= amount;
      admin.resources[resource] += amount;
    }
    room.bank.ore -= 2;
    room.players[1].resources.ore += 2;
  }
  room.code = "ADTEST";
  room.updatedAt = Date.now();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-admin-ui-"));
  fs.writeFileSync(path.join(dataDir, "ADTEST.json"), JSON.stringify({ version: 2, room }));
  const service = createGameServer({ dataDir, random: () => .1 });
  const port = await service.listen();
  const contexts = [];
  const pages = [];
  for (const player of room.players) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexts.push(context);
    const page = await context.newPage();
    pages.push(page);
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => socket.connected);
    await page.locator(".resume-details > summary").click();
    await page.locator("#resume-key").fill(player.reconnectToken);
    await page.locator("#import-session").click();
    await page.waitForFunction(() => bound && Boolean(state) && !busy);
  }
  return {
    room, service, dataDir, pages, contexts,
    async close() {
      for (const context of contexts) await context.close();
      await service.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("nonadmins request removal and only the admin can approve or decline", async ({ browser }) => {
  const t = await fixture(browser);
  try {
    const [admin, requester, observer] = t.pages;
    const playerId = await requester.evaluate(() => state.viewerId);
    const before = await requester.evaluate(() => state.players.find((p) => p.id === state.viewerId).resources);
    const denied = await requester.evaluate(() => connection.submit("resignGame", { confirmed: true }));
    expect(denied.ok).toBe(false);
    await requester.locator(".room-settings").evaluate((node) => { node.open = true; });
    await requester.locator("#resign-game").click();
    await requester.locator("#resign-confirmed").check();
    await requester.locator("#confirm-resign").click();
    await admin.waitForFunction((id) => state.removalRequests.some((request) => request.playerId === id), playerId);
    expect(await requester.evaluate(() => state.players.find((p) => p.id === state.viewerId).resources)).toEqual(before);
    await expect(observer.locator(".pending-removal-badge")).toHaveCount(1);
    const forged = await observer.evaluate((playerId) => connection.submit("removePlayer", { playerId, confirmed: true }), playerId);
    expect(forged.ok).toBe(false);
    await admin.locator(`[data-decline-removal="${playerId}"]`).click();
    await requester.waitForFunction(() => !state.removalRequests.length);
    await requester.locator("#resign-game").click();
    await requester.locator("#resign-confirmed").check();
    await requester.locator("#confirm-resign").click();
    await admin.waitForFunction(() => state.removalRequests.length === 1);
    await admin.locator(`[data-approve-removal="${playerId}"]`).click();
    await admin.locator("#admin-remove-checked").check();
    await admin.locator("#admin-remove-confirm").click();
    await expect(requester.locator("#landing")).toBeVisible();
    await observer.waitForFunction((id) => !state.players.some((p) => p.id === id), playerId);
    expect(await observer.evaluate(() => state.players.filter((p) => p.id === state.hostId).length)).toBe(1);
  } finally { await t.close(); }
});

test("offline admin retains authority, and admin departure requires an explicit successor", async ({ browser }) => {
  const t = await fixture(browser);
  try {
    const [admin, successor, observer] = t.pages;
    const originalId = await admin.evaluate(() => state.viewerId);
    const successorId = await successor.evaluate(() => state.viewerId);
    await admin.evaluate(() => socket.disconnect());
    await observer.waitForFunction((id) => !state.players.find((p) => p.id === id).connected, originalId);
    expect(await observer.evaluate(() => state.hostId)).toBe(originalId);
    const denied = await successor.evaluate(() => connection.submit("transferAdmin", { playerId: state.viewerId }));
    expect(denied.ok).toBe(false);
    await admin.evaluate(() => socket.connect());
    await admin.waitForFunction(() => bound && !busy);
    await admin.locator(".room-settings").evaluate((node) => { node.open = true; });
    await admin.locator("#resign-game").click();
    await admin.locator("#resign-confirmed").check();
    await expect(admin.locator("#confirm-resign")).toBeDisabled();
    await choose(admin, "successor-choice", successorId);
    await expect(admin.locator("#confirm-resign")).toBeEnabled();
    await admin.locator("#confirm-resign").click();
    await expect(admin.locator("#landing")).toBeVisible();
    await successor.waitForFunction((id) => state.hostId === id && state.players.length === 3, successorId);
    expect(await observer.evaluate(() => state.players.filter((p) => p.id === state.hostId).length)).toBe(1);
  } finally { await t.close(); }
});

test("bank and player trades notify every connected player with exact public amounts", async ({ browser }) => {
  const t = await fixture(browser);
  try {
    const [actor, target] = t.pages;
    const rate = await actor.evaluate(() => state.players.find((p) => p.id === state.viewerId).tradeRates.wood);
    await choose(actor, "bank-give", "wood");
    await choose(actor, "bank-receive", "ore");
    await actor.locator("#bank-submit").click();
    await actor.waitForFunction(() => !busy);
    for (const page of t.pages) {
      await expect(page.locator("#game-log")).toContainText(`${rate} wood`);
      await expect(page.locator("#activity-notifications")).toContainText("1 ore");
    }
    const targetId = await target.evaluate(() => state.viewerId);
    await actor.locator('[data-tab="player"]').click();
    await choose(actor, "trade-target", targetId);
    await actor.locator("#give-wood").fill("1");
    await actor.locator("#want-ore").fill("1");
    await actor.locator("#offer-submit").click();
    await target.waitForFunction(() => state.trade?.targetId === state.viewerId);
    await target.locator("#accept-trade").click();
    for (const page of t.pages) {
      await expect(page.locator("#game-log")).toContainText("accepted");
      await expect(page.locator("#activity-notifications")).toContainText("1 wood");
    }
    await actor.locator("#buy-development").click();
    await actor.waitForFunction(() => !busy);
    const ownCard = await actor.evaluate(() => state.players.find((p) => p.id === state.viewerId).developmentCards.at(-1));
    const publicEvents = await target.evaluate(() => state.log.filter((event) => /bought a development card/.test(event.message)));
    expect(publicEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(publicEvents)).not.toContain(ownCard.id);
    expect(JSON.stringify(publicEvents)).not.toContain(ownCard.type);
  } finally { await t.close(); }
});

test("activity history remains complete beyond the recent snapshot and pagination is duplicate-free", async ({ browser }) => {
  const t = await fixture(browser);
  try {
    const byId = new Map();
    for (const page of t.pages) byId.set(await page.evaluate(() => state.viewerId), page);
    let view = await t.pages[0].evaluate(() => state);
    for (let turn = 0; turn < 50; turn++) {
      const page = byId.get(view.currentPlayerId);
      await page.waitForFunction((revision) => state.revision >= revision && !busy, view.revision);
      if (view.phase === "roll") {
        const result = await page.evaluate(() => connection.submit("gameAction", { type: "roll", expectedTurnNumber: state.turnNumber }));
        expect(result.ok).toBe(true);
      }
      const ended = await page.evaluate(() => connection.submit("gameAction", { type: "endTurn", expectedTurnNumber: state.turnNumber }));
      expect(ended.ok).toBe(true);
      view = await page.evaluate(() => state);
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    expect(view.eventSequence).toBeGreaterThan(80);
    expect(view.log.length).toBeLessThanOrEqual(80);
    const page = t.pages[0];
    await page.locator("#open-history").click();
    await expect(page.locator(".activity-row")).toHaveCount(50);
    await page.locator("#history-more").click();
    await expect(page.locator(".activity-row")).toHaveCount(100);
    const ids = await page.locator(".activity-row").evaluateAll((nodes) => nodes.map((node) => node.dataset.eventId));
    expect(new Set(ids).size).toBe(ids.length);
  } finally { await t.close(); }
});
