"use strict";

function findLayout(neighbours, inventory, order, priorities, nodeLimit, greedy = false) {
  const layout = Array(neighbours.length).fill(-1);
  const remaining = [...inventory];
  let nodes = 0;
  function place(depth) {
    if (++nodes > nodeLimit) return false;
    if (depth === layout.length) return true;
    let chosen = -1;
    let choices = [];
    const capacity = inventory.map(() => 0);
    for (const index of order) {
      if (layout[index] !== -1) continue;
      const available = priorities[index].filter((resource) => remaining[resource] > 0 &&
        neighbours[index].every((other) => layout[other] !== resource));
      if (!available.length) return false;
      for (const resource of available) capacity[resource]++;
      if (chosen === -1 || available.length < choices.length ||
          (available.length === choices.length && neighbours[index].length > neighbours[chosen].length)) {
        chosen = index;
        choices = available;
      }
    }
    if (remaining.some((count, resource) => count > capacity[resource])) return false;
    if (greedy) choices.sort((a, b) => remaining[b] - remaining[a]);
    for (const resource of choices) {
      layout[chosen] = resource;
      remaining[resource]--;
      if (place(depth + 1)) return true;
      remaining[resource]++;
      layout[chosen] = -1;
      if (nodes >= nodeLimit) break;
    }
    return false;
  }
  return place(0) ? layout : null;
}

function spreadResources(neighbours, inventory, shuffled, searchLimit = 2000) {
  const indices = neighbours.map((_, index) => index);
  const resources = inventory.map((_, index) => index);
  if (inventory.some((count) => !Number.isSafeInteger(count) || count < 0) ||
      inventory.reduce((total, count) => total + count, 0) !== neighbours.length ||
      !Number.isSafeInteger(searchLimit) || searchLimit < 0) {
    throw new Error("Invalid resource layout inventory or search limit.");
  }
  const order = shuffled(indices);
  // A shuffled multiset weights early choices by tile supply without always pushing deserts
  // and less-common resources to the coast.
  const bag = inventory.flatMap((count, resource) => Array(count).fill(resource));
  const priorities = indices.map(() => [...new Set(shuffled(bag))]);
  const randomized = findLayout(neighbours, inventory, order, priorities, searchLimit);
  if (randomized) return randomized;

  // These two fixed island graphs also have a verified greedy solution in canonical order.
  // Bound both searches so pathological randomness cannot stall a shared game server.
  const fallback = findLayout(neighbours, inventory, indices, indices.map(() => resources), 64, true);
  if (!fallback) throw new Error("Unable to arrange the resource inventory on this island.");
  return fallback;
}

module.exports = { spreadResources };
