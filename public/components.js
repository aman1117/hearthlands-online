"use strict";

window.GameControls = (() => {
  const values = new Map();
  const descriptors = new Map();
  let popup = null;
  let openId = null;
  const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const label = (value) => value.charAt(0).toUpperCase() + value.slice(1);

  function configure(id, items, initial, onChange) {
    const before = descriptors.get(id);
    const signature = JSON.stringify(items.map(({ value, label, disabled }) => [value, label, disabled]));
    if (openId === id && before?.signature !== signature) close(false);
    descriptors.set(id, { items, onChange, signature });
    if (!items.some((item) => item.value === values.get(id))) values.set(id, initial ?? items[0]?.value ?? "");
    return values.get(id);
  }
  function resourcePicker(id, title, { selected = "wood", counts, rates, disabled = false, disabledValues = [], onChange } = {}) {
    const items = ["wood", "brick", "sheep", "wheat", "ore"].map((resource) => ({
      value: resource, label: label(resource), disabled: disabled || disabledValues.includes(resource),
    }));
    const value = configure(id, items, selected, onChange);
    const tab = items.find((item) => item.value === value && !item.disabled)?.value || items.find((item) => !item.disabled)?.value;
    return `<fieldset id="${id}" class="resource-choice" data-control="${id}" role="radiogroup" aria-labelledby="${id}-legend"><legend id="${id}-legend">${escape(title)}</legend><div class="resource-choice-row">${items.map((item) => `
      <button type="button" role="radio" data-picker="${id}" data-value="${item.value}" aria-checked="${item.value === value}" aria-label="${item.label}${rates ? `, ${rates[item.value]} to one` : ""}${counts ? `, ${counts[item.value]} available` : ""}" tabindex="${item.value === tab ? 0 : -1}" ${item.disabled ? "disabled" : ""}>
        ${Tabletop.icon(item.value)}<span class="resource-choice-name">${item.label}</span>${counts ? `<span class="choice-stock">${counts[item.value]}</span>` : ""}${rates ? `<span class="choice-rate">${rates[item.value]}:1</span>` : ""}
      </button>`).join("")}</div></fieldset>`;
  }
  function playerPicker(id, title, players, { selected, disabled = false, onChange } = {}) {
    const items = players.map((p) => ({ value: p.id, label: p.name, disabled }));
    const value = configure(id, items, selected, onChange);
    const tab = items.find((item) => item.value === value)?.value || items[0]?.value;
    return `<fieldset id="${id}" class="player-choice" data-control="${id}" role="radiogroup"><legend>${escape(title)}</legend>${players.map((p) => `
      <button type="button" role="radio" data-picker="${id}" data-value="${p.id}" aria-checked="${p.id === value}" tabindex="${p.id === tab ? 0 : -1}" ${disabled ? "disabled" : ""}><span class="seat-chip" style="--seat-color:${p.color}"></span>${escape(p.name)}</button>`).join("")}</fieldset>`;
  }
  function select(id, title, items, { selected, onChange } = {}) {
    const value = configure(id, items, selected, onChange);
    const chosen = items.find((item) => item.value === value);
    return `<div id="${id}" class="game-select" data-control="${id}"><label id="${id}-label">${escape(title)}</label><button id="${id}-trigger" type="button" role="combobox" aria-labelledby="${id}-label ${id}-value" aria-controls="${id}-list" aria-expanded="${openId === id}" aria-haspopup="listbox" data-open-picker="${id}"><span id="${id}-value">${escape(chosen?.label || "Choose a location")}</span><span class="choice-chevron" aria-hidden="true"></span></button></div>`;
  }
  function read(id) { return values.get(id) || ""; }
  function set(id, value) {
    const descriptor = descriptors.get(id);
    if (!descriptor?.items.some((item) => item.value === value)) return false;
    values.set(id, value);
    refresh(id);
    return true;
  }
  function refresh(id) {
    const value = read(id);
    const options = [...document.querySelectorAll(`[data-picker="${id}"]`)];
    const tab = options.find((node) => node.dataset.value === value && !node.disabled) || options.find((node) => !node.disabled);
    options.forEach((node) => {
      node.setAttribute("aria-checked", String(node.dataset.value === value));
      node.tabIndex = node === tab ? 0 : -1;
    });
    const output = document.getElementById(`${id}-value`);
    if (output) output.textContent = descriptors.get(id).items.find((item) => item.value === value)?.label || "Choose a location";
  }
  function choose(id, value) {
    const descriptor = descriptors.get(id);
    if (!descriptor?.items.some((item) => item.value === value && !item.disabled)) return;
    set(id, value);
    close(false);
    descriptor.onChange?.(value);
    document.getElementById(`${id}-trigger`)?.focus();
  }
  function close(restoreFocus = true) {
    if (!openId) return;
    const trigger = document.getElementById(`${openId}-trigger`);
    trigger?.setAttribute("aria-expanded", "false");
    popup?.remove();
    popup = null;
    openId = null;
    if (restoreFocus) trigger?.focus();
  }
  function position() {
    const anchor = document.getElementById(`${openId}-trigger`);
    if (!popup || !anchor) { close(false); return; }
    const rect = anchor.getBoundingClientRect();
    if (!anchor.getClientRects().length || rect.bottom < 0 || rect.top > window.innerHeight) { close(false); return; }
    const width = Math.min(Math.max(290, rect.width), window.innerWidth - 24);
    const height = Math.min(330, window.innerHeight - 36);
    popup.style.width = `${width}px`;
    popup.style.maxHeight = `${height}px`;
    popup.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    const availableBelow = window.innerHeight - rect.bottom - 12;
    const top = availableBelow >= Math.min(230, height) ? rect.bottom + 5 : Math.max(12, rect.top - Math.min(height, popup.scrollHeight) - 5);
    popup.style.top = `${top}px`;
  }
  function filteredOptions(query = "") {
    const descriptor = descriptors.get(openId);
    if (!descriptor || !popup) return;
    const items = descriptor.items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
    popup.querySelector('[role="listbox"]').innerHTML = items.length ? items.map((item) => `<button type="button" role="option" aria-selected="${read(openId) === item.value}" data-option="${item.value}" ${item.disabled ? "disabled" : ""}>${escape(item.label)}<span aria-hidden="true">${read(openId) === item.value ? "✓" : ""}</span></button>`).join("") : '<p class="picker-empty">No matching locations.</p>';
    position();
  }
  function open(id) {
    if (openId === id) { close(); return; }
    close(false);
    openId = id;
    popup = document.createElement("section");
    popup.className = "choice-popup";
    popup.setAttribute("aria-label", "Choose a map location");
    popup.innerHTML = `<label for="${id}-filter">Find a location</label><input id="${id}-filter" type="search" placeholder="Search terrain, number, or junction" autocomplete="off"><div id="${id}-list" role="listbox" aria-label="Available locations"></div>`;
    document.body.appendChild(popup);
    const filter = popup.querySelector("input");
    filter.oninput = () => filteredOptions(filter.value);
    popup.onclick = (event) => {
      const option = event.target.closest("[data-option]");
      if (option) choose(id, option.dataset.option);
    };
    popup.onkeydown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
      const nodes = [...popup.querySelectorAll('[role="option"]:not(:disabled)')];
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && nodes.length) {
        event.preventDefault();
        event.stopPropagation();
        const index = nodes.indexOf(document.activeElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? nodes.length - 1 :
          (index + (event.key === "ArrowDown" ? 1 : -1) + nodes.length) % nodes.length;
        nodes[next].focus();
      }
      if (event.key === "Enter" && event.target === filter && nodes[0]) {
        event.preventDefault();
        choose(id, nodes[0].dataset.option);
      }
      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        const trigger = document.getElementById(`${id}-trigger`);
        close(false);
        const focusable = [...document.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]')]
          .filter((node) => node.getClientRects().length && node.tabIndex >= 0);
        const index = focusable.indexOf(trigger);
        const next = (index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
        focusable[next]?.focus();
      }
    };
    document.getElementById(`${id}-trigger`).setAttribute("aria-expanded", "true");
    filteredOptions();
    filter.focus();
  }

  document.addEventListener("click", (event) => {
    const radio = event.target.closest("[data-picker]");
    if (radio && !radio.disabled) {
      const id = radio.dataset.picker;
      set(id, radio.dataset.value);
      descriptors.get(id).onChange?.(radio.dataset.value);
      return;
    }
    const trigger = event.target.closest("[data-open-picker]");
    if (trigger) { open(trigger.dataset.openPicker); return; }
    const step = event.target.closest("[data-step]");
    if (step) {
      const input = document.getElementById(step.dataset.input);
      if (Number(step.dataset.step) > 0) input.stepUp();
      else input.stepDown();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (popup && !popup.contains(event.target)) close(false);
  });
  document.addEventListener("keydown", (event) => {
    const radio = event.target.closest("[data-picker]");
    if (radio && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const nodes = [...document.querySelectorAll(`[data-picker="${radio.dataset.picker}"]:not(:disabled)`)];
      const index = nodes.indexOf(radio);
      const next = event.key === "Home" ? 0 : event.key === "End" ? nodes.length - 1 :
        (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + nodes.length) % nodes.length;
      nodes[next]?.focus();
      nodes[next]?.click();
    }
    const trigger = event.target.closest("[data-open-picker]");
    if (trigger && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); open(trigger.dataset.openPicker); }
  });
  function syncCounters(root = document) {
    const inputs = root.matches?.(".counter-input input") ? [root] : [...root.querySelectorAll(".counter-input input")];
    for (const input of inputs) {
      const value = input.valueAsNumber;
      const min = Number(input.min);
      const max = Number(input.max);
      document.querySelector(`[data-input="${input.id}"][data-step="-1"]`).disabled = input.disabled || !Number.isFinite(value) || value <= min;
      document.querySelector(`[data-input="${input.id}"][data-step="1"]`).disabled = input.disabled || max <= min || (Number.isFinite(value) && value >= max);
    }
  }
  document.addEventListener("input", (event) => {
    if (event.target.matches(".counter-input input")) syncCounters(event.target);
  });
  window.addEventListener("resize", position);
  document.addEventListener("scroll", (event) => {
    if (popup && !popup.contains(event.target)) position();
  }, true);
  function counter(prefix, resource, limit = 24, known = true) {
    const id = `${prefix}-${resource}`;
    return `<label class="resource-counter" for="${id}"><span class="counter-resource">${Tabletop.icon(resource)}${label(resource)}</span><span class="counter-input"><button type="button" data-step="-1" data-input="${id}" aria-label="Remove one ${resource}">−</button><input id="${id}" type="number" min="0" max="${limit}" step="1" value="0" inputmode="numeric" aria-label="${label(resource)} amount"><button type="button" data-step="1" data-input="${id}" aria-label="Add one ${resource}">+</button></span><span class="counter-limit">${limit} ${known ? "available" : "max"}</span></label>`;
  }
  function dice(value) {
    const dots = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
    return `<span class="dice-space" role="img" aria-label="${value ? `Die ${value}` : "Rolling die"}"><span class="dice-shadow"></span><span class="dice-cube" data-value="${value || 1}">${["front", "left", "top", "bottom", "right", "back"].map((face, index) => `<span class="cube-face cube-${face}" aria-hidden="true">${Array.from({ length: 9 }, (_, i) => `<i class="${dots[index + 1].includes(i) ? "pip" : ""}"></i>`).join("")}</span>`).join("")}</span></span>`;
  }
  return { read, set, reset(id) { values.delete(id); }, resourcePicker, playerPicker, select, counter, dice, close, syncCounters };
})();
