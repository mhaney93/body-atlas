// Keeps the lymphatic parts under the skin and out of solid bone, as
// scripts/check-lymphatic.mjs checks them. The Z-Anatomy lymph nodes are
// fitted onto the BodyParts3D skeleton bone by bone (extract-z-anatomy.py),
// which leaves a few up to ~7 mm into a bone or out through the skin. Each
// node (a connected piece of a part's mesh) is moved as a whole, so it keeps
// its shape: by the deepest vertex's way out, again until nothing is left in
// bone or outside the skin. The spleen and thymus are moved the same way.
//
// Z-Anatomy draws most nodes as spheres about 2.5 mm across, smaller than a
// typical lymph node (about 5-10 mm), so each node smaller than NODE_SIZE is
// first scaled up about its centre to that size.
import { Envelope, Solid } from './solid.mjs';

// mm kept between a part and the skin or a bone surface, so simplification
// afterwards does not bring it back into contact.
const CLEARANCE = 0.8;
const MAX_STEPS = 30;
// mm across a lymph node is drawn at least.
const NODE_SIZE = 6;

/** Vertex index lists of each connected piece of a mesh. */
function pieces(positions, indices) {
  const parent = Array.from({ length: positions.length / 3 }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let t = 0; t < indices.length; t += 3) {
    const a = find(indices[t]);
    parent[find(indices[t + 1])] = a;
    parent[find(indices[t + 2])] = a;
  }
  const byRoot = new Map();
  for (let i = 0; i < parent.length; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(i);
  }
  return [...byRoot.values()];
}

/** Scales a node smaller than NODE_SIZE up about its centre to that size. */
function enlarge(pos, piece, target = NODE_SIZE) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const i of piece)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pos[i * 3 + k]);
      max[k] = Math.max(max[k], pos[i * 3 + k]);
    }
  const size = Math.max(...max.map((v, k) => v - min[k]));
  if (!(size > 0) || size >= target) return size;
  const s = target / size;
  const c = min.map((v, k) => (v + max[k]) / 2);
  for (const i of piece) for (let k = 0; k < 3; k++) pos[i * 3 + k] = c[k] + (pos[i * 3 + k] - c[k]) * s;
  return size;
}

/** Scales a piece about its centre by `s`. */
function rescale(pos, piece, s) {
  const c = [0, 1, 2].map((k) => piece.reduce((sum, i) => sum + pos[i * 3 + k], 0) / piece.length);
  for (const i of piece) for (let k = 0; k < 3; k++) pos[i * 3 + k] = c[k] + (pos[i * 3 + k] - c[k]) * s;
}

/**
 * Enlarges the small nodes, then moves each piece of each part (BodyParts3D mm) so it lies inside `skin`
 * and outside every bone of `bones` (both as built, in mm). Returns how many
 * pieces moved and any piece that could not be freed.
 */
export function settleLymphatic(objs, skin, bones) {
  const envelope = new Envelope(skin.positions, skin.indices, 10, 2.5);
  const solids = bones.map((b) => new Solid(b.positions, b.indices, 4));
  // The strongest way out for one vertex, or null if it is fine.
  const escape = (p) => {
    let best = null;
    const out = envelope.outside(p);
    if (out > 0) {
      const q = envelope.solid.closest(p).point;
      best = q.map((v, k) => p[k] + ((v - p[k]) / out) * (out + CLEARANCE));
    }
    for (const solid of solids) {
      if (!solid.nearBox(p) || !solid.contains(p)) continue;
      const { point: q, distance: d } = solid.closest(p);
      const target = q.map((v, k) => p[k] + ((v - p[k]) / (d || 1)) * (d + CLEARANCE));
      if (!best || d + CLEARANCE > Math.hypot(...best.map((v, k) => v - p[k]))) best = target;
    }
    return best && best.map((v, k) => v - p[k]);
  };
  let moved = 0;
  const stuck = [];
  for (const obj of objs) {
    const pos = obj.positions;
    for (const piece of pieces(pos, obj.indices)) {
      const node = obj.source === 'z-anatomy' && obj.group !== 'organs';
      const original = node ? enlarge(pos, piece) : 0;
      let size = Math.max(original, NODE_SIZE);
      let steps = 0;
      for (; steps < MAX_STEPS; steps++) {
        // A node squeezed between bone and skin (e.g. the occipital nodes
        // under the thin scalp) is shrunk back toward its drawn size.
        if (node && steps === MAX_STEPS - 1 && size > original * 1.01) {
          const next = Math.max(original, size * 0.8);
          rescale(pos, piece, next / size);
          size = next;
          steps = 0;
        }
        let move = null;
        let length = 0;
        for (const i of piece) {
          const m = escape([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
          const l = m ? Math.hypot(...m) : 0;
          if (l > length) [move, length] = [m, l];
        }
        if (!move) break;
        for (const i of piece) for (let k = 0; k < 3; k++) pos[i * 3 + k] += move[k];
      }
      if (steps) moved++;
      if (steps === MAX_STEPS) stuck.push(obj.name);
    }
  }
  return { moved, stuck };
}
