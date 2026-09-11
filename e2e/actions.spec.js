"use strict";

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRoom, addPlayer, startGame, applyAction, publicState } = require("../game");
const { createGameServer } = require("../server");
const { plan } = require("./strategy.cjs");
const { choose } = require("./ui.cjs");

async function clickAndWait(page, selector) {
  const revision = await page.evaluate(() => state.revision);
  await page.locator(selector).click();
  await page.waitForFunction((old) => !busy && state.revision > old, revision);
}

async function fixture(browser) {
  const { room, player: host } = createRoom("Host");
  for (const name of ["Cedar", "River", "Ember"]) addPlayer(room, name);
  startGame(room, host.id, () => 0.42);
  while (room.phase === "setup") {
    const view = publicState(room, room.players[room.turnIndex].id);
    applyAction(room, view.viewerId, plan(view));
  }
  room.phase = "action";
  room.code = "EETEST";
  room.updatedAt = Date.now();
  const actor = room.players[room.turnIndex];
  const target = room.players.find((p) => p.id !== actor.id);
  // Explicit fixture supply for isolated UI paths; the full-game spec never injects cards/resources.
  function grant(p, bundle) {
    for (const [r, amount] of Object.entries(bundle)) { room.bank[r] -= amount; p.resources[r] += amount; }
  }
  grant(actor, { wood: 6, brick: 3, sheep: 2, wheat: 4, ore: 4 });
  grant(target, { ore: 3, brick: 2 });
  for (const type of ["knight", "roadBuilding", "yearOfPlenty", "monopoly", "victoryPoint"]) {
    const index = room.developmentDeck.findIndex((card) => card.type === type);
    actor.developmentCards.push({ ...room.developmentDeck.splice(index, 1)[0], boughtTurn: 0 });
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-ui-actions-"));
  fs.writeFileSync(path.join(dataDir, `${room.code}.json`), JSON.stringify({ version: 2, room }));
  const service = createGameServer({ dataDir, random: () => 0 });
  const port = await service.listen();
  expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
  const contexts = [];
  const byId = new Map();
  const errors = [];
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
    await page.waitForFunction((id) => state?.viewerId === id && !busy, player.id);
    byId.set(player.id, page);
  }
  return {
    service, dataDir, port,
    actor: byId.get(actor.id), target: byId.get(target.id), byId, actorId: actor.id, targetId: target.id, errors,
    async close(additionalServices = []) {
      for (const context of contexts) await context.close();
      await service.close();
      for (const additional of additionalServices) await additional.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function offer(page, targetId, giveResource, giveAmount, wantResource, wantAmount) {
  await page.locator("#trade-details").evaluate((node) => { node.open = true; });
  await page.locator('[data-tab="player"]').click();
  await choose(page, "trade-target", targetId);
  for (const r of ["wood", "brick", "sheep", "wheat", "ore"]) {
    await page.locator(`#give-${r}`).fill(String(r === giveResource ? giveAmount : 0));
    await page.locator(`#want-${r}`).fill(String(r === wantResource ? wantAmount : 0));
  }
  await clickAndWait(page, "#offer-submit");
}

test("browser offers, counteroffers, acceptance, rejection, cancellation and port-rate bank trades", async ({ browser }) => {
  const table = await fixture(browser);
  try {
    const aBefore = await table.actor.evaluate(() => state.players.find((p) => p.id === state.viewerId).resources);
    const bBefore = await table.target.evaluate(() => state.players.find((p) => p.id === state.viewerId).resources);
    await offer(table.actor, table.targetId, "wood", 1, "ore", 1);
    await table.target.waitForFunction(() => state.trade?.targetId === state.viewerId);
    await offer(table.target, table.actorId, "ore", 1, "wood", 2);
    await table.actor.waitForFunction(() => state.trade?.targetId === state.viewerId);
    await clickAndWait(table.actor, "#accept-trade");
    const after = await table.actor.evaluate(() => state.players.find((p) => p.id === state.viewerId).resources);
    expect(after.wood).toBe(aBefore.wood - 2);
    expect(after.ore).toBe(aBefore.ore + 1);
    await table.target.waitForFunction(() => !state.trade);
    expect(await table.target.evaluate(() => state.players.find((p) => p.id === state.viewerId).resources.wood)).toBe(bBefore.wood + 2);
    await offer(table.actor, table.targetId, "wood", 1, "ore", 1);
    await table.target.waitForFunction(() => Boolean(state.trade));
    await clickAndWait(table.target, "#decline-trade");
    await table.actor.waitForFunction(() => !state.trade);
    await offer(table.actor, table.targetId, "wood", 1, "ore", 1);
    await clickAndWait(table.actor, "#cancel-trade");
    expect(await table.actor.evaluate(() => state.trade)).toBeNull();
    const rate = await table.actor.evaluate(() => state.players.find((p) => p.id === state.viewerId).tradeRates.wood);
    await table.actor.locator('[data-tab="bank"]').click();
    await choose(table.actor, "bank-give", "wood");
    await choose(table.actor, "bank-receive", "ore");
    await clickAndWait(table.actor, "#bank-submit");
    expect(await table.actor.evaluate(() => state.players.find((p) => p.id === state.viewerId).resources.wood)).toBe(after.wood - rate);
    expect(table.errors).toEqual([]);
  } finally { await table.close(); }
});

test("open browser seats reconnect after a server restart without losing their position", async ({ browser }) => {
  const table = await fixture(browser);
  let replacement;
  try {
    const before = await table.actor.evaluate(() => ({ id: state.viewerId, board: state.board, cards: state.players.find((p) => p.id === state.viewerId).developmentCards, revision: state.revision }));
    let stopped = false;
    const closing = table.service.close().then(() => { stopped = true; });
    await expect.poll(() => stopped, { timeout: 10_000, message: "Server must shut down with open browser seats" }).toBe(true);
    await closing;
    replacement = createGameServer({ dataDir: table.dataDir, random: () => 0 });
    await replacement.listen(table.port);
    await table.actor.waitForFunction((before) => socket.connected && bound && state.revision > before.revision && state.viewerId === before.id, before, { timeout: 15_000 });
    const after = await table.actor.evaluate(() => ({ board: state.board, cards: state.players.find((p) => p.id === state.viewerId).developmentCards }));
    expect(after.board).toEqual(before.board);
    expect(after.cards).toEqual(before.cards);
    expect(table.errors).toEqual([]);
  } finally {
    await table.close(replacement ? [replacement] : []);
  }
});

test("all development-card dialogs resolve through browser controls with one card per activation", async ({ browser }) => {
  const table = await fixture(browser);
  try {
    for (const type of ["yearOfPlenty", "monopoly", "roadBuilding", "knight"]) {
      const page = table.actor;
      await page.waitForFunction((id) => state.currentPlayerId === id && ["roll", "action"].includes(state.phase), table.actorId);
      const card = await page.evaluate((type) => state.players.find((p) => p.id === state.viewerId).developmentCards.find((c) => c.type === type), type);
      await page.locator(`[data-card="${card.id}"]`).click();
      await expect(page.locator("#development-dialog")).toBeVisible();
      if (type === "yearOfPlenty") await page.locator("#plenty-wheat").fill("2");
      if (type === "monopoly") await choose(page, "monopoly-resource", "brick");
      await clickAndWait(page, "#play-development");
      await expect(page.locator("#development-dialog")).not.toBeVisible();
      if (type === "roadBuilding") {
        for (let road = 0; road < 2; road++) {
          await expect(page.locator("#place-location")).toBeEnabled();
          await clickAndWait(page, "#place-location");
        }
        expect(await page.evaluate(() => state.freeRoadsRemaining)).toBe(0);
      }
      if (type === "knight") {
        const view = await page.evaluate(() => state);
        const move = plan(view);
        await choose(page, "location-select", move.tileId);
        await clickAndWait(page, "#place-location");
        if (await page.evaluate(() => state.phase === "steal")) {
          await clickAndWait(page, ".steal-target:first-of-type");
        }
      }
      expect(await page.locator(".play-card:enabled").count()).toBe(0);
      if (await page.locator("#roll-button").count()) await clickAndWait(page, "#roll-button");
      await clickAndWait(page, "#end-turn");
      let view = await page.evaluate(() => state);
      while (view.currentPlayerId !== table.actorId) {
        const other = table.byId.get(view.currentPlayerId);
        await other.waitForFunction((revision) => state.revision >= revision, view.revision);
        await clickAndWait(other, "#roll-button");
        await clickAndWait(other, "#end-turn");
        view = await other.evaluate(() => state);
      }
    }
    const self = await table.actor.evaluate(() => state.players.find((p) => p.id === state.viewerId));
    expect(self.knightsPlayed).toBe(1);
    expect(self.developmentCards.map((card) => card.type)).toEqual(["victoryPoint"]);
    expect(table.errors).toEqual([]);
  } finally { await table.close(); }
});
