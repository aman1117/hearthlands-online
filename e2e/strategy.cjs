"use strict";

// A deterministic test player. It reads only the same private/public view as a browser.
const resources = ["wood", "brick", "sheep", "wheat", "ore"];
const costs = {
  city: { wheat: 2, ore: 3 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  development: { sheep: 1, wheat: 1, ore: 1 },
  road: { wood: 1, brick: 1 },
};

function scoreVertex(state, id) {
  const vertex = state.board.vertices.find((v) => v.id === id);
  const self = state.players.find((p) => p.id === state.viewerId);
  const production = Object.fromEntries(resources.map((r) => [r, 0]));
  state.board.vertices.filter((v) => v.structure?.playerId === self.id).forEach((v) => {
    for (const tileId of v.adjacentTiles) {
      const tile = state.board.tiles.find((t) => t.id === tileId);
      if (tile.number) production[tile.resource] += 6 - Math.abs(7 - tile.number);
    }
  });
  return vertex.adjacentTiles.reduce((sum, tileId) => {
    const tile = state.board.tiles.find((t) => t.id === tileId);
    if (!tile.number) return sum;
    const weight = { wood: 1, brick: 0.8, sheep: 1.1, wheat: 1.5, ore: 1.6 }[tile.resource];
    return sum + (6 - Math.abs(7 - tile.number)) * weight * (production[tile.resource] ? 1 : 2.5);
  }, 0);
}

function bestRoad(state) {
  const edges = state.legal.roadEdges;
  const vertices = new Map(state.board.vertices.map((v) => [v.id, v]));
  function targetScore(vertexId, depth, seen) {
    if (depth > 4 || seen.has(vertexId)) return -10;
    seen = new Set([...seen, vertexId]);
    const vertex = vertices.get(vertexId);
    if (vertex.structure && vertex.structure.playerId !== state.viewerId) return -10;
    let score = !vertex.structure && vertex.adjacentVertices.every((id) => !vertices.get(id).structure)
      ? scoreVertex(state, vertexId) / (depth + 1) : -10;
    for (const next of vertex.adjacentVertices) score = Math.max(score, targetScore(next, depth + 1, seen));
    return score;
  }
  return [...edges].sort((aId, bId) => {
    const score = (id) => Math.max(...state.board.edges.find((edge) => edge.id === id).vertices.map((vertex) => targetScore(vertex, 0, new Set())));
    return score(bId) - score(aId) || Number(aId.slice(1)) - Number(bId.slice(1));
  })[0];
}

function plan(state) {
  const self = state.players.find((p) => p.id === state.viewerId);
  const legal = state.legal;
  const myId = state.viewerId;
  const emptyBundle = () => Object.fromEntries(resources.map((r) => [r, 0]));
  if (state.pendingDiscards?.[myId]) {
    const discard = emptyBundle();
    const remaining = { ...self.resources };
    for (let i = 0; i < state.pendingDiscards[myId]; i++) {
      const resource = [...resources].sort((a, b) => remaining[b] - remaining[a])[0];
      remaining[resource]--;
      discard[resource]++;
    }
    return { type: "discard", resources: discard };
  }
  if (myId !== state.currentPlayerId) return null;
  if (state.phase === "setup") return state.setupNeedsRoad
    ? { type: "setupRoad", edgeId: bestRoad(state) }
    : { type: "setupSettlement", vertexId: [...legal.settlementVertices].sort((a, b) => scoreVertex(state, b) - scoreVertex(state, a))[0] };
  if (state.phase === "robber") {
    const scores = legal.robberTiles.map((id) => {
      const tile = state.board.tiles.find((t) => t.id === id);
      const score = tile.vertices.reduce((sum, vertexId) => {
        const owner = state.board.vertices.find((v) => v.id === vertexId).structure?.playerId;
        return sum + (owner ? owner === myId ? -100 : 10 : 0);
      }, 0) + (tile.number ? 6 - Math.abs(7 - tile.number) : 0);
      return [id, score];
    }).sort((a, b) => b[1] - a[1]);
    return { type: "moveRobber", tileId: scores[0][0] };
  }
  if (state.phase === "steal") {
    return { type: "steal", targetId: [...state.robberVictims].sort((a, b) =>
      state.players.find((p) => p.id === b).resourceCount - state.players.find((p) => p.id === a).resourceCount)[0] };
  }
  if (state.freeRoadsRemaining) {
    if (legal.roadEdges.length) return { type: "buildRoad", edgeId: bestRoad(state) };
    if (legal.canFinishFreeRoads) return { type: "finishFreeRoads" };
  }

  const playable = (self.developmentCards || []).filter((card) => legal.playableCardIds.includes(card.id));
  const knight = playable.find((card) => card.type === "knight");
  if (knight) return { type: "playDevelopment", cardId: knight.id };
  const citySites = state.board.vertices.filter((v) => v.structure?.playerId === myId && v.structure.kind === "settlement");
  const goal = citySites.length && self.citiesLeft ? costs.city : self.settlementsLeft ? costs.settlement : costs.development;
  const plenty = playable.find((card) => card.type === "yearOfPlenty");
  if (plenty) {
    const bundle = emptyBundle();
    const bank = { ...state.bank };
    for (let i = 0; i < Math.min(2, Object.values(state.bank).reduce((a, b) => a + b, 0)); i++) {
      const r = [...resources].filter((r) => bank[r]).sort((a, b) =>
        ((goal[b] || 0) - self.resources[b] - bundle[b]) - ((goal[a] || 0) - self.resources[a] - bundle[a]))[0];
      if (r) { bundle[r]++; bank[r]--; }
    }
    return { type: "playDevelopment", cardId: plenty.id, resources: bundle };
  }
  const monopoly = playable.find((card) => card.type === "monopoly");
  if (monopoly) {
    const resource = [...resources].sort((a, b) => ((goal[b] || 0) - self.resources[b]) - ((goal[a] || 0) - self.resources[a]))[0];
    return { type: "playDevelopment", cardId: monopoly.id, resource };
  }
  const roads = playable.find((card) => card.type === "roadBuilding");
  if (roads) return { type: "playDevelopment", cardId: roads.id };
  if (legal.canRoll) return { type: "roll" };
  if (legal.settlementVertices.length) {
    return { type: "buildSettlement", vertexId: [...legal.settlementVertices].sort((a, b) => scoreVertex(state, b) - scoreVertex(state, a))[0] };
  }
  if (legal.cityVertices.length) {
    return { type: "buildCity", vertexId: [...legal.cityVertices].sort((a, b) => scoreVertex(state, b) - scoreVertex(state, a))[0] };
  }
  if (legal.canBuyDevelopment) return { type: "buyDevelopment" };
  if (legal.canBankTrade) {
    const goals = [goal, costs.development, costs.settlement, costs.road];
    for (const target of goals) {
      if (target === costs.development && !state.developmentCount) continue;
      const deficits = resources.filter((r) => self.resources[r] < (target[r] || 0) && state.bank[r]);
      const surplus = resources.filter((r) => self.resources[r] - (target[r] || 0) >= self.tradeRates[r])
        .sort((a, b) => self.resources[b] - self.resources[a]);
      if (deficits.length && surplus.length) {
        return { type: "bankTrade", giveResource: surplus[0], receiveResource: deficits[0] };
      }
    }
  }
  if (legal.roadEdges.length && self.settlementsLeft) return { type: "buildRoad", edgeId: bestRoad(state) };
  if (legal.canEndTurn) return { type: "endTurn" };
  return null;
}

module.exports = { plan };
