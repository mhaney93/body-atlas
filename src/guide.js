// The Guide: steps through every part of a body system in turn, head to toe,
// selecting each as a click would, so you can read the whole system with the
// → key without hunting for parts. The stepping itself is the reusable
// Stepper (src/stepper.js); this module decides the order and adds the
// "Guide" button under each layer's toggle.
import { sideOf, sidelessName } from './search.js';

const SIDES = { left: 0, right: 1 };
/** Heights are compared to the millimetre, so float noise never reorders parts. */
const mm = (metres) => Math.round(metres * 1000);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The order the Guide visits a layer's parts in: top to bottom by the height
 * of each part's centre, with a paired part's left and right sides one after
 * the other (at their average height), left first. Ties go by name, so the
 * same parts always come out in the same order whatever order they came in.
 * @template {{ meshName: string, center: { y: number } }} P
 * @param {P[]} parts every clickable part of the layer (Viewer.partCenters)
 * @returns {P[]}
 */
export function guideOrder(parts) {
  const pairs = new Map();
  for (const part of parts) {
    const side = sideOf(part.meshName);
    const key = side ? sidelessName(part.meshName) : part.meshName;
    if (!pairs.has(key)) pairs.set(key, { key, parts: [] });
    pairs.get(key).parts.push({ part, side });
  }
  const groups = [...pairs.values()].map((g) => ({
    ...g,
    y: mm(g.parts.reduce((sum, { part }) => sum + part.center.y, 0) / g.parts.length),
  }));
  groups.sort((a, b) => b.y - a.y || byText(a.key, b.key));
  return groups.flatMap((g) =>
    g.parts
      .sort((a, b) => (SIDES[a.side] ?? -1) - (SIDES[b.side] ?? -1) || byText(a.part.meshName, b.part.meshName))
      .map(({ part }) => part),
  );
}

/**
 * The "Guide" button for one layer, shown under its toggle. It starts the
 * shared `stepper` on the layer's parts (loading the model first if needed)
 * and, pressed again, ends it.
 * @param {import('./viewer.js').Viewer} viewer
 * @param {object} layer
 * @param {import('./stepper.js').Stepper} stepper items are `{ layerId, meshName, center }`
 * @param {{ onStart?: () => void }} [host] `onStart` runs just before the guide starts
 * @returns {{ element: HTMLButtonElement, stop: () => void }} call stop() when the layer is hidden
 */
export function guideControls(viewer, layer, stepper, { onStart } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tour-button guide-button';
  button.style.setProperty('--layer-color', layer.color);
  button.title = 'Step through every part of this system, top to bottom (← → to move, Esc to end)';
  const mine = () => stepper.active && stepper.current.layerId === layer.id;
  const label = () => (button.textContent = mine() ? '■ End guide' : '☰ Guide');
  label();
  stepper.subscribe(label);
  /** Set while the model loads; stop() clears it, so a guide on a layer switched off meanwhile never starts. */
  let starting = false;

  button.addEventListener('click', async () => {
    if (mine()) return stepper.stop();
    if (starting) return;
    starting = true;
    try {
      await viewer.preloadLayer(layer);
    } catch (err) {
      console.error(err);
      starting = false;
      return;
    }
    if (!starting) return;
    starting = false;
    const parts = guideOrder(viewer.partCenters(layer.id)).map((p) => ({ ...p, layerId: layer.id }));
    onStart?.();
    stepper.start(parts);
  });
  return {
    element: button,
    stop() {
      starting = false;
      if (mine()) stepper.stop();
    },
  };
}
