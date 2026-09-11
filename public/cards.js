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
  return { resource, development };
})();
