"use strict";

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const { perform } = require("./ui.cjs");

const deploymentUrl = process.env.HEARTHLANDS_DEPLOYMENT_URL;
test.skip(!deploymentUrl, "Opt in with HEARTHLANDS_DEPLOYMENT_URL; these checks create a new saved test room.");
if (deploymentUrl) {
  const url = new URL(deploymentUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Deployment checks require a credential-free HTTPS URL.");
}

async function settled(page) {
  await page.waitForFunction(() => socket.connected && bound && state && !busy);
}
async function persistentView(page) {
  return page.evaluate(() => ({
    code: state.code, viewerId: state.viewerId, hostId: state.hostId,
    phase: state.phase, turnNumber: state.turnNumber, currentPlayerId: state.currentPlayerId,
    board: state.board, eventSequence: state.eventSequence,
    self: state.players.filter((player) => player.id === state.viewerId).map((player) => ({
      id: player.id, resources: player.resources, developmentCards: player.developmentCards,
      revealedDevelopment: player.revealedDevelopment,
    }))[0],
  }));
}

test("public deployment supports real three-player play, WebSockets, offline recovery and browser reopening", async ({ browser, request }, testInfo) => {
  test.setTimeout(300_000);
  const contexts = [];
  const pages = [];
  const byId = new Map();
  const errors = [];
  let roomCode;
  try {
    const redirect = await request.get(deploymentUrl.replace(/^https:/, "http:"), { maxRedirects: 0 });
    expect([301, 302, 307, 308]).toContain(redirect.status());
    expect(redirect.headers().location).toMatch(/^https:/);
    expect((await request.get(`${deploymentUrl}/health`)).ok()).toBe(true);
    for (let index = 0; index < 3; index++) {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      pages.push(page);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(deploymentUrl);
      await page.waitForFunction(() => socket.connected);
      await page.locator("#player-name").fill(["Azure host", "Azure second", "Azure third"][index]);
      if (!index) await page.locator("#create-room").click();
      else {
        await page.locator("#room-code").fill(roomCode);
        await page.locator("#join-room").click();
      }
      await settled(page);
      roomCode = await page.evaluate(() => state.code);
      byId.set(await page.evaluate(() => state.viewerId), page);
      await page.waitForFunction(() => socket.io.engine.transport.name === "websocket");
    }
    const host = pages[0];
    await expect(host.locator(".player-nameplate")).toHaveCount(3);
    await host.locator("#ping-mode").click();
    await host.locator("#start-game").click();
    await host.waitForFunction(() => state.phase === "setup" && !busy);
    let view = await host.evaluate(() => state);
    let undoExercised = false;
    while (view.phase === "setup") {
      const page = byId.get(view.currentPlayerId);
      await page.waitForFunction((revision) => state.revision >= revision && !busy, view.revision);
      await expect(page.locator("#ping-mode")).toHaveAttribute("aria-pressed", "false");
      const move = await page.evaluate(() => state.setupNeedsRoad
        ? { type: "setupRoad", edgeId: state.legal.roadEdges[0] }
        : { type: "setupSettlement", vertexId: state.legal.settlementVertices[0] });
      const beforePlacement = !undoExercised ? await persistentView(page) : null;
      await perform(page, move);
      if (!undoExercised) {
        await perform(page, { type: "undoPlacement" });
        const undone = await persistentView(page);
        expect(undone.board).toEqual(beforePlacement.board);
        expect(undone.self).toEqual(beforePlacement.self);
        await perform(page, move);
        undoExercised = true;
      }
      view = await page.evaluate(() => state);
    }
    const actor = byId.get(view.currentPlayerId);
    await actor.waitForFunction((revision) => state.revision >= revision && !busy, view.revision);
    await expect(actor.locator("#undo-placement")).toBeDisabled();
    await perform(actor, { type: "roll" });
    if (await actor.evaluate(() => state.phase === "robber")) {
      await perform(actor, { type: "moveRobber", tileId: await actor.evaluate(() => state.legal.robberTiles[0]) });
    }
    if (await actor.evaluate(() => state.phase === "steal")) {
      await perform(actor, { type: "steal", targetId: await actor.evaluate(() => state.robberVictims[0]) });
    }
    await expect.poll(() => actor.evaluate(() => state.phase)).toBe("action");
    const currentRevision = await actor.evaluate(() => state.revision);
    for (const page of pages) {
      await page.waitForFunction((revision) => state.revision >= revision && !busy, currentRevision);
      expect(await page.evaluate(() => state.players.filter((player) => player.id !== state.viewerId).every((player) =>
        player.resources === undefined && player.developmentCards === undefined &&
        player.revealedDevelopment.victoryPoint === undefined))).toBe(true);
    }
    const ownerId = await host.evaluate(() => state.viewerId);
    await pages[1].locator(`[data-public-player="${ownerId}"]`).click();
    await expect(pages[1].locator("#public-cards-dialog")).toBeVisible();
    await expect(pages[1].locator("#public-cards-dialog .play-card")).toHaveCount(0);
    await pages[1].locator("#public-cards-done").click();
    const before = await persistentView(host);
    await contexts[0].setOffline(true);
    await host.waitForFunction(() => !bound);
    await contexts[0].setOffline(false);
    await settled(host);
    const after = await persistentView(host);
    expect(after.board).toEqual(before.board);
    expect(after.self).toEqual(before.self);
    expect(after.turnNumber).toBe(before.turnNumber);

    const savedHost = await contexts[0].storageState();
    await contexts[0].close();
    const reopened = await browser.newContext({ storageState: savedHost });
    contexts[0] = reopened;
    const reopenedPage = await reopened.newPage();
    reopenedPage.on("pageerror", (error) => errors.push(error.message));
    pages[0] = reopenedPage;
    await reopenedPage.goto(deploymentUrl);
    await reopenedPage.locator(`#saved-games [data-room="${roomCode}"]`).click();
    await settled(reopenedPage);
    const restored = await persistentView(reopenedPage);
    expect(restored.self).toEqual(before.self);
    expect(restored.board).toEqual(before.board);
    expect(restored.hostId).toBe(before.hostId);
    await reopenedPage.evaluate(() => {
      window.cloudHeartbeatReceived = false;
      socket.io.engine.on("packet", (packet) => { if (packet.type === "ping") window.cloudHeartbeatReceived = true; });
    });
    await reopenedPage.waitForFunction(() => window.cloudHeartbeatReceived, null, { timeout: 45_000 });
    expect(await reopenedPage.evaluate(() => socket.connected && socket.io.engine.transport.name === "websocket")).toBe(true);
    const recovery = [];
    for (let index = 0; index < contexts.length; index++) {
      recovery.push({ storageState: await contexts[index].storageState(), expected: await persistentView(pages[index]) });
    }
    fs.writeFileSync(testInfo.outputPath("cloud-recovery.json"), JSON.stringify(recovery), { mode: 0o600 });
    await reopenedPage.screenshot({ path: testInfo.outputPath("azure-game.png"), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
    // Keep the newly created test room: cloud checks never delete saved data.
  }
});

test("public deployment restores saved players after a cloud process restart", async ({ browser }) => {
  test.skip(!process.env.HEARTHLANDS_RECOVERY_FILE, "Supply the private recovery artifact from the initial deployment check.");
  const recovery = JSON.parse(fs.readFileSync(process.env.HEARTHLANDS_RECOVERY_FILE, "utf8"));
  const contexts = [];
  try {
    for (const seat of recovery) {
      const context = await browser.newContext({ storageState: seat.storageState });
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(deploymentUrl);
      await page.locator(`#saved-games [data-room="${seat.expected.code}"]`).click();
      await settled(page);
      await page.waitForFunction(() => socket.io.engine.transport.name === "websocket");
      const actual = await persistentView(page);
      expect(actual.code).toBe(seat.expected.code);
      expect(actual.viewerId).toBe(seat.expected.viewerId);
      expect(actual.hostId).toBe(seat.expected.hostId);
      expect(actual.phase).toBe(seat.expected.phase);
      expect(actual.turnNumber).toBe(seat.expected.turnNumber);
      expect(actual.board).toEqual(seat.expected.board);
      expect(actual.self).toEqual(seat.expected.self);
      expect(actual.eventSequence).toBeGreaterThanOrEqual(seat.expected.eventSequence);
    }
  } finally { for (const context of contexts) await context.close(); }
});
