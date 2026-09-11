"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { io } = require("socket.io-client");
const { createGameServer } = require("../server");
const { plan } = require("../e2e/strategy.cjs");

function rng(seed) {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function request(client, event, payload = {}) {
  return new Promise((resolve, reject) => {
    client.timeout(5000).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else if (!response.ok) reject(new Error(`${event}/${payload.type}: ${response.error}`));
      else resolve(response);
    });
  });
}

for (const count of [3, 4, 5, 6]) {
  test(`${count} networked players reach a real ten-point win without resource injection`, { timeout: 180_000 }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hearthlands-fullgame-"));
    const service = createGameServer({ dataDir: directory, random: rng(count === 6 ? 807 : count + 100) });
    const port = await service.listen();
    const clients = [];
    t.after(async () => {
      clients.forEach((client) => client.close());
      await service.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const seats = new Map();
    let code;
    for (let i = 0; i < count; i++) {
      const client = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false });
      clients.push(client);
      client.on("state", (state) => { client.latest = state; });
      await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("connect_error", reject); });
      const result = await request(client, i === 0 ? "createRoom" : "joinRoom", { name: `Explorer ${i + 1}`, code });
      code = result.roomCode;
      seats.set(result.playerId, client);
    }
    await request(clients[0], "startGame");
    const moves = {};
    let view = clients[0].latest;
    for (let step = 0; step < 7000 && !view.winnerId; step++) {
      const discardId = Object.entries(view.pendingDiscards || {}).find(([, amount]) => amount > 0)?.[0];
      const client = seats.get(discardId || view.currentPlayerId);
      // Broadcasts to different sockets may be delivered after the initiating socket's ack.
      if ((client.latest.revision || 0) < view.revision) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Missing broadcast")), 5000);
          const listener = (state) => {
            if (state.revision >= view.revision) { clearTimeout(timeout); client.off("state", listener); resolve(); }
          };
          client.on("state", listener);
        });
      }
      const move = plan(client.latest);
      assert.ok(move, `No legal move in phase ${view.phase}`);
      moves[move.type] = (moves[move.type] || 0) + 1;
      // Real clients are rate limited; this also verifies that limits allow a fast game.
      await new Promise((resolve) => setTimeout(resolve, 30));
      await request(client, "gameAction", { ...move, requestId: crypto.randomUUID() });
      view = client.latest;
    }
    assert.ok(view.winnerId, `No winner after ${JSON.stringify(moves)}; points: ${view.players.map((p) => p.points)}`);
    assert.equal(view.phase, "finished");
    assert.ok(view.players.find((p) => p.id === view.winnerId).points >= 10);
    t.diagnostic(JSON.stringify({ count, moves, winner: view.players.find((p) => p.id === view.winnerId).name }));
  });
}
