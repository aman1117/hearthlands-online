"use strict";

// Drive the same resource tiles and location chooser a human uses.
async function choose(page, id, value) {
  const control = page.locator(`#${id}`);
  if (await control.locator('[role="radio"]').count()) {
    await control.locator(`[data-value="${value}"]`).click();
  } else {
    await page.locator(`#${id}-trigger`).click();
    await page.locator(`.choice-popup [data-option="${value}"]`).click();
  }
}

async function perform(page, move) {
  const before = await page.evaluate(() => state.revision);
  if (["setupSettlement", "setupRoad", "moveRobber", "buildRoad", "buildSettlement", "buildCity"].includes(move.type)) {
    const type = { buildRoad: "road", buildSettlement: "settlement", buildCity: "city" }[move.type];
    const free = await page.evaluate(() => state.freeRoadsRemaining);
    if (type && !free) await page.locator(`[data-build="${type}"]`).click();
    await choose(page, "location-select", move.edgeId || move.vertexId || move.tileId);
    await page.locator("#place-location").click();
  } else if (move.type === "roll") await page.locator("#roll-button").click();
  else if (move.type === "endTurn") await page.locator("#end-turn").click();
  else if (move.type === "buyDevelopment") await page.locator("#buy-development").click();
  else if (move.type === "finishFreeRoads") await page.locator("#finish-roads").click();
  else if (move.type === "discard") {
    for (const [resource, amount] of Object.entries(move.resources)) await page.locator(`#discard-${resource}`).fill(String(amount));
    await page.locator("#submit-discard").click();
  } else if (move.type === "steal") await page.locator(`[data-target="${move.targetId}"]`).click();
  else if (move.type === "bankTrade") {
    await page.locator("#trade-details").evaluate((element) => { element.open = true; });
    await page.locator('[data-tab="bank"]').click();
    await choose(page, "bank-give", move.giveResource);
    await choose(page, "bank-receive", move.receiveResource);
    await page.locator("#bank-submit").click();
  } else if (move.type === "playDevelopment") {
    await page.locator(`[data-card="${move.cardId}"]`).click();
    if (move.resource) await choose(page, "monopoly-resource", move.resource);
    if (move.resources) {
      for (const [resource, amount] of Object.entries(move.resources)) await page.locator(`#plenty-${resource}`).fill(String(amount));
    }
    await page.locator("#play-development").click();
  } else throw new Error(`No browser interaction for ${move.type}`);
  await page.waitForFunction((revision) => !busy && state.revision > revision, before);
}

module.exports = { choose, perform };
