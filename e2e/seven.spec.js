"use strict";

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGameServer } = require("../server");
const { createRoom, addPlayer, startGame, applyAction, publicState } = require("../game");
const { choose } = require("./ui.cjs");

async function fixture(browser, emptyVictims = false) {
  const { room, player: actor } = createRoom("Rowan");
  ["Mira", "Ellis", "Noa"].forEach((name) => addPlayer(room, name));
  startGame(room, actor.id, () => .999);
  while (room.phase === "setup") {
    const id = room.players[room.turnIndex].id;
    const view = publicState(room, id);
    applyAction(room, id, view.setupNeedsRoad ? { type: "setupRoad", edgeId: view.legal.roadEdges[0] }
      : { type: "setupSettlement", vertexId: view.legal.settlementVertices[0] });
  }
  for (const player of room.players) {
    for (const resource of Object.keys(player.resources)) {
      room.bank[resource] += player.resources[resource];
      player.resources[resource] = 0;
    }
  }
  const hands = emptyVictims ? [{ wood: 6 }, {}, {}, { wheat: 6 }] :
    [{ wood: 5, brick: 4 }, { sheep: 8 }, { ore: 7 }, { wheat: 6 }];
  hands.forEach((hand, index) => {
    for (const [resource, count] of Object.entries(hand)) {
      room.players[index].resources[resource] = count;
      room.bank[resource] -= count;
    }
  });
  room.players[2].developmentCards = room.developmentDeck.splice(0, 5).map((card) => ({ ...card, boughtTurn: 0 }));
  room.code = "SEVENS";
  room.updatedAt = Date.now();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-seven-ui-"));
  fs.writeFileSync(path.join(dataDir, "SEVENS.json"), JSON.stringify({ version: 2, room }));
  const draws = [0, .999, .5];
  const service = createGameServer({ dataDir, random: () => draws.shift() ?? .5 });
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
    await page.waitForFunction(() => bound && state && !busy);
  }
  return {
    room, pages, contexts, service,
    read: () => service.storage.getRoom("SEVENS"),
    async close() {
      for (const context of contexts) await context.close();
      await service.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("seven opens clear discard choices, preserves a draft during peer updates, then lets the roller choose a victim", async ({ browser }, testInfo) => {
  const t = await fixture(browser);
  try {
    const [actor, mira, ellis, noa] = t.pages;
    const beforeBank = structuredClone((await t.read()).bank);
    await actor.locator("#roll-button").click();
    await expect(actor.locator("#discard-dialog")).toBeVisible();
    await expect(mira.locator("#discard-dialog")).toBeVisible();
    await expect(ellis.locator("#discard-dialog")).not.toBeVisible();
    await expect(noa.locator("#discard-dialog")).not.toBeVisible();
    await actor.waitForFunction(() => !busy);
    await expect(actor.locator("#discard-total")).toHaveText("9");
    await expect(actor.locator("#discard-required")).toHaveText("4");
    await expect(actor.locator("#discard-keep")).toHaveText("5");
    await expect(actor.locator("#submit-discard")).toBeDisabled();
    await expect(ellis.locator("#required-action")).toContainText("7 resources");
    expect(await ellis.evaluate(() => state.players.find((p) => p.id === state.viewerId).developmentCount)).toBe(5);
    await actor.locator("#discard-wood").fill("2");
    await actor.locator("#discard-brick").fill("2");
    await expect(actor.locator("#submit-discard")).toBeEnabled();
    await actor.locator("#discard-view-board").click();
    await expect(actor.locator("#discard-dialog")).not.toBeVisible();
    await mira.locator("#discard-sheep").fill("4");
    await mira.locator("#submit-discard").click();
    await expect(mira.locator("#discard-dialog")).not.toBeVisible();
    await expect(mira.locator("#required-action")).toContainText("Your cards are returned");
    await actor.waitForFunction(() => Object.keys(state.pendingDiscards).length === 1);
    await expect(actor.locator("#discard-dialog")).not.toBeVisible();
    await actor.locator("#choose-discard").click();
    await expect(actor.locator("#discard-wood")).toHaveValue("2");
    await expect(actor.locator("#discard-brick")).toHaveValue("2");
    await actor.setViewportSize({ width: 390, height: 844 });
    await actor.locator("#discard-dialog").screenshot({ path: testInfo.outputPath("discard-mobile.png") });
    expect(await actor.evaluate(() => document.getElementById("discard-dialog").getBoundingClientRect().width <= innerWidth)).toBe(true);
    await actor.locator("#submit-discard").click();
    await actor.waitForFunction(() => state.phase === "robber" && !busy);
    await expect(actor.locator("#discard-dialog")).not.toBeVisible();
    const discarded = await t.read();
    expect(discarded.bank.wood).toBe(beforeBank.wood + 2);
    expect(discarded.bank.brick).toBe(beforeBank.brick + 2);
    expect(discarded.bank.sheep).toBe(beforeBank.sheep + 4);
    expect(await actor.evaluate(() => state.players.find((p) => p.id === state.viewerId).resourceCount)).toBe(5);
    await actor.setViewportSize({ width: 1440, height: 1000 });
    await choose(actor, "location-select", "t0");
    await actor.locator("#place-location").click();
    await actor.waitForFunction(() => state.phase === "steal" && !busy);
    await expect(actor.locator(".steal-target")).toHaveCount(2);
    await actor.locator("#required-action").screenshot({ path: testInfo.outputPath("steal-choice.png") });
    const ellisId = t.room.players[2].id;
    const bankBeforeSteal = structuredClone((await t.read()).bank);
    await actor.locator(`[data-target="${ellisId}"]`).click();
    await actor.waitForFunction(() => state.phase === "action" && !busy);
    const final = await t.read();
    expect(final.bank).toEqual(bankBeforeSteal);
    expect(final.players[0].resources.ore).toBe(1);
    expect(final.players[2].resources.ore).toBe(6);
    expect(final.players[2].developmentCards).toHaveLength(5);
    const hidden = final.log.filter((event) => ["discarded", "resourceStolen"].includes(event.type));
    for (const event of hidden) {
      expect(event.data.resources).toBeUndefined();
      expect(event.data.resource).toBeUndefined();
    }
    await expect(actor.locator("#board .terrain-label")).toHaveCount(0);
    expect(await actor.locator("#board .token-text").count()).toBeGreaterThan(0);
  } finally { await t.close(); }
});

test("a seven with no large hands goes straight to the robber and empty opponents cannot be robbed", async ({ browser }) => {
  const t = await fixture(browser, true);
  try {
    const actor = t.pages[0];
    await actor.locator("#roll-button").click();
    await actor.waitForFunction(() => state.phase === "robber" && !busy);
    for (const page of t.pages) await expect(page.locator("#discard-dialog")).not.toBeVisible();
    const before = (await t.read()).players.map((p) => p.resources);
    await choose(actor, "location-select", "t0");
    await actor.locator("#place-location").click();
    await actor.waitForFunction(() => state.phase === "action" && !busy);
    await expect(actor.locator(".steal-target")).toHaveCount(0);
    await expect(actor.locator("#toast")).toContainText("No eligible opponent");
    expect((await t.read()).players.map((p) => p.resources)).toEqual(before);
  } finally { await t.close(); }
});

test("closing and reopening a browser restores the required discard without returning cards automatically", async ({ browser }) => {
  const t = await fixture(browser);
  try {
    const actor = t.pages[0];
    const originalBank = structuredClone((await t.read()).bank);
    await actor.locator("#roll-button").click();
    await expect(actor.locator("#discard-dialog")).toBeVisible();
    await actor.waitForFunction(() => !busy);
    await actor.locator("#discard-wood").fill("2");
    const storageState = await t.contexts[0].storageState();
    await t.contexts[0].close();
    const context = await browser.newContext({ storageState });
    t.contexts.push(context);
    const page = await context.newPage();
    const port = t.service.server.address().port;
    await page.goto(`http://127.0.0.1:${port}/?room=SEVENS`);
    await page.waitForFunction(() => bound && !busy);
    await expect(page.locator("#discard-dialog")).toBeVisible();
    await expect(page.locator("#discard-total")).toHaveText("9");
    await expect(page.locator("#discard-required")).toHaveText("4");
    await expect(page.locator("#submit-discard")).toBeDisabled();
    expect((await t.read()).bank).toEqual(originalBank);
    expect(await page.evaluate(() => state.players.find((p) => p.id === state.viewerId).resourceCount)).toBe(9);
  } finally { await t.close(); }
});
