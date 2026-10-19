// Moves a built layer's (already simplified) meshes to where they belong in
// the BodyParts3D body, the way nervous-model.mjs fits the nerves:
// - beneath the skin;
// - out of solid bone, except where the part really lies in that bone
//   (passages.mjs), and there no deeper than the opening runs;
// - out of the other parts it must yield to (overlaps.mjs).
// BodyParts3D's own meshes overlap here and there (a vein above the skin of
// the calf, a tendon sunk into the bone it inserts on), simplification moves
// surfaces by a millimetre or two, and the Z-Anatomy parts were fitted to the
// skeleton bone by bone only. Each vertex that breaks a rule is moved just far
// enough, and the move fades out over the surface around it so the mesh bends
// instead of tearing. An edge that still cuts through a bone between two good
// vertices is split, so its middle can move too. Vertices that share a
// position (a muscle and its tendon along their seam) move and split as one.
// That crumples a thin tube (a vessel lying on a rib), whose sides get
// different moves, so a layer of vessels is first moved by a smooth field
// instead (the `smooth` option, see moveSmoothly), and vertex by vertex only
// where that leaves something wrong.
import { onSkin } from './passages.mjs';
import { allowedDepth, boneTolerance, SKIN_TOLERANCE } from './placement.mjs';

// How far (mm) a moved vertex ends up beneath the skin, outside a bone it
// may not enter, or outside a part it yields to.
const SKIN_CLEARANCE = 0.5;
const BONE_CLEARANCE = 0.3;
const YIELD_CLEARANCE = 0.5;
// A vertex in a bone it has an opening into is moved back to this far above
// the opening's depth; elsewhere only a vertex deeper than this far above the
// tolerance is moved, so the check passes with a margin.
const MARGIN = 0.5;
// A move fades out over this many mm along the surface, plus its own length.
const TAPER = 10;
// An edge is split only where it is this close (mm) to failing the check:
// its ends may sit up to MARGIN short of a limit, and a stricter test would
// split ever-shorter edges for sagittas that do not matter.
const EDGE_MARGIN = 0.2;
// Edges shorter than this (mm) are not split: a chord that short across a
// groove between two bones dips only a fraction of a millimetre.
const MIN_SPLIT = 3;
// Rounds of moving vertices, and of splitting the edges that are still bad.
const MOVES = 6;
const SPLITS = 3;
// The smooth field starts this much finer than the `smooth` option and halves
// this many times, with this many rounds at each scale: wide pulls shift a
// whole stretch of vessel first, and finer ones settle what is left nearer
// its bad points.
const SMOOTH_SCALES = 5;
const SMOOTH_ROUNDS = 8;
// A pull is turned to agree with the pulls around it (see agree) only if
// that way leads out of its bone within EXIT_REACH mm, tested EXIT_STEP mm
// apart.
const EXIT_STEP = 0.5;
const EXIT_REACH = 12;
// Points along each edge are tested at most this far apart (mm), as in
// check-placement.mjs.
const STEP = 1.5;

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const toward = (from, to, distance) => scale(sub(to, from), distance / (len(sub(to, from)) || 1));
const edgeKey = (a, b) => Math.min(a, b) * 4294967296 + Math.max(a, b);

/** Binary min-heap of [key, value] pairs. */
class Heap {
  items = [];

  get size() {
    return this.items.length;
  }

  push(key, value) {
    const a = this.items;
    a.push([key, value]);
    for (let i = a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (l + 1 < a.length && a[l + 1][0] < a[m][0]) m = l + 1;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Settles `parts` in place. Each part keeps its vertices in order (moved ones
 * get new positions); vertices added by splitting edges come after them, and
 * its indices are replaced.
 * @param {{name: string, positions: ArrayLike<number>, indices: ArrayLike<number>}[]} parts mm
 * @param {object} options
 * @param {string} options.layer the parts' layer id (for passages.mjs)
 * @param {import('./placement.mjs').Body} options.body
 * @param {(part: string) => {name: string, solid: import('./solid.mjs').Solid}[]} [options.blockers] parts `part` must stay out of
 * @param {number} [options.smooth] first move the parts by a field this wide (mm), so thin tubes shift whole (see moveSmoothly)
 * @returns {Map<string, number>} the largest move (mm) of each part that moved
 */
export function settle(parts, { layer, body, blockers = () => [], smooth }) {
  // Weld vertices by position so seams between meshes move as one.
  const ids = new Map();
  const pos = [];
  const names = [];
  const local = parts.map((part) => {
    const out = new Int32Array(part.positions.length / 3);
    for (let v = 0; v < out.length; v++) {
      const p = [part.positions[v * 3], part.positions[v * 3 + 1], part.positions[v * 3 + 2]];
      const key = p.map((x) => x.toFixed(3)).join(',');
      let id = ids.get(key);
      if (id === undefined) {
        id = pos.length;
        ids.set(key, id);
        pos.push(p);
        names.push(new Set());
      }
      names[id].add(part.name);
      out[v] = id;
    }
    return out;
  });
  const start = pos.map((p) => [...p]);
  let tris = parts.map((part, pi) => Array.from(part.indices, (i) => local[pi][i]));

  const blocking = new Map();
  const blockersOf = (own) => {
    const key = [...own].join('\n');
    if (!blocking.has(key)) blocking.set(key, [...new Map([...own].flatMap((n) => blockers(n)).map((b) => [b.name, b])).values()]);
    return blocking.get(key);
  };
  // A part on the skin (ON_SKIN) is moved in only where it sticks out further
  // than it may; everything else wherever it is outside.
  const skinCache = new Map();
  const skinLimit = (own, edge) => {
    const key = [...own].join('\n');
    if (!skinCache.has(key)) skinCache.set(key, Math.max(0, ...[...own].map((n) => onSkin(layer, n)?.depth ?? 0)));
    const depth = skinCache.get(key);
    if (depth) return depth - (edge ? EDGE_MARGIN : MARGIN);
    return edge ? SKIN_TOLERANCE - EDGE_MARGIN : 0;
  };
  const allowedCache = new Map();
  const allowed = (own, bone) => {
    const key = `${[...own].join('\n')}\t${bone}`;
    if (!allowedCache.has(key)) allowedCache.set(key, Math.max(...[...own].map((n) => allowedDepth(layer, n, bone))));
    return allowedCache.get(key);
  };

  /**
   * The move that puts point `p` of the parts named in `own` right (zero if
   * it is fine). With `edge`, only a point near failing the check counts.
   * With `smooth`, a point in a bone it has no opening into goes back only
   * to within the tolerance, not right out of the bone: a vessel lying on a
   * rib needs to move less, so it is less often pushed into the next bone.
   * Also gives the bone that set the move, if a bone did.
   */
  const fixFrom = (p, own, edge = false) => {
    let move = [0, 0, 0];
    let from = null;
    const longer = (m, bone = null) => {
      if (len(m) > len(move)) [move, from] = [m, bone];
    };
    for (const hit of body.bonesAt(p)) {
      const depth = allowed(own, hit.bone);
      if (hit.depth <= depth - (edge ? EDGE_MARGIN : MARGIN)) continue;
      // Out of the bone, or back to within its opening.
      longer(toward(p, hit.point, hit.depth - target(depth)), hit.bone);
    }
    for (const b of blockersOf(own)) {
      if (!b.solid.nearBox(p) || !b.solid.contains(p)) continue;
      const near = b.solid.closest(p);
      longer(toward(p, near.point, near.distance + YIELD_CLEARANCE));
    }
    const q = add(p, move);
    const out = body.outside(q);
    if (out > skinLimit(own, edge)) move = add(move, toward(q, body.skin.depth(q).point, out + SKIN_CLEARANCE));
    return { move, bone: from };
  };
  const fix = (p, own, edge = false) => fixFrom(p, own, edge).move;
  /** How deep (mm) a moved point ends up in a bone it may go `depth` into (negative: outside it). */
  const target = (depth) => (smooth || depth > boneTolerance(layer) ? depth - 2 * MARGIN : -BONE_CLEARANCE);

  const adjacency = () => {
    const adj = pos.map(() => []);
    for (const t of tris)
      for (let i = 0; i < t.length; i += 3)
        for (let e = 0; e < 3; e++) {
          const [a, b] = [t[i + e], t[i + ((e + 1) % 3)]];
          if (a !== b) adj[a].push(b);
        }
    return adj;
  };

  /** Moves bad vertices in `todo` (and, fading out, their neighbours); returns all that moved. */
  const moveVertices = (todo) => {
    const adj = adjacency();
    const changed = new Set();
    let check = todo;
    for (let round = 0; round < MOVES && check.length; round++) {
      const moves = new Map();
      for (const id of check) {
        const m = fix(pos[id], names[id]);
        if (len(m) > 0) moves.set(id, m);
      }
      if (!moves.size) break;
      // Each vertex takes the strongest nearby move, scaled down with
      // distance along the surface; a bad vertex takes its own.
      const applied = new Map(moves);
      for (const [id, move] of moves) {
        const reach = TAPER + len(move);
        const dist = new Map([[id, 0]]);
        const queue = new Heap();
        queue.push(0, id);
        while (queue.size) {
          const [d, v] = queue.pop();
          if (d > dist.get(v)) continue;
          const w = 1 - d / reach;
          if (!moves.has(v) && len(applied.get(v) ?? [0, 0, 0]) < len(move) * w) applied.set(v, scale(move, w));
          for (const n of adj[v]) {
            const nd = d + len(sub(pos[n], pos[v]));
            if (nd >= reach || nd >= (dist.get(n) ?? Infinity)) continue;
            dist.set(n, nd);
            queue.push(nd, n);
          }
        }
      }
      check = [];
      for (const [id, m] of applied) {
        // A good vertex only follows its neighbours' move if that keeps it good.
        if (!moves.has(id) && len(fix(add(pos[id], m), names[id])) > 0) continue;
        pos[id] = add(pos[id], m);
        changed.add(id);
        check.push(id);
      }
    }
    return changed;
  };

  /**
   * Splits every edge with a bad point between its two good ends (only edges with an
   * end in `near`, if given); returns the vertices it added or cut between.
   */
  const splitEdges = (near) => {
    const mid = new Map();
    const touched = new Set();
    for (const t of tris)
      for (let i = 0; i < t.length; i += 3)
        for (let e = 0; e < 3; e++) {
          const [a, b] = [t[i + e], t[i + ((e + 1) % 3)]];
          const key = edgeKey(a, b);
          if (mid.has(key)) continue;
          mid.set(key, -1);
          if (near && !near.has(a) && !near.has(b)) continue;
          const n = Math.ceil(len(sub(pos[b], pos[a])) / STEP);
          const own = new Set([...names[a]].filter((x) => names[b].has(x)));
          if (!own.size || n < 2 || len(sub(pos[b], pos[a])) < MIN_SPLIT) continue;
          // A bad end is for moveVertices; splitting next to it would only
          // make more edges that start at a bad point.
          if (len(fix(pos[a], names[a])) > 0 || len(fix(pos[b], names[b])) > 0) continue;
          for (let s = 1; s < n; s++)
            if (len(fix(add(pos[a], scale(sub(pos[b], pos[a]), s / n)), own, true)) > 0) {
              mid.set(key, pos.length);
              touched.add(a).add(b).add(pos.length);
              pos.push(scale(add(pos[a], pos[b]), 0.5));
              names.push(own);
              break;
            }
        }
    // Each triangle is cut along its split edges (1, 2 or 3 of them).
    tris = tris.map((t) => {
      const out = [];
      for (let i = 0; i < t.length; i += 3) {
        const v = [t[i], t[i + 1], t[i + 2]];
        const m = [0, 1, 2].map((e) => mid.get(edgeKey(v[e], v[(e + 1) % 3])) ?? -1);
        const cuts = m.filter((x) => x >= 0).length;
        if (!cuts) out.push(...v);
        else if (cuts === 3) out.push(v[0], m[0], m[2], m[0], v[1], m[1], m[2], m[1], v[2], m[0], m[1], m[2]);
        else {
          // Rotate so the (first) split edge runs from a to b.
          const r = m.findIndex((x, e) => x >= 0 && (cuts === 1 || m[(e + 1) % 3] >= 0));
          const [a, b, c] = [v[r], v[(r + 1) % 3], v[(r + 2) % 3]];
          const [ab, bc] = [m[r], m[(r + 1) % 3]];
          if (cuts === 1) out.push(a, ab, c, ab, b, c);
          else out.push(a, ab, c, ab, b, bc, ab, bc, c);
        }
      }
      return out;
    });
    return touched;
  };

  /**
   * Turns the pulls out of a bone that go against the pulls around them.
   * Each point is pulled to the bone surface nearest it, so a vessel cutting
   * through a bone's edge (the right suprascapular vein through the
   * clavicle) was pulled up on one side and down on the other: the pulls
   * cancelled, then pulled its sides apart, and it crumpled. A pull out of a
   * bone that points against the pulls out of the same bone within `smooth`
   * mm (weighted as in the field) is turned their way instead, so the
   * vessel leaves the bone all on one side. `past` keeps the
   * pulls of earlier rounds too, so the way does not flip from round to
   * round as the points still in the bone change.
   */
  const agree = (pulls, past) => {
    const cell = (p) => p.map((x) => Math.floor(x / smooth));
    const now = pulls.filter((pull) => pull.bone);
    for (const pull of now) {
      const key = cell(pull.p).join(',');
      if (!past.has(key)) past.set(key, []);
      past.get(key).push({ ...pull });
    }
    const turned = [];
    for (const pull of now) {
      const [x, y, z] = cell(pull.p);
      let way = [0, 0, 0];
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++)
            for (const other of past.get(`${x + dx},${y + dy},${z + dz}`) ?? []) {
              const d = len(sub(pull.p, other.p));
              if (other.bone !== pull.bone || d >= smooth || ![...other.own].some((n) => pull.own.has(n))) continue;
              way = add(way, scale(other.m, (1 - (d / smooth) ** 2) ** 2));
            }
      if (dot(way, pull.m) >= 0) continue;
      // Only where that way leads out through the bone within EXIT_REACH mm
      // (the vessel crosses an edge of it), and no further than the pull
      // went: pulled far through a thick bone, a vessel was dragged along it.
      const unit = scale(way, 1 / len(way));
      const limit = target(allowed(pull.own, pull.bone));
      for (let s = EXIT_STEP; s <= EXIT_REACH; s += EXIT_STEP)
        if (body.bonesAt(add(pull.p, scale(unit, s))).every((hit) => hit.bone !== pull.bone || hit.depth <= limit)) {
          turned.push([pull, scale(unit, Math.min(s, len(pull.m)))]);
          break;
        }
    }
    for (const [pull, m] of turned) pull.m = m;
  };

  /**
   * Moves the parts by a smooth displacement field rather than vertex by
   * vertex: every bad point (a vertex, or a point along an edge as
   * check-placement.mjs samples it) pulls the vertices of its own parts within
   * `radius` mm of it toward its fix, weighted down with distance in space.
   * A vertex takes the weighted average of its pulls, faded by the strongest
   * one. A vessel is much narrower than the field, so its cross-section moves
   * as one and it bends instead of crumpling. Returns the vertices still bad.
   */
  const moveSmoothly = () => {
    let check = pos.map((_, id) => id);
    const past = new Map();
    for (let round = 0; round < SMOOTH_SCALES * SMOOTH_ROUNDS; round++) {
      const radius = smooth / 2 ** Math.floor(round / SMOOTH_ROUNDS);
      const cell = (p) => p.map((x) => Math.floor(x / radius));
      // The bad points among (and on the edges of) what moved last round.
      const looking = new Set(check);
      const pulls = [];
      for (const id of check) {
        const { move: m, bone } = fixFrom(pos[id], names[id]);
        if (len(m) > 0) pulls.push({ p: pos[id], m, own: names[id], bone });
      }
      const seen = new Set();
      for (const t of tris)
        for (let i = 0; i < t.length; i += 3)
          for (let e = 0; e < 3; e++) {
            const [a, b] = [t[i + e], t[i + ((e + 1) % 3)]];
            const key = edgeKey(a, b);
            if (seen.has(key) || (!looking.has(a) && !looking.has(b))) continue;
            seen.add(key);
            const own = new Set([...names[a]].filter((x) => names[b].has(x)));
            const n = Math.ceil(len(sub(pos[b], pos[a])) / STEP);
            if (!own.size) continue;
            for (let s = 1; s < n; s++) {
              const p = add(pos[a], scale(sub(pos[b], pos[a]), s / n));
              const { move: m, bone } = fixFrom(p, own, true);
              if (len(m) > 0) pulls.push({ p, m, own, bone });
            }
          }
      if (!pulls.length) return [];
      agree(pulls, past);
      const grid = new Map();
      for (const pull of pulls) {
        const key = cell(pull.p).join(',');
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(pull);
      }
      const moves = new Map();
      pos.forEach((p, id) => {
        const [x, y, z] = cell(p);
        let sum = [0, 0, 0];
        let total = 0;
        let strongest = 0;
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dz = -1; dz <= 1; dz++)
              for (const pull of grid.get(`${x + dx},${y + dy},${z + dz}`) ?? []) {
                const d = len(sub(p, pull.p));
                if (d >= radius || ![...pull.own].some((n) => names[id].has(n))) continue;
                const w = (1 - (d / radius) ** 2) ** 2;
                sum = add(sum, scale(pull.m, w));
                total += w;
                strongest = Math.max(strongest, w);
              }
        if (total > 0) moves.set(id, scale(sum, strongest / total));
      });
      for (const [id, m] of moves) pos[id] = add(pos[id], m);
      check = [...moves.keys()];
    }
    return check.filter((id) => len(fix(pos[id], names[id])) > 0);
  };

  // After the first round, look again only around what moved or was split.
  let todo = smooth ? moveSmoothly() : pos.map((_, id) => id);
  let near = null;
  for (let round = 0; round <= SPLITS; round++) {
    const changed = moveVertices(todo);
    if (round === SPLITS) break;
    if (near) for (const id of changed) near.add(id);
    const touched = splitEdges(near);
    if (!touched.size) break;
    const adj = adjacency();
    near = new Set(touched);
    for (const id of touched) for (const n of adj[id]) near.add(n);
    todo = [...near];
  }

  // Write back: each part keeps its own vertices and gains the split ones it uses.
  const moved = new Map();
  parts.forEach((part, pi) => {
    const index = new Map();
    const positions = Array.from(part.positions);
    local[pi].forEach((id, v) => {
      if (!index.has(id)) index.set(id, v);
      const d = len(sub(pos[id], start[id]));
      if (d > 0) {
        moved.set(part.name, Math.max(moved.get(part.name) ?? 0, d));
        positions.splice(v * 3, 3, ...pos[id]);
      }
    });
    part.indices = tris[pi].map((id) => {
      if (!index.has(id)) {
        index.set(id, positions.length / 3);
        positions.push(...pos[id]);
        if (!moved.has(part.name)) moved.set(part.name, 0);
      }
      return index.get(id);
    });
    part.positions = positions;
  });
  return moved;
}
