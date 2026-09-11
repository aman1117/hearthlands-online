"use strict";

// Original vector artwork. The same silhouettes connect terrain, cards, and controls.
window.Tabletop = (() => {
  const icons = {
    wood: '<path d="M11 23h4v7h-4z" fill="#7c5031"/><path d="M13 1 3 16h5L1 24h24l-7-8h5z" fill="#267347"/><path d="m13 1 1 22H2l7-8H4z" fill="#479a5c"/>',
    brick: '<path d="m2 14 15-6 13 7-15 7z" fill="#e59764"/><path d="m2 14 13 8v8L2 22z" fill="#b65335"/><path d="m15 22 15-7v8l-15 7z" fill="#833d2d"/><path d="m5 3 13-3 11 7-14 5z" fill="#db8055"/><path d="m5 3 10 9v7L5 11z" fill="#a34a32"/><path d="m15 12 14-5v7l-14 5z" fill="#753d2e"/>',
    sheep: '<path d="M9 23v6m13-6v6" stroke="#514334" stroke-width="3"/><path d="M4 14a6 6 0 0 1 7-7 6 6 0 0 1 10 0 6 6 0 0 1 7 7c6 8-3 13-10 11C6 29-1 21 4 14" fill="#fff5da" stroke="#9d957c" stroke-width="1.3"/><ellipse cx="26" cy="15" rx="4" ry="6" fill="#514334"/><circle cx="27" cy="13" r="1" fill="white"/>',
    wheat: '<path d="M15 31V4m-2 19-7-9m10 4 9-10" fill="none" stroke="#986423" stroke-width="2.3"/><path d="M14 19C4 19 3 12 4 9c5 0 9 4 10 10m2-2C15 7 21 5 26 4c2 5-2 11-10 13M14 11C8 8 10 2 14 0c4 3 5 8 0 11M15 27c-8 0-12-5-12-9 8 0 12 4 12 9m2-3c1-8 6-11 12-10 0 7-5 10-12 10" fill="#e8b53e" stroke="#aa7727" stroke-width=".7"/>',
    ore: '<path d="m2 24 8-19 10-4 11 23-12 8z" fill="#7c8f9c" stroke="#3f535f" stroke-width="1.5"/><path d="m10 5 8 6-5 11-11 2z" fill="#b7c6c9"/><path d="m20 1-2 10 13 13z" fill="#536c7d"/><path d="m13 22 18 2-12 8z" fill="#415561"/>',
    road: '<path d="m2 24 24-18 5 6L7 30z" fill="currentColor"/><path d="m3 23 23-17" stroke="#fff5de" stroke-width="2"/>',
    settlement: '<path d="M4 14 16 3l12 11v15H4z" fill="currentColor"/><path d="m1 15 15-14 15 14" fill="none" stroke="currentColor" stroke-width="3"/><path d="M13 20h6v9h-6z" fill="#fff7e1" opacity=".6"/>',
    city: '<path d="M1 30V15h10V6l7-5 7 5v10h6v14z" fill="currentColor"/><path d="M16 7h4v5h-4zm0 11h4v5h-4z" fill="#fff7e1" opacity=".6"/>',
    cards: '<rect x="3" y="3" width="20" height="25" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><rect x="8" y="6" width="21" height="25" rx="3" fill="currentColor"/><path d="m18 12 3 4 5 1-3 4 1 5-6-3-5 3 1-5-3-4 5-1z" fill="#f4d68c"/>',
    crown: '<path d="m2 8 8 6L16 3l6 11 8-6-4 19H6z" fill="currentColor"/><path d="M6 30h20" stroke="currentColor" stroke-width="2"/>',
    knight: '<path d="M7 29h20l-1-7-9-5 8 1 5-8-9-8-9 3 2 7-6 9z" fill="currentColor"/><circle cx="24" cy="8" r="1.5" fill="#fff4d8"/>',
    pointer: '<path d="m7 2 1 25 6-7 6 11 5-3-7-10 10-1z" fill="currentColor"/>',
    ping: '<circle cx="16" cy="16" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 0v9m0 14v9M0 16h9m14 0h9" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="16" r="3" fill="currentColor"/>',
    shuffle: '<path d="M2 7h5c7 0 10 18 17 18h6m-6-5 6 5-6 5M2 25h5c7 0 10-18 17-18h6m-6-5 6 5-6 5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>',
    sound: '<path d="M2 12h6l8-7v22l-8-7H2z" fill="currentColor"/><path d="M21 10q7 6 0 12m5-18q12 12 0 24" fill="none" stroke="currentColor" stroke-width="2"/>',
    expand: '<path d="M2 12V2h10m8 0h10v10m0 8v10H20m-8 0H2V20" fill="none" stroke="currentColor" stroke-width="2.5"/>',
    lock: '<rect x="6" y="13" width="20" height="17" rx="3" fill="currentColor"/><path d="M10 13V8a6 6 0 0 1 12 0v5" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="16" cy="20" r="2" fill="#fff5df"/>',
  };
  function icon(name, className = "") {
    return `<svg class="ui-icon ${className}" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true" focusable="false">${icons[name] || icons.cards}</svg>`;
  }
  function glyph(name) { return icons[name] || icons.cards; }
  function defs() {
    return `<defs>
      <linearGradient id="land-wood" x2=".6" y2="1"><stop stop-color="#77a765"/><stop offset="1" stop-color="#356749"/></linearGradient>
      <linearGradient id="land-brick" x2=".7" y2="1"><stop stop-color="#dfa57b"/><stop offset="1" stop-color="#b06442"/></linearGradient>
      <linearGradient id="land-sheep" x2=".5" y2="1"><stop stop-color="#b6cc76"/><stop offset="1" stop-color="#759450"/></linearGradient>
      <linearGradient id="land-wheat" x2=".4" y2="1"><stop stop-color="#f5d071"/><stop offset="1" stop-color="#cfa045"/></linearGradient>
      <linearGradient id="land-ore" x2=".5" y2="1"><stop stop-color="#bbc8ca"/><stop offset="1" stop-color="#75898f"/></linearGradient>
      <linearGradient id="land-desert" x2=".3" y2="1"><stop stop-color="#eed59d"/><stop offset="1" stop-color="#c9a677"/></linearGradient>
      <linearGradient id="token-light" x2=".3" y2="1"><stop stop-color="#fffdf0"/><stop offset="1" stop-color="#e9d3a8"/></linearGradient>
      <pattern id="fine-grain" width="23" height="19" patternUnits="userSpaceOnUse"><circle cx="3" cy="7" r=".6" fill="#fff" opacity=".2"/><circle cx="14" cy="15" r=".8" fill="#182c26" opacity=".13"/><path d="m18 3 3 1M4 15h2" stroke="#fff" opacity=".13"/></pattern>
      <clipPath id="land-clip"><path d="m0-100 86.603 50v100L0 100l-86.603-50V-50Z"/></clipPath>
      <g id="pine"><path d="M-2 11h4v16h-4z" fill="#745036"/><path d="M0-29-17 1h7L-23 15h46L10 1h7Z" fill="#224f38"/><path d="M0-29v44h-23L-10 1h-7Z" fill="#3a7c49"/><path d="M0-17 7-3M0-1l13 10" stroke="#8ba967" stroke-width="2" opacity=".6"/></g>
      <g id="mountain"><path d="m-42 35 30-65 13 12 15-26 45 79Z" fill="#687f8c"/><path d="m-42 35 30-65 8 30-11 6-9 29Zm43-53 15-26 10 31-9 5Z" fill="#d9e1d9"/><path d="m16-44 4 46 41 33-35-48Z" fill="#8b9fa8"/><path d="M-4 0 4 11l-9 24h-12Zm24 2 8 15-8 18H5Z" fill="#465f70"/></g>
      <g id="grazing-sheep"><ellipse cy="10" rx="16" ry="4" fill="#3e5b38" opacity=".18"/><path d="M-8 4v9m14-9v9" stroke="#635341" stroke-width="3"/><path d="M-13-3q0-11 11-7Q7-18 12-7q8 0 6 8-4 10-14 7-15 7-21-4Z" fill="#fff7df" stroke="#d4d1b0"/><ellipse cx="15" cy="0" rx="4" ry="7" fill="#5e5644"/><circle cx="16" cy="-2" r="1" fill="#fff"/></g>
      <g id="grain-sheaf"><path d="M0 23V-22M-2 14-15-12M2 14l13-26" stroke="#9e722d" stroke-width="2"/><path d="M0-20c-12-11-8-18 0-22 8 4 12 11 0 22M-4 0C-20-3-23-14-20-19-8-19-3-11-4 0M4 0C20-3 23-14 20-19 8-19 3-11 4 0M-1 11C-13 8-17 2-17-5-7-4-2 2-1 11M1 11C13 8 17 2 17-5 7-4 2 2 1 11" fill="#eec657" stroke="#b78730" stroke-width="1"/><path d="m-7 15 14-2" stroke="#95632e" stroke-width="4"/></g>
      <g id="clay-stone"><path d="m-23 9 5-19 25-7 21 15-8 23-27 3Z" fill="#b86b47"/><path d="m-18-10 25-7 9 12-11 11-28 3Z" fill="#e3a477"/><path d="m5 6 15 15-27 3-16-15Z" fill="#955335"/><path d="m16-5 12 3-8 23L5 6Z" fill="#c78152"/></g>
    </defs>`;
  }
  function use(symbol, x, y, scale = 1) {
    return `<use href="#${symbol}" transform="translate(${x} ${y}) scale(${scale})"/>`;
  }
  function terrain(resource, variant = 0) {
    let scenery = "";
    switch (resource) {
      case "wood":
        scenery = `<path d="M-100 30Q-50-10 0 12T100-4V110H-100" fill="#244d3a" opacity=".23"/>` +
          [[-49, -31, .8], [-17, -56, .75], [42, -36, .9], [62, 12, .7], [-53, 34, .85], [2, 54, .8], [42, 59, .65]].map(([x, y, s]) => use("pine", x, y, s)).join("");
        break;
      case "ore":
        scenery = `<path d="M-100 34Q-20 10 100 35V110H-100" fill="#566f76" opacity=".25"/>${use("mountain", -30, -35, .8)}${use("mountain", 39, 27, .86)}${use("mountain", -44, 46, .65)}<path d="m4 79 12-4 7 7-15 4Zm53-112 9-4 8 5-12 7Z" fill="#5b7076"/>`;
        break;
      case "wheat":
        scenery = `<path d="M-100-18Q10-58 100-14M-100-3Q10-43 100 1M-100 12Q10-28 100 16M-100 30Q10-10 100 34M-100 48Q10 8 100 52M-100 68Q10 28 100 72" fill="none" stroke="#ad812c" stroke-width="6" opacity=".28"/>${use("grain-sheaf", -48, -22, .67)}${use("grain-sheaf", 43, 51, .72)}${use("grain-sheaf", -25, 66, .5)}`;
        break;
      case "sheep":
        scenery = `<path d="M-110 14Q-54-42 25 0T110-1V110H-110" fill="#63864a" opacity=".27"/><path d="M-110 66Q-5 7 110 43V110H-110" fill="#d0dd93" opacity=".35"/>${use("grazing-sheep", -49, -33, .9)}${use("grazing-sheep", 43, 25, .82)}${use("grazing-sheep", -28, 59, .72)}<path d="m53-38 2-10 4 8m-4 3 8-5M-60 24l2-9 4 7" stroke="#4c7442" fill="none" stroke-width="2"/>`;
        break;
      case "brick":
        scenery = `<path d="M-100-4Q-28-70 39-32T105 1V110H-100" fill="#c77d56" opacity=".5"/><path d="M-90 51Q0-2 100 39" fill="none" stroke="#efd1a0" stroke-width="8" opacity=".3"/>${use("clay-stone", -42, -34, .95)}${use("clay-stone", 45, 41, .9)}${use("clay-stone", -33, 61, .7)}<path d="m41-53 18 5-5 9-15-4" fill="#a35c3c"/>`;
        break;
      default:
        scenery = `<path d="M-100 6Q-30-72 28-20T110-4M-110 62Q-20-20 36 31T110 51" fill="none" stroke="#f8e7b8" stroke-width="15" opacity=".6"/><path d="M-100 18Q-32-55 20-9M-100 74Q-17 0 28 36" fill="none" stroke="#a17e4d" stroke-width="2" opacity=".4"/><path d="m41-34 11-3 8 7-13 5ZM-52 35l7-4 8 5-12 3" fill="#b09062"/>`;
    }
    return `<g class="terrain-art" clip-path="url(#land-clip)" transform="scale(${variant % 2 ? -1 : 1} 1)">${scenery}<rect x="-100" y="-100" width="200" height="200" fill="url(#fine-grain)"/></g>`;
  }
  function building(kind, color) {
    if (kind === "city") {
      return `<g class="wooden-piece"><ellipse cx="2" cy="23" rx="29" ry="9" fill="#182b2d" opacity=".3"/><path d="M-24 1-8-10 5 0v22h-29Z" fill="${color}"/><path d="M5 0 14-7v22l-9 7Z" fill="${color}"/><path d="M5 0 14-7v22l-9 7Z" fill="#14232c" opacity=".25"/><path d="M-3-17 10-29 24-17v37H-3Z" fill="${color}"/><path d="m10-29 8-5 14 12-8 5Z" fill="${color}"/><path d="m24-17 8-5v35l-8 7Z" fill="${color}"/><path d="m24-17 8-5v35l-8 7Z" fill="#15222a" opacity=".28"/><path d="m-24 1 16-11L5 0M-3-17l13-12 14 12" stroke="#ffefd1" opacity=".8" fill="none" stroke-width="2.5"/><path d="M7-12h7v8H7zm0 17h7v8H7z" fill="#fff1cb" opacity=".55"/></g>`;
    }
    return `<g class="wooden-piece"><ellipse cx="3" cy="22" rx="25" ry="8" fill="#182b2d" opacity=".3"/><path d="M-19-2 0-20 19-2v24h-38Z" fill="${color}"/><path d="m0-20 9-6 19 18-9 6Z" fill="${color}"/><path d="m19-2 9-6v24l-9 6Z" fill="${color}"/><path d="m19-2 9-6v24l-9 6Z" fill="#162630" opacity=".3"/><path d="m-19-2 19-18 19 18" stroke="#ffefd1" stroke-width="3" opacity=".8" fill="none"/><path d="M-4 11h8v11h-8Z" fill="#382f27" opacity=".3"/></g>`;
  }
  function die(value) {
    const dots = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] }[value] || [];
    return `<span class="die" role="img" aria-label="Die ${value}">${Array.from({ length: 9 }, (_, i) => `<i class="${dots.includes(i) ? "pip" : ""}"></i>`).join("")}</span>`;
  }
  return { icon, glyph, defs, terrain, building, die };
})();
