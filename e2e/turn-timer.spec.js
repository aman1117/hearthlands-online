"use strict";
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createGameServer } = require("../server");
const { createRoom, addPlayer } = require("../game");

async function lobby(browser) {
  const { room } = createRoom("Rowan");
  addPlayer(room, "Mira"); addPlayer(room, "Ellis");
  room.code = "TIMERS"; room.updatedAt = Date.now();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-timer-ui-"));
  fs.writeFileSync(path.join(dataDir, "TIMERS.json"), JSON.stringify({ version: 2, room }));
  const service = createGameServer({ dataDir, timerGraceMs: 0, timerSweepMs: 200 });
  const port = await service.listen();
  const contexts = [], pages = [], errors = [];
  for (const player of room.players) {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => socket.connected);
    await page.locator(".resume-details > summary").click();
    await page.locator("#resume-key").fill(player.reconnectToken);
    await page.locator("#import-session").click();
    await page.waitForFunction(() => bound && state && !busy);
    pages.push(page);
  }
  return { room, pages, errors, read: () => service.storage.getRoom(room.code),
    async close() { for (const context of contexts) await context.close(); await service.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

for (const width of [1440, 390]) test(`the admin sets per-move timers, everyone sees the countdown, and expired moves happen automatically at ${width}px`, async ({ browser }, testInfo) => {
  const t = await lobby(browser);
  try {
    const [host, mira] = t.pages;
    for (const page of t.pages) await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await expect(host.locator('#lobby-timer [data-timer-preset="off"]')).toHaveAttribute("aria-checked", "true");
    await expect(mira.locator("#lobby-timer [data-timer-summary]")).toHaveText("Turn timer: off");
    await expect(mira.locator("#lobby-timer [data-timer-preset]")).toHaveCount(0);
    await host.locator('#lobby-timer [data-timer-preset="60"]').click();
    await host.locator("#lobby-timer [data-timer-apply]").click();
    await mira.waitForFunction(() => state.turnTimer.preset === "60");
    await expect(mira.locator("#lobby-timer [data-timer-summary]")).toContainText("60s · 60s turn, 10s roll, 20s robber");
    await expect(host.locator("#turn-clock")).toBeHidden();
    await host.locator("#lobby-timer").screenshot({ path: testInfo.outputPath(`lobby-timer-${width}.png`) });
    await host.locator("#start-game").click();
    await mira.waitForFunction(() => state.phase === "setup" && state.turnTimer.timer);
    const first = await host.evaluate(() => state.currentPlayerId);
    const firstPage = t.pages[t.room.players.findIndex((player) => player.id === first)];
    await expect(firstPage.locator("#turn-clock")).toHaveClass(/mine/);
    await expect(firstPage.locator("#turn-clock .turn-clock-who")).toHaveText("You");
    await expect(firstPage.locator("#turn-clock .turn-clock-stage")).toHaveText("Starting settlement");
    await expect(firstPage.locator("#turn-clock [data-clock-time]")).toHaveText(/^(2:00|1:5\d)$/);
    const observer = t.pages.find((page) => page !== firstPage);
    await expect(observer.locator("#turn-clock")).not.toHaveClass(/mine/);
    await host.locator("#game-timer").evaluate((node) => node.closest("details").open = true);
    await expect(mira.locator("#game-timer [data-timer-preset]")).toHaveCount(0);
    await host.locator('#game-timer [data-timer-preset="custom"]').click();
    const fields = { setupSettlement: 10, setupRoad: 5, roll: 5, discard: 5, robber: 5, turn: 10, bonus: 0 };
    await host.locator("#game-timer-setupSettlement").fill("9");
    await host.locator("#game-timer [data-timer-apply]").click();
    await expect(host.locator("#game-timer [data-timer-error]")).toHaveText("Starting settlement must be 10-3600 seconds.");
    for (const [field, value] of Object.entries(fields)) await host.locator(`#game-timer-${field}`).fill(String(value));
    await host.locator("#game-timer [data-timer-apply]").click();
    await mira.waitForFunction(() => state.turnTimer.preset === "custom");
    await expect(firstPage.locator("#turn-clock [data-clock-time]")).toHaveText(/^(10|9|8)s$/);
    await host.locator(".game-header").screenshot({ path: testInfo.outputPath(`header-clock-${width}.png`) });
    await expect(firstPage.locator("#turn-clock")).toHaveClass(/low/, { timeout: 12_000 });
    await mira.waitForFunction(() => state.log.some((event) => event.type === "turnTimedOut"), null, { timeout: 15_000 });
    await expect(mira.locator("#game-log")).toContainText("ran out of time; a starting settlement was placed for them");
    await mira.waitForFunction(() => state.turnTimer.timer?.kind === "setupRoad");
    await expect(observer.locator("#turn-clock .turn-clock-stage")).toHaveText("Starting road");
    const room = await t.read();
    expect(room.board.vertices.filter((vertex) => vertex.structure?.playerId === first)).toHaveLength(1);
    await host.locator("#game-timer").evaluate((node) => node.closest("details").open = true);
    await host.locator('#game-timer [data-timer-preset="off"]').click();
    await host.locator("#game-timer [data-timer-apply]").click();
    await mira.waitForFunction(() => !state.turnTimer.timer);
    await expect(mira.locator("#turn-clock")).toBeHidden();
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});
