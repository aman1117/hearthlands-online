"use strict";

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGameServer } = require("../server");
const { createRoom, addPlayer, startGame, applyAction, publicState } = require("../game");
const { perform, previewPlacement, boardPoint } = require("./ui.cjs");

async function table(browser, { setup = false, mobile = false, preRoll = false, cardType } = {}) {
  const { room, player: host } = createRoom("Rowan");
  addPlayer(room, "Mira");
  addPlayer(room, "Ellis");
  startGame(room, host.id, () => .999);
  if (!setup) {
    while (room.phase === "setup") {
      const actor = room.players[room.turnIndex].id;
      const view = publicState(room, actor);
      applyAction(room, actor, view.setupNeedsRoad ? { type: "setupRoad", edgeId: view.legal.roadEdges[0] }
        : { type: "setupSettlement", vertexId: view.legal.settlementVertices[0] });
    }
    if (!preRoll) applyAction(room, host.id, { type: "roll" }, () => .1);
    for (const [resource, count] of Object.entries({ wood: 6, brick: 6, sheep: 3, wheat: 7, ore: 6 })) {
      room.bank[resource] -= count;
      host.resources[resource] += count;
    }
    if (!preRoll) {
      const candidates = [{ position: structuredClone(room), route: [] }];
      const seen = new Set();
      let route;
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        const legal = publicState(candidate.position, host.id).legal;
        if (legal.settlementVertices.length) { route = candidate.route; break; }
        if (candidate.route.length === 3) continue;
        for (const edgeId of legal.roadEdges) {
          const position = structuredClone(candidate.position);
          applyAction(position, host.id, { type: "buildRoad", edgeId });
          const signature = position.board.edges.filter((edge) => edge.road?.playerId === host.id).map((edge) => edge.id).join(",");
          if (seen.has(signature)) continue;
          seen.add(signature);
          candidates.push({ position, route: [...candidate.route, edgeId] });
        }
      }
      expect(route).toBeDefined();
      for (const edgeId of route) applyAction(room, host.id, { type: "buildRoad", edgeId });
      expect(publicState(room, host.id).legal.settlementVertices.length).toBeGreaterThan(0);
    }
  }
  let cardId;
  if (cardType) {
    const index = room.developmentDeck.findIndex((card) => card.type === cardType);
    const card = { ...room.developmentDeck.splice(index, 1)[0], boughtTurn: 0 };
    host.developmentCards.push(card);
    cardId = card.id;
  }
  room.code = "PLACER";
  room.updatedAt = Date.now();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-placement-"));
  fs.writeFileSync(path.join(dataDir, "PLACER.json"), JSON.stringify({ version: 2, room }));
  let service = createGameServer({ dataDir, random: () => .1 });
  const port = await service.listen();
  const contexts = [], pages = [], errors = [];
  const byId = new Map();
  for (const [index, player] of room.players.entries()) {
    const context = await browser.newContext(index === 0 && mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1440, height: 1000 } });
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
    room, host, cardId, pages, contexts, errors, byId,
    read() { return service.storage.getRoom(room.code); },
    async restart() {
      await service.close();
      service = createGameServer({ dataDir, random: () => .1 });
      await service.listen(port);
    },
    async close() {
      for (const context of contexts) await context.close();
      await service.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function domain(room) {
  return {
    board: room.board, bank: room.bank, turnIndex: room.turnIndex, turnNumber: room.turnNumber, phase: room.phase,
    players: room.players.map(({ id, resources, roadsLeft, settlementsLeft, citiesLeft, points, longestRoad }) =>
      ({ id, resources, roadsLeft, settlementsLeft, citiesLeft, points, longestRoad })),
    longestRoadHolderId: room.longestRoadHolderId, largestArmyHolderId: room.largestArmyHolderId,
  };
}

test("roads, settlements and cities are placed directly on the board and undo refunds their exact cost", async ({ browser }, testInfo) => {
  const t = await table(browser);
  try {
    const actor = t.pages[0];
    await expect(actor.locator("#location-select-trigger")).toHaveCount(0);
    for (const [type, key, legal] of [["buildRoad", "edgeId", "roadEdges"], ["buildSettlement", "vertexId", "settlementVertices"], ["buildCity", "vertexId", "cityVertices"]]) {
      const before = domain(await t.read());
      const id = await actor.evaluate((legal) => state.legal[legal][0], legal);
      await perform(actor, { type, [key]: id });
      await expect(actor.locator("#undo-placement")).toBeEnabled();
      await expect(t.pages[1].locator("#undo-placement")).toBeDisabled();
      expect(await t.pages[1].evaluate(() => state.undoPlacement)).toBeNull();
      await perform(actor, { type: "undoPlacement" });
      expect(domain(await t.read())).toEqual(before);
    }
    await actor.locator('[data-build="city"]').click();
    await previewPlacement(actor, await actor.evaluate(() => state.legal.cityVertices[0]));
    await actor.locator(".board-panel").screenshot({ path: testInfo.outputPath("city-preview-desktop.png") });
    await expect(actor.locator("#end-turn")).toBeDisabled();
    await actor.locator("#cancel-placement").click();
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("previews do not spend cards or requests and survive another player reconnecting", async ({ browser }) => {
  const t = await table(browser, { setup: true });
  try {
    const actor = t.pages[0];
    const before = domain(await t.read());
    const sequence = await actor.evaluate(() => state.nextSequence);
    const id = await actor.evaluate(() => state.legal.settlementVertices[0]);
    await previewPlacement(actor, id);
    await t.pages[1].reload();
    await t.pages[1].waitForFunction(() => bound && !busy);
    expect(await actor.evaluate(() => boardPlacement.selection?.id)).toBe(id);
    expect(await actor.evaluate(() => state.nextSequence)).toBe(sequence);
    await actor.locator("#cancel-placement").click();
    expect(domain(await t.read())).toEqual(before);
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("admin pointing during other players' turns cannot hide placements on the next setup turn", async ({ browser }) => {
  const t = await table(browser, { setup: true });
  try {
    const actor = t.pages[0];
    await perform(actor, { type: "setupSettlement", vertexId: await actor.evaluate(() => state.legal.settlementVertices[0]) });
    await perform(actor, { type: "setupRoad", edgeId: await actor.evaluate(() => state.legal.roadEdges[0]) });
    await actor.locator("#ping-mode").click();
    await expect(actor.locator("#ping-mode")).toHaveAttribute("aria-pressed", "true");
    let view = await actor.evaluate(() => state);
    while (view.currentPlayerId !== t.host.id) {
      const page = t.byId.get(view.currentPlayerId);
      await page.waitForFunction((revision) => state.revision >= revision && !busy, view.revision);
      const move = await page.evaluate(() => state.setupNeedsRoad
        ? { type: "setupRoad", edgeId: state.legal.roadEdges[0] }
        : { type: "setupSettlement", vertexId: state.legal.settlementVertices[0] });
      await perform(page, move);
      view = await page.evaluate(() => state);
    }
    await actor.waitForFunction(() => state.currentPlayerId === state.viewerId && !busy);
    await expect(actor.locator("#ping-mode")).toHaveAttribute("aria-pressed", "false");
    expect(await actor.locator("#placement-layer [data-place]").count()).toBeGreaterThan(0);
    const before = domain(await t.read());
    await perform(actor, { type: "setupSettlement", vertexId: await actor.evaluate(() => state.legal.settlementVertices[0]) });
    await perform(actor, { type: "undoPlacement" });
    expect(domain(await t.read())).toEqual(before);
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("mobile finger taps select nearby corners and roads with visible confirmation, not dropdowns", async ({ browser }, testInfo) => {
  const t = await table(browser, { setup: true, mobile: true });
  try {
    const actor = t.pages[0];
    const id = await actor.evaluate(() => [...boardPlacement.targets].sort((a, b) => a.y - b.y)[0].id);
    const point = await boardPoint(actor, id);
    await actor.touchscreen.tap(point.x, point.y - 14);
    await actor.waitForFunction((id) => boardPlacement.selection?.id === id, id);
    await expect(actor.locator("#confirm-placement")).toBeInViewport();
    expect(await actor.evaluate(() => {
      const tray = document.getElementById("placement-toolbar").getBoundingClientRect();
      const notices = document.getElementById("activity-notifications");
      return !notices || !notices.children.length || notices.getBoundingClientRect().bottom <= tray.top;
    })).toBe(true);
    expect(await actor.evaluate(() => state.setupNeedsRoad)).toBe(false);
    await actor.screenshot({ path: testInfo.outputPath("settlement-preview-mobile.png") });
    await actor.locator("#confirm-placement").tap();
    await actor.waitForFunction(() => state.setupNeedsRoad && !busy);
    const edge = await actor.evaluate(() => state.legal.roadEdges[0]);
    await previewPlacement(actor, edge, { touch: true });
    await expect(actor.locator("#placement-warning")).toContainText("finishes your setup turn");
    await actor.locator("#confirm-placement").tap();
    await actor.waitForFunction(() => state.currentPlayerId !== state.viewerId && !busy);
    await expect(actor.locator("#undo-placement")).toBeDisabled();
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("vertical roads remain clickable after zooming and dragging from a placement target does not place anything", async ({ browser }) => {
  const t = await table(browser, { setup: true });
  try {
    const actor = t.pages[0];
    const vertex = await actor.evaluate(() => {
      const vertical = (edge) => {
        const a = state.board.vertices.find((v) => v.id === edge.vertices[0]);
        const b = state.board.vertices.find((v) => v.id === edge.vertices[1]);
        return a.x === b.x;
      };
      return state.board.vertices.filter((vertex) => state.legal.settlementVertices.includes(vertex.id) &&
        state.board.edges.some((edge) => edge.vertices.includes(vertex.id) && vertical(edge)))
        .sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y))[0].id;
    });
    await perform(actor, { type: "setupSettlement", vertexId: vertex });
    const edge = await actor.evaluate(() => boardPlacement.targets.find((target) => target.a.x === target.b.x).id);
    await actor.locator("#zoom-in").click();
    await actor.locator("#zoom-in").click();
    await expect(actor.locator("#zoom-reset")).toHaveText("150%");
    await actor.waitForFunction(() => {
      const matrix = elements.board.getScreenCTM();
      const value = [matrix.a, matrix.d, matrix.e, matrix.f].join(":");
      const previous = window.lastPlacementMatrix;
      window.lastPlacementMatrix = value;
      return value === previous;
    });
    const start = await boardPoint(actor, edge);
    const revision = await actor.evaluate(() => state.revision);
    const pan = await actor.evaluate(() => panzoom.getPan());
    await actor.mouse.move(start.x, start.y);
    await actor.mouse.down();
    await actor.mouse.move(start.x + 45, start.y + 30, { steps: 6 });
    await actor.mouse.up();
    expect(await actor.evaluate(() => boardPlacement.selection)).toBeNull();
    expect(await actor.evaluate(() => state.revision)).toBe(revision);
    expect(await actor.evaluate(() => panzoom.getPan())).not.toEqual(pan);
    await previewPlacement(actor, edge);
    await actor.locator("#confirm-placement").click();
    await actor.waitForFunction(() => state.currentPlayerId !== state.viewerId && !busy);
    expect((await t.read()).board.edges.find((candidate) => candidate.id === edge).road.playerId).toBe(t.host.id);
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("free roads undo without restoring the development card or losing the pre-roll obligation", async ({ browser }) => {
  const t = await table(browser, { preRoll: true, cardType: "roadBuilding" });
  try {
    const actor = t.pages[0];
    const before = await t.read();
    await actor.locator("#ping-mode").click();
    await perform(actor, { type: "playDevelopment", cardId: t.cardId });
    await expect(actor.locator("#ping-mode")).toHaveAttribute("aria-pressed", "false");
    for (let road = 0; road < 2; road++) {
      await perform(actor, { type: "buildRoad", edgeId: await actor.evaluate(() => state.legal.roadEdges[0]) });
    }
    expect(await actor.evaluate(() => state.legal.canRoll)).toBe(true);
    await perform(actor, { type: "undoPlacement" });
    expect(await actor.evaluate(() => state.freeRoadsRemaining)).toBe(1);
    expect(await actor.evaluate(() => state.legal.canRoll)).toBe(false);
    await perform(actor, { type: "undoPlacement" });
    const restored = await t.read();
    expect(restored.board).toEqual(before.board);
    expect(restored.bank).toEqual(before.bank);
    expect(await actor.evaluate(() => state.freeRoadsRemaining)).toBe(2);
    expect(await actor.evaluate(() => state.players.find((p) => p.id === state.viewerId).revealedDevelopment.roadBuilding)).toBe(1);
    expect(restored.players[0].developmentCards.some((card) => card.id === t.cardId)).toBe(false);
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("robber previews and safe relocation undo never reverse a completed theft", async ({ browser }) => {
  const t = await table(browser, { cardType: "knight" });
  try {
    const actor = t.pages[0];
    await perform(actor, { type: "playDevelopment", cardId: t.cardId });
    const before = await t.read();
    const tiles = await actor.evaluate(() => {
      const victims = (tile) => state.board.vertices.some((vertex) => vertex.structure &&
        vertex.structure.playerId !== state.viewerId && vertex.adjacentTiles.includes(tile.id) &&
        state.players.find((player) => player.id === vertex.structure.playerId).resourceCount > 0);
      return {
        empty: state.board.tiles.find((tile) => state.legal.robberTiles.includes(tile.id) && !victims(tile)).id,
        occupied: state.board.tiles.find((tile) => state.legal.robberTiles.includes(tile.id) && victims(tile)).id,
      };
    });
    await perform(actor, { type: "moveRobber", tileId: tiles.empty });
    expect(await actor.evaluate(() => state.phase)).toBe("action");
    await perform(actor, { type: "undoPlacement" });
    expect((await t.read()).board).toEqual(before.board);
    await perform(actor, { type: "moveRobber", tileId: tiles.occupied });
    expect(await actor.evaluate(() => state.phase)).toBe("steal");
    await perform(actor, { type: "undoPlacement" });
    expect(await actor.evaluate(() => state.phase)).toBe("robber");
    await perform(actor, { type: "moveRobber", tileId: tiles.occupied });
    await perform(actor, { type: "steal", targetId: await actor.evaluate(() => state.robberVictims[0]) });
    await expect(actor.locator("#undo-placement")).toBeDisabled();
    expect((await t.read()).bank).toEqual(before.bank);
    expect((await t.read()).players[0].knightsPlayed).toBe(1);
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("placement undo remains available after browser reload and server restart", async ({ browser }) => {
  const t = await table(browser);
  try {
    const actor = t.pages[0];
    const before = domain(await t.read());
    await perform(actor, { type: "buildRoad", edgeId: await actor.evaluate(() => state.legal.roadEdges[0]) });
    const id = await actor.evaluate(() => state.undoPlacement.id);
    await actor.reload();
    await actor.waitForFunction(() => bound && !busy);
    expect(await actor.evaluate(() => state.undoPlacement.id)).toBe(id);
    const revision = await actor.evaluate(() => state.revision);
    await t.restart();
    await actor.waitForFunction((revision) => bound && socket.connected && state.revision > revision && !busy, revision);
    expect(await actor.evaluate(() => state.undoPlacement.id)).toBe(id);
    await perform(actor, { type: "undoPlacement" });
    expect(domain(await t.read())).toEqual(before);
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});
