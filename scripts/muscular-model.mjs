// Builds the Muscular layer's meshes: every BodyParts3D muscle, plus the
// muscles BodyParts3D lacks (latissimus dorsi, the abdominal wall, the face
// and jaw, ...) from the Z-Anatomy extract in data-sources/z-anatomy/muscular/.
//
// - BodyParts3D ships a few paired muscles for one side only (e.g. the
//   intercostals, longus colli); those are mirrored across the midline.
// - Z-Anatomy muscles are warped onto the BodyParts3D skeleton with the same
//   bone-by-bone fit as the nervous system (buildWarp in nervous-model.mjs).
// - Each muscle's tendons are split off as a part of their own (group
//   "tendon", extra `of` naming the muscle): stretches of the mesh that are
//   much thinner than the muscle's belly and reach a bone.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildWarp } from './nervous-model.mjs';
import { Solid } from './solid.mjs';

// BodyParts3D concepts whose elements are muscles or parts of one (heads, the
// parts of the deltoid, ...). The papillary muscles of the heart and the
// smooth muscle of the colon are filed elsewhere, so they stay out.
const MUSCLE_CONCEPTS = ['muscle organ', 'head of muscle organ', 'zone of muscle organ'];
// Elements filed under neither concept: muscle sets, the trapezius parts and
// the free-standing tendons.
const EXTRA_MUSCLES = [
  'FJ1462', 'FJ1462M', 'FJ1463', 'FJ1463M', // levatores costarum
  'FJ1509', 'FJ1509M', 'FJ1510', 'FJ1510M', 'FJ1511', 'FJ1511M', // hand interossei and lumbricals
  'FJ1520', 'FJ1520M', 'FJ1521', 'FJ1521M', // trapezius
  'FJ1549', 'FJ1549M', 'FJ1550', 'FJ1550M', 'FJ1552', 'FJ1552M', 'FJ1553', 'FJ1553M', // short neck and back muscles
];
const TENDONS = ['FJ1291', 'FJ1342', 'FJ1343', 'FJ1405', 'FJ1405M', 'FJ1581'];
// Muscles filed under another system, which ships them instead: the external
// anal sphincter is in digestive.glb (FJ1450 and its mirror duplicate its
// two halves, FJ2548 and FJ2543).
const ELSEWHERE = ['FJ1450', 'FJ1450M', 'FJ2543', 'FJ2548'];

// BodyParts3D names made specific: the dataset calls this pair just
// "spinalis", but they lie in the neck, above spinalis thoracis (+X is the
// body's left).
const BP3D_NAMES = { FJ1543: 'Right spinalis cervicis', FJ1543M: 'Left spinalis cervicis' };

/** Tidies a BodyParts3D muscle name and ties free-standing tendons to their muscle. */
function bp3dPart(part) {
  const name = (BP3D_NAMES[part.id] ?? part.name).replace(/^(.*infraspinatus) muscle$/i, '$1');
  const side = /^(Left|Right) intermediate tendon$/.exec(name)?.[1];
  if (side) return { ...part, name: `Intermediate tendon of ${side.toLowerCase()} digastric`, of: `${side} digastric` };
  const lid = /^Tendon of (left|right) levator palpebrae superioris$/.exec(name)?.[1];
  if (lid) return { ...part, name, of: `${lid[0].toUpperCase()}${lid.slice(1)} levator palpebrae superioris` };
  return { ...part, name };
}

// Z-Anatomy names that differ from the usual (BodyParts3D/TA) English name.
const Z_RENAMES = {
  Bucinator: 'Buccinator',
  'Levator nasolabialis': 'Levator labii superioris alaeque nasi',
  'Internal abdominal oblique': 'Internal oblique',
  'Dorsal interossei muscles of foot': 'Set of dorsal interossei of foot',
  'Multifidus colli': 'Multifidus cervicis',
  'Intermediate tendon of digastric muscle': 'Intermediate tendon',
};

// Muscles that end in skin, fascia, a raphe or other muscles rather than in a
// tendon on bone (the face's expression muscles, the sphincters, the sheets
// between the ribs and of the pelvic floor): their thin edges are not tendons.
const NO_TENDON =
  /orbicularis|zygomaticus|risorius|levator (labii|anguli)|depressor (anguli|labii|septi)|mentalis|nasalis|procerus|corrugator|frontalis|occipitalis|temporoparietalis|buccinator|platysma|sphincter|intercostal|transversus thoracis|pubococcygeus|iliococcygeus|puborectalis/i;

// Tendon detection, in mm: a vertex is tendon-thin where the mesh is thinner
// than TENDON_RATIO of the belly's typical thickness and than TENDON_MAX. A
// thin stretch counts as tendon only if it comes within BONE_REACH of a bone.
const TENDON_RATIO = 0.4;
const TENDON_MAX = 6;
const BONE_REACH = 4;
const MIN_TENDON_AREA = 25; // mm²

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lowerFirst = (s) => s[0].toLowerCase() + s.slice(1);

/** Element ids of the BodyParts3D muscles, from the IS-A element list. */
function muscleElements(metaDir) {
  const ids = new Set(EXTRA_MUSCLES);
  for (const line of readFileSync(join(metaDir, 'isa_element_parts.txt'), 'utf8').split('\n')) {
    const [, concept, id] = line.split('\t');
    if (MUSCLE_CONCEPTS.includes(concept)) ids.add(id.trim());
  }
  for (const id of ELSEWHERE) ids.delete(id);
  return ids;
}

/**
 * Mirrors parts that BodyParts3D has on one side of the body only (every
 * vertex on one side of the x = 0 midline, which its own "M" mirror files
 * use) and whose name has no counterpart on the other side.
 */
function mirrorOneSided(parts) {
  const keyOf = (name) => name.toLowerCase().replace(/\b(left|right) /, '');
  const sides = new Map();
  const sideOf = (o) => {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (let i = 0; i < o.positions.length; i += 3) {
      min = Math.min(min, o.positions[i]);
      max = Math.max(max, o.positions[i]);
      sum += o.positions[i];
    }
    const mean = sum / (o.positions.length / 3);
    if (min > -1.5 && mean > 3) return 'left';
    if (max < 1.5 && mean < -3) return 'right';
    return 'both';
  };
  for (const o of parts) {
    const key = keyOf(o.name);
    if (!sides.has(key)) sides.set(key, new Set());
    sides.get(key).add(sideOf(o));
  }
  const mirrored = [];
  for (const o of parts) {
    const seen = sides.get(keyOf(o.name));
    if (seen.size !== 1 || seen.has('both')) continue;
    const positions = o.positions.map((v, i) => (i % 3 === 0 ? -v : v));
    // Mirroring flips the triangles inside out; swap two corners back.
    const indices = [];
    for (let i = 0; i < o.indices.length; i += 3) indices.push(o.indices[i], o.indices[i + 2], o.indices[i + 1]);
    const name = /\b(left|right)\b/i.test(o.name)
      ? o.name.replace(/\b(left|right)\b/i, (s) => ({ left: 'right', right: 'left' })[s.toLowerCase()].replace(/^./, (c) => (s[0] === s[0].toUpperCase() ? c.toUpperCase() : c)))
      : o.name;
    mirrored.push({ ...o, id: `${o.id}-mirrored`, name, positions, indices, mirrored: true });
  }
  return mirrored;
}

/** Display name of a Z-Anatomy object, e.g. "Latissimus dorsi muscle.l" → "Left latissimus dorsi". */
function zName(objectName) {
  const [, base, s] = /^(.*?)(?:\.([lr]))?$/.exec(objectName);
  const name = Z_RENAMES[base] ?? Z_RENAMES[base.replace(/ muscles?$/, '')] ?? base.replace(/ muscles?$/, '');
  if (!s) return name;
  return `${s === 'l' ? 'Left' : 'Right'} ${lowerFirst(name)}`;
}

/** Uniform grid of triangles for ray casts through one mesh (mm). */
class RayGrid {
  constructor(positions, indices, cell = 3) {
    this.p = positions;
    this.idx = indices;
    this.cell = cell;
    this.map = new Map();
    for (let t = 0; t < indices.length / 3; t++) {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let v = 0; v < 3; v++)
        for (let k = 0; k < 3; k++) {
          const x = positions[indices[t * 3 + v] * 3 + k];
          lo[k] = Math.min(lo[k], Math.floor(x / cell));
          hi[k] = Math.max(hi[k], Math.floor(x / cell));
        }
      for (let x = lo[0]; x <= hi[0]; x++)
        for (let y = lo[1]; y <= hi[1]; y++)
          for (let z = lo[2]; z <= hi[2]; z++) {
            const key = this.#key(x, y, z);
            if (!this.map.has(key)) this.map.set(key, []);
            this.map.get(key).push(t);
          }
    }
  }

  #key(x, y, z) {
    return (x + 2048) * 16777216 + (y + 2048) * 4096 + (z + 2048);
  }

  /** Distance to the first triangle hit from `o` along unit `d` (skipping `skip`), up to `max`; Infinity if none. */
  cast(o, d, max, skip) {
    const { cell } = this;
    const c = o.map((v) => Math.floor(v / cell));
    const step = d.map((v) => (v > 0 ? 1 : -1));
    const tDelta = d.map((v) => (v ? Math.abs(cell / v) : Infinity));
    const tMax = d.map((v, k) => (v ? ((v > 0 ? c[k] + 1 : c[k]) * cell - o[k]) / v : Infinity));
    let best = Infinity;
    let t = 0;
    while (t <= max) {
      for (const tri of this.map.get(this.#key(c[0], c[1], c[2])) ?? []) {
        if (skip.has(tri)) continue;
        const h = this.#hit(o, d, tri);
        if (h > 0.05 && h < best) best = h;
      }
      // A hit inside the current cell is final.
      const next = Math.min(...tMax);
      if (best <= next) return best;
      const k = tMax.indexOf(next);
      c[k] += step[k];
      t = next;
      tMax[k] += tDelta[k];
    }
    return best <= max ? best : Infinity;
  }

  /** Möller–Trumbore ray/triangle distance, or -1. */
  #hit(o, d, tri) {
    const { p, idx } = this;
    const a = [p[idx[tri * 3] * 3], p[idx[tri * 3] * 3 + 1], p[idx[tri * 3] * 3 + 2]];
    const b = [p[idx[tri * 3 + 1] * 3], p[idx[tri * 3 + 1] * 3 + 1], p[idx[tri * 3 + 1] * 3 + 2]];
    const c = [p[idx[tri * 3 + 2] * 3], p[idx[tri * 3 + 2] * 3 + 1], p[idx[tri * 3 + 2] * 3 + 2]];
    const e1 = sub(b, a);
    const e2 = sub(c, a);
    const q = cross(d, e2);
    const det = dot(e1, q);
    if (Math.abs(det) < 1e-12) return -1;
    const s = sub(o, a);
    const u = dot(s, q) / det;
    if (u < 0 || u > 1) return -1;
    const r = cross(s, e1);
    const v = dot(d, r) / det;
    if (v < 0 || u + v > 1) return -1;
    return dot(e2, r) / det;
  }
}

/** Area-weighted vertex normals, pointing out of the mesh. */
function outwardNormals(positions, indices) {
  const n = new Float64Array(positions.length);
  let volume = 0;
  const at = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [at(indices[t]), at(indices[t + 1]), at(indices[t + 2])];
    const f = cross(sub(b, a), sub(c, a));
    volume += dot(a, cross(b, c));
    for (const v of [indices[t], indices[t + 1], indices[t + 2]]) for (let k = 0; k < 3; k++) n[v * 3 + k] += f[k];
  }
  const sign = volume < 0 ? -1 : 1;
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]) * sign || 1;
    n[i] /= len;
    n[i + 1] /= len;
    n[i + 2] /= len;
  }
  return n;
}

/**
 * Splits a muscle into its fleshy belly and its tendons. Returns the belly
 * (or the whole muscle when nothing qualifies) and, if found, a tendon part.
 */
function splitTendons(part, bones) {
  const { positions, indices } = part;
  const nv = positions.length / 3;
  const normals = outwardNormals(positions, indices);
  const grid = new RayGrid(positions, indices);
  const trisOf = Array.from({ length: nv }, () => []);
  for (let t = 0; t < indices.length / 3; t++) for (let v = 0; v < 3; v++) trisOf[indices[t * 3 + v]].push(t);
  const neighbours = Array.from({ length: nv }, () => new Set());
  for (let t = 0; t < indices.length; t += 3)
    for (let v = 0; v < 3; v++) {
      neighbours[indices[t + v]].add(indices[t + ((v + 1) % 3)]);
      neighbours[indices[t + v]].add(indices[t + ((v + 2) % 3)]);
    }

  // Thickness: how far a ray into the mesh travels before leaving it.
  let thick = new Float64Array(nv);
  for (let i = 0; i < nv; i++) {
    const o = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const d = [-normals[i * 3], -normals[i * 3 + 1], -normals[i * 3 + 2]];
    const t = grid.cast(o, d, 120, new Set(trisOf[i]));
    thick[i] = Number.isFinite(t) ? t : 120;
  }
  for (let pass = 0; pass < 3; pass++) {
    const next = new Float64Array(nv);
    for (let i = 0; i < nv; i++) {
      let sum = thick[i];
      for (const j of neighbours[i]) sum += thick[j];
      next[i] = sum / (neighbours[i].size + 1);
    }
    thick = next;
  }
  const sorted = [...thick].sort((a, b) => a - b);
  const belly = sorted[Math.floor(sorted.length * 0.7)];
  const limit = Math.min(TENDON_MAX, belly * TENDON_RATIO);
  const thin = thick.map((t) => (t < limit ? 1 : 0));

  // Keep the thin regions that reach a bone and are big enough to see.
  const tendon = new Uint8Array(nv);
  const seen = new Uint8Array(nv);
  const triArea = (t) => {
    const p = (k) => [positions[indices[t * 3 + k] * 3], positions[indices[t * 3 + k] * 3 + 1], positions[indices[t * 3 + k] * 3 + 2]];
    const [a, b, c] = [p(0), p(1), p(2)];
    return Math.hypot(...cross(sub(b, a), sub(c, a))) / 2;
  };
  let pieces = 0;
  for (let s = 0; s < nv; s++) {
    if (!thin[s] || seen[s]) continue;
    const region = [s];
    seen[s] = 1;
    for (let k = 0; k < region.length; k++)
      for (const j of neighbours[region[k]]) if (thin[j] && !seen[j]) (seen[j] = 1), region.push(j);
    const tris = new Set(region.flatMap((v) => trisOf[v]));
    let area = 0;
    for (const t of tris) area += triArea(t) / 3;
    if (area < MIN_TENDON_AREA) continue;
    const reaches = region.some((v) => {
      const p = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
      return bones.some((b) => b.nearBox(p, BONE_REACH) && b.closest(p, null, BONE_REACH).distance < BONE_REACH);
    });
    if (!reaches) continue;
    for (const v of region) tendon[v] = 1;
    pieces++;
  }
  if (!pieces) return [part];

  const bellyIdx = [];
  const tendonIdx = [];
  for (let t = 0; t < indices.length; t += 3) {
    const n = tendon[indices[t]] + tendon[indices[t + 1]] + tendon[indices[t + 2]];
    (n >= 2 ? tendonIdx : bellyIdx).push(indices[t], indices[t + 1], indices[t + 2]);
  }
  if (!tendonIdx.length || !bellyIdx.length) return [part];
  return [
    { ...part, indices: bellyIdx },
    {
      ...part,
      id: `${part.id}-tendon`,
      name: `${pieces > 1 ? 'Tendons' : 'Tendon'} of ${lowerFirst(part.name)}`,
      indices: tendonIdx,
      group: 'tendon',
      of: part.name,
    },
  ];
}

/** Keeps only the vertices a part's triangles use. */
function compact(part) {
  const map = new Map();
  const positions = [];
  const indices = part.indices.map((v) => {
    if (!map.has(v)) {
      map.set(v, positions.length / 3);
      positions.push(part.positions[v * 3], part.positions[v * 3 + 1], part.positions[v * 3 + 2]);
    }
    return map.get(v);
  });
  return { ...part, positions, indices };
}

/**
 * Returns the muscular system as parts shaped like build-models' parseObj
 * output ({ name, positions, indices } in BodyParts3D millimetres), each with
 * a `group` ("muscle" or "tendon") and tendons with `of`, their muscle's name.
 * @param {{ objDir: string, metaDir: string, zDir: string }} dirs
 * @param {Map<string, {name: string, positions: number[]}>} bp3dBones BodyParts3D bones by English name (full resolution)
 * @param {{name: string, positions: number[], indices: number[]}[]} shownBones the bones as shown (simplified)
 * @param {(path: string) => object} parseObj
 * @param {(parts: object[]) => object[]} mergeByName joins same-named elements, splitting unsided names by side
 */
export function loadMuscular({ objDir, metaDir, zDir }, bp3dBones, shownBones, parseObj, mergeByName) {
  const available = new Set(readdirSync(objDir).map((f) => f.replace(/\.obj$/, '')));
  const ids = [...muscleElements(metaDir), ...TENDONS].filter((id) => available.has(id)).sort();
  const bp3d = ids.map((id) =>
    bp3dPart({ ...parseObj(join(objDir, `${id}.obj`)), id, group: TENDONS.includes(id) ? 'tendon' : 'muscle' }),
  );
  const parts = [...bp3d, ...mirrorOneSided(bp3d)];

  const warp = buildWarp(JSON.parse(readFileSync(join(zDir, '..', 'nervous', 'landmarks.json'), 'utf8')), bp3dBones);
  for (const file of readdirSync(zDir).filter((f) => f.endsWith('.obj')).sort()) {
    const obj = parseObj(join(zDir, file));
    const object = /^# Z-Anatomy name : (.*)$/m.exec(readFileSync(join(zDir, file), 'utf8'))[1].trim();
    const positions = [];
    for (let i = 0; i < obj.positions.length; i += 3) {
      positions.push(...warp.blended([obj.positions[i] * 1000, obj.positions[i + 1] * 1000, obj.positions[i + 2] * 1000]));
    }
    const name = zName(object);
    parts.push({ ...obj, id: file, name, positions, source: 'z-anatomy', group: /tendon/i.test(name) ? 'tendon' : 'muscle' });
  }

  const bones = shownBones.map((b) => new Solid(b.positions, b.indices, 6));
  const out = [];
  for (const part of mergeByName(parts)) {
    if (part.group === 'tendon' || NO_TENDON.test(part.name)) out.push(part);
    else out.push(...splitTendons(part, bones).map(compact));
  }
  const tendons = out.filter((p) => p.of).length;
  console.log(`  ${out.length - tendons} muscles (${parts.filter((p) => p.source === 'z-anatomy').length} Z-Anatomy meshes), ${tendons} split tendons`);
  return out;
}
