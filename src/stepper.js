// A reusable previous/next stepper: walks a list of items one at a time, with
// ‹ › buttons, an "n / total" counter and the ←/→ and Esc keys. The Guide
// (src/guide.js) uses it to step through every part of a body system; it knows
// nothing about parts, so another mode can drive it with its own items.
// Stepper is the state and key handling (no DOM, so it runs in node);
// stepperBar() draws it.
import { isTypingTarget } from './keyboard-nav.js';

/** Inputs that use the arrow keys themselves (the peel slider, radio groups). */
const ARROW_INPUT_TYPES = new Set(['range', 'radio']);

/**
 * What a keydown asks of a running stepper: 'next' (→), 'prev' (←), 'exit'
 * (Esc) or null. Keys are left alone while the user types (isTypingTarget, the
 * same guard as WASD movement and the search's "/"), on a slider or radio
 * group that uses the arrows itself, and with a modifier held (Alt+← is the
 * browser's Back).
 */
export function stepperKey(event) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  const el = event.target;
  if (isTypingTarget(el)) return null;
  if (el?.tagName?.toLowerCase() === 'input' && ARROW_INPUT_TYPES.has(el.type?.toLowerCase())) return null;
  return { ArrowRight: 'next', ArrowLeft: 'prev', Escape: 'exit' }[event.key] ?? null;
}

export class Stepper {
  /**
   * @param {{
   *   onStep?: (item: any, index: number, total: number) => void,
   *   onStop?: () => void,
   * }} [handlers] `onStep` runs on every move, including the first; `onStop` when stopped
   */
  constructor({ onStep, onStop } = {}) {
    this.onStep = onStep ?? (() => {});
    this.onStop = onStop ?? (() => {});
    this.items = [];
    this.index = -1;
    this.listeners = new Set();
  }

  get active() {
    return this.index >= 0;
  }

  get total() {
    return this.items.length;
  }

  get current() {
    return this.items[this.index];
  }

  /** Starts (or restarts) on `items` at `index`; does nothing for an empty list. */
  start(items, index = 0) {
    if (!items.length) return this.stop();
    this.items = items;
    this.#go(Math.min(Math.max(index, 0), items.length - 1));
  }

  /** Moves to item `index`; false (and no move) past either end or while stopped. */
  go(index) {
    if (!this.active || index < 0 || index >= this.total || index === this.index) return false;
    this.#go(index);
    return true;
  }

  next() {
    return this.go(this.index + 1);
  }

  prev() {
    return this.go(this.index - 1);
  }

  stop() {
    if (!this.active) return;
    this.index = -1;
    this.items = [];
    this.#changed();
    this.onStop();
  }

  /**
   * Acts on a keydown (see stepperKey) while running; returns whether it did,
   * and then the page should not also act on it.
   */
  handleKey(event) {
    if (!this.active) return false;
    const action = stepperKey(event);
    if (!action) return false;
    event.preventDefault?.();
    if (action === 'exit') this.stop();
    else this[action]();
    return true;
  }

  /** Handles ←/→/Esc from `target` (normally window) while running. */
  listen(target) {
    target.addEventListener('keydown', (e) => this.handleKey(e));
    return this;
  }

  /** Runs `fn(stepper)` after every move and on stop, e.g. to redraw. */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #go(index) {
    this.index = index;
    this.#changed();
    this.onStep(this.current, index, this.total);
  }

  #changed() {
    for (const fn of this.listeners) fn(this);
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/**
 * The floating bar that shows and drives a Stepper: a kicker, the current
 * item's title, ‹ "n / total" › and a × that stops it. Hidden while stopped.
 * @param {Stepper} stepper
 * @param {{ kicker: (stepper: Stepper) => string, title?: (item: any) => string, color?: (stepper: Stepper) => string }} view
 * @returns {HTMLElement} add it to the page once
 */
export function stepperBar(stepper, { kicker, title = String, color = () => '' }) {
  const bar = el('aside', 'panel stepper');
  bar.setAttribute('aria-live', 'polite');
  bar.hidden = true;
  const close = el('button', 'close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'End');
  close.title = 'End (Esc)';
  const prev = el('button', 'stepper-arrow', '‹');
  prev.type = 'button';
  prev.setAttribute('aria-label', 'Previous');
  prev.title = 'Previous (←)';
  const next = el('button', 'stepper-arrow', '›');
  next.type = 'button';
  next.setAttribute('aria-label', 'Next');
  next.title = 'Next (→)';
  const count = el('span', 'stepper-count');
  const label = el('p', 'kicker');
  const name = el('p', 'stepper-title');
  const nav = el('div', 'stepper-nav');
  nav.append(prev, count, next);
  bar.append(close, label, name, nav);

  close.addEventListener('click', () => stepper.stop());
  prev.addEventListener('click', () => stepper.prev());
  next.addEventListener('click', () => stepper.next());
  stepper.subscribe(() => {
    bar.hidden = !stepper.active;
    document.body.classList.toggle('stepping', stepper.active);
    if (!stepper.active) return;
    bar.style.setProperty('--layer-color', color(stepper));
    label.textContent = kicker(stepper);
    name.textContent = title(stepper.current);
    count.textContent = `${stepper.index + 1} / ${stepper.total}`;
    prev.disabled = stepper.index === 0;
    next.disabled = stepper.index === stepper.total - 1;
  });
  return bar;
}
