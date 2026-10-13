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
// Nerves, which Z-Anatomy stores as bevelled curves, become tubes here.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CRANIUM = ['Frontal bone', 'Occipital bone', 'Left parietal bone', 'Right parietal bone', 'Left temporal bone', 'Right temporal bone'];
// Meshes that move with the cranium as one rigid body.
const BRAIN = /lobe|insula|cerebellum|brainstem|optic chiasm|optic tract/i;

// Tube radius in mm for a Z-Anatomy radius (also mm). Z-Anatomy draws most
// nerves at 0.5 mm; they are thickened so they stay visible as threads.
const tubeRadius = (r) => Math.min(2.6, 0.7 + r * 0.9);
const TUBE_SIDES = 6;

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
    bones.push({ name, src, T: icp(src, pointsOf(target)) });
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

/** Drops polyline points that deviate less than `tol` mm from the straight line between their neighbours. */
function thin(line, tol = 0.4) {
  if (line.length < 3) return line;
  const out = [line[0]];
  for (let i = 1; i < line.length - 1; i++) {
    const a = out[out.length - 1];
    const c = line[i + 1];
    const ac = sub(c, a);
    const len2 = dot(ac.slice(0, 3), ac.slice(0, 3)) || 1;
    const ab = sub(line[i], a);
    const t = Math.max(0, Math.min(1, dot(ab.slice(0, 3), ac.slice(0, 3)) / len2));
    const off = Math.sqrt(dist2(line[i], add(a, scale(ac, t))));
    if (off > tol || Math.abs(line[i][3] - a[3]) > 0.2) out.push(line[i]);
  }
  out.push(line[line.length - 1]);
  return out;
}

const sideName = (side, name) => (side ? `${side} ${name[0].toLowerCase()}${name.slice(1)}` : name);

/**
 * Returns the nervous system as parts shaped like build-models' parseObj
 * output ({ name, positions, indices } in BodyParts3D millimetres).
 * @param {string} dir data-sources/z-anatomy/nervous
 * @param {Map<string, number[]>} bp3dBones BodyParts3D bone positions by English name
 * @param {(path: string) => object} parseObj
 */
export function loadNervous(dir, bp3dBones, parseObj) {
  const warp = buildWarp(JSON.parse(readFileSync(join(dir, 'landmarks.json'), 'utf8')), bp3dBones);
  const parts = [];

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.obj')).sort()) {
    const obj = parseObj(join(dir, file));
    const map = BRAIN.test(obj.name) ? warp.cranium : warp.blended;
    const positions = [];
    for (let i = 0; i < obj.positions.length; i += 3) {
      positions.push(...map(scale(obj.positions.slice(i, i + 3), 1000)));
    }
    parts.push({ name: obj.name, positions, indices: obj.indices, source: 'z-anatomy' });
  }

  for (const nerve of JSON.parse(readFileSync(join(dir, 'nerves.json'), 'utf8'))) {
    const positions = [];
    const indices = [];
    for (const line of nerve.lines) {
      const mm = line.map(([x, y, z, r]) => [...warp.blended([x * 1000, y * 1000, z * 1000]), r * 1000]);
      tube(thin(mm), positions, indices);
    }
    parts.push({ name: sideName(nerve.side, nerve.name), positions, indices, source: 'z-anatomy', simplify: false });
  }
  return parts;
}
