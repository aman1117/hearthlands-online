"use strict";

const { test, expect } = require("@playwright/test");
const express = require("express");
const http = require("node:http");
const path = require("node:path");
const { Server } = require("socket.io");
const { createRoom, addPlayer, startGame, applyAction, publicState } = require("../game");

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

function fixture(phase = "action") {
  const { room, player } = createRoom("Rowan");
  ["Mira", "Ellis", "Noa"].forEach((name) => addPlayer(room, name));
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

test("map-location chooser supports search, arrows, selection, and Escape without placing a piece", async ({ page }) => {
  await story(page, fixture("setup"));
  await page.locator("#location-select-trigger").click();
  await page.locator("#location-select-filter").fill("Junction 2 ");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => GameControls.read("location-select"))).toBe("v1");
  await expect(page.locator("#location-select-trigger")).toHaveAttribute("aria-expanded", "false");
  await page.locator("#location-select-trigger").click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".choice-popup")).toHaveCount(0);
  await expect(page.locator("#location-select-trigger")).toBeFocused();
  await page.locator("#location-select-trigger").click();
  await page.keyboard.press("Tab");
  await expect(page.locator("#place-location")).toBeFocused();
  expect(await page.evaluate(() => state.setupNeedsRoad)).toBe(false);
});

test("location chooser survives the rail scroll that accompanies opening it", async ({ page }) => {
  await story(page, fixture("setup"));
  await page.locator(".action-panel").evaluate((node) => { node.style.maxHeight = "350px"; });
  await page.locator("#location-select-trigger").click();
  await expect(page.locator(".choice-popup")).toBeVisible();
  await page.locator(".action-panel").evaluate((node) => {
    node.scrollTop += 12;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator(".choice-popup")).toBeVisible();
  await page.locator('.choice-popup [data-option="v1"]').click();
  expect(await page.evaluate(() => GameControls.read("location-select"))).toBe("v1");
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
