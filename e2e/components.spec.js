"use strict";

const { test, expect } = require("@playwright/test");
const express = require("express");
const http = require("node:http");
const path = require("node:path");
const { Server } = require("socket.io");
const { createRoom, addPlayer, startGame, applyAction, publicState, COSTS } = require("../game");
const { previewPlacement } = require("./ui.cjs");

let server;
let io;
let url;
test.beforeAll(async () => {
  const app = express();
  app.get("/vendor/panzoom.min.js", (_request, response) => response.sendFile(require.resolve("@panzoom/panzoom/dist/panzoom.min.js")));
  app.use(express.static(process.env.HEARTHLANDS_PUBLIC_DIR || path.join(__dirname, "..", "public")));
  server = http.createServer(app);
  io = new Server(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  expect((await fetch(url)).ok).toBe(true);
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => io.close(resolve));
});

function fixture(phase = "action", playerCount = 4) {
  const { room, player } = createRoom("Rowan");
  ["Mira", "Ellis", "Noa", "Sage", "Ash"].slice(0, playerCount - 1).forEach((name) => addPlayer(room, name));
  startGame(room, player.id, () => .999);
  room.code = "UITEST";
  if (phase !== "setup") {
    while (room.phase === "setup") {
      const actor = room.players[room.turnIndex];
      const view = publicState(room, actor.id);
      applyAction(room, actor.id, view.setupNeedsRoad
        ? { type: "setupRoad", edgeId: view.legal.roadEdges[0] }
        : { type: "setupSettlement", vertexId: view.legal.settlementVertices[0] });
    }
    applyAction(room, room.players[room.turnIndex].id, { type: "roll" }, () => .3);
    const actor = room.players[room.turnIndex];
    for (const [resource, amount] of Object.entries({ wood: 4, brick: 3, sheep: 2, wheat: 3, ore: 3 })) {
      room.bank[resource] -= amount;
      actor.resources[resource] += amount;
    }
    for (const type of ["knight", "monopoly", "roadBuilding", "yearOfPlenty", "victoryPoint"]) {
      const index = room.developmentDeck.findIndex((card) => card.type === type);
      actor.developmentCards.push({ ...room.developmentDeck.splice(index, 1)[0], boughtTurn: 0 });
    }
  }
  room.players[1].connected = false;
  return publicState(room, room.players[room.turnIndex].id);
}

async function story(page, view = fixture()) {
  await page.goto(url);
  await page.waitForFunction(() => socket.connected);
  // Component-only fixture. Integration specs submit all actual game actions to the server.
  await page.evaluate((view) => {
    state = view;
    bound = true;
    connection.bound = true;
    elements.landing.classList.add("hidden");
    elements.game.classList.remove("hidden");
    render();
  }, view);
}

test("player nameplates label their statistics and explain offline seats", async ({ page }, testInfo) => {
  await story(page);
  await expect(page.locator(".player-nameplate")).toHaveCount(4);
  await expect(page.locator(".player-nameplate").nth(1)).toContainText("Offline");
  for (const label of ["Resources", "Dev cards", "Longest road", "Played knights"]) await expect(page.locator(".player-nameplate").first()).toContainText(label);
  expect(await page.locator(".player-nameplate").first().evaluate((node) => getComputedStyle(node).backgroundImage)).toBe("none");
  await page.locator(".players-panel").screenshot({ path: testInfo.outputPath("player-nameplates.png") });
});

for (const [width, count] of [[1920, 3], [1440, 3], [1100, 3], [390, 6], [320, 6]]) {
  test(`tabletop nameplates stay readable for ${count} seats at ${width}px without exposing hands`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width > 1020 ? 1000 : 844 });
    const view = fixture("action", count);
    view.hostId = view.players[2].id;
    view.players[0].name = "amansha";
    view.players[1].name = count === 6 ? "LongName<&>1234567890" : "asur";
    view.players[2].name = "Shivam";
    view.players[0].points = 7;
    view.players[0].resourceCount = count === 6 ? 120 : 12;
    view.players[0].developmentCount = count === 6 ? 34 : 5;
    view.players[2].longestRoad = 6;
    view.longestRoadHolderId = view.players[2].id;
    await story(page, view);
    const before = await page.evaluate(() => JSON.stringify(state));
    await expect(page.locator(".nameplate-plaque")).toHaveCount(count);
    await expect(page.locator('.nameplate-plaque[aria-current="true"]')).toHaveCount(1);
    await expect(page.locator(".nameplate-plaque .admin-chip:visible")).toHaveCount(1);
    for (const player of view.players) {
      const plate = page.locator(`[data-nameplate-player="${player.id}"]`);
      await expect(plate.locator(".player-name")).toHaveText(player.name);
      await expect(plate.locator(".player-score strong")).toHaveText(String(player.points));
      for (const [metric, value] of Object.entries({
        resources: player.resourceCount, development: player.developmentCount || 0,
        road: player.longestRoad || 0, knights: player.knightsPlayed || 0,
      })) await expect(plate.locator(`[data-stat="${metric}"] b`)).toHaveText(String(value));
      expect(await plate.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await expect(plate.locator(".physical-resource, .play-card, [data-development-type]")).toHaveCount(0);
    }
    await expect(page.locator(".remove-player")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator("#players").screenshot({ path: testInfo.outputPath(`nameplates-${count}-${width}.png`) });
    if (width <= 1020) {
      const last = page.locator(".nameplate-plaque").last();
      await last.scrollIntoViewIfNeeded();
      await expect(last.locator(".public-cards-link")).toBeInViewport();
      expect(await last.locator(".public-cards-link").evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => JSON.stringify(state))).toBe(before);
  });
}

test("nameplate controls survive peer updates and permission changes without losing focus", async ({ page }) => {
  await story(page);
  const viewer = await page.evaluate(() => state.viewerId);
  const link = page.locator(`[data-public-player="${viewer}"]`);
  await link.focus();
  const survived = await page.evaluate(() => {
    const button = document.querySelector(`[data-public-player="${state.viewerId}"]`);
    state.players[1].connected = true;
    state.players[0].resourceCount++;
    render();
    return document.querySelector(`[data-public-player="${state.viewerId}"]`) === button;
  });
  expect(survived).toBe(true);
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#public-cards-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(link).toBeFocused();
  await expect(page.locator(".remove-player")).toHaveCount(3);
  const target = await page.evaluate(() => state.players[1].id);
  await page.locator(`.remove-player[data-player="${target}"]`).click();
  await expect(page.locator("#admin-remove-dialog")).toBeVisible();
  await page.evaluate((id) => { state.hostId = id; render(); }, target);
  await expect(page.locator("#admin-remove-dialog")).not.toBeVisible();
  await expect(page.locator(".remove-player")).toHaveCount(0);
  await expect(page.locator(".admin-chip:visible")).toHaveCount(1);
});

test("nameplate status distinguishes paired turns, offline seats, mandatory discards, removal requests and victory", async ({ page }) => {
  const view = fixture();
  const waiting = view.players[1];
  view.turnRole = "secondary";
  view.pendingDiscards = { [waiting.id]: 4 };
  view.removalRequests = [{ playerId: waiting.id, requestedAt: Date.now() }];
  view.largestArmyHolderId = view.viewerId;
  view.players[0].knightsPlayed = 3;
  await story(page, view);
  await expect(page.locator(`[data-nameplate-player="${waiting.id}"]`)).toContainText("Offline · seat saved");
  await expect(page.locator(`[data-nameplate-player="${waiting.id}"]`)).toContainText("Must return 4 cards");
  await expect(page.locator(`[data-nameplate-player="${waiting.id}"]`)).toContainText("Removal requested");
  await expect(page.locator(".nameplate-plaque.current .role-label")).toHaveText("Your turn · paired");
  await expect(page.locator(".nameplate-plaque.current .bonus-label")).toContainText("Largest Army +2");
  await page.evaluate(() => {
    state.phase = "finished"; state.winnerId = state.players[2].id; state.pendingDiscards = {}; state.removalRequests = [];
    renderPlayers();
  });
  await expect(page.locator(".nameplate-plaque.current")).toHaveCount(0);
  await expect(page.locator(".nameplate-plaque.winner")).toHaveCount(1);
  await expect(page.locator(".nameplate-plaque.winner .role-label")).toHaveText("Winner");
  await expect(page.locator(".remove-player")).toHaveCount(0);
  await page.evaluate(() => { state.phase = "lobby"; state.winnerId = null; renderPlayers(); });
  await expect(page.locator(".nameplate-plaque.current")).toHaveCount(0);
  await expect(page.locator(".nameplate-plaque.winner")).toHaveCount(0);
  await expect(page.locator(".nameplate-metrics:visible")).toHaveCount(0);
  await expect(page.locator("[data-public-player]")).toHaveCount(0);
  await expect(page.locator(".player-score").first()).toHaveAttribute("aria-label", "Score starts when the game begins");
});

for (const width of [1440, 390, 320]) test(`help resource conversion card matches authoritative costs and fits a ${width}px viewport`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  await story(page);
  const before = await page.evaluate(() => JSON.stringify(state));
  await page.locator("#rules-button").click();
  await expect(page.locator("#rules-dialog")).toBeVisible();
  await expect(page.getByRole("region", { name: "Resource conversion reference card" })).toBeVisible();
  for (const [kind, cost] of Object.entries(COSTS)) {
    const row = page.locator(`[data-reference-build="${kind}"]`);
    const displayed = await row.locator("[data-resource]").evaluateAll((nodes) =>
      Object.fromEntries(nodes.map((node) => [node.dataset.resource, Number(node.dataset.count)])));
    expect(displayed).toEqual(cost);
  }
  for (const rate of [4, 3, 2]) {
    const card = page.locator(`[data-reference-rate="${rate}"]`);
    await expect(card).toContainText(`${rate}:1`);
    await expect(card).toContainText("1 different resource");
  }
  await expect(page.locator('[data-reference-rate="2"]')).toContainText("port's resource");
  await expect(page.locator("#resource-reference")).toContainText("after rolling");
  expect(await page.locator("#rules-dialog").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.locator("#resource-reference").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(state))).toBe(before);
  if (width !== 320) {
    if (width === 1440) {
      await page.locator("#resource-reference").screenshot({ path: testInfo.outputPath(`resource-reference-${width}.png`) });
    } else {
      await page.locator("#rules-dialog").evaluate((node) => { node.scrollTop = 0; });
      await page.locator("#rules-dialog").screenshot({ path: testInfo.outputPath("resource-reference-mobile-costs.png") });
    }
  }
  await page.locator('[data-reference-rate="2"]').scrollIntoViewIfNeeded();
  await expect(page.locator('[data-reference-rate="2"]')).toBeInViewport();
  if (width === 390) await page.locator("#rules-dialog").screenshot({ path: testInfo.outputPath("resource-reference-mobile-rates.png") });
  await page.keyboard.press("Escape");
  await expect(page.locator("#rules-dialog")).not.toBeVisible();
  await expect(page.locator("#rules-button")).toBeFocused();
});

for (const width of [1440, 390, 320]) test(`development meanings in help cover every card without changing game state at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  await story(page);
  const before = await page.evaluate(() => JSON.stringify(state));
  await page.locator("#rules-button").focus();
  await page.keyboard.press("Enter");
  await page.locator("#show-development-guide").click();
  await expect(page.locator("#development-reference-title")).toBeFocused();
  await expect(page.locator("#development-reference-title")).toBeInViewport();
  const guide = page.getByRole("region", { name: "Development card meanings" });
  await expect(guide.locator("[data-guide-card]")).toHaveCount(5);
  const meanings = {
    knight: ["Knight", "one random resource card", "No one discards", "3", "Largest Army"],
    roadBuilding: ["Road Building", "up to two roads for free", "legal spot", "card is still spent"],
    yearOfPlenty: ["Year of Plenty", "two resource cards from the bank", "same resource", "Invention", "bank is empty"],
    monopoly: ["Monopoly", "Every opponent gives you all", "bank gives nothing", "zero cards"],
    victoryPoint: ["Victory Point", "1 hidden victory point", "no Play button", "newly bought", "10 points"],
  };
  for (const [type, phrases] of Object.entries(meanings)) {
    const card = guide.locator(`[data-guide-card="${type}"]`);
    await expect(card.locator("h4")).toHaveText(phrases[0]);
    for (const phrase of phrases.slice(1)) await expect(card).toContainText(phrase);
    await expect(card.locator(".development-guide-emblem svg")).toHaveCount(1);
    expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  }
  await expect(guide.locator(".development-timing")).toContainText("one non-VP development card per turn");
  await expect(guide.locator(".development-timing")).toContainText("before rolling");
  await expect(guide.locator(".development-timing")).toContainText("earlier turn");
  await expect(guide.locator(".development-timing")).toContainText("paired activation");
  await expect(guide).toContainText("cannot trade or give away development cards");
  await expect(guide.locator("button, [data-card], .play-card")).toHaveCount(0);
  expect(await page.locator("#rules-dialog").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  if (width !== 320) await page.locator("#rules-dialog").screenshot({ path: testInfo.outputPath(`development-meanings-${width}.png`) });
  await guide.locator('[data-guide-card="victoryPoint"]').scrollIntoViewIfNeeded();
  await expect(guide.locator("#guide-victory-title")).toBeInViewport();
  if (width === 390) await page.locator("#rules-dialog").screenshot({ path: testInfo.outputPath("development-meanings-mobile-end.png") });
  expect(await page.evaluate(() => JSON.stringify(state))).toBe(before);
  await page.keyboard.press("Escape");
  await expect(page.locator("#rules-dialog")).not.toBeVisible();
  await expect(page.locator("#rules-button")).toBeFocused();
  await page.locator("#rules-button").click();
  await expect(page.locator("#show-resource-guide")).toBeInViewport();
  await page.locator("#show-resource-guide").click();
  await expect(page.locator("#resource-reference h3")).toBeFocused();
  await expect(page.locator("#resource-reference h3")).toBeInViewport();
});

test("development meanings are reference-only even without any held development cards", async ({ page }) => {
  const view = fixture();
  for (const player of view.players) {
    player.developmentCount = 0;
    if (player.developmentCards) player.developmentCards = [];
  }
  await story(page, view);
  await page.locator("#rules-button").click();
  await page.locator("#show-development-guide").click();
  await expect(page.locator("#development-reference [data-guide-card]")).toHaveCount(5);
  await expect(page.locator("#development-reference")).toContainText("not anyone's hand");
  await expect(page.locator("#development-cards .play-card")).toHaveCount(0);
});

test("legacy public cards show known Knights without guessing discarded cards or exposing a private hand", async ({ page }) => {
  const view = fixture();
  const owner = view.players.find((player) => player.id === view.viewerId);
  delete owner.revealedDevelopment;
  owner.knightsPlayed = 2;
  await story(page, view);
  await page.locator(`[data-public-player="${owner.id}"]`).click();
  await expect(page.locator('#public-knights [data-revealed-type="knight"]')).toContainText("×2");
  await expect(page.locator("#public-progress")).toContainText("No progress-card plays are recorded");
  await expect(page.locator("#public-history-warning")).toBeVisible();
  await expect(page.locator("#public-card-privacy")).toContainText("5 unplayed cards remain private");
  await expect(page.locator("#public-cards-dialog [data-revealed-type]")).toHaveCount(1);
  await expect(page.locator("#public-victory-section")).not.toBeVisible();
  await expect(page.locator("#public-cards-dialog .play-card")).toHaveCount(0);
});

test("public gallery yields to mandatory discards and closes when its player is removed or a rematch begins", async ({ page }) => {
  await story(page);
  const ownerId = await page.evaluate(() => state.viewerId);
  await page.locator(`[data-public-player="${ownerId}"]`).click();
  await page.evaluate(() => {
    state.phase = "discard";
    state.pendingDiscards = { [state.viewerId]: Math.floor(me().resourceCount / 2) };
    render();
  });
  await expect(page.locator("#public-cards-dialog")).not.toBeVisible();
  await expect(page.locator("#discard-dialog")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.getElementById("discard-dialog").contains(document.activeElement))).toBe(true);
  await page.locator("#discard-view-board").click();
  const opponentId = await page.evaluate(() => state.players.find((player) => player.id !== state.viewerId).id);
  await page.locator(`[data-public-player="${opponentId}"]`).click();
  await page.evaluate((id) => {
    state.players = state.players.filter((player) => player.id !== id);
    for (const edge of state.board.edges) if (edge.road?.playerId === id) edge.road = null;
    for (const vertex of state.board.vertices) if (vertex.structure?.playerId === id) vertex.structure = null;
    render();
  }, opponentId);
  await expect(page.locator("#public-cards-dialog")).not.toBeVisible();
  await page.locator(`[data-public-player="${ownerId}"]`).click();
  await page.evaluate(() => { state.phase = "lobby"; state.pendingDiscards = {}; render(); });
  await expect(page.locator("#public-cards-dialog")).not.toBeVisible();
  await expect(page.locator("[data-public-player]")).toHaveCount(0);
});

test("resource trade controls use illustrated keyboard-operable choices, not native dropdowns", async ({ page }, testInfo) => {
  await story(page);
  await expect(page.locator("select")).toHaveCount(0);
  const give = page.locator("#bank-give");
  await give.locator('[data-value="wood"]').click();
  await page.keyboard.press("ArrowRight");
  await expect(give.locator('[data-value="brick"]')).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#bank-submit")).toContainText("brick");
  await page.locator("#bank-receive [data-value=ore]").click();
  await expect(page.locator("#bank-receive [data-value=ore]")).toHaveAttribute("aria-checked", "true");
  await page.locator("#trade-section").screenshot({ path: testInfo.outputPath("trading-post.png") });
});

for (const width of [1440, 390, 320]) test(`earthy trade offer shows exact resource cards and usable actions at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  const view = fixture();
  const self = view.players.find((player) => player.id === view.viewerId);
  const sender = view.players.find((player) => player.id !== view.viewerId);
  self.name = "amansha";
  sender.name = "Shivam";
  view.trade = { id: "visual-offer", fromId: sender.id, targetId: self.id,
    give: { wood: 1, brick: 0, sheep: 2, wheat: 0, ore: 0 },
    want: { wood: 0, brick: 1, sheep: 0, wheat: 0, ore: 0 } };
  await story(page, view);
  const card = page.locator("#trade-offer-card");
  await card.scrollIntoViewIfNeeded();
  await expect(card).toHaveAttribute("data-trade-state", "ready");
  await expect(card.locator(".offer-participants")).toContainText("Shivam");
  await expect(card.locator(".offer-participants")).toContainText("You");
  await expect(card.locator('[data-trade-direction="receive"]')).toContainText("You receive");
  await expect(card.locator('[data-trade-direction="receive"] .offer-side-heading')).toContainText("3 cards");
  const receive = await card.locator('[data-trade-direction="receive"] [data-trade-resource]').evaluateAll((nodes) =>
    Object.fromEntries(nodes.map((node) => [node.dataset.tradeResource, Number(node.dataset.count)])));
  const give = await card.locator('[data-trade-direction="give"] [data-trade-resource]').evaluateAll((nodes) =>
    Object.fromEntries(nodes.map((node) => [node.dataset.tradeResource, Number(node.dataset.count)])));
  expect(receive).toEqual({ wood: 1, sheep: 2 });
  expect(give).toEqual({ brick: 1 });
  await expect(card.locator("#accept-trade")).toBeEnabled();
  await expect(card.locator("#decline-trade")).toBeEnabled();
  for (const button of ["accept-trade", "decline-trade"]) {
    expect(await page.locator(`#${button}`).evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  }
  expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => state.trade)).toEqual(view.trade);
  if (width !== 320) await card.screenshot({ path: testInfo.outputPath(`earthy-trade-offer-${width}.png`) });
});

test("trade card handles long names, many resources, pending states and stable keyboard focus", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const view = fixture();
  const sender = view.players.find((player) => player.id !== view.viewerId);
  sender.name = "NorthwindMerchant<&>";
  view.trade = { id: "long-offer", fromId: sender.id, targetId: view.viewerId,
    give: { wood: 19, brick: 19, sheep: 19, wheat: 19, ore: 0 },
    want: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 19 } };
  await story(page, view);
  const card = page.locator("#trade-offer-card");
  await expect(card.locator(".offer-participants")).toContainText(sender.name);
  await expect(card.locator('[data-trade-direction="receive"] [data-trade-resource]')).toHaveCount(4);
  await expect(card.locator("#accept-trade")).toBeDisabled();
  await expect(card).toHaveAttribute("data-trade-state", "blocked");
  await expect(card.locator("#trade-response-status")).toContainText("more ore");
  expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await card.screenshot({ path: testInfo.outputPath("earthy-trade-offer-multi-resource.png") });
  await page.locator("#decline-trade").focus();
  await page.evaluate(() => render());
  await expect(page.locator("#decline-trade")).toBeFocused();
  await page.evaluate(() => { busy = true; trading.refresh(); });
  await expect(card).toHaveAttribute("data-trade-state", "pending");
  await expect(card.locator("#accept-trade")).toContainText("Confirming");
  await expect(card.locator("#decline-trade")).toBeDisabled();
  await page.evaluate(() => { busy = false; bound = false; trading.refresh(); });
  await expect(card).toHaveAttribute("data-trade-state", "offline");
  await expect(card.locator("#trade-response-status")).toContainText("Reconnecting");
});

for (const role of ["sender", "observer"]) test(`trade card shows unambiguous terms and allowed actions to the ${role}`, async ({ page }) => {
  const view = fixture();
  const others = view.players.filter((player) => player.id !== view.viewerId);
  const from = role === "sender" ? view.players.find((player) => player.id === view.viewerId) : others[0];
  const target = role === "sender" ? others[0] : others[1];
  if (role === "observer") view.currentPlayerId = from.id;
  view.trade = { id: "perspective-offer", fromId: from.id, targetId: target.id,
    give: { wood: 1, brick: 0, sheep: 2, wheat: 0, ore: 0 },
    want: { wood: 0, brick: 1, sheep: 0, wheat: 0, ore: 0 } };
  await story(page, view);
  if (role === "sender") {
    await expect(page.locator('[data-trade-direction="receive"] [data-trade-resource="brick"]')).toHaveAttribute("data-count", "1");
    await expect(page.locator('[data-trade-direction="give"] [data-trade-resource="sheep"]')).toHaveAttribute("data-count", "2");
    await expect(page.locator("#cancel-trade")).toBeEnabled();
    await expect(page.locator("#cancel-trade")).toContainText("Withdraw offer");
  } else {
    await expect(page.locator('[data-trade-direction="receive"]')).toContainText(`${from.name} gives`);
    await expect(page.locator('[data-trade-direction="give"]')).toContainText(`${target.name} gives`);
    await expect(page.locator("#trade-response-status")).toHaveText("This offer is between the named players.");
    await expect(page.locator("#cancel-trade")).toHaveCount(0);
  }
  await expect(page.locator("#accept-trade")).toHaveCount(0);
  await expect(page.locator("#decline-trade")).toHaveCount(0);
});

test("a restored unfulfillable offer explains why acceptance is blocked without exposing the sender's hand", async ({ page }) => {
  const view = fixture();
  const sender = view.players.find((player) => player.id !== view.viewerId);
  view.trade = { id: "legacy-offer", fromId: sender.id, targetId: view.viewerId,
    give: { wood: 1, brick: 0, sheep: 0, wheat: 0, ore: 0 },
    want: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 1 } };
  view.tradeUnavailableReason = "offered-resources-spent";
  await story(page, view);
  await expect(page.locator("#accept-trade")).toBeDisabled();
  await expect(page.locator("#trade-response-status")).toContainText("sender no longer holds the offered cards");
  await expect(page.locator("#decline-trade")).toBeEnabled();
});

test("PostgreSQL-style JSON key ordering never replaces unchanged trade response buttons", async ({ page }) => {
  const view = fixture();
  const sender = view.players.find((player) => player.id !== view.viewerId);
  view.trade = { id: "jsonb-offer", fromId: sender.id, targetId: view.viewerId,
    give: { wood: 1, brick: 0, sheep: 0, wheat: 0, ore: 0 },
    want: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 1 } };
  await story(page, view);
  await page.locator("#accept-trade").focus();
  const unchanged = await page.evaluate(() => {
    const original = document.getElementById("accept-trade");
    const reverse = (object) => Object.fromEntries(Object.entries(object).reverse());
    state.trade = reverse({ ...state.trade, give: reverse(state.trade.give), want: reverse(state.trade.want) });
    render();
    return document.getElementById("accept-trade") === original;
  });
  expect(unchanged).toBe(true);
  await expect(page.locator("#accept-trade")).toBeFocused();
});

test("board choices support keyboard preview and Escape without placing a piece", async ({ page }) => {
  await story(page, fixture("setup"));
  await expect(page.locator("#location-select-trigger")).toHaveCount(0);
  await expect(page.locator('#placement-layer [tabindex="0"]')).toHaveCount(1);
  await page.locator('#placement-layer [tabindex="0"]').focus();
  await page.keyboard.press("ArrowRight");
  const selectedId = await page.evaluate(() => document.activeElement.dataset.place);
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => boardPlacement.selection.id)).toBe(selectedId);
  await expect(page.locator("#placement-toolbar")).toBeVisible();
  await expect(page.locator("#confirm-placement")).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.locator("#placement-toolbar")).not.toBeVisible();
  await expect(page.locator(`[data-place="${selectedId}"]`)).toBeFocused();
  expect(await page.evaluate(() => state.setupNeedsRoad)).toBe(false);
});

test("choosing a build piece with the keyboard moves focus directly onto its legal board targets", async ({ page }) => {
  await story(page);
  await page.locator('[data-build="city"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('#placement-layer [tabindex="0"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#placement-title")).toContainText("city");
  await expect(page.locator("#confirm-placement")).toBeEnabled();
});

test("point mode has an obvious return to placement and cannot silently hide the board choices", async ({ page }) => {
  await story(page, fixture("setup"));
  await page.locator("#ping-mode").click();
  await expect(page.locator("#placement-layer [data-place]")).toHaveCount(0);
  await expect(page.locator("#placement-directions")).toContainText("pointing, not placing");
  await page.locator("#resume-placement").click();
  const id = await page.evaluate(() => boardPlacement.targets[0].id);
  await previewPlacement(page, id);
  await expect(page.locator("#placement-toolbar")).toBeVisible();
  expect(await page.evaluate(() => state.setupNeedsRoad)).toBe(false);
});

test("the admin automatically leaves point mode when their own setup turn arrives", async ({ page }) => {
  const view = fixture("setup");
  expect(view.viewerId).toBe(view.hostId);
  await story(page, view);
  await page.locator("#ping-mode").click();
  await page.evaluate(() => {
    const next = structuredClone(state);
    state = { ...state, currentPlayerId: state.players.find((player) => player.id !== state.viewerId).id };
    applyState(next);
  });
  await expect(page.locator("#ping-mode")).toHaveAttribute("aria-pressed", "false");
  expect(await page.locator("#placement-layer [data-place]").count()).toBeGreaterThan(0);
});

test("resource counters respect limits and exact discard selection", async ({ page }) => {
  const view = fixture();
  view.phase = "discard";
  view.pendingDiscards = { [view.viewerId]: 2 };
  await story(page, view);
  await expect(page.locator("#submit-discard")).toBeDisabled();
  await expect(page.locator('[data-input="discard-wood"][data-step="-1"]')).toBeDisabled();
  await page.locator('[data-input="discard-wood"][data-step="1"]').click();
  await page.locator('[data-input="discard-wood"][data-step="1"]').click();
  await expect(page.locator("#submit-discard")).toBeEnabled();
  await expect(page.locator("#discard-count")).toContainText("2 of 2 selected");
  await page.locator("#discard-ore").fill("3");
  await expect(page.locator("#submit-discard")).toBeDisabled();
});

test("dice animation has neutral pending semantics and settles on authoritative faces", async ({ page }, testInfo) => {
  await story(page);
  await page.evaluate(() => {
    diceMotion = { active: true, started: performance.now(), actor: state.viewerId, turn: state.turnNumber };
    renderActions();
  });

  await expect(page.locator(".dice-stage")).toHaveClass(/is-rolling/);
  await expect(page.locator(".dice-space").first()).toHaveAttribute("aria-label", "Rolling die");
  expect(await page.locator(".dice-cube").first().evaluate((node) => getComputedStyle(node).animationName)).toBe("dice-tumble");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.locator(".dice-cube").first().evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
  await page.evaluate(() => {
    diceMotion = null;
    state.dice = [3, 4];
    renderActions();
  });
  await expect(page.locator(".dice-cube").first()).toHaveAttribute("data-value", "3");
  await expect(page.locator(".dice-space").nth(1)).toHaveAttribute("aria-label", "Die 4");
  await expect(page.locator(".dice-stage")).toContainText("Rolled 7");
  await page.locator("#dice-area").screenshot({ path: testInfo.outputPath("dice-settled.png") });
});

test("resource and development hands use physical card artwork and local game fonts", async ({ page }, testInfo) => {
  await story(page);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(".physical-resource")).toHaveCount(5);
  await expect(page.locator(".physical-development")).toHaveCount(5);
  const bounds = await page.locator(".physical-resource").first().evaluate((card) => {
    const title = card.querySelector(".resource-title").getBoundingClientRect();
    const face = card.querySelector(".resource-face").getBoundingClientRect();
    return { left: title.left - face.left, right: face.right - title.right };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(-1);
  expect(bounds.right).toBeGreaterThanOrEqual(-1);
  await expect(page.locator('.physical-development[data-development-type="monopoly"]')).toContainText("Monopoly");
  expect(await page.evaluate(() => document.fonts.check('600 16px "Cinzel"'))).toBe(true);
  expect(await page.evaluate(() => document.fonts.check('400 14px "Source Sans 3"'))).toBe(true);
  await page.locator("#hand-section").screenshot({ path: testInfo.outputPath("resource-playing-cards.png") });
  await page.locator("#development-section").screenshot({ path: testInfo.outputPath("development-playing-cards.png") });
});
