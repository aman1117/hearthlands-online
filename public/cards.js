"use strict";

window.GameCards = (() => {
  const materials = { wood: "#557b52", brick: "#bb7859", sheep: "#9caf69", wheat: "#dcb35b", ore: "#8199a4" };
  const emblems = { knight: "knight", roadBuilding: "road", yearOfPlenty: "wheat", monopoly: "crown", victoryPoint: "settlement" };
  const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

  function resource(type, count, index) {
    return `<div class="resource-card physical-resource ${count ? "" : "empty"}" style="--material:${materials[type]};--fan:${(index - 2) * 2}deg" role="img" aria-label="${count} ${type} resource cards">
      <span class="card-backing" aria-hidden="true"></span>
      <div class="resource-face">
        <span class="card-corner corner-top" aria-hidden="true"><b>${count}</b>${Tabletop.icon(type)}</span>
        <div class="resource-window"><svg class="card-scene" viewBox="-86 -70 172 140" width="86" height="70" aria-hidden="true"><rect x="-100" y="-100" width="200" height="200" fill="${materials[type]}"/>${Tabletop.terrain(type, 0)}</svg></div>
        <span class="resource-title">${type}</span>
        <span class="card-corner corner-bottom" aria-hidden="true"><b>${count}</b>${Tabletop.icon(type)}</span>
      </div>
    </div>`;
  }

  function development(type, cards, playableIds, metadata, finished) {
    const playable = cards.find((card) => playableIds.includes(card.id));
    const representative = playable || cards[0];
    const [name, description] = metadata;
    return `<article class="development-card physical-development card-${type}" data-development-type="${type}">
      <span class="development-edition">HEARTHLANDS</span>
      <span class="development-quantity" title="${cards.length} cards of this type">${cards.length > 1 ? `×${cards.length}` : ""}</span>
      <div class="development-seal">${Tabletop.icon(emblems[type])}</div>
      <strong class="development-title">${escape(name)}</strong>
      <p>${escape(description)}</p>
      ${type === "victoryPoint" ? `<span class="vp-seal">+${cards.length} VP</span><small>${finished ? "Revealed" : "Private until victory"}</small>` :
        `<button type="button" class="play-card secondary-button" data-card="${representative.id}" ${playable ? "" : "disabled"}>${playable ? "Play card" : "Not playable now"}</button>`}
    </article>`;
  }
  function revealed(type, count, name, status) {
    return `<article class="development-card physical-development revealed-development card-${type}" data-revealed-type="${type}" aria-label="${count} ${escape(name)}: ${escape(status)}">
      <span class="development-edition">PUBLIC INFORMATION</span>
      <span class="revealed-quantity">×${count}</span>
      <div class="development-seal">${Tabletop.icon(emblems[type])}</div>
      <strong class="development-title">${escape(name)}</strong>
      <span class="revealed-status">${escape(status)}</span>
    </article>`;
  }
  function reference(costs) {
    const names = { road: "Road", settlement: "Settlement", city: "City upgrade", development: "Development card" };
    const buildRows = Object.entries(names).map(([kind, name]) => {
      const price = Object.entries(costs[kind]).map(([type, count]) =>
        `<span class="reference-resource" data-resource="${type}" data-count="${count}" style="--material:${materials[type]}">${Tabletop.icon(type)}<span><b>${count}</b> ${type}</span></span>`).join('<span class="reference-plus" aria-hidden="true">+</span>');
      return `<div class="reference-build-row" data-reference-build="${kind}"><span class="reference-piece">${Tabletop.icon(kind === "development" ? "cards" : kind)}<strong>${name}</strong></span><div class="reference-cost">${price}</div></div>`;
    }).join("");
    const rates = [
      [4, "Bank", "4 cards of one resource", "No port needed"],
      [3, "General port", "3 cards of one resource", "Requires your settlement or city at a 3:1 port"],
      [2, "Matching port", "2 cards of the port's resource", "Requires your settlement or city at that resource's 2:1 port"],
    ].map(([rate, name, give, requirement]) => `<article class="reference-rate" data-reference-rate="${rate}"><div class="reference-rate-heading"><strong>${name}</strong><span>${rate}:1</span></div><p>${give} <span aria-hidden="true">→</span> <b>1 different resource</b></p><small>${requirement}</small></article>`).join("");
    return `<div class="reference-heading"><span class="eyebrow">KEEP AT HAND</span><h3>Resource conversion</h3><p>What your cards can build, and how to exchange them.</p></div>
      <div class="reference-builds"><h4>Building costs</h4>${buildRows}<p class="reference-note">A city replaces one of your settlements and returns its settlement piece.</p></div>
      <div class="reference-trading"><h4>Bank &amp; port trades</h4><div class="reference-rates">${rates}</div>
      <p class="reference-note">Use your best available rate. The bank must have the resource you want. Trade only after rolling and resolving any seven; a paired turn has no second roll.</p>
      <p class="reference-note">Player trades have no fixed ratio: agree on an exchange with the active primary player. No gifts or the same resource on both sides.</p></div>`;
  }
  return { resource, development, revealed, reference };
})();
