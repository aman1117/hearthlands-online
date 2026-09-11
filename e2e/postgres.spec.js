"use strict";

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createGameServer } = require("../server");
const { plan } = require("./strategy.cjs");
const { perform } = require("./ui.cjs");

const databaseUrl = process.env.TEST_DATABASE_URL;
test.skip(!databaseUrl, "Set an isolated loopback TEST_DATABASE_URL to exercise real PostgreSQL.");
if (databaseUrl && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl).hostname)) {
  throw new Error("PostgreSQL browser tests refuse non-loopback databases.");
}

test("a real PostgreSQL-backed three-player match runs from lobby to victory and persists", async ({ browser }, testInfo) => {
  test.setTimeout(900_000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-pg-browser-"));
  const databaseSchema = `hl_browser_${crypto.randomBytes(8).toString("hex")}`;
  let seed = 307;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const options = { dataDir, databaseUrl, databaseSchema, databaseSsl: "disable", random };
  const service = createGameServer(options);
  const port = await service.listen();
  const contexts = [];
  const pages = [];
  const byId = new Map();
  let roomCode;
  let reopened;
  try {
    for (let i = 0; i < 3; i++) {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      pages.push(page);
      await page.goto(`http://127.0.0.1:${port}`);
      await page.waitForFunction(() => socket.connected);
      await page.locator("#player-name").fill(`Player ${i + 1}`);
      if (!i) await page.locator("#create-room").click();
      else {
        await page.locator("#room-code").fill(roomCode);
        await page.locator("#join-room").click();
      }
      await page.waitForFunction(() => state?.phase === "lobby" && bound && !busy);
      roomCode = await page.evaluate(() => state.code);
      byId.set(await page.evaluate(() => state.viewerId), page);
    }
    await pages[0].locator("#start-game").click();
    await pages[0].waitForFunction(() => state.phase === "setup");
    let view = await pages[0].evaluate(() => state);
    for (let step = 0; step < 6000 && !view.winnerId; step++) {
      const discarder = Object.entries(view.pendingDiscards || {}).find(([, count]) => count > 0)?.[0];
      const page = byId.get(discarder || view.currentPlayerId);
      await page.waitForFunction((revision) => state.revision >= revision && !busy, view.revision);
      const move = plan(await page.evaluate(() => state));
      expect(move).toBeTruthy();
      await perform(page, move);
      view = await page.evaluate(() => state);
    }
    expect(view.winnerId).toBeTruthy();
    const stored = await service.storage.getRoom(roomCode);
    expect(stored.winnerId).toBe(view.winnerId);
    expect(stored.eventSequence).toBeGreaterThan(80);
    for (const context of contexts) await context.close();
    await service.close();
    reopened = createGameServer(options);
    await reopened.listen();
    const restored = await reopened.storage.getRoom(roomCode);
    expect(restored.board).toEqual(stored.board);
    expect(restored.winnerId).toBe(stored.winnerId);
    const events = await reopened.storage.listEvents(roomCode, { limit: 1000 });
    expect(events.length).toBeGreaterThan(80);
    await testInfo.attach("database-backend", { body: JSON.stringify({ backend: "PostgreSQL", schema: databaseSchema, eventSequence: restored.eventSequence }), contentType: "application/json" });
  } finally {
    for (const context of contexts) await context.close();
    if (reopened) await reopened.close();
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    // The isolated PostgreSQL schema is deliberately retained; no DROP or DELETE.
  }
});
