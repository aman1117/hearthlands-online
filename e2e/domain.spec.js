"use strict";

const { test, expect } = require("@playwright/test");

const customUrl = process.env.HEARTHLANDS_CUSTOM_DOMAIN_URL;
const originalUrl = "https://hearthlands-online.yellowwater-07aa7c55.centralindia.azurecontainerapps.io";
test.skip(!customUrl, "Opt in with HEARTHLANDS_CUSTOM_DOMAIN_URL; this creates a new saved test room.");
if (customUrl) {
  const url = new URL(customUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.origin === originalUrl) {
    throw new Error("Provide a distinct, credential-free HTTPS custom origin.");
  }
}

test("custom domain uses valid HTTPS and the same saved seats without requiring a new game", async ({ browser, request }) => {
  const contexts = [];
  const errors = [];
  try {
    const redirect = await request.get(customUrl.replace(/^https:/, "http:"), { maxRedirects: 0 });
    expect([301, 302, 307, 308]).toContain(redirect.status());
    expect(redirect.headers().location).toMatch(/^https:/);
    for (const url of [customUrl, originalUrl]) {
      const response = await request.get(`${url}/health`);
      expect(response.ok()).toBe(true);
      expect(await response.json()).toEqual({ ok: true });
    }
    const originalContext = await browser.newContext();
    contexts.push(originalContext);
    const original = await originalContext.newPage();
    original.on("pageerror", (error) => errors.push(error.message));
    await original.goto(originalUrl);
    await original.waitForFunction(() => socket.connected);
    await original.locator("#player-name").fill("Domain transfer");
    await original.locator("#create-room").click();
    await original.waitForFunction(() => bound && state?.phase === "lobby" && !busy);
    const before = await original.evaluate(() => ({
      code: state.code, id: state.viewerId, host: state.hostId, board: state.board,
      token: connection.currentSeat.reconnectToken,
    }));
    const customContext = await browser.newContext();
    contexts.push(customContext);
    const custom = await customContext.newPage();
    custom.on("pageerror", (error) => errors.push(error.message));
    await custom.goto(customUrl);
    await custom.waitForFunction(() => socket.connected);
    await expect(custom.locator("#saved-games-section")).not.toBeVisible();
    await custom.locator(".resume-details > summary").click();
    await custom.locator("#resume-key").fill(before.token);
    await custom.locator("#import-session").click();
    await custom.waitForFunction(() => bound && state && !busy);
    await custom.waitForFunction(() => socket.io.engine.transport.name === "websocket");
    const after = await custom.evaluate(() => ({ code: state.code, id: state.viewerId, host: state.hostId, board: state.board }));
    expect(after).toEqual({ code: before.code, id: before.id, host: before.host, board: before.board });
    await original.waitForFunction(() => connection.blocked && !bound);
    expect(new URL(custom.url()).origin).toBe(new URL(customUrl).origin);
    expect(new URL(custom.url()).searchParams.get("room")).toBe(before.code);
    await custom.reload();
    await custom.waitForFunction(() => bound && state && !busy && socket.io.engine.transport.name === "websocket");
    expect(await custom.evaluate(() => state.viewerId)).toBe(before.id);
    expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
    // Keep the test-created room; domain checks never delete application data.
  }
});
