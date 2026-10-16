// Checks the keyboard-movement key handling in src/keyboard-nav.js: which
// keys move the camera, that typing and browser shortcuts are left alone, and
// that held keys are dropped when the window loses focus.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FAST_MULTIPLIER, KeyboardNav, isTypingTarget, movementDirection, movementKey } from '../src/keyboard-nav.js';

const el = (tagName, extra = {}) => ({ tagName, isContentEditable: false, ...extra });
const key = (code, extra = {}) => ({ code, target: el('BODY'), shiftKey: false, preventDefault() {}, ...extra });

/** Minimal stand-in for window: records listeners and dispatches to them. */
function fakeWindow() {
  const listeners = {};
  return {
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
    fire: (type, event = {}) => listeners[type]?.forEach((fn) => fn(event)),
  };
}

test('typing targets are text fields, selects and editable text', () => {
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(isTypingTarget(el(tag)), true, tag);
  for (const type of ['text', 'search', 'number', 'email']) assert.equal(isTypingTarget(el('INPUT', { type })), true, type);
  for (const type of ['checkbox', 'radio', 'range', 'button']) assert.equal(isTypingTarget(el('INPUT', { type })), false, type);
  assert.equal(isTypingTarget(el('DIV', { isContentEditable: true })), true);
  for (const tag of ['BODY', 'BUTTON', 'CANVAS']) assert.equal(isTypingTarget(el(tag)), false, tag);
  assert.equal(isTypingTarget(null), false);
});

test('WASDQE move the camera; other keys do not', () => {
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']) assert.equal(movementKey(key(code)), code);
  for (const code of ['KeyR', 'Space', 'ArrowUp', 'Enter']) assert.equal(movementKey(key(code)), null);
});

test('keys are ignored while typing or with Ctrl, Meta or Alt held', () => {
  assert.equal(movementKey(key('KeyW', { target: el('INPUT') })), null);
  assert.equal(movementKey(key('KeyW', { target: el('DIV', { isContentEditable: true }) })), null);
  assert.equal(movementKey(key('KeyW', { ctrlKey: true })), null);
  assert.equal(movementKey(key('KeyS', { metaKey: true })), null);
  assert.equal(movementKey(key('KeyD', { altKey: true })), null);
  assert.equal(movementKey(key('KeyW', { shiftKey: true })), 'KeyW');
});

test('keys still move the camera after a checkbox or slider is clicked', () => {
  const win = fakeWindow();
  const nav = new KeyboardNav(win);
  win.fire('keydown', key('KeyW', { target: el('INPUT', { type: 'checkbox' }) }));
  win.fire('keydown', key('KeyD', { target: el('INPUT', { type: 'range' }) }));
  assert.equal(nav.moving, true);
  assert.deepEqual([...nav.held], ['KeyW', 'KeyD']);
});

test('direction maps keys to axes, cancels opposites and normalises diagonals', () => {
  assert.deepEqual(movementDirection(new Set(['KeyW'])), { forward: 1, right: 0, up: 0 });
  assert.deepEqual(movementDirection(new Set(['KeyS'])), { forward: -1, right: 0, up: 0 });
  assert.deepEqual(movementDirection(new Set(['KeyA'])), { forward: 0, right: -1, up: 0 });
  assert.deepEqual(movementDirection(new Set(['KeyE'])), { forward: 0, right: 0, up: 1 });
  assert.deepEqual(movementDirection(new Set(['KeyQ'])), { forward: 0, right: 0, up: -1 });
  assert.deepEqual(movementDirection(new Set(['KeyW', 'KeyS'])), { forward: 0, right: 0, up: 0 });
  const diagonal = movementDirection(new Set(['KeyW', 'KeyD']));
  assert.ok(Math.abs(Math.hypot(diagonal.forward, diagonal.right, diagonal.up) - 1) < 1e-9);
});

test('held keys are tracked, Shift speeds up, and keyup or blur stops movement', () => {
  const win = fakeWindow();
  const nav = new KeyboardNav(win);
  let prevented = false;
  win.fire('keydown', key('KeyW', { preventDefault: () => (prevented = true) }));
  assert.equal(nav.moving, true);
  assert.equal(prevented, true);
  assert.equal(nav.direction().forward, 1);

  win.fire('keydown', key('KeyW', { shiftKey: true }));
  assert.equal(nav.direction().forward, FAST_MULTIPLIER);
  win.fire('keyup', key('ShiftLeft'));
  assert.equal(nav.direction().forward, 1);

  win.fire('keyup', key('KeyW'));
  assert.equal(nav.moving, false);

  win.fire('keydown', key('KeyA'));
  win.fire('blur');
  assert.equal(nav.moving, false);
});

test('typing or a shortcut stops movement and leaves the key to the page', () => {
  const win = fakeWindow();
  const nav = new KeyboardNav(win);
  win.fire('keydown', key('KeyD'));
  let prevented = false;
  win.fire('keydown', key('KeyW', { target: el('INPUT'), preventDefault: () => (prevented = true) }));
  assert.equal(nav.moving, false);
  assert.equal(prevented, false);

  win.fire('keydown', key('KeyD'));
  win.fire('keydown', key('KeyR', { ctrlKey: true }));
  assert.equal(nav.moving, false);
});
