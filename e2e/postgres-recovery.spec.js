"use strict";

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRoom, addPlayer, startGame, applyAction, publicState } = require("../game");
const { createGameServer } = require("../server");

const databaseUrl = process.env.TEST_DATABASE_URL;
test.skip(!databaseUrl, "Requires an isolated loopback PostgreSQL test database.");
if (databaseUrl && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl).hostname)) {
  throw new Error("Database recovery tests refuse non-loopback databases.");
}

test("a browser move survives a dropped PostgreSQL coordinator connection without restarting the app", async ({ browser }) => {
  const { room, player } = createRoom("Rowan");
  addPlayer(room, "Mira");
  addPlayer(room, "Ellis");
  startGame(room, player.id, () => .999);
  while (room.phase === "setup") {
    const actorId = room.players[room.turnIndex].id;
    const view = publicState(room, actorId);
    applyAction(room, actorId, view.setupNeedsRoad ? { type: "setupRoad", edgeId: view.legal.roadEdges[0] }
      : { type: "setupSettlement", vertexId: view.legal.settlementVertices[0] });
  }
  room.code = "PGTEST";
  room.updatedAt = Date.now();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-pg-recovery-"));
  fs.writeFileSync(path.join(dataDir, "PGTEST.json"), JSON.stringify({ version: 2, room }));
  const service = createGameServer({
    dataDir, databaseUrl, databaseSchema: `hl_recover_${crypto.randomBytes(8).toString("hex")}`,
    databaseSsl: "disable", random: () => .1,
  });
  const port = await service.listen();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => socket.connected);
    await page.locator(".resume-details > summary").click();
    await page.locator("#resume-key").fill(player.reconnectToken);
    await page.locator("#import-session").click();
    await page.waitForFunction(() => bound && !busy && state.phase === "roll");
    await service.storage.adapter.client.end();
    await page.locator("#roll-button").click();
    await page.waitForFunction(() => !busy && state.phase === "action", null, { timeout: 20_000 });
    await expect(page.locator(".dice-stage")).toContainText("Rolled 2");
    const saved = await service.storage.getRoom("PGTEST");
    expect(saved.log.filter((event) => event.type === "diceRolled")).toHaveLength(1);
    expect((await service.storage.health()).ok).toBe(true);
  } finally {
    await context.close();
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
