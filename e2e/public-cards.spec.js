"use strict";

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGameServer } = require("../server");
const { createRoom, addPlayer, startGame, applyAction, publicState } = require("../game");
const { perform } = require("./ui.cjs");

async function fixture(browser, { finished = false } = {}) {
  const { room, player: host } = createRoom("Rowan");
  addPlayer(room, "Mira");
  addPlayer(room, "Ellis");
  startGame(room, host.id, () => .999);
  while (room.phase === "setup") {
    const id = room.players[room.turnIndex].id;
    const view = publicState(room, id);
    applyAction(room, id, view.setupNeedsRoad ? { type: "setupRoad", edgeId: view.legal.roadEdges[0] }
      : { type: "setupSettlement", vertexId: view.legal.settlementVertices[0] });
  }
  applyAction(room, host.id, { type: "roll" }, () => .1);
  const cards = {};
  for (const type of ["knight", "roadBuilding", "yearOfPlenty", "monopoly", "victoryPoint"]) {
    const index = room.developmentDeck.findIndex((card) => card.type === type);
    const card = { ...room.developmentDeck.splice(index, 1)[0], boughtTurn: 0 };
    host.developmentCards.push(card);
    cards[type] = card.id;
  }
  if (finished) {
    const give = (resource, amount) => { room.bank[resource] -= amount; host.resources[resource] += amount; };
    const victoryCards = room.developmentDeck.filter((card) => card.type === "victoryPoint");
    room.developmentDeck = room.developmentDeck.filter((card) => card.type !== "victoryPoint");
    host.developmentCards.push(...victoryCards.map((card) => ({ ...card, boughtTurn: 0 })));
    for (const vertex of room.board.vertices.filter((vertex) => vertex.structure?.playerId === host.id)) {
      give("ore", 3);
      give("wheat", 2);
      applyAction(room, host.id, { type: "buildCity", vertexId: vertex.id });
    }
    give("wood", 1);
    give("brick", 1);
    give("sheep", 1);
    give("wheat", 1);
    for (let step = 0; step < 10 && !room.winnerId; step++) {
      let view = publicState(room, host.id);
      if (view.legal.settlementVertices.length) {
        applyAction(room, host.id, { type: "buildSettlement", vertexId: view.legal.settlementVertices[0] });
      } else {
        give("wood", 1);
        give("brick", 1);
        view = publicState(room, host.id);
        applyAction(room, host.id, { type: "buildRoad", edgeId: view.legal.roadEdges[0] });
      }
    }
    expect(room.winnerId).toBe(host.id);
  }
  room.code = "PUBDEV";
  room.updatedAt = Date.now();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-public-cards-"));
  fs.writeFileSync(path.join(dataDir, "PUBDEV.json"), JSON.stringify({ version: 2, room }));
  let service = createGameServer({ dataDir, random: () => .1 });
  const services = [service];
  const port = await service.listen();
  const pages = [];
  const contexts = [];
  const byId = new Map();
  const errors = [];
  for (const player of room.players) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexts.push(context);
    const page = await context.newPage();
    pages.push(page);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => socket.connected);
    await page.locator(".resume-details > summary").click();
    await page.locator("#resume-key").fill(player.reconnectToken);
    await page.locator("#import-session").click();
    await page.waitForFunction(() => bound && state && !busy);
    byId.set(player.id, page);
  }
  return {
    room, cards, pages, byId, errors, get service() { return service; },
    async restart() {
      await service.close();
      service = createGameServer({ dataDir, random: () => .1 });
      services.push(service);
      await service.listen(port);
    },
    async close() {
      for (const context of contexts) await context.close();
      for (const instance of services) await instance.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function nextOwnTurn(t) {
  const actor = t.pages[0];
  if (await actor.locator("#roll-button").count()) await perform(actor, { type: "roll" });
  await perform(actor, { type: "endTurn" });
  let view = await actor.evaluate(() => state);
  while (view.currentPlayerId !== t.room.players[0].id) {
    const page = t.byId.get(view.currentPlayerId);
    await page.waitForFunction((revision) => state.revision >= revision && !busy, view.revision);
    await perform(page, { type: "roll" });
    await perform(page, { type: "endTurn" });
    view = await page.evaluate(() => state);
  }
  await actor.waitForFunction(() => state.currentPlayerId === state.viewerId && !busy);
}

test("public cards update live for opponents and persist through reload/restart without exposing private hands", async ({ browser }, testInfo) => {
  const t = await fixture(browser);
  try {
    const [actor, observer] = t.pages;
    const ownerId = t.room.players[0].id;
    await observer.locator(`[data-public-player="${ownerId}"]`).click();
    await expect(observer.locator("#public-cards-dialog")).toBeVisible();
    await expect(observer.locator("#public-knights")).toContainText("No Knights played");
    await expect(observer.locator("#public-progress")).toContainText("No progress cards played");
    await expect(observer.locator("#public-card-privacy")).toContainText("5 unplayed cards remain private");
    await expect(observer.locator("#public-victory-section")).not.toBeVisible();
    await expect(observer.locator("#public-cards-dialog .play-card")).toHaveCount(0);
    const publicPlayer = await observer.evaluate((id) => state.players.find((p) => p.id === id), ownerId);
    expect(publicPlayer.developmentCards).toBeUndefined();
    expect(publicPlayer.revealedDevelopment.victoryPoint).toBeUndefined();
    await actor.locator(`[data-public-player="${ownerId}"]`).click();
    await expect(actor.locator("#public-victory-section")).not.toBeVisible();
    await expect(actor.locator("#public-cards-dialog [data-revealed-type]")).toHaveCount(0);
    await actor.locator("#public-cards-done").click();
    const focusedPicker = observer.locator(`[data-picker="public-player-choice"][data-value="${ownerId}"]`);
    await focusedPicker.focus();
    await perform(actor, { type: "playDevelopment", cardId: t.cards.knight });
    await expect(observer.locator('#public-knights [data-revealed-type="knight"]')).toContainText("×1");
    await expect(focusedPicker).toBeFocused();
    await expect(observer.locator("#public-knight-caption")).toContainText("1 played Knight");
    await expect(observer.locator("#public-progress [data-revealed-type]")).toHaveCount(0);
    await perform(actor, { type: "moveRobber", tileId: await actor.evaluate(() => state.legal.robberTiles[0]) });
    if (await actor.evaluate(() => state.phase === "steal")) {
      await perform(actor, { type: "steal", targetId: await actor.evaluate(() => state.robberVictims[0]) });
    }
    await observer.locator("#close-public-cards").click();
    await nextOwnTurn(t);
    await observer.locator(`[data-public-player="${ownerId}"]`).click();
    await perform(actor, { type: "playDevelopment", cardId: t.cards.monopoly, resource: "wood" });
    await expect(observer.locator('#public-progress [data-revealed-type="monopoly"]')).toContainText("×1");
    await expect(observer.locator('#public-progress [data-revealed-type="monopoly"]')).toContainText("discard pile");
    await expect(observer.locator('#public-progress [data-revealed-type="roadBuilding"]')).toHaveCount(0);
    await expect(observer.locator("#public-victory-section")).not.toBeVisible();
    await observer.locator("#public-cards-done").click();
    await nextOwnTurn(t);
    await observer.locator(`[data-public-player="${ownerId}"]`).click();
    await perform(actor, { type: "playDevelopment", cardId: t.cards.yearOfPlenty, resources: { ore: 2 } });
    await expect(observer.locator('#public-progress [data-revealed-type="yearOfPlenty"]')).toContainText("×1");
    await observer.locator("#public-cards-done").click();
    await nextOwnTurn(t);
    await observer.locator(`[data-public-player="${ownerId}"]`).click();
    await perform(actor, { type: "playDevelopment", cardId: t.cards.roadBuilding });
    while (await actor.evaluate(() => state.freeRoadsRemaining > 0)) {
      await perform(actor, { type: "buildRoad", edgeId: await actor.evaluate(() => state.legal.roadEdges[0]) });
    }
    await expect(observer.locator('#public-progress [data-revealed-type="roadBuilding"]')).toContainText("×1");
    await expect(observer.locator("#public-card-privacy")).toContainText("1 unplayed card remains private");
    await expect(observer.locator("#public-history-warning")).not.toBeVisible();
    await observer.locator("#public-cards-dialog").screenshot({ path: testInfo.outputPath("public-development-desktop.png") });
    await observer.setViewportSize({ width: 390, height: 844 });
    await observer.locator("#public-cards-dialog").screenshot({ path: testInfo.outputPath("public-development-mobile.png") });
    expect(await observer.evaluate(() => document.getElementById("public-cards-dialog").getBoundingClientRect().width <= innerWidth)).toBe(true);
    await observer.reload();
    await observer.waitForFunction(() => bound && state && !busy);
    await observer.locator(`[data-public-player="${ownerId}"]`).click();
    await expect(observer.locator('#public-progress [data-revealed-type="monopoly"]')).toContainText("×1");
    const before = await t.service.storage.getRoom("PUBDEV");
    await t.restart();
    await observer.waitForFunction((revision) => bound && socket.connected && state.revision > revision, before.revision);
    await expect(observer.locator('#public-knights [data-revealed-type="knight"]')).toContainText("×1");
    await expect(observer.locator('#public-progress [data-revealed-type="monopoly"]')).toContainText("×1");
    const after = await t.service.storage.getRoom("PUBDEV");
    expect(after.board).toEqual(before.board);
    expect(after.players[0].resources).toEqual(before.players[0].resources);
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("gallery player switching is keyboard accessible", async ({ browser }) => {
  const t = await fixture(browser);
  try {
    const observer = t.pages[1];
    await observer.locator(`[data-public-player="${t.room.players[0].id}"]`).focus();
    await observer.keyboard.press("Enter");
    await expect(observer.locator("#public-cards-title")).toContainText("Rowan");
    await observer.locator(`[data-picker="public-player-choice"][data-value="${t.room.players[0].id}"]`).focus();
    await observer.keyboard.press("ArrowRight");
    await expect(observer.locator("#public-cards-title")).toContainText("Mira");
    await expect(observer.locator(`[data-picker="public-player-choice"][data-value="${t.room.players[1].id}"]`)).toBeFocused();
    await observer.keyboard.press("ArrowRight");
    await expect(observer.locator("#public-cards-title")).toContainText("Ellis");
    await observer.keyboard.press("Escape");
    await expect(observer.locator("#public-cards-dialog")).not.toBeVisible();
    await expect(observer.locator(`[data-public-player="${t.room.players[0].id}"]`)).toBeFocused();
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("completed games reveal victory cards in the public gallery", async ({ browser }) => {
  const t = await fixture(browser, { finished: true });
  try {
    const observer = t.pages[1];
    await observer.locator(`[data-public-player="${t.room.players[0].id}"]`).click();
    await expect(observer.locator("#public-victory-section")).toBeVisible();
    await expect(observer.locator('#public-victory [data-revealed-type="victoryPoint"]')).toContainText("×5");
    await expect(observer.locator("#public-card-privacy")).toContainText("4 unplayed cards remain private");
    await expect(observer.locator("#public-cards-dialog .play-card")).toHaveCount(0);
  } finally { await t.close(); }
});
