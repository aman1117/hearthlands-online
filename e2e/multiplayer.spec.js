"use strict";

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGameServer } = require("../server");
const { plan } = require("./strategy.cjs");
const { perform, previewPlacement } = require("./ui.cjs");

function randomSeed(seed) {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

async function createTable(browser, playerCount, seed, testInfo) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-browser-"));
  const service = createGameServer({ dataDir, random: randomSeed(seed) });
  const port = await service.listen();
  expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
  const contexts = [];
  const pages = [];
  const errors = [];
  for (let i = 0; i < playerCount; i++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexts.push(context);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    pages.push(page);
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => socket.connected);
    await page.locator("#player-name").fill(`Explorer ${i + 1}`);
    if (i === 0) {
      await page.locator("#create-room").click();
      await expect(page.locator("#game")).toBeVisible();
    } else {
      const code = await pages[0].locator("#copy-code").textContent();
      await page.locator("#room-code").fill(code);
      await page.locator("#join-room").click();
      await expect(page.locator("#game")).toBeVisible();
    }
  }
  await expect(pages[0].locator("#start-game")).toBeEnabled();
  await pages[0].locator("#start-game").click();
  await pages[0].waitForFunction(() => state?.phase === "setup");
  const byId = new Map();
  for (const page of pages) {
    await page.waitForFunction(() => state?.phase === "setup");
    byId.set(await page.evaluate(() => state.viewerId), page);
  }
  return {
    pages, byId, service, dataDir, port, errors,
    async close() {
      if (testInfo.status !== testInfo.expectedStatus) {
        await pages[0].screenshot({ path: testInfo.outputPath("failure.png"), fullPage: true }).catch(() => {});
      }
      for (const context of contexts) await context.close();
      await service.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

for (const count of [3, 4, 5, 6]) {
  test(`${count} players complete snake setup, play a turn, use mobile layout and reconnect`, async ({ browser }, testInfo) => {
    const table = await createTable(browser, count, 42 + count, testInfo);
    try {
      let view = await table.pages[0].evaluate(() => state);
      expect(view.board.tiles.length).toBe(count <= 4 ? 19 : 30);
      for (let i = 0; i < count * 4; i++) {
        const page = table.byId.get(view.currentPlayerId);
        await page.waitForFunction((revision) => state.revision >= revision, view.revision);
        const next = await page.evaluate(() => state);
        const move = plan(next);
        if (i === 0) {
          await previewPlacement(page, move.vertexId);
          await page.locator("#confirm-placement").click();
          await page.waitForFunction((revision) => !busy && state.revision > revision, next.revision);
        } else if (i === 1) {
          const edge = next.board.edges.find((edge) => {
            if (!next.legal.roadEdges.includes(edge.id)) return false;
            const a = next.board.vertices.find((v) => v.id === edge.vertices[0]);
            const b = next.board.vertices.find((v) => v.id === edge.vertices[1]);
            return a.x !== b.x;
          });
          await previewPlacement(page, edge.id);
          await page.locator("#confirm-placement").click();
          await page.waitForFunction((revision) => !busy && state.revision > revision, next.revision);
        } else await perform(page, move);
        view = await page.evaluate(() => state);
      }
      expect(view.phase).toBe("roll");
      expect(view.board.vertices.filter((v) => v.structure).length).toBe(count * 2);
      expect(view.board.edges.filter((edge) => edge.road).length).toBe(count * 2);
      const actor = table.byId.get(view.currentPlayerId);
      await perform(actor, { type: "roll" });
      view = await actor.evaluate(() => state);
      for (const [id, required] of Object.entries(view.pendingDiscards)) {
        if (!required) continue;
        const discarder = table.byId.get(id);
        await discarder.waitForFunction(() => Boolean(state.pendingDiscards[state.viewerId]));
        await perform(discarder, plan(await discarder.evaluate(() => state)));
      }
      while (["robber", "steal"].includes((await actor.evaluate(() => state)).phase)) {
        await perform(actor, plan(await actor.evaluate(() => state)));
      }
      const primary = await actor.evaluate(() => state.currentPlayerId);
      await perform(actor, { type: "endTurn" });
      view = await actor.evaluate(() => state);
      if (count > 4) {
        expect(view.turnRole).toBe("secondary");
        expect(view.currentPlayerId).toBe(view.players[(view.players.findIndex((p) => p.id === primary) + 3) % count].id);
        const paired = table.byId.get(view.currentPlayerId);
        await paired.waitForFunction((revision) => state.revision >= revision, view.revision);
        expect(await paired.locator("#roll-button").count()).toBe(0);
      }
      const mobile = table.pages[0];
      await mobile.setViewportSize({ width: 390, height: 844 });
      expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await mobile.screenshot({ path: testInfo.outputPath(`${count}-player-mobile.png`), fullPage: true });
      await mobile.locator("#rules-button").click();
      await expect(mobile.locator("#rules-dialog")).toBeVisible();
      await mobile.locator("#close-rules").click();
      const playerId = await mobile.evaluate(() => state.viewerId);
      await mobile.reload();
      await mobile.waitForFunction((id) => state?.viewerId === id, playerId);
      expect(await mobile.locator("#game").isVisible()).toBe(true);
      expect(table.errors).toEqual([]);
    } finally { await table.close(); }
  });
}

for (const playerCount of [3, 6]) test(`${playerCount === 3 ? "three" : "six"} real browsers play from empty lobby to ten-point victory and rematch`, async ({ browser }, testInfo) => {
  test.setTimeout(900_000);
  const table = await createTable(browser, playerCount, playerCount === 3 ? 307 : 807, testInfo);
  const counts = {};
  try {
    let view = await table.pages[0].evaluate(() => state);
    for (let step = 0; step < 7000 && !view.winnerId; step++) {
      const discarderId = Object.entries(view.pendingDiscards || {}).find(([, count]) => count > 0)?.[0];
      const id = discarderId || view.currentPlayerId;
      const page = table.byId.get(id);
      await page.waitForFunction((revision) => state.revision >= revision && !busy, view.revision);
      const move = plan(await page.evaluate(() => state));
      expect(move, `No move during ${view.phase}`).toBeTruthy();
      counts[move.type] = (counts[move.type] || 0) + 1;
      await perform(page, move);
      view = await page.evaluate(() => state);
    }
    expect(view.winnerId, `Game did not finish: ${JSON.stringify(counts)}`).toBeTruthy();
    const winner = table.byId.get(view.winnerId);
    await expect(winner.locator("#winner-panel")).toBeVisible();
    await winner.screenshot({ path: testInfo.outputPath("victory.png"), fullPage: true });
    const host = table.byId.get(view.hostId);
    await host.waitForFunction(() => state.phase === "finished");
    await host.locator("#rematch").click();
    await host.waitForFunction(() => state.phase === "lobby");
    expect(await host.locator(".player-card").count()).toBe(playerCount);
    expect(table.errors).toEqual([]);
    await testInfo.attach("actions", { body: JSON.stringify(counts, null, 2), contentType: "application/json" });
  } finally { await table.close(); }
});
