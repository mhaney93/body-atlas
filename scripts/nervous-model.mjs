// Builds the Nervous layer's meshes from the Z-Anatomy extract in
// data-sources/z-anatomy/nervous/ (written by scripts/extract-z-anatomy.py).
//
// Z-Anatomy derives from BodyParts3D but its skeleton is not in exactly the
// same place (it is symmetrised and posed slightly differently, by up to
// ~2 cm in the arms), so a single offset would leave nerves outside bones and
// skin. Instead each landmark bone in landmarks.json is fitted rigidly (ICP)
// to the same BodyParts3D bone, and:
// - the brain moves with the transform fitted to the whole cranium;
// - every other point moves with a distance-weighted blend of the transforms
//   of the bones nearest to it, like skinning a mesh to a skeleton.
// That fit is rigid per bone, and the two models' bones and soft tissue differ
// in shape, so it still left superficial nerves up to 1 cm outside the
// BodyParts3D skin and some nerves running through solid bone (the vagus
// through the thoracic vertebrae, the intercostals through the sternum). So
// a last, local step (fitLine, fitPoints) pushes each nerve back under the skin and
// out of any bone it has no real opening through (nerve-passages.mjs), and
// fades the push out along the nerve so it bends smoothly.
// Nerves, which Z-Anatomy stores as bevelled curves, become tubes here.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { passage } from './nerve-passages.mjs';
import { Envelope, Solid } from './solid.mjs';

const CRANIUM = ['Frontal bone', 'Occipital bone', 'Left parietal bone', 'Right parietal bone', 'Left temporal bone', 'Right temporal bone'];
// Meshes that move with the cranium as one rigid body.
const BRAIN = /lobe|insula|cerebellum|brainstem|optic chiasm|optic tract/i;

// Tube radius in mm for a Z-Anatomy radius (also mm). Z-Anatomy draws most
// nerves at 0.5 mm; they are thickened so they stay visible as threads.
const tubeRadius = (r) => Math.min(2.6, 0.7 + r * 0.9);
const TUBE_SIDES = 6;

// How far (mm) the tube surface is kept beneath the outer skin surface, and
// clear of bone it does not pass through. The tube may graze bone by up to
// BONE_GRAZE mm less BONE_CLEARANCE, which does not show, so thick nerves
// still fit through narrow gaps (the brachial plexus roots over the first rib).
const SKIN_CLEARANCE = 0.6;
const BONE_CLEARANCE = 0.3;
const BONE_GRAZE = 1;
const boneClearance = (radius) => Math.max(0, radius - BONE_GRAZE) + BONE_CLEARANCE;
// Mesh surfaces (brain, cord, ganglia) keep the clearance of a tube this
// thick (mm), which covers their simplification after the fit.
const MESH_RADIUS = 1.5;
// Arc length (mm) over which a move fades out along a nerve.
const TAPER = 15;
// A point counts as in a canal through a bone if rays along four of the six
// axis directions hit that bone within this many mm.
const ENCLOSED_WITHIN = 12;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => scale(a, 1 / (Math.hypot(...a) || 1));
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const centroid = (pts) => scale(pts.reduce(add, [0, 0, 0]), 1 / pts.length);
const apply = ({ R, t }, p) => [
  R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0],
  R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1],
  R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2],
];

/** Uniform grid for nearest-point queries over [x, y, z, tag?] points. */
class Grid {
  constructor(points, cell = 8) {
    this.cell = cell;
    this.map = new Map();
    for (const p of points) {
      const k = this.#key(p);
      if (!this.map.has(k)) this.map.set(k, []);
      this.map.get(k).push(p);
    }
  }

  #key(p) {
    return `${Math.floor(p[0] / this.cell)},${Math.floor(p[1] / this.cell)},${Math.floor(p[2] / this.cell)}`;
  }

  /** All points within the cube of half-size `r` around `p`. */
  near(p, r) {
    const out = [];
    const lo = p.map((v) => Math.floor((v - r) / this.cell));
    const hi = p.map((v) => Math.floor((v + r) / this.cell));
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++) {
          const bucket = this.map.get(`${x},${y},${z}`);
          if (bucket) for (const q of bucket) out.push(q);
        }
    return out;
  }

  nearest(p) {
    for (let r = this.cell; ; r *= 2) {
      let best = null;
      let bestD = Infinity;
      for (const q of this.near(p, r)) {
        const d = dist2(p, q);
        if (d < bestD) [best, bestD] = [q, d];
      }
      // Only trust a hit that is no farther than the searched cube's half-size.
      if (best && Math.sqrt(bestD) <= r) return best;
      if (r > 4000) return best;
    }
  }
}

/** Eigenvector of the largest eigenvalue of a symmetric 4×4 matrix (Jacobi). */
function topEigenvector(m) {
  const a = m.map((row) => [...row]);
  const v = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < 4; p++)
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i;
  return v.map((row) => row[best]);
}

/** Least-squares rigid transform taking points `a` onto `b` (Horn's method). */
function rigidFit(a, b) {
  const ca = centroid(a);
  const cb = centroid(b);
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < a.length; i++) {
    const p = sub(a[i], ca);
    const q = sub(b[i], cb);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r * 3 + c] += p[r] * q[c];
  }
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = S;
  const [w, x, y, z] = topEigenvector([
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ]);
  const R = [
    w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z,
  ];
  return { R, t: sub(cb, apply({ R, t: [0, 0, 0] }, ca)) };
}

/** Rigidly registers `src` points onto the `dst` point cloud (trimmed ICP). */
function icp(src, dst) {
  const grid = new Grid(dst, 6);
  let T = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: sub(centroid(dst), centroid(src)) };
  let rms = Infinity;
  for (let iter = 0; iter < 60; iter++) {
    const moved = src.map((p) => apply(T, p));
    const pairs = moved.map((p, i) => ({ i, q: grid.nearest(p), d: 0 }));
    for (const pr of pairs) pr.d = dist2(moved[pr.i], pr.q);
    // Ignore the worst 20% of matches: the two models split some bones differently.
    const kept = [...pairs].sort((m, n) => m.d - n.d).slice(0, Math.ceil(pairs.length * 0.8));
    const next = Math.sqrt(kept.reduce((s, pr) => s + pr.d, 0) / kept.length);
    T = rigidFit(
      kept.map((pr) => src[pr.i]),
      kept.map((pr) => pr.q),
    );
    if (Math.abs(rms - next) < 1e-4) break;
    rms = next;
  }
  return { ...T, rms };
}

function pointsOf(positions) {
  const out = [];
  for (let i = 0; i < positions.length; i += 3) out.push([positions[i], positions[i + 1], positions[i + 2]]);
  return out;
}

/** Fits every landmark bone and returns functions mapping Z-Anatomy mm → BodyParts3D mm. */
function buildWarp(landmarks, bp3dBones) {
  const bones = [];
  for (const [name, pts] of Object.entries(landmarks)) {
    const target = bp3dBones.get(name);
    if (!target) throw new Error(`Landmark bone "${name}" is not in BodyParts3D`);
    const src = pts.map((p) => scale(p, 1000));
    bones.push({ name, src, T: icp(src, pointsOf(target.positions)) });
  }
  const worst = [...bones].sort((a, b) => b.T.rms - a.T.rms).slice(0, 3);
  console.log(`  fitted ${bones.length} landmark bones; worst RMS: ${worst.map((b) => `${b.name} ${b.T.rms.toFixed(2)} mm`).join(', ')}`);

  const cranium = bones.filter((b) => CRANIUM.includes(b.name));
  const craniumT = icp(
    cranium.flatMap((b) => b.src),
    cranium.flatMap((b) => b.src.map((p) => apply(b.T, p))),
  );

  const samples = new Grid(
    bones.flatMap((b, i) => b.src.map((p) => [...p, i])),
    20,
  );
  const FALLOFF = 40; // mm beyond the nearest bone over which others still count

  function blended(p) {
    let r = 40;
    let near;
    for (;;) {
      near = samples.near(p, r);
      if (near.length) {
        const dmin = Math.sqrt(Math.min(...near.map((q) => dist2(p, q))));
        if (r >= dmin + FALLOFF) break;
      }
      r *= 2;
    }
    const perBone = new Map();
    for (const q of near) {
      const d = dist2(p, q);
      if (!(perBone.get(q[3]) <= d)) perBone.set(q[3], d);
    }
    const dmin = Math.sqrt(Math.min(...perBone.values()));
    let sum = 0;
    let out = [0, 0, 0];
    for (const [i, d2] of perBone) {
      const d = Math.sqrt(d2);
      const fall = Math.max(0, 1 - (d - dmin) / FALLOFF) ** 2;
      if (!fall) continue;
      const w = fall / Math.max(d, 2) ** 2;
      out = add(out, scale(apply(bones[i].T, p), w));
      sum += w;
    }
    return scale(out, 1 / sum);
  }

  return { cranium: (p) => apply(craniumT, p), blended };
}

// Directions tried when moving a point out of bone (a Fibonacci sphere).
const ESCAPE_DIRS = Array.from({ length: 42 }, (_, i) => {
  const y = 1 - (2 * i + 1) / 42;
  const r = Math.sqrt(1 - y * y);
  const a = i * Math.PI * (3 - Math.sqrt(5));
  return [Math.cos(a) * r, y, Math.sin(a) * r];
});

/**
 * Moves that keep nerves where they belong in the BodyParts3D body: beneath
 * the skin, and out of every bone they have no real passage through
 * (nerve-passages.mjs). Radii are the tube radii in mm.
 */
function bodyConstraints(skinMesh, solids) {
  const skin = new Envelope(skinMesh.positions, skinMesh.indices, 10, 2.5);
  const allBones = [...solids].map(([name, solid]) => ({ name, solid }));
  const blockers = new Map();
  const bonesFor = (part) => {
    if (!blockers.has(part)) blockers.set(part, allBones.filter((b) => !passage(part, b.name)));
    return blockers.get(part);
  };
  const underSkin = (q, deep) => {
    const s = skin.depth(q, deep);
    return !s || s.depth >= deep;
  };
  const inBone = (q, bones) => bones.some((b) => b.solid.nearBox(q) && b.solid.contains(q));
  // In a hole through a bone, such as a vertebral canal: rays along most of
  // the six axis directions hit that one bone close by.
  const enclosed = (q, bones) =>
    bones.some((b) => b.solid.nearBox(q) && b.solid.rayHits(q, ENCLOSED_WITHIN).filter(Boolean).length >= 4);

  return {
    inBone: (p, part) => inBone(p, bonesFor(part)),

    /**
     * Moves a run of consecutive points that lie in bone out of it, all in
     * one direction so the nerve stays on one side of the bone. Bones touch
     * (vertebrae and disks, say), so the way out must clear all of them, and
     * it must not end in a canal or above the skin. Given an `inward` point
     * (a mesh's centre), it leaves only toward it, so a brain surface stays
     * inside the skull. Returns one move per point, or null.
     */
    escape(points, radii, part, inward) {
      const bones = bonesFor(part);
      for (const needSkin of [true, false]) {
        let best = null;
        let bestCost = 40;
        for (const d of ESCAPE_DIRS) {
          if (inward && points.some((p) => dot(d, sub(inward, p)) <= 0)) continue;
          const ts = [];
          for (const [i, p] of points.entries()) {
            const deep = radii[i] + SKIN_CLEARANCE;
            let t = 0.5;
            for (; t <= bestCost; t += 0.5) {
              const q = add(p, scale(d, t));
              if (!inBone(q, bones) && !enclosed(q, bones) && (!needSkin || underSkin(q, deep))) break;
            }
            if (t > bestCost) break;
            ts.push(t);
          }
          if (ts.length < points.length) continue;
          [best, bestCost] = [{ d, ts }, Math.max(...ts)];
        }
        if (best) return points.map((_, i) => scale(best.d, best.ts[i] + boneClearance(radii[i])));
      }
      return null;
    },

    /** Moves a point that is not in bone beneath the skin and clear of bone surfaces, or null. */
    settle(p, radius, part) {
      const deep = radius + SKIN_CLEARANCE;
      const clear = boneClearance(radius);
      let move = null;
      const s = skin.depth(p, deep);
      if (s && s.depth < deep) {
        // Inside, step away from the nearest skin point; outside, toward it.
        const dir = s.depth > 0 ? norm(sub(p, s.point)) : norm(sub(s.point, p));
        move = scale(dir, deep - s.depth);
      }
      for (const bone of bonesFor(part)) {
        if (!bone.solid.nearBox(p, clear)) continue;
        const near = bone.solid.closest(p, null, clear);
        if (!near.point || near.distance >= clear) continue;
        const step = add(move ?? [0, 0, 0], scale(norm(sub(p, near.point)), clear - near.distance));
        // Clearing a bone never takes priority over staying under the skin.
        if (underSkin(add(p, step), deep)) move = step;
      }
      return move;
    },
  };
}

const DENSE_STEP = 1.5;

/** Inserts points so a polyline of [x, y, z, r] points has no segment longer than `step` mm. */
function densify(line, step = DENSE_STEP) {
  const out = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    const n = Math.ceil(Math.sqrt(dist2(a, b)) / step);
    for (let k = 1; k <= n; k++) out.push(a.map((v, j) => v + ((b[j] - v) * k) / n));
  }
  return out;
}

/**
 * Moves a polyline of [x, y, z, r] points (mm) to satisfy `body`, fading
 * each move out along the nerve so it bends smoothly. It is densified first,
 * and again wherever the moves pulled neighbours apart, so no straight
 * segment between checked points can cut through bone or skin.
 */
function fitLine(line, part, body) {
  let pts = line;
  for (let pass = 0; pass < 3; pass++) {
    pts = densify(pts);
    fitPoints(pts, part, body);
    if (pts.every((p, i) => !i || dist2(p, pts[i - 1]) <= DENSE_STEP ** 2 * 4)) break;
  }
  return pts;
}

function fitPoints(pts, part, body) {
  for (let iter = 0; iter < 20; iter++) {
    const at = (i) => pts[i].slice(0, 3);
    const radius = (i) => tubeRadius(pts[i][3]);
    const moves = pts.map(() => null);
    for (let i = 0; i < pts.length; ) {
      if (!body.inBone(at(i), part)) {
        moves[i] = body.settle(at(i), radius(i), part);
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < pts.length && body.inBone(at(j + 1), part)) j++;
      const run = Array.from({ length: j - i + 1 }, (_, k) => i + k);
      body.escape(run.map(at), run.map(radius), part)?.forEach((m, k) => (moves[i + k] = m));
      i = j + 1;
    }
    if (!moves.some(Boolean)) break;
    const arc = [0];
    for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1] + Math.sqrt(dist2(pts[i], pts[i - 1])));
    // Each point takes the strongest nearby move, scaled down with distance along the nerve.
    const applied = pts.map((_, i) => {
      let best = [0, 0, 0];
      let bestLen = 0;
      for (let j = i; j >= 0 && arc[i] - arc[j] < TAPER; j--) [best, bestLen] = strongest(best, bestLen, moves[j], 1 - (arc[i] - arc[j]) / TAPER);
      for (let j = i + 1; j < pts.length && arc[j] - arc[i] < TAPER; j++) [best, bestLen] = strongest(best, bestLen, moves[j], 1 - (arc[j] - arc[i]) / TAPER);
      return best;
    });
    pts.forEach((p, i) => p.splice(0, 3, ...add(p, applied[i])));
  }
}

function strongest(best, bestLen, move, weight) {
  if (!move) return [best, bestLen];
  const len = Math.hypot(...move) * weight;
  return len > bestLen ? [scale(move, weight), len] : [best, bestLen];
}

/** Parallel-transport tube around a polyline of [x, y, z, r] points (mm). */
function tube(line, positions, indices) {
  const pts = line.map((p) => p.slice(0, 3));
  const n = pts.length;
  const tangents = pts.map((_, i) => norm(sub(pts[Math.min(i + 1, n - 1)], pts[Math.max(i - 1, 0)])));
  let normal = norm(cross(tangents[0], Math.abs(tangents[0][2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
  const base = positions.length / 3;
  for (let i = 0; i < n; i++) {
    const t = tangents[i];
    normal = norm(sub(normal, scale(t, dot(normal, t))));
    const binormal = cross(t, normal);
    const r = tubeRadius(line[i][3]);
    for (let k = 0; k < TUBE_SIDES; k++) {
      const a = (k / TUBE_SIDES) * Math.PI * 2;
      const off = add(scale(normal, Math.cos(a) * r), scale(binormal, Math.sin(a) * r));
      positions.push(...add(pts[i], off));
    }
  }
  for (let i = 0; i + 1 < n; i++)
    for (let k = 0; k < TUBE_SIDES; k++) {
      const a = base + i * TUBE_SIDES + k;
      const b = base + i * TUBE_SIDES + ((k + 1) % TUBE_SIDES);
      indices.push(a, a + TUBE_SIDES, b, b, a + TUBE_SIDES, b + TUBE_SIDES);
    }
  // Close both ends with a centre vertex each.
  for (const [i, flip] of [[0, true], [n - 1, false]]) {
    const c = positions.length / 3;
    positions.push(...pts[i]);
    for (let k = 0; k < TUBE_SIDES; k++) {
      const a = base + i * TUBE_SIDES + k;
      const b = base + i * TUBE_SIDES + ((k + 1) % TUBE_SIDES);
      indices.push(...(flip ? [c, b, a] : [c, a, b]));
    }
  }
}

/**
 * Drops polyline points while keeping the line within `tol` mm of every
 * original point (Douglas-Peucker), and its radius within 0.2 mm.
 */
function thin(line, tol = 0.4) {
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [a, c] = [line[i], line[j]];
    const ac = sub(c, a);
    const len2 = dot(ac, ac) || 1;
    let worst = -1;
    let worstOff = 0;
    for (let k = i + 1; k < j; k++) {
      const t = Math.max(0, Math.min(1, dot(sub(line[k], a), ac) / len2));
      const off = Math.sqrt(dist2(line[k], add(a, scale(ac, t))));
      const r = a[3] + (c[3] - a[3]) * t;
      // Weigh a radius change like an offset of tol / 0.2 mm.
      const err = Math.max(off, (Math.abs(line[k][3] - r) * tol) / 0.2);
      if (err > worstOff) [worst, worstOff] = [k, err];
    }
    if (worst >= 0 && worstOff > tol) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

const sideName = (side, name) => (side ? `${side} ${name[0].toLowerCase()}${name.slice(1)}` : name);

/**
 * Returns the nervous system as parts shaped like build-models' parseObj
 * output ({ name, positions, indices } in BodyParts3D millimetres).
 * @param {string} dir data-sources/z-anatomy/nervous
 * @param {Map<string, {name: string, positions: number[], indices: number[]}>} bp3dBones BodyParts3D bones by English name
 * @param {{positions: number[], indices: number[]}} skin the BodyParts3D skin as shown (simplified)
 * @param {{name: string, positions: number[], indices: number[]}[]} shownBones the bones as shown (simplified)
 * @param {(path: string) => object} parseObj
 */
export function loadNervous(dir, bp3dBones, skin, shownBones, parseObj) {
  const solids = new Map(shownBones.map((b) => [b.name, new Solid(b.positions, b.indices, 4)]));
  const warp = buildWarp(JSON.parse(readFileSync(join(dir, 'landmarks.json'), 'utf8')), bp3dBones);
  const body = bodyConstraints(skin, solids);
  const parts = [];

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.obj')).sort()) {
    const obj = parseObj(join(dir, file));
    const map = BRAIN.test(obj.name) ? warp.cranium : warp.blended;
    const warped = pointsOf(obj.positions).map((p) => map(scale(p, 1000)));
    const centre = centroid(warped);
    const positions = [];
    for (let p of warped) {
      // Mesh surfaces (brain, cord, ganglia) are moved vertex by vertex.
      for (let iter = 0; iter < 4; iter++) {
        const move = body.inBone(p, obj.name) ? body.escape([p], [MESH_RADIUS], obj.name, centre)?.[0] : body.settle(p, MESH_RADIUS, obj.name);
        if (!move) break;
        p = add(p, move);
      }
      positions.push(...p);
    }
    parts.push({ name: obj.name, positions, indices: obj.indices, source: 'z-anatomy' });
  }

  for (const nerve of JSON.parse(readFileSync(join(dir, 'nerves.json'), 'utf8'))) {
    const name = sideName(nerve.side, nerve.name);
    const positions = [];
    const indices = [];
    for (const line of nerve.lines) {
      const mm = line.map(([x, y, z, r]) => [...warp.blended([x * 1000, y * 1000, z * 1000]), r * 1000]);
      tube(thin(fitLine(mm, name, body)), positions, indices);
    }
    parts.push({ name, positions, indices, source: 'z-anatomy', simplify: false });
  }
  return parts;
}
