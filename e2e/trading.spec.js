"use strict";
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createGameServer } = require("../server");
const { createRoom, addPlayer, startGame, applyAction, publicState } = require("../game");
const { choose, perform } = require("./ui.cjs");

async function table(browser, { preRoll = false, shortRecipient = false, postgres = false, ellisOre = 0 } = {}) {
  const { room, player: host } = createRoom("Rowan");
  addPlayer(room, "Mira"); addPlayer(room, "Ellis");
  startGame(room, host.id, () => .999);
  while (room.phase === "setup") {
    const id = room.players[room.turnIndex].id;
    const view = publicState(room, id);
    applyAction(room, id, view.setupNeedsRoad ? { type: "setupRoad", edgeId: view.legal.roadEdges[0] }
      : { type: "setupSettlement", vertexId: view.legal.settlementVertices[0] });
  }
  if (!preRoll) applyAction(room, host.id, { type: "roll" }, () => .1);
  for (const [index, player] of room.players.entries()) {
    for (const resource of Object.keys(player.resources)) { room.bank[resource] += player.resources[resource]; player.resources[resource] = 0; }
    const bundle = index === 0 ? { wood: 8, brick: 4, ore: 2, sheep: 2, wheat: 2 }
      : index === 1 ? { ore: shortRecipient ? 0 : 4, sheep: 2 } : { wheat: 3, ...(ellisOre ? { ore: ellisOre } : {}) };
    for (const [resource, count] of Object.entries(bundle)) { room.bank[resource] -= count; player.resources[resource] += count; }
  }
  const card = room.developmentDeck.splice(room.developmentDeck.findIndex((card) => card.type === "knight"), 1)[0];
  host.developmentCards.push({ ...card, boughtTurn: 0 });
  room.code = "TRADED"; room.updatedAt = Date.now();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-trade-"));
  fs.writeFileSync(path.join(dataDir, "TRADED.json"), JSON.stringify({ version: 2, room }));
  const options = { dataDir, random: () => .1 };
  if (postgres) {
    const url = new URL(process.env.TEST_DATABASE_URL);
    expect(["postgres:", "postgresql:"]).toContain(url.protocol);
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(url.hostname);
    expect(url.pathname).toBe("/hearthlands_test");
    Object.assign(options, { databaseUrl: process.env.TEST_DATABASE_URL, databaseSsl: "disable",
      databaseSchema: `hearthlands_trade_browser_${crypto.randomBytes(8).toString("hex")}` });
  }
  let service = createGameServer(options);
  const port = await service.listen();
  const contexts = [], pages = [], errors = [], wires = [];
  for (const player of room.players) {
    const context = await browser.newContext();
    contexts.push(context);
    const wire = { holdRequests: false, holdResponses: false, buffered: [], requests: [],
      release() { this.holdRequests = this.holdResponses = false; for (const { target, message } of this.buffered.splice(0)) target.send(message); } };
    wires.push(wire);
    await context.routeWebSocket(/\/socket\.io\//, (client) => {
      const upstream = client.connectToServer();
      client.onMessage((message) => {
        const packet = typeof message === "string" && /^42\d*\[/.test(message) ? JSON.parse(message.slice(message.indexOf("["))) : null;
        if (packet?.[0] === "gameAction") {
          wire.requests.push(packet[1]);
          if (wire.holdRequests) { wire.buffered.push({ target: upstream, message }); return; }
        }
        upstream.send(message);
      });
      upstream.onMessage((message) => {
        if (wire.holdResponses && typeof message === "string" && /^(42|43)/.test(message)) wire.buffered.push({ target: client, message });
        else client.send(message);
      });
    });
    const page = await context.newPage();
    pages.push(page);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => socket.connected);
    await page.locator(".resume-details > summary").click();
    await page.locator("#resume-key").fill(player.reconnectToken);
    await page.locator("#import-session").click();
    await page.waitForFunction(() => bound && state && !busy && socket.io.engine.transport.name === "websocket");
    // Long default so unrelated tests never race the open-offer auto-decline countdown.
    await page.evaluate(() => { trading.autoDeclineMs = 10 * 60 * 1000; });
  }
  return { room, pages, wires, contexts, errors, card,
    read: () => service.storage.getRoom(room.code),
    history: () => service.storage.listEvents(room.code, { limit: 1000 }),
    async restart() { await service.close(); service = createGameServer(options); await service.listen(port); },
    async close() { for (const context of contexts) await context.close(); await service.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}
const ACCEPT = '[data-trade-action="accept"]', DECLINE = '[data-trade-action="decline"]', COUNTER = '[data-trade-action="counter"]';
const WITHDRAW = '[data-trade-action="withdraw"]', EDIT = '[data-trade-action="edit"]', STATUS = "[data-trade-status]";
const offerCard = (page, tradeId) => page.locator(`.trade-offer[data-trade-id="${tradeId}"]`);
const forMe = () => state.trades?.some((trade) => trade.targetId === state.viewerId);

async function openPlayerTab(page) {
  await page.locator("#trade-details").evaluate((node) => { node.open = true; });
  await page.locator('[data-tab="player"]').click();
}
async function fillDraft(page, give = {}, want = {}) {
  for (const resource of ["wood", "brick", "sheep", "wheat", "ore"]) {
    await page.locator(`#give-${resource}`).fill(String(give[resource] || 0));
    await page.locator(`#want-${resource}`).fill(String(want[resource] || 0));
  }
}
async function draft(page, target, give = { wood: 1 }, want = { ore: 1 }) {
  await openPlayerTab(page);
  await choose(page, "trade-target", target);
  await fillDraft(page, give, want);
}
async function counter(page, tradeId, give, want) {
  await openPlayerTab(page);
  await offerCard(page, tradeId).locator(COUNTER).click();
  await expect(page.locator("#trade-mode")).toBeVisible();
  await fillDraft(page, give, want);
}
async function offer(t, give, want) {
  await draft(t.pages[0], t.room.players[1].id, give, want);
  await t.pages[0].locator("#offer-submit").click();
  await t.pages[0].waitForFunction(() => state.trades?.length && !busy);
  await t.pages[1].waitForFunction(forMe);
  return (await t.read()).trades.at(-1).id;
}
function holdings(room) { return { bank: room.bank, players: room.players.map((player) => player.resources) }; }

for (const width of [1440, 390, 320]) test(`trade destinations and named recipients prevent accidental offers at ${width}px`, async ({ browser }, testInfo) => {
  const t = await table(browser);
  try {
    const [actor, mira, ellis] = t.pages;
    await actor.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await expect(actor.locator('[data-tab="bank"]')).toHaveAttribute("aria-pressed", "true");
    await expect(actor.locator(".bank-destination")).toContainText("No player receives these cards");
    await expect(actor.locator("#bank-submit")).toContainText("Trade with bank");
    await actor.locator("#trade-section").screenshot({ path: testInfo.outputPath("bank-destination.png") });
    await actor.locator('[data-tab="player"]').click();
    await expect(actor.locator('[data-tab="bank"]')).toHaveAttribute("aria-pressed", "false");
    await expect(actor.locator('[data-tab="player"]')).toHaveAttribute("aria-pressed", "true");
    await expect(actor.locator("#bank-trade")).not.toBeVisible();
    await expect(actor.locator(".player-destination")).toContainText("not a bank exchange");
    await expect(actor.locator('#trade-target [aria-checked="true"]')).toHaveCount(0);
    await expect(actor.locator("#trade-recipient")).toContainText("No player selected");
    await actor.locator("#give-wood").fill("1");
    await actor.locator("#want-wheat").fill("1");
    await expect(actor.locator("#offer-submit")).toBeDisabled();
    await expect(actor.locator("#trade-draft-status")).toContainText("Choose a player");
    await actor.evaluate(() => trading.sendOffer("named"));
    expect(t.wires[0].requests.filter((request) => request.type === "offerTrade")).toHaveLength(0);
    await choose(actor, "trade-target", t.room.players[1].id);
    await expect(actor.locator("#offer-submit")).toHaveText("Send offer to Mira");
    await actor.keyboard.press("ArrowRight");
    await expect(actor.locator(`#trade-target [data-value="${t.room.players[2].id}"]`)).toHaveAttribute("aria-checked", "true");
    await expect(actor.locator("#trade-recipient")).toHaveText("Offer to: Ellis");
    await expect(actor.locator("#trade-give-heading")).toHaveText("You give to Ellis");
    await expect(actor.locator("#trade-want-heading")).toHaveText("You receive from Ellis");
    await expect(actor.locator("#offer-submit")).toHaveText("Send offer to Ellis");
    await expect(actor.locator("#trade-draft-status")).toContainText("1 wood to Ellis");
    const revision = await actor.evaluate(() => state.revision);
    await mira.reload();
    await actor.waitForFunction((revision) => state.revision > revision, revision);
    await expect(actor.locator("#offer-submit")).toHaveText("Send offer to Ellis");
    await actor.locator('[data-tab="bank"]').click();
    await actor.locator('[data-tab="player"]').click();
    await expect(actor.locator("#give-wood")).toHaveValue("1");
    await expect(actor.locator("#offer-submit")).toHaveText("Send offer to Ellis");
    expect((await t.read()).trades).toEqual([]);
    expect(t.wires[0].requests.filter((request) => request.type === "offerTrade" || request.type === "bankTrade")).toHaveLength(0);
    expect(await actor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await actor.locator("#trade-section").screenshot({ path: testInfo.outputPath("player-destination.png") });
    const before = holdings(await t.read());
    await actor.locator("#offer-submit").click();
    await ellis.waitForFunction(forMe);
    expect((await t.read()).trades[0].targetId).toBe(t.room.players[2].id);
    expect(holdings(await t.read())).toEqual(before);
    await expect(ellis.locator(`.trade-offer ${ACCEPT}`)).toHaveText("Accept trade with Rowan");
    await expect(ellis.locator(`.trade-offer ${COUNTER}`)).toHaveText("Counteroffer");
    await expect(actor.locator(`.trade-offer ${STATUS}`)).toContainText("Waiting for Ellis");
    await mira.waitForFunction(() => state.trades?.length > 0);
    await expect(mira.locator(`.trade-offer ${ACCEPT}`)).toHaveCount(0);
    await ellis.locator(`.trade-offer ${ACCEPT}`).click();
    await actor.waitForFunction(() => !state.trades.length && !busy);
    const after = holdings(await t.read());
    expect(after.bank).toEqual(before.bank);
    expect(after.players[1]).toEqual(before.players[1]);
    expect(after.players[0].wood).toBe(before.players[0].wood - 1);
    expect(after.players[2].wood).toBe(before.players[2].wood + 1);
    expect(after.players[0].wheat).toBe(before.players[0].wheat + 1);
    expect(after.players[2].wheat).toBe(before.players[2].wheat - 1);
    await expect(actor.locator('#trade-target [aria-checked="true"]')).toHaveCount(0);
    await expect(actor.locator("#offer-submit")).toBeDisabled();
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("bank exchanges never send a drafted player offer or change another player's cards", async ({ browser }) => {
  const t = await table(browser);
  try {
    const actor = t.pages[0];
    await draft(actor, t.room.players[1].id);
    const before = holdings(await t.read());
    const rate = await actor.evaluate(() => me().tradeRates.wood);
    await perform(actor, { type: "bankTrade", giveResource: "wood", receiveResource: "brick" });
    const after = holdings(await t.read());
    expect((await t.read()).trades).toEqual([]);
    expect(after.players.slice(1)).toEqual(before.players.slice(1));
    expect(after.players[0].wood).toBe(before.players[0].wood - rate);
    expect(after.players[0].brick).toBe(before.players[0].brick + 1);
    expect(after.bank.wood).toBe(before.bank.wood + rate);
    expect(after.bank.brick).toBe(before.bank.brick - 1);
    expect(t.wires[0].requests.filter((request) => request.type === "offerTrade")).toHaveLength(0);
    await actor.locator('[data-tab="player"]').click();
    await expect(actor.locator("#trade-recipient")).toHaveText("Offer to: Mira");
    await expect(actor.locator("#give-wood")).toHaveValue("1");
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

for (const postgres of [false, true]) test(`${postgres ? "PostgreSQL" : "SQLite"} Accept survives a peer update between pointer down and pointer up`, async ({ browser }) => {
  test.skip(postgres && !process.env.TEST_DATABASE_URL, "Set the isolated loopback test database URL.");
  const t = await table(browser, { postgres });
  try {
    await offer(t);
    const page = t.pages[1];
    const button = page.locator(`.trade-offer ${ACCEPT}`);
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const revision = await page.evaluate(() => state.revision);
    await t.pages[2].reload();
    await page.waitForFunction((revision) => state.revision > revision, revision);
    await page.mouse.up();
    await expect.poll(async () => (await t.history()).filter((event) => event.type === "tradeAccepted").length).toBe(1);
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("pre-roll trades are blocked for every player and bank, with a visible reason", async ({ browser }) => {
  const t = await table(browser, { preRoll: true });
  try {
    for (const page of t.pages) {
      await page.locator('[data-tab="player"]').click();
      await expect(page.locator("#offer-submit")).toBeDisabled();
      await expect(page.locator("#trade-status")).toContainText(/roll/i);
      expect(await page.evaluate(() => state.legal.canOfferTrade || state.legal.canBankTrade)).toBe(false);
    }
    await perform(t.pages[0], { type: "roll" });
    await offer(t);
    await expect(t.pages[1].locator(`.trade-offer ${ACCEPT}`)).toBeEnabled();
  } finally { await t.close(); }
});

test("incoming offers explain insufficient resources and Counteroffer targets the sender beside the original", async ({ browser }) => {
  const t = await table(browser, { shortRecipient: true });
  try {
    const original = await offer(t);
    const page = t.pages[1];
    await expect(page.locator(`.trade-offer ${ACCEPT}`)).toBeDisabled();
    await expect(page.locator(`.trade-offer ${STATUS}`)).toContainText("1 more ore");
    await counter(page, original, { sheep: 1 }, { wood: 1 });
    expect(await page.evaluate(() => GameControls.read("trade-target"))).toBe(t.room.players[0].id);
    await expect(page.locator('#trade-target [role="radio"]').first()).toBeDisabled();
    await expect(page.locator("#trade-mode-text")).toContainText("Countering Rowan's offer");
    await expect(page.locator("#offer-submit")).toHaveText("Send counteroffer to Rowan");
    await page.locator("#offer-submit").click();
    await t.pages[0].waitForFunction(() => state.trades?.length === 2 && !busy);
    const [kept, sent] = (await t.read()).trades;
    expect(kept.id).toBe(original);
    expect(sent).toMatchObject({ fromId: t.room.players[1].id, targetId: t.room.players[0].id, counterTo: original });
    await expect(t.pages[0].locator(`.trade-offer.is-counter .offer-counter-note`)).toHaveText("Counter to Rowan's offer");
    await expect(page.locator("#trade-mode")).toBeHidden();
    await offerCard(t.pages[0], sent.id).locator(ACCEPT).click();
    await t.pages[0].waitForFunction((id) => !state.trades.some((trade) => trade.id === id) && !busy, sent.id);
    expect((await t.history()).filter((event) => event.type === "tradeAccepted")).toHaveLength(1);
  } finally { await t.close(); }
});

test("slow acceptance retries one saved request and survives browser reload without a second exchange", async ({ browser }) => {
  const t = await table(browser);
  try {
    await offer(t);
    const before = holdings(await t.read());
    const page = t.pages[1], wire = t.wires[1];
    wire.holdResponses = true;
    await page.locator(`.trade-offer ${ACCEPT}`).click();
    await expect(page.locator(`.trade-offer ${ACCEPT}`)).toBeDisabled();
    await expect(page.locator(`.trade-offer ${STATUS}`)).toContainText(/confirm/i);
    await expect.poll(() => wire.requests.filter((request) => request.type === "respondTrade").length, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    expect(new Set(wire.requests.filter((request) => request.type === "respondTrade").map((request) => request.requestId)).size).toBe(1);
    wire.holdResponses = false;
    wire.buffered = [];
    await page.reload();
    await page.waitForFunction(() => bound && !busy && !state.trades.length);
    const after = holdings(await t.read());
    expect(after.bank).toEqual(before.bank);
    expect(after.players[0].ore).toBe(before.players[0].ore + 1);
    expect(after.players[1].ore).toBe(before.players[1].ore - 1);
    expect((await t.history()).filter((event) => event.type === "tradeAccepted")).toHaveLength(1);
  } finally { await t.close(); }
});

test("delayed acceptance cannot accept edited terms and an edit during a pointer press cannot accept them either", async ({ browser }) => {
  const t = await table(browser);
  try {
    const first = await offer(t);
    const before = holdings(await t.read());
    t.wires[1].holdRequests = true;
    await t.pages[1].locator(`.trade-offer ${ACCEPT}`).click();
    await expect.poll(() => t.wires[1].buffered.length).toBeGreaterThan(0);
    const edit = async (amount, previous) => {
      await offerCard(t.pages[0], previous).locator(EDIT).click();
      await expect(t.pages[0].locator("#trade-mode-text")).toContainText("Editing your offer");
      await fillDraft(t.pages[0], { wood: amount }, { ore: amount });
      await expect(t.pages[0].locator("#offer-submit")).toHaveText("Update offer to Mira");
      await t.pages[0].locator("#offer-submit").click();
      await t.pages[0].waitForFunction((id) => state.trades.length === 1 && state.trades[0].id !== id && !busy, previous);
      return (await t.read()).trades[0].id;
    };
    const replaced = await edit(2, first);
    t.wires[1].release();
    await t.pages[1].waitForFunction(() => !busy);
    expect(holdings(await t.read())).toEqual(before);
    expect((await t.read()).trades.map((trade) => trade.id)).toEqual([replaced]);
    const button = t.pages[1].locator(`.trade-offer ${ACCEPT}`);
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    await t.pages[1].mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await t.pages[1].mouse.down();
    const latest = await edit(3, replaced);
    await t.pages[1].waitForFunction((id) => state.trades[0]?.id === id, latest);
    await t.pages[1].mouse.up();
    expect((await t.read()).trades).toHaveLength(1);
    expect(holdings(await t.read())).toEqual(before);
    await t.pages[1].locator(`.trade-offer ${ACCEPT}`).click();
    await t.pages[1].waitForFunction(() => !state.trades.length && !busy);
    expect((await t.history()).filter((event) => event.type === "tradeAccepted")).toHaveLength(1);
  } finally { await t.close(); }
});

test("a pending offer persists through server restart and expires visibly when the sender spends its resources", async ({ browser }) => {
  const t = await table(browser);
  try {
    await offer(t, { wood: 8 }, { ore: 1 });
    const initial = await t.read();
    await t.restart();
    await t.pages[1].waitForFunction((revision) => bound && socket.connected && state.revision > revision, initial.revision);
    expect((await t.read()).trades).toEqual(initial.trades);
    await expect(t.pages[1].locator(`.trade-offer ${ACCEPT}`)).toBeEnabled();
    await perform(t.pages[0], { type: "bankTrade", giveResource: "wood", receiveResource: "brick" });
    await t.pages[1].waitForFunction(() => !state.trades.length);
    await expect(t.pages[1].locator(`.trade-offer ${ACCEPT}`)).toHaveCount(0);
    const cancelled = (await t.history()).find((event) => event.type === "tradeCancelled");
    expect(cancelled.data.reason).toBe("offered-resources-spent");
    expect((await t.history()).filter((event) => event.type === "tradeAccepted")).toHaveLength(0);
  } finally { await t.close(); }
});

test("a Knight interrupts trading and stale offers no longer display an unusable Accept button", async ({ browser }) => {
  const t = await table(browser);
  try {
    await offer(t);
    await perform(t.pages[0], { type: "playDevelopment", cardId: t.card.id });
    await t.pages[1].waitForFunction(() => state.phase === "robber");
    await expect(t.pages[1].locator(`.trade-offer ${ACCEPT}`)).toHaveCount(0);
    await expect(t.pages[1].locator("#trade-status")).toContainText(/robber/i);
    expect((await t.read()).trades).toEqual([]);
  } finally { await t.close(); }
});

test("an off-turn proposal can be countered by the active player and counter drafts survive unrelated presence changes", async ({ browser }) => {
  const t = await table(browser);
  try {
    const sender = t.pages[2], actor = t.pages[0];
    await draft(sender, t.room.players[0].id, { wheat: 1 }, { wood: 1 });
    await sender.locator("#offer-submit").click();
    await actor.waitForFunction(forMe);
    const proposal = (await t.read()).trades[0].id;
    await counter(actor, proposal, { wood: 2 }, { wheat: 1 });
    expect(await actor.evaluate(() => GameControls.read("trade-target"))).toBe(t.room.players[2].id);
    await actor.locator("#give-wood").focus();
    const revision = await actor.evaluate(() => state.revision);
    await t.pages[1].reload();
    await actor.waitForFunction((revision) => state.revision > revision, revision);
    await expect(actor.locator("#give-wood")).toBeFocused();
    await expect(actor.locator("#give-wood")).toHaveValue("2");
    await actor.locator("#offer-submit").click();
    await sender.waitForFunction(forMe);
    expect((await t.read()).trades.at(-1)).toMatchObject({ targetId: t.room.players[2].id, counterTo: proposal });
    await sender.locator(`.trade-offer.is-counter ${ACCEPT}`).click();
    await sender.waitForFunction(() => state.trades.length === 1 && !busy);
    expect((await t.history()).filter((event) => event.type === "tradeAccepted")).toHaveLength(1);
  } finally { await t.close(); }
});

test("a delayed counteroffer cannot revive a withdrawn offer and offline recipients can reconnect to valid offers", async ({ browser }) => {
  const t = await table(browser);
  try {
    const first = await offer(t);
    await counter(t.pages[1], first, { ore: 2 }, { wood: 2 });
    t.wires[1].holdRequests = true;
    await t.pages[1].locator("#offer-submit").click();
    await expect.poll(() => t.wires[1].buffered.length).toBeGreaterThan(0);
    await t.pages[0].locator(`.trade-offer ${WITHDRAW}`).click();
    await t.pages[0].waitForFunction(() => !state.trades.length && !busy);
    t.wires[1].release();
    await t.pages[1].waitForFunction(() => !busy);
    expect((await t.read()).trades).toEqual([]);
    expect((await t.history()).filter((event) => event.type === "tradeCounteroffered")).toHaveLength(0);
    await expect(t.pages[1].locator("#trade-mode")).toBeHidden();
    const id = await offer(t);
    await t.contexts[1].setOffline(true);
    await t.pages[1].waitForFunction(() => !bound);
    await expect(t.pages[1].locator(`.trade-offer ${ACCEPT}`)).toBeDisabled();
    await expect(t.pages[1].locator(`.trade-offer ${STATUS}`)).toContainText("Reconnecting");
    await t.contexts[1].setOffline(false);
    await t.pages[1].waitForFunction(() => bound && !busy);
    expect((await t.read()).trades[0].id).toBe(id);
    await t.pages[1].setViewportSize({ width: 390, height: 844 });
    await t.pages[1].locator(`.trade-offer ${ACCEPT}`).click();
    await t.pages[1].waitForFunction(() => !state.trades.length && !busy);
    expect((await t.history()).filter((event) => event.type === "tradeAccepted")).toHaveLength(1);
  } finally { await t.close(); }
});

for (const width of [1440, 390]) test(`open offers reach every player, show live responses and trade only with the chosen acceptor at ${width}px`, async ({ browser }, testInfo) => {
  const t = await table(browser);
  try {
    const [actor, mira, ellis] = t.pages;
    const [, miraId, ellisId] = t.room.players.map((player) => player.id);
    for (const page of t.pages) await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await openPlayerTab(actor);
    await actor.locator("#give-wood").fill("1");
    await actor.locator("#want-wheat").fill("1");
    await expect(actor.locator("#offer-submit")).toBeDisabled();
    await expect(actor.locator("#offer-all-submit")).toBeEnabled();
    await expect(actor.locator("#trade-draft-status")).toContainText("offer 1 wood for 1 wheat to all players");
    for (const page of [mira, ellis]) {
      await page.locator('[data-tab="player"]').click();
      await expect(page.locator("#offer-all-submit")).toBeHidden();
    }
    const before = holdings(await t.read());
    await actor.locator("#offer-all-submit").click();
    for (const page of [mira, ellis]) await page.waitForFunction(() => state.trades?.some((trade) => trade.targetId === null) && !busy);
    expect((await t.read()).trades[0].targetId).toBeNull();
    await expect(mira.locator(".trade-offer .offer-title")).toHaveText("Open trade offer");
    await expect(mira.locator(`.trade-offer ${ACCEPT}`)).toBeDisabled();
    await expect(mira.locator(`.trade-offer ${STATUS}`)).toContainText("1 more wheat");
    await mira.locator(`.trade-offer ${DECLINE}`).click();
    await expect(actor.locator(`.trade-response-row[data-player="${miraId}"]`)).toHaveAttribute("data-response", "declined");
    await expect(ellis.locator(`.trade-offer ${COUNTER}`)).toBeVisible();
    await ellis.locator(`.trade-offer ${ACCEPT}`).click();
    await ellis.waitForFunction((id) => state.trades[0]?.responses?.[id] === "accepted" && !busy, ellisId);
    await expect(ellis.locator(`.trade-offer ${ACCEPT}`)).toHaveText("Accepted");
    await expect(ellis.locator(`.trade-offer ${ACCEPT}`)).toBeDisabled();
    expect(holdings(await t.read())).toEqual(before);
    await expect(actor.locator(`.trade-response-row[data-player="${ellisId}"]`)).toHaveAttribute("data-response", "accepted");
    await expect(actor.locator(`.trade-offer ${STATUS}`)).toContainText("1 accepted · 1 declined · 0 waiting");
    await expect(actor.locator(`[data-trade-action="complete"][data-partner="${miraId}"]`)).toHaveCount(0);
    await expect(mira.locator('[data-trade-action="complete"]')).toHaveCount(0);
    const confirm = actor.locator(`[data-trade-action="complete"][data-partner="${ellisId}"]`);
    await expect(confirm).toHaveText("Trade with Ellis");
    expect(await actor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await actor.locator(".trade-offer").first().screenshot({ path: testInfo.outputPath(`open-offer-${width}.png`) });
    await confirm.click();
    await actor.waitForFunction(() => !state.trades.length && !busy);
    const after = holdings(await t.read());
    expect(after.bank).toEqual(before.bank);
    expect(after.players[1]).toEqual(before.players[1]);
    expect(after.players[0].wood).toBe(before.players[0].wood - 1);
    expect(after.players[0].wheat).toBe(before.players[0].wheat + 1);
    expect(after.players[2].wood).toBe(before.players[2].wood + 1);
    expect(after.players[2].wheat).toBe(before.players[2].wheat - 1);
    const history = await t.history();
    expect(history.filter((event) => event.type === "tradeResponded")).toHaveLength(2);
    const accepted = history.filter((event) => event.type === "tradeAccepted");
    expect(accepted).toHaveLength(1);
    expect(accepted[0].data.targetId).toBe(ellisId);
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

for (const width of [1440, 320]) test(`several offers stack with linked counteroffers, Me too copies and drafting hints at ${width}px`, async ({ browser }, testInfo) => {
  const t = await table(browser, { ellisOre: 1 });
  try {
    const [actor, mira, ellis] = t.pages;
    const [rowanId, miraId, ellisId] = t.room.players.map((player) => player.id);
    for (const page of t.pages) await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await openPlayerTab(actor);
    await fillDraft(actor, { wood: 2 }, { ore: 1 });
    await actor.locator("#offer-all-submit").click();
    await actor.waitForFunction(() => state.trades.length === 1 && !busy);
    await draft(actor, miraId, { brick: 1 }, { sheep: 1 });
    await actor.locator("#offer-submit").click();
    await actor.waitForFunction(() => state.trades.length === 2 && !busy);
    await expect(actor.locator("#trade-offer-count")).toHaveText("2");
    const open = (await t.read()).trades[0].id;
    await openPlayerTab(mira);
    await offerCard(mira, open).locator(COUNTER).click();
    await expect(offerCard(actor, open).locator("[data-trade-drafting]")).toHaveText("Mira is preparing a counteroffer…");
    await expect(offerCard(actor, open).locator(`.trade-response-row[data-player="${miraId}"]`)).toHaveAttribute("data-response", "countering");
    await expect(mira.locator("#give-ore")).toHaveValue("1");
    await expect(mira.locator("#want-wood")).toHaveValue("2");
    await mira.locator("#want-wood").fill("3");
    await mira.locator("#offer-submit").click();
    await actor.waitForFunction(() => state.trades.length === 3 && !busy);
    const counterId = (await t.read()).trades[2].id;
    await expect(actor.locator(".trade-offer").nth(1)).toHaveAttribute("data-trade-id", counterId);
    await expect(offerCard(actor, open).locator("[data-trade-drafting]")).toBeHidden();
    await ellis.waitForFunction((id) => state.trades.some((trade) => trade.id === id), counterId);
    await openPlayerTab(ellis);
    const meToo = offerCard(ellis, counterId).locator('[data-trade-action="metoo"]');
    await expect(meToo).toHaveText("Me too: offer the same to Rowan");
    await meToo.click();
    await actor.waitForFunction(() => state.trades.length === 4 && !busy);
    const copy = (await t.read()).trades[3];
    expect(copy).toMatchObject({ fromId: ellisId, targetId: rowanId, counterTo: open, give: { ore: 1 }, want: { wood: 3 } });
    expect(await actor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await actor.locator("#trade-offers").screenshot({ path: testInfo.outputPath(`offer-stack-${width}.png`) });
    const before = holdings(await t.read());
    await offerCard(actor, copy.id).locator(ACCEPT).click();
    await actor.waitForFunction((id) => !state.trades.some((trade) => trade.id === id) && !busy, copy.id);
    const after = holdings(await t.read());
    expect(after.players[2].ore).toBe(before.players[2].ore - 1);
    expect(after.players[2].wood).toBe(before.players[2].wood + 3);
    expect((await t.read()).trades.map((trade) => trade.id)).toEqual([open, (await t.read()).trades[1].id, counterId]);
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("open-ended Any offers are countered with exact cards, and unanswered open offers auto-decline unless kept", async ({ browser }) => {
  const t = await table(browser);
  try {
    const [actor, mira, ellis] = t.pages;
    await openPlayerTab(actor);
    await fillDraft(actor, { wood: 1 }, {});
    await actor.locator("#want-any").fill("1");
    await expect(actor.locator("#trade-draft-status")).toContainText("offer 1 wood for any 1 to all players");
    await ellis.evaluate(() => { trading.autoDeclineMs = 6000; });
    await actor.locator("#offer-all-submit").click();
    await mira.waitForFunction(() => state.trades.length === 1);
    const id = (await t.read()).trades[0].id;
    await expect(offerCard(mira, id).locator('[data-trade-resource="any"]')).toHaveAttribute("data-count", "1");
    await expect(offerCard(mira, id).locator(ACCEPT)).toHaveCount(0);
    await expect(offerCard(mira, id).locator(COUNTER)).toHaveText("Choose cards & counter");
    await expect(offerCard(ellis, id).locator("[data-trade-countdown]")).toBeVisible();
    await openPlayerTab(ellis);
    await offerCard(ellis, id).locator('[data-trade-action="pin"]').click();
    await expect(offerCard(ellis, id).locator("[data-countdown-text]")).toContainText("still thinking");
    await offerCard(mira, id).locator(COUNTER).click();
    await expect(mira.locator("#trade-mode-text")).toContainText("Replace each Any card");
    await fillDraft(mira, { ore: 1 }, { wood: 1 });
    await mira.locator("#offer-submit").click();
    await actor.waitForFunction(() => state.trades.length === 2 && !busy);
    await mira.waitForTimeout(3500);
    expect((await t.read()).trades[0].responses).toEqual({}, "pinned and countering players are never auto-declined");
    await mira.evaluate(() => { trading.pinned.clear(); });
    await ellis.evaluate(() => { trading.pinned.clear(); trading.seenAt.set(state.trades[0].id, Date.now() - 10000); });
    await expect.poll(async () => (await t.read()).trades.find((trade) => trade.id === id)?.responses?.[t.room.players[2].id]).toBe("declined");
    await offerCard(actor, (await t.read()).trades.at(-1).id).locator(ACCEPT).click();
    await actor.waitForFunction(() => !busy && state.log.some((event) => event.type === "tradeAccepted"));
    expect((await t.history()).filter((event) => event.type === "tradeAccepted")).toHaveLength(1);
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("players block and unblock trades from the trading post, and blocked offers stop reaching them", async ({ browser }) => {
  const t = await table(browser);
  try {
    const [actor, mira] = t.pages;
    const [rowanId, miraId] = t.room.players.map((player) => player.id);
    await openPlayerTab(mira);
    await mira.locator("#trade-settings > summary").click();
    const toggle = mira.locator(`[data-embargo-player="${rowanId}"]`);
    await expect(toggle).toHaveText("Block Rowan");
    await toggle.click();
    await mira.waitForFunction((id) => state.embargoes?.[state.viewerId]?.includes(id) && !busy, rowanId);
    await expect(mira.locator("#toast")).toContainText("You blocked trading with Rowan");
    await expect(mira.locator(`[data-embargo-player="${rowanId}"]`)).toHaveAttribute("aria-pressed", "true");
    await draft(actor, miraId);
    await expect(actor.locator("#trade-draft-status")).toContainText("Mira blocked trading with you");
    await expect(actor.locator("#offer-submit")).toBeDisabled();
    await openPlayerTab(actor);
    await fillDraft(actor, { wood: 1 }, { wheat: 1 });
    await actor.locator("#offer-all-submit").click();
    await actor.waitForFunction(() => state.trades.length === 1 && !busy);
    await expect(actor.locator(`.trade-response-row[data-player="${miraId}"]`)).toHaveAttribute("data-response", "blocked");
    await mira.waitForFunction(() => state.trades.length === 1);
    await expect(mira.locator(`.trade-offer ${ACCEPT}`)).toHaveCount(0);
    await mira.locator('.trade-offer [data-trade-action="unblock"]').click();
    await mira.waitForFunction(() => !Object.keys(state.embargoes || {}).length && !busy);
    await expect(mira.locator(`.trade-offer ${ACCEPT}`)).toHaveCount(1);
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("tapping hand cards drafts trades, and a mixed bundle can go to the bank from the player composer", async ({ browser }) => {
  const t = await table(browser);
  try {
    const actor = t.pages[0];
    const rates = await actor.evaluate(() => me().tradeRates);
    await actor.locator("#trade-details").evaluate((node) => { node.open = true; });
    await actor.locator('#resources [data-hand-resource="brick"]').click();
    await expect(actor.locator('#bank-give [data-value="brick"]')).toHaveAttribute("aria-checked", "true");
    await actor.locator('[data-tab="player"]').click();
    const hand = actor.locator('#resources [data-hand-resource="wood"]');
    await expect(hand).toHaveAttribute("role", "button");
    for (let index = 0; index < rates.wood; index++) await hand.click();
    await expect(actor.locator("#give-wood")).toHaveValue(String(rates.wood));
    await hand.focus();
    await actor.keyboard.press("Enter");
    await expect(actor.locator("#give-wood")).toHaveValue(String(rates.wood + 1));
    await actor.locator("#give-wood").fill(String(rates.wood));
    await actor.locator("#give-brick").fill(String(rates.brick));
    await actor.locator("#want-ore").fill("1");
    await actor.locator("#want-sheep").fill("1");
    await expect(actor.locator("#offer-bank-submit")).toBeVisible();
    await expect(actor.locator("#offer-bank-submit")).toContainText("Trade with bank instead");
    const before = holdings(await t.read());
    await actor.locator("#offer-bank-submit").click();
    await expect.poll(async () => (await t.read()).players[0].resources.ore).toBe(before.players[0].ore + 1);
    const after = holdings(await t.read());
    expect(after.players[0]).toMatchObject({ wood: before.players[0].wood - rates.wood, brick: before.players[0].brick - rates.brick,
      sheep: before.players[0].sheep + 1 });
    expect(after.players.slice(1)).toEqual(before.players.slice(1));
    expect((await t.history()).filter((event) => event.type === "bankTrade").at(-1).data.want).toEqual({ sheep: 1, ore: 1 });
    await expect(actor.locator("#give-wood")).toHaveValue("0");
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});

test("bank exchanges several full sets in one action and resets the quantity afterwards", async ({ browser }) => {
  const t = await table(browser);
  try {
    const actor = t.pages[0];
    const rate = await actor.evaluate(() => me().tradeRates.wood);
    const most = Math.floor(8 / rate);
    await actor.locator("#trade-details").evaluate((node) => { node.open = true; });
    await choose(actor, "bank-give", "wood");
    await choose(actor, "bank-receive", "ore");
    await expect(actor.locator("#bank-count")).toHaveAttribute("max", String(most));
    await actor.locator("#bank-count").fill(String(most + 1));
    await expect(actor.locator("#bank-submit")).toBeDisabled();
    await actor.locator("#bank-count").fill("2");
    await expect(actor.locator("#bank-submit")).toContainText(`Give ${2 * rate} wood → receive 2 ore`);
    const before = holdings(await t.read());
    await perform(actor, { type: "bankTrade", giveResource: "wood", receiveResource: "ore", count: 2 });
    const after = holdings(await t.read());
    expect(after.players[0].wood).toBe(before.players[0].wood - 2 * rate);
    expect(after.players[0].ore).toBe(before.players[0].ore + 2);
    expect(after.bank.wood).toBe(before.bank.wood + 2 * rate);
    expect(after.bank.ore).toBe(before.bank.ore - 2);
    expect(after.players.slice(1)).toEqual(before.players.slice(1));
    expect(t.wires[0].requests.filter((request) => request.type === "bankTrade").map(({ give, want }) => ({ give, want })))
      .toEqual([{ give: { wood: 2 * rate }, want: { ore: 2 } }]);
    expect((await t.history()).filter((event) => event.type === "bankTrade").at(-1).data).toEqual({ give: { wood: 2 * rate }, want: { ore: 2 }, ratio: rate });
    await expect(actor.locator("#bank-count")).toHaveValue("1");
    expect(t.errors).toEqual([]);
  } finally { await t.close(); }
});
