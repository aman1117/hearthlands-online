"use strict";

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGameServer } = require("../server");
const { previewPlacement } = require("./ui.cjs");

async function table(browser, count = 2, mobileIndex = -1) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-tabletop-"));
  const service = createGameServer({ dataDir });
  const port = await service.listen();
  const pages = [];
  const contexts = [];
  const errors = [];
  let code;
  async function join(index) {
    const context = await browser.newContext(index === mobileIndex
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1440, height: 1000 } });
    contexts.push(context);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    pages.push(page);
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => socket.connected);
    await page.locator("#player-name").fill(`Friend ${index + 1}`);
    if (!code) {
      await page.locator("#create-room").click();
      await page.waitForFunction(() => Boolean(state?.board) && !busy);
      code = await page.locator("#copy-code").textContent();
    } else {
      await page.locator("#room-code").fill(code);
      await page.locator("#join-room").click();
      await page.waitForFunction(() => Boolean(state?.board) && !busy);
    }
    return page;
  }
  for (let i = 0; i < count; i++) await join(i);
  return {
    pages, errors, service, dataDir, join, port,
    async close() {
      for (const context of contexts) await context.close();
      await service.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function at(page, x, y) {
  return page.evaluate(({ x, y }) => {
    const svg = document.getElementById("board");
    const b = svg.viewBox.baseVal;
    const p = new DOMPoint(b.x + x * b.width, b.y + y * b.height).matrixTransform(svg.getScreenCTM());
    return { x: p.x, y: p.y };
  }, { x, y });
}

async function move(page, x, y) {
  await page.bringToFront();
  const target = await at(page, x, y);
  await page.mouse.move(target.x, target.y);
}

test("shared cursors stay aligned across different zooms; pings do not change the game", async ({ browser }) => {
  const t = await table(browser, 4);
  try {
    const [host, guest] = t.pages;
    await guest.locator("#zoom-in").click();
    await guest.locator("#zoom-in").click();
    await expect(guest.locator("#zoom-reset")).toHaveText("150%");
    const id = await host.evaluate(() => state.viewerId);
    const marker = guest.locator(`.shared-pointer[data-player-id="${id}"]`);
    const revision = await host.evaluate(() => state.revision);
    await move(host, .46, .35);
    await expect(marker).toHaveCount(1);
    const alignment = await guest.evaluate((id) => {
      const cursor = document.querySelector(`.shared-pointer[data-player-id="${id}"]`);
      const svg = document.getElementById("board");
      const b = svg.viewBox.baseVal;
      const target = new DOMPoint(b.x + Number(cursor.dataset.mapX) * b.width, b.y + Number(cursor.dataset.mapY) * b.height).matrixTransform(svg.getScreenCTM());
      const actual = cursor.getScreenCTM();
      return { x: Math.abs(target.x - actual.e), y: Math.abs(target.y - actual.f), label: cursor.textContent };
    }, id);
    expect(alignment.x).toBeLessThan(1);
    expect(alignment.y).toBeLessThan(1);
    expect(alignment.label).toBe("Friend 1");
    expect(await host.evaluate(() => state.revision)).toBe(revision);
    await host.locator("#ping-mode").click();
    const target = await at(host, .5, .4);
    await host.mouse.click(target.x, target.y);
    await expect(guest.locator(`.shared-ping[data-player-id="${id}"]`)).toHaveCount(1);
    expect(await host.evaluate(() => state.revision)).toBe(revision);
    await host.mouse.move(1, 1);
    await expect(marker).toHaveCount(0);
    await expect(guest.locator(`.shared-ping[data-player-id="${id}"]`)).toHaveCount(1);
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("host shuffles a shared preview, player-count changes resize it, and start locks it", async ({ browser }, testInfo) => {
  const t = await table(browser, 4);
  try {
    const [host, guest] = t.pages;
    await expect(guest.locator("#shuffle-map")).toBeDisabled();
    const old = await host.evaluate(() => ({ board: state.board, version: state.mapVersion }));
    await host.locator("#shuffle-map").click();
    await host.waitForFunction((version) => !busy && state.mapVersion > version, old.version);
    const shuffled = await host.evaluate(() => state.board);
    expect(shuffled).not.toEqual(old.board);
    await guest.waitForFunction((version) => state.mapVersion > version, old.version);
    expect(await guest.evaluate(() => state.board)).toEqual(shuffled);
    await host.reload();
    await host.waitForFunction(() => Boolean(state?.board) && !busy);
    expect(await host.evaluate(() => state.board)).toEqual(shuffled);
    // Reload can transfer hosting to another connected seat; use the current host.
    const hostId = await host.evaluate(() => state.hostId);
    const actualHost = (await Promise.all(t.pages.map(async (page) => [page, await page.evaluate(() => state.viewerId)]))).find(([, id]) => id === hostId)[0];
    await t.join(4);
    await actualHost.waitForFunction(() => state.board.tiles.length === 30);
    const expanded = await actualHost.evaluate(() => state.board);
    expect(await actualHost.locator("#board svg").count()).toBe(0);
    await t.join(5);
    await actualHost.waitForFunction(() => state.players.length === 6);
    expect(await actualHost.evaluate(() => state.board)).toEqual(expanded);
    await actualHost.screenshot({ path: testInfo.outputPath("lobby-tabletop-desktop.png"), fullPage: true });
    await actualHost.locator("#start-game").click();
    await actualHost.waitForFunction(() => state.phase === "setup");
    expect(await actualHost.evaluate(() => state.board)).toEqual(expanded);
    await expect(actualHost.locator("#shuffle-map")).not.toBeVisible();
    const current = await actualHost.evaluate(() => state.currentPlayerId);
    const actor = (await Promise.all(t.pages.map(async (page) => [page, await page.evaluate(() => state.viewerId)]))).find(([, id]) => id === current)[0];
    await actor.waitForFunction(() => state.phase === "setup");
    await actor.screenshot({ path: testInfo.outputPath("setup-tabletop-desktop.png"), fullPage: true });
    await actor.setViewportSize({ width: 390, height: 844 });
    expect(await actor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await actor.screenshot({ path: testInfo.outputPath("setup-tabletop-mobile.png"), fullPage: true });
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("point mode cannot place settlements, while ordinary placement and map dragging still work", async ({ browser }) => {
  const t = await table(browser, 4);
  try {
    await t.pages[0].locator("#start-game").click();
    await t.pages[0].waitForFunction(() => state.phase === "setup");
    const actorId = await t.pages[0].evaluate(() => state.currentPlayerId);
    const actor = (await Promise.all(t.pages.map(async (page) => [page, await page.evaluate(() => state.viewerId)]))).find(([, id]) => id === actorId)[0];
    await actor.waitForFunction(() => state.phase === "setup");
    const initial = await actor.evaluate(() => ({ revision: state.revision, id: state.legal.settlementVertices[0] }));
    await actor.locator("#ping-mode").focus();
    await actor.keyboard.press("p");
    await expect(actor.locator("#ping-mode")).toHaveAttribute("aria-pressed", "true");
    const position = await actor.evaluate((id) => {
      const vertex = state.board.vertices.find((v) => v.id === id);
      const p = new DOMPoint(vertex.x * 100, vertex.y * 100).matrixTransform(document.getElementById("board").getScreenCTM());
      return { x: p.x, y: p.y };
    }, initial.id);
    await actor.mouse.click(position.x, position.y);
    await expect(actor.locator(".shared-ping")).toHaveCount(1);
    expect(await actor.evaluate(() => state.revision)).toBe(initial.revision);
    expect(await actor.evaluate(() => state.setupNeedsRoad)).toBe(false);
    await actor.locator("#ping-mode").click();
    await previewPlacement(actor, initial.id);
    await actor.locator("#confirm-placement").click();
    await actor.waitForFunction(() => state.setupNeedsRoad && !busy);
    const revision = await actor.evaluate(() => state.revision);
    await actor.locator("#zoom-in").click();
    await expect(actor.locator("#zoom-reset")).toHaveText("125%");
    await actor.bringToFront();
    const from = await at(actor, .35, .4);
    await actor.mouse.move(from.x, from.y);
    await actor.mouse.down();
    await actor.mouse.move(from.x + 40, from.y + 20, { steps: 6 });
    await actor.mouse.up();
    const pan = await actor.evaluate(() => panzoom.getPan());
    expect(Math.abs(pan.x) + Math.abs(pan.y)).toBeGreaterThan(5);
    expect(await actor.evaluate(() => state.revision)).toBe(revision);
    await actor.locator("#zoom-reset").click();
    await expect(actor.locator("#zoom-reset")).toHaveText("100%");
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("lobby clearly explains missing connections instead of an unexplained disabled start", async ({ browser }) => {
  const t = await table(browser, 4);
  try {
    await t.pages[3].evaluate(() => socket.disconnect());
    await expect(t.pages[0].locator("#lobby-status")).toContainText("Friend 4");
    await expect(t.pages[0].locator("#lobby-status")).toContainText("reconnect");
    await expect(t.pages[0].locator("#start-game")).toBeDisabled();
    await t.pages[3].evaluate(() => socket.connect());
    await t.pages[3].waitForFunction(() => bound && socket.connected);
    await expect(t.pages[0].locator("#start-game")).toBeEnabled();
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("touch players can tap to ping with cursor sharing turned off", async ({ browser }) => {
  const t = await table(browser, 2, 1);
  try {
    const [host, mobile] = t.pages;
    const id = await mobile.evaluate(() => state.viewerId);
    await mobile.locator("#toggle-pointers").tap();
    await expect(mobile.locator("#toggle-pointers")).toHaveAttribute("aria-pressed", "false");
    await mobile.locator("#ping-mode").tap();
    const location = await at(mobile, .5, .38);
    const revision = await mobile.evaluate(() => state.revision);
    await mobile.touchscreen.tap(location.x, location.y);
    await expect(host.locator(`.shared-ping[data-player-id="${id}"]`)).toHaveCount(1);
    await expect(host.locator(`.shared-pointer[data-player-id="${id}"]`)).toHaveCount(0);
    expect(await mobile.evaluate(() => state.revision)).toBe(revision);
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("sound preferences survive reload and fullscreen controls are reversible", async ({ browser }) => {
  const t = await table(browser, 2);
  try {
    const page = t.pages[0];
    await expect(page.locator("#sound-toggle")).toHaveAttribute("aria-pressed", "false");
    await page.locator("#sound-toggle").click();
    await expect(page.locator("#sound-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => audioContext.state)).toBe("running");
    await page.reload();
    await page.waitForFunction(() => Boolean(state?.board) && !busy);
    await expect(page.locator("#sound-toggle")).toHaveAttribute("aria-pressed", "true");
    const spot = await at(page, .5, .4);
    await page.mouse.click(spot.x, spot.y);
    await page.waitForFunction(() => audioContext?.state === "running");
    await page.locator("#sound-toggle").click();
    await expect(page.locator("#sound-toggle")).toHaveAttribute("aria-pressed", "false");
    await page.locator("#fullscreen-toggle").click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    await page.locator("#fullscreen-toggle").click();
    await page.waitForFunction(() => !document.fullscreenElement);
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});
