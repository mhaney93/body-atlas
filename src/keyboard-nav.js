// Keyboard camera movement: W/S forward/back, A/D left/right, Q/E down/up,
// Shift to go faster. This module only tracks which keys are held; the viewer
// turns that into camera motion each frame.

/** Movement keys by KeyboardEvent.code (physical position, so WASD works on any layout). */
const KEY_AXES = {
  KeyW: ['forward', 1],
  KeyS: ['forward', -1],
  KeyD: ['right', 1],
  KeyA: ['right', -1],
  KeyE: ['up', 1],
  KeyQ: ['up', -1],
};

export const FAST_MULTIPLIER = 3;

/** Input types that take no typed text, so letter keys can stay page shortcuts. */
const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file', 'image']);

/**
 * True when keystrokes belong to the focused element (a text field, select or
 * editable text), so page shortcuts should leave them alone.
 */
export function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toLowerCase();
  if (tag === 'input') return !NON_TEXT_INPUT_TYPES.has(el.type?.toLowerCase());
  return tag === 'textarea' || tag === 'select';
}

/** The movement key an event is for, or null if the camera should ignore it. */
export function movementKey(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return null; // browser shortcuts
  if (isTypingTarget(event.target)) return null;
  return event.code in KEY_AXES ? event.code : null;
}

/**
 * Direction for the held keys as { forward, right, up }, each -1..1 (opposite
 * keys cancel) and normalised so diagonals are no faster.
 */
export function movementDirection(held) {
  const dir = { forward: 0, right: 0, up: 0 };
  for (const code of held) {
    const [axis, sign] = KEY_AXES[code];
    dir[axis] += sign;
  }
  const length = Math.hypot(dir.forward, dir.right, dir.up);
  if (length > 1) for (const axis in dir) dir[axis] /= length;
  return dir;
}

/** Tracks held movement keys on `target` (normally window). */
export class KeyboardNav {
  held = new Set();
  fast = false;

  constructor(target) {
    target.addEventListener('keydown', (e) => {
      this.fast = e.shiftKey;
      const code = movementKey(e);
      if (!code) {
        // A shortcut or typing started mid-move: stop rather than drift on.
        if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) this.held.clear();
        return;
      }
      this.held.add(code);
      e.preventDefault();
    });
    target.addEventListener('keyup', (e) => {
      this.fast = e.shiftKey;
      this.held.delete(e.code);
    });
    // Keyups never arrive while the window is in the background.
    target.addEventListener('blur', () => this.clear());
  }

  clear() {
    this.held.clear();
    this.fast = false;
  }

  get moving() {
    return this.held.size > 0;
  }

  /** { forward, right, up } for the held keys, scaled by the Shift multiplier. */
  direction() {
    const dir = movementDirection(this.held);
    if (this.fast) for (const axis in dir) dir[axis] *= FAST_MULTIPLIER;
    return dir;
  }
}
