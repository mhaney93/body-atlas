// The part search box: a combobox over src/search.js. Type to list matches,
// ↑/↓ to move, Enter to pick, Esc to close (again to leave the box); "/"
// anywhere else focuses it. `onPick` gets the chosen index entry.
import { isTypingTarget } from './keyboard-nav.js';
import { isSearchShortcut, search } from './search.js';

/**
 * @param {HTMLElement} root element holding `input[type=search]` and `ul[role=listbox]`
 * @param {{
 *   index: () => object[],
 *   layer: (id: string) => { name: string, color: string },
 *   reasons: Record<string, string>,
 *   approximate: string,
 *   onPick: (entry: object) => void,
 * }} options `index` is called on first use, so the index is built only when needed
 */
export function searchBox(root, { index, layer, reasons, approximate, onPick }) {
  const input = root.querySelector('input');
  const list = root.querySelector('[role="listbox"]');
  let results = [];
  let active = -1;
  let entries = null;

  const open = (on) => {
    list.hidden = !on;
    input.setAttribute('aria-expanded', String(on));
    if (!on) setActive(-1);
  };

  function setActive(i) {
    active = i;
    const options = list.querySelectorAll('[role="option"]');
    options.forEach((el, j) => el.setAttribute('aria-selected', String(j === i)));
    if (i >= 0) {
      input.setAttribute('aria-activedescendant', options[i].id);
      options[i].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function option(entry, i) {
    const system = layer(entry.layerId);
    const li = document.createElement('li');
    li.id = `search-option-${i}`;
    li.setAttribute('role', 'option');
    li.className = entry.kind === 'notShown' ? 'search-option not-shown-option' : 'search-option';
    li.style.setProperty('--layer-color', system.color);
    const name = document.createElement('span');
    name.className = 'search-name';
    name.textContent = entry.name;
    if (entry.side) {
      const side = document.createElement('span');
      side.className = 'search-side';
      side.textContent = entry.side === 'left' ? 'Left' : 'Right';
      name.append(' ', side);
    }
    const meta = document.createElement('span');
    meta.className = 'search-meta';
    const parts =
      entry.kind === 'notShown'
        ? [`Not shown · ${reasons[entry.reason] ?? entry.reason}`, system.name]
        : [system.name, entry.region, entry.approximate && approximate];
    if (entry.alias) parts.push(`also called ${entry.alias}`);
    meta.textContent = parts.filter(Boolean).join(' · ');
    li.append(name, meta);
    // Keep focus in the box (mousedown would blur it) so the list stays put.
    li.addEventListener('pointerdown', (e) => e.preventDefault());
    li.addEventListener('click', () => pick(i));
    return li;
  }

  function render() {
    const query = input.value.trim();
    if (!query) {
      results = [];
      list.replaceChildren();
      open(false);
      return;
    }
    entries ??= index();
    results = search(entries, query);
    if (results.length) {
      list.replaceChildren(...results.map(option));
    } else {
      const empty = document.createElement('li');
      empty.className = 'search-empty';
      empty.textContent = `No part matches “${query}”. Try another name or spelling.`;
      list.replaceChildren(empty);
    }
    open(true);
    setActive(results.length ? 0 : -1);
  }

  function pick(i) {
    const entry = results[i];
    if (!entry) return;
    open(false);
    input.blur(); // hands the keys back to the camera and, on phones, closes the keyboard
    onPick(entry);
  }

  input.addEventListener('input', render);
  input.addEventListener('focus', () => input.value.trim() && render());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) return render();
      if (!results.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((active + step + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(active >= 0 ? active : 0);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (!list.hidden) open(false);
      else {
        input.value = '';
        input.blur();
      }
    }
  });
  root.addEventListener('focusout', (e) => {
    if (!root.contains(e.relatedTarget)) open(false);
  });
  window.addEventListener('keydown', (e) => {
    if (!isSearchShortcut(e, isTypingTarget)) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
  return { input };
}
