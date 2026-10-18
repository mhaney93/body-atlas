// The skeleton that poses the anatomy for Stretching mode. The models are
// separate rigid meshes with no bones or skin weights, so the rig is built from
// the bones themselves: each body segment (thigh, forearm, a finger's middle
// phalanx…) owns the bone meshes in it, and turns about a pivot found from
// their shape (the femoral head, the elbow, a metacarpal head…). Soft parts
// (muscles, tendons) get weights from the nearest bone, blended across each
// joint, so a muscle that crosses a joint bends with it (see skinWeights).
// Pure: it reads world-space vertex arrays and runs in node for the tests.
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const ANTERIOR = new THREE.Vector3(0, 0, 1);
const POSTERIOR = new THREE.Vector3(0, 0, -1);
/** The models face +z with the body's right side at -x. */
const LATERAL = { left: new THREE.Vector3(1, 0, 0), right: new THREE.Vector3(-1, 0, 0) };

export const SIDES = ['left', 'right'];
const FINGERS = ['index', 'middle', 'ring', 'little'];
const METACARPAL = { index: 'second', middle: 'third', ring: 'fourth', little: 'fifth' };
const TOES = ['big', 'second', 'third', 'fourth', 'little'];
const METATARSAL = { big: 'first', second: 'second', third: 'third', fourth: 'fourth', little: 'fifth' };
const PHALANX = ['proximal', 'middle', 'distal'];

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Every segment, parents first: id, parent, side (null on the midline), the
 * family a region's candidate list names it by, and how far (m) its weights
 * blend into its parent's across the joint.
 */
export const SEGMENTS = (() => {
  const list = [
    { id: 'pelvis', parent: null, family: 'pelvis', blend: 0.05 },
    { id: 'lumbar', parent: 'pelvis', family: 'lumbar', blend: 0.05 },
    { id: 'thorax', parent: 'lumbar', family: 'thorax', blend: 0.05 },
    { id: 'lower-neck', parent: 'thorax', family: 'lower-neck', blend: 0.03 },
    { id: 'upper-neck', parent: 'lower-neck', family: 'upper-neck', blend: 0.025 },
    { id: 'head', parent: 'upper-neck', family: 'head', blend: 0.02 },
    { id: 'mandible', parent: 'head', family: 'mandible', blend: 0.012 },
  ];
  for (const side of SIDES) {
    const s = (id) => `${side}-${id}`;
    const add = (id, parent, family, blend) => list.push({ id: s(id), parent, side, family, blend });
    add('girdle', 'thorax', 'girdle', 0.04);
    add('upperarm', s('girdle'), 'upperarm', 0.05);
    add('forearm', s('upperarm'), 'forearm', 0.035);
    add('twist', s('forearm'), 'twist', 0.02);
    add('hand', s('twist'), 'hand', 0.02);
    add('thumb1', s('hand'), 'thumb', 0.01);
    add('thumb2', s('thumb1'), 'thumb', 0.007);
    add('thumb3', s('thumb2'), 'thumb', 0.005);
    for (const f of FINGERS) {
      add(`${f}1`, s('hand'), 'fingers', 0.007);
      add(`${f}2`, s(`${f}1`), 'fingers', 0.005);
      add(`${f}3`, s(`${f}2`), 'fingers', 0.004);
    }
    add('thigh', 'pelvis', 'thigh', 0.06);
    add('shank', s('thigh'), 'shank', 0.045);
    add('foot', s('shank'), 'foot', 0.03);
    for (const t of TOES) {
      const n = t === 'big' ? 2 : 3;
      for (let i = 1; i <= n; i++) add(`${t}toe${i}`, i === 1 ? s('foot') : s(`${t}toe${i - 1}`), 'toes', i === 1 ? 0.006 : 0.004);
    }
  }
  return list;
})();

const SEGMENT_BY_ID = new Map(SEGMENTS.map((s) => [s.id, s]));

/** Which segment a bone mesh belongs to, by its name; null for none. */
export function segmentOfBone(meshName) {
  const n = meshName.toLowerCase();
  if (/\bhip bone\b|sacrum|coccyx/.test(n)) return 'pelvis';
  if (/lumbar vertebra/.test(n)) return 'lumbar';
  if (/thoracic vertebra|\brib\b|costal cartilage|sternum|manubrium|xiphoid/.test(n)) return 'thorax';
  if (/(fifth|sixth|seventh) cervical vertebra/.test(n)) return 'lower-neck';
  if (/(third|fourth) cervical vertebra|\baxis\b|hyoid/.test(n)) return 'upper-neck';
  if (/mandible/.test(n)) return 'mandible';
  if (/\batlas\b|frontal|parietal|occipital|temporal bone|sphenoid|ethmoid|vomer|maxilla|zygomatic|nasal bone|lacrimal|palatine|nasal concha|malleus|incus|stapes/.test(n))
    return 'head';
  const side = /\bleft\b/.test(n) ? 'left' : /\bright\b/.test(n) ? 'right' : null;
  if (!side) return null;
  const s = (id) => `${side}-${id}`;
  if (/clavicle|scapula/.test(n)) return s('girdle');
  if (/humerus/.test(n)) return s('upperarm');
  if (/\bradius\b|\bulna\b/.test(n)) return s('forearm');
  if (/first metacarpal/.test(n)) return s('thumb1');
  if (/metacarpal|scaphoid|lunate|triquetr|pisiform|trapezium|trapezoid|capitate|hamate/.test(n)) return s('hand');
  let m = /(proximal|middle|distal) phalanx of (?:left|right) (thumb|index finger|middle finger|ring finger|little finger)/.exec(n);
  if (m) {
    if (m[2] === 'thumb') return s(m[1] === 'proximal' ? 'thumb2' : 'thumb3');
    return s(`${m[2].split(' ')[0]}${PHALANX.indexOf(m[1]) + 1}`);
  }
  if (/femur/.test(n)) return s('thigh');
  if (/tibia|fibula|patella/.test(n)) return s('shank');
  m = /(proximal|middle|distal) phalanx of (?:left|right) (big|second|third|fourth|little) toe/.exec(n);
  if (m) return s(`${m[2]}toe${m[2] === 'big' ? (m[1] === 'proximal' ? 1 : 2) : PHALANX.indexOf(m[1]) + 1}`);
  if (/talus|calcaneus|navicular|cuboid|cuneiform|metatarsal|sesamoid/.test(n)) return s('foot');
  return null;
}

/**
 * The segment families a soft part of each region may follow; a sided part
 * follows only its own side's limb segments. Muscular regions, plus the
 * Skeletal ones for completeness.
 */
export const REGION_FAMILIES = {
  Head: ['head'],
  Face: ['head', 'mandible'],
  Eye: ['head'],
  Jaw: ['head', 'mandible'],
  Tongue: ['head', 'mandible'],
  Throat: ['lower-neck', 'upper-neck', 'head'],
  Larynx: ['lower-neck', 'upper-neck', 'head'],
  Neck: ['thorax', 'lower-neck', 'upper-neck', 'head', 'mandible', 'girdle'],
  Back: ['pelvis', 'lumbar', 'thorax', 'lower-neck', 'upper-neck', 'head', 'girdle', 'upperarm'],
  Chest: ['thorax', 'girdle', 'upperarm'],
  Abdomen: ['pelvis', 'lumbar', 'thorax', 'thigh'],
  Pelvis: ['pelvis', 'lumbar', 'thigh'],
  'Pelvic floor': ['pelvis'],
  Shoulder: ['thorax', 'girdle', 'upperarm'],
  'Upper arm': ['girdle', 'upperarm', 'forearm'],
  Elbow: ['upperarm', 'forearm'],
  Forearm: ['upperarm', 'forearm', 'hand', 'thumb', 'fingers'],
  Hand: ['hand', 'thumb', 'fingers'],
  Hip: ['pelvis', 'lumbar', 'thigh'],
  Thigh: ['pelvis', 'thigh', 'shank'],
  Leg: ['thigh', 'shank', 'foot', 'toes'],
  Ankle: ['shank', 'foot'],
  Foot: ['shank', 'foot', 'toes'],
};

// --- geometry helpers over flat [x, y, z, …] arrays -------------------------

function centroid(a) {
  const c = new THREE.Vector3();
  for (let i = 0; i < a.length; i += 3) c.x += a[i], c.y += a[i + 1], c.z += a[i + 2];
  return c.divideScalar(a.length / 3);
}

/** The vertices within `width` (m) of the extreme along `dir`. */
function band(a, dir, width) {
  let max = -Infinity;
  for (let i = 0; i < a.length; i += 3) max = Math.max(max, a[i] * dir.x + a[i + 1] * dir.y + a[i + 2] * dir.z);
  const out = [];
  for (let i = 0; i < a.length; i += 3)
    if (a[i] * dir.x + a[i + 1] * dir.y + a[i + 2] * dir.z >= max - width) out.push(a[i], a[i + 1], a[i + 2]);
  return out;
}

/** The long axis of a set of points (power iteration on the covariance), pointing along `toward`. */
function principalAxis(a, toward) {
  const c = centroid(a);
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < a.length; i += 3) {
    const d = [a[i] - c.x, a[i + 1] - c.y, a[i + 2] - c.z];
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) m[r * 3 + k] += d[r] * d[k];
  }
  let v = toward.clone().normalize();
  for (let it = 0; it < 30; it++) {
    v = new THREE.Vector3(
      m[0] * v.x + m[1] * v.y + m[2] * v.z,
      m[3] * v.x + m[4] * v.y + m[5] * v.z,
      m[6] * v.x + m[7] * v.y + m[8] * v.z,
    ).normalize();
  }
  return v.dot(toward) < 0 ? v.negate() : v;
}

/** The centroid of the end of a long bone that points along `toward`: the last `fraction` of its length. */
function boneEnd(a, toward, fraction) {
  const axis = principalAxis(a, toward);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < a.length; i += 3) {
    const t = a[i] * axis.x + a[i + 1] * axis.y + a[i + 2] * axis.z;
    min = Math.min(min, t);
    max = Math.max(max, t);
  }
  return centroid(band(a, axis, (max - min) * fraction));
}

/** Least-squares sphere through the points; null when the fit is degenerate. */
function fitSphere(a) {
  // Solve x² + y² + z² = 2ax + 2by + 2cz + d for (a, b, c, d).
  const ata = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const atb = [0, 0, 0, 0];
  for (let i = 0; i < a.length; i += 3) {
    const row = [2 * a[i], 2 * a[i + 1], 2 * a[i + 2], 1];
    const rhs = a[i] ** 2 + a[i + 1] ** 2 + a[i + 2] ** 2;
    for (let r = 0; r < 4; r++) {
      atb[r] += row[r] * rhs;
      for (let k = 0; k < 4; k++) ata[r][k] += row[r] * row[k];
    }
  }
  // Gaussian elimination with partial pivoting.
  const m = ata.map((r, i) => [...r, atb[i]]);
  for (let col = 0; col < 4; col++) {
    let best = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(m[r][col]) > Math.abs(m[best][col])) best = r;
    [m[col], m[best]] = [m[best], m[col]];
    if (Math.abs(m[col][col]) < 1e-12) return null;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let k = col; k < 5; k++) m[r][k] -= f * m[col][k];
    }
  }
  const [x, y, z, d] = m.map((r, i) => r[4] / r[i]);
  const radius = Math.sqrt(d + x * x + y * y + z * z);
  return Number.isFinite(radius) ? { center: new THREE.Vector3(x, y, z), radius } : null;
}

/** The centre of a ball-shaped bone end: a sphere fit of the band, or its centroid if the fit is implausible. */
function ballCentre(a, dir, width, [rMin, rMax]) {
  const b = band(a, dir, width);
  const s = fitSphere(b);
  return s && s.radius >= rMin && s.radius <= rMax ? s.center : centroid(b);
}

// --- the rig ---------------------------------------------------------------

/**
 * Builds the rig from the skeleton's bones.
 * @param {(meshName: string) => ArrayLike<number> | undefined} verts world-space
 *   positions of a Skeletal mesh by its original name, flat [x, y, z, …]
 * @returns {{ segments: Map<string, object>, frames: object }} each segment has
 *   its definition plus `pivot`, `dir` (unit, from the pivot along the segment)
 *   and `end`; `frames.hand[side]` holds `palmar`, `radial` and `distal` unit
 *   vectors, `frames.forearmRest[side]` the forearm's rest supination (degrees)
 */
export function buildRig(verts) {
  const need = (name) => {
    const a = verts(name);
    if (!a?.length) throw new Error(`rig: no bone "${name}"`);
    return a;
  };
  const disc = (level) => centroid(need(`Intervertebral disk of ${level} vertebra`));
  const points = new Map();
  const set = (id, pivot, end) => points.set(id, { pivot, end });

  set('lumbar', disc('fifth lumbar'), disc('twelfth thoracic'));
  set('thorax', disc('twelfth thoracic'), disc('seventh cervical'));
  set('lower-neck', disc('seventh cervical'), disc('fourth cervical'));
  const atlas = centroid(need('Atlas'));
  set('upper-neck', disc('fourth cervical'), atlas);
  const skullTop = centroid([...band(need('Left parietal bone'), UP, 0.01), ...band(need('Right parietal bone'), UP, 0.01)]);
  set('head', atlas, skullTop);
  // The jaw hinges at its two condyles: the highest points of its back half.
  const mandible = need('Mandible');
  const mc = centroid(mandible);
  const back = [];
  for (let i = 0; i < mandible.length; i += 3) if (mandible[i + 2] < mc.z - 0.01) back.push(mandible[i], mandible[i + 1], mandible[i + 2]);
  const top = band(back, UP, 0.008);
  const halves = [[], []];
  for (let i = 0; i < top.length; i += 3) halves[top[i] < 0 ? 0 : 1].push(top[i], top[i + 1], top[i + 2]);
  const condyles = centroid(halves[0]).add(centroid(halves[1])).multiplyScalar(0.5);
  set('mandible', condyles, centroid(band(mandible, new THREE.Vector3(0, -0.5, 1).normalize(), 0.01)));
  const sacrum = centroid(need('Sacrum'));

  const frames = { hand: {}, forearmRest: {} };
  for (const side of SIDES) {
    const S = cap(side);
    const lat = LATERAL[side];
    const med = lat.clone().negate();
    const s = (id) => `${side}-${id}`;
    const bone = (name) => need(name.replace('{S}', S).replace('{s}', side));

    const humerus = bone('{S} humerus');
    const shoulder = ballCentre(humerus, med.clone().multiplyScalar(0.5).add(UP).normalize(), 0.035, [0.015, 0.035]);
    const sc = centroid(band(bone('{S} clavicle'), med, 0.01));
    const elbow = centroid(band(humerus, DOWN, 0.015)).addScaledVector(UP, 0.012);
    const capitate = centroid(bone('{S} capitate'));
    const wrist = centroid(band(bone('{S} radius'), DOWN, 0.008)).add(capitate).multiplyScalar(0.5);
    set(s('girdle'), sc, shoulder);
    set(s('upperarm'), shoulder, elbow);
    set(s('forearm'), elbow, wrist);
    set(s('twist'), wrist, wrist.clone().add(wrist.clone().sub(elbow).normalize().multiplyScalar(0.01)));
    const mcHead = (f) => boneEnd(bone(`{S} ${METACARPAL[f]} metacarpal bone`), DOWN, 0.25);
    const heads = Object.fromEntries(FINGERS.map((f) => [f, mcHead(f)]));
    set(s('hand'), wrist, heads.middle);
    // Each finger: knuckle → middle joint → end joint → tip.
    for (const f of FINGERS) {
      let pivot = heads[f];
      for (let i = 1; i <= 3; i++) {
        const ph = bone(`${cap(PHALANX[i - 1])} phalanx of {s} ${f} finger`);
        const end = boneEnd(ph, centroid(ph).sub(pivot), 0.25);
        set(s(`${f}${i}`), pivot, end);
        pivot = end;
      }
    }
    const mc1 = bone('{S} first metacarpal bone');
    const cmc = boneEnd(mc1, wrist.clone().sub(centroid(mc1)), 0.2);
    const thumbMcp = boneEnd(mc1, centroid(mc1).sub(wrist), 0.25);
    const thumbProx = bone('Proximal phalanx of {s} thumb');
    const thumbIp = boneEnd(thumbProx, centroid(thumbProx).sub(thumbMcp), 0.25);
    const thumbDist = bone('Distal phalanx of {s} thumb');
    set(s('thumb1'), cmc, thumbMcp);
    set(s('thumb2'), thumbMcp, thumbIp);
    set(s('thumb3'), thumbIp, boneEnd(thumbDist, centroid(thumbDist).sub(thumbIp), 0.2));

    const distal = heads.middle.clone().sub(wrist).normalize();
    const radial = heads.index.clone().sub(heads.little);
    radial.addScaledVector(distal, -radial.dot(distal)).normalize();
    const palmar = (side === 'right' ? radial.clone().cross(distal) : distal.clone().cross(radial)).normalize();
    frames.hand[side] = { palmar, radial, distal };
    const axis = wrist.clone().sub(elbow).normalize();
    const flat = (v) => v.clone().addScaledVector(axis, -v.dot(axis)).normalize();
    const p = flat(palmar);
    const m = flat(med);
    // Pronation turns the palm toward the midline, so this is how far pronation goes to reach thumb-forward.
    frames.forearmRest[side] = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(m.dot(p), -1, 1)));

    const femur = bone('{S} femur');
    const hip = ballCentre(femur, med.clone().multiplyScalar(0.7).add(UP).normalize(), 0.035, [0.017, 0.035]);
    const knee = ballCentre(femur, DOWN, 0.03, [0.02, 0.06]);
    const ankle = centroid(band(bone('{S} tibia'), DOWN, 0.006)).add(centroid(band(bone('{S} fibula'), DOWN, 0.006))).multiplyScalar(0.5);
    const mtHead = (t) => boneEnd(bone(`{S} ${METATARSAL[t]} metatarsal bone`), ANTERIOR, 0.25);
    set(s('thigh'), hip, knee);
    set(s('shank'), knee, ankle);
    set(s('foot'), ankle, mtHead('second'));
    for (const t of TOES) {
      let pivot = mtHead(t);
      const n = t === 'big' ? 2 : 3;
      for (let i = 1; i <= n; i++) {
        const kind = t === 'big' ? ['proximal', 'distal'][i - 1] : PHALANX[i - 1];
        const ph = bone(`${cap(kind)} phalanx of {s} ${t} toe`);
        const end = boneEnd(ph, centroid(ph).sub(pivot), 0.25);
        set(s(`${t}toe${i}`), pivot, end);
        pivot = end;
      }
    }
  }
  const hips = points.get('left-thigh').pivot.clone().add(points.get('right-thigh').pivot).multiplyScalar(0.5);
  set('pelvis', sacrum, hips);

  const segments = new Map();
  for (const def of SEGMENTS) {
    const { pivot, end } = points.get(def.id);
    const dir = end.clone().sub(pivot);
    const length = dir.length();
    segments.set(def.id, { ...def, pivot, end, dir: dir.normalize(), length });
  }
  return { segments, frames };
}

/** Each segment's bone index in the skeleton (its place in SEGMENTS). */
export const SEGMENT_INDEX = new Map(SEGMENTS.map((s, i) => [s.id, i]));

/**
 * A spatial index of bone surface points by segment, for skinWeights: a
 * uniform grid with each cell's points stored contiguously.
 * @param {Iterable<[string, ArrayLike<number>]>} bones [mesh name, world positions] of every Skeletal mesh
 * @param {number} [step] keep every `step`-th vertex
 */
export function indexBones(bones, step = 2) {
  const cell = 0.015;
  const pts = [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const [name, a] of bones) {
    const seg = segmentOfBone(name);
    if (!seg) continue;
    const s = SEGMENT_INDEX.get(seg);
    for (let i = 0; i < a.length; i += 3 * step) {
      pts.push(a[i], a[i + 1], a[i + 2], s);
      for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], a[i + k])), (max[k] = Math.max(max[k], a[i + k]));
    }
  }
  const dims = max.map((m, k) => Math.floor((m - min[k]) / cell) + 1);
  const cellOf = (x, y, z) =>
    (Math.floor((x - min[0]) / cell) * dims[1] + Math.floor((y - min[1]) / cell)) * dims[2] + Math.floor((z - min[2]) / cell);
  const count = new Int32Array(dims[0] * dims[1] * dims[2] + 1);
  const n = pts.length / 4;
  for (let p = 0; p < n; p++) count[cellOf(pts[p * 4], pts[p * 4 + 1], pts[p * 4 + 2]) + 1]++;
  for (let c = 1; c < count.length; c++) count[c] += count[c - 1];
  const xyz = new Float32Array(n * 3);
  const segs = new Uint8Array(n);
  const fill = count.slice();
  for (let p = 0; p < n; p++) {
    const at = fill[cellOf(pts[p * 4], pts[p * 4 + 1], pts[p * 4 + 2])]++;
    xyz.set([pts[p * 4], pts[p * 4 + 1], pts[p * 4 + 2]], at * 3);
    segs[at] = pts[p * 4 + 3];
  }
  return { cell, min, dims, start: count, xyz, segs };
}

/** The segment index of the nearest indexed bone point among `allowed` (an array of booleans by index), or -1 within `maxDist`. */
function nearestSegment(index, x, y, z, allowed, maxDist = 0.2) {
  const { cell, min, dims, start, xyz, segs } = index;
  const cx = Math.floor((x - min[0]) / cell);
  const cy = Math.floor((y - min[1]) / cell);
  const cz = Math.floor((z - min[2]) / cell);
  let best = Infinity;
  let seg = -1;
  for (let r = 0; r * cell <= maxDist; r++) {
    // Once a point is found, a ring further out than it can't hold a nearer one.
    if (seg >= 0 && ((r - 1) * cell) ** 2 > best) break;
    for (let i = cx - r; i <= cx + r; i++) {
      if (i < 0 || i >= dims[0]) continue;
      for (let j = cy - r; j <= cy + r; j++) {
        if (j < 0 || j >= dims[1]) continue;
        const edge = i === cx - r || i === cx + r || j === cy - r || j === cy + r;
        for (let k = cz - r; k <= cz + r; k += edge ? 1 : 2 * r || 1) {
          if (k < 0 || k >= dims[2]) continue;
          const c = (i * dims[1] + j) * dims[2] + k;
          for (let p = start[c]; p < start[c + 1]; p++) {
            if (!allowed[segs[p]]) continue;
            const d = (xyz[p * 3] - x) ** 2 + (xyz[p * 3 + 1] - y) ** 2 + (xyz[p * 3 + 2] - z) ** 2;
            if (d < best) (best = d), (seg = segs[p]);
          }
        }
      }
    }
  }
  return seg;
}

const smoothstep = (e0, e1, x) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * The segments a soft part may follow: its region's families (REGION_FAMILIES;
 * any family for an unknown region), on its own side only when it has one.
 * @returns {Set<number>} segment indices
 */
export function candidateSegments(region, side) {
  const families = REGION_FAMILIES[region];
  const out = new Set();
  SEGMENTS.forEach((s, i) => {
    if (families && !families.includes(s.family)) return;
    if (side && s.side && s.side !== side) return;
    out.add(i);
  });
  return out;
}

/**
 * Skin weights for a soft part: each vertex follows the segment of its
 * nearest bone, blended into the parent segment across the joint plane and
 * into a child segment it lies near, so a muscle that crosses a joint bends
 * with it; along the forearm the weight shifts to the twist segment toward the
 * wrist, so turning the hand twists the forearm with it.
 * @param {ReturnType<typeof buildRig>} rig
 * @param {ReturnType<typeof indexBones>} index
 * @param {ArrayLike<number>} positions world-space [x, y, z, …]
 * @param {Set<number>} allowed candidate segment indices (candidateSegments)
 * @returns {{ indices: Uint8Array, weights: Float32Array }} 4 influences per vertex
 */
export function skinWeights(rig, index, positions, allowed) {
  const n = positions.length / 3;
  const indices = new Uint8Array(n * 4);
  const weights = new Float32Array(n * 4);
  const segs = SEGMENTS.map((d) => rig.segments.get(d.id));
  const allow = SEGMENTS.map((_, i) => allowed.has(i));
  const children = SEGMENTS.map((d) => SEGMENTS.flatMap((c, i) => (c.parent === d.id && allowed.has(i) ? [i] : [])));
  const v = new THREE.Vector3();
  const d = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    const s = nearestSegment(index, v.x, v.y, v.z, allow);
    const infl = new Map();
    if (s < 0) {
      infl.set(0, 1);
    } else {
      const seg = segs[s];
      // Across the joint to the parent: full weight past the joint plane, none behind it.
      const parent = seg.parent ? SEGMENT_INDEX.get(seg.parent) : -1;
      const own = parent >= 0 ? smoothstep(-seg.blend, seg.blend, d.copy(v).sub(seg.pivot).dot(seg.dir)) : 1;
      infl.set(s, own);
      if (parent >= 0 && own < 1) infl.set(parent, 1 - own);
      // Past the nearest child joint along this segment, if the vertex lies near it.
      let child = -1;
      let near = Infinity;
      for (const c of children[s]) {
        const dist = segs[c].pivot.distanceTo(v);
        if (dist < near) (near = dist), (child = c);
      }
      if (child >= 0 && near < 3 * segs[child].blend + 0.03) {
        const into = smoothstep(-segs[child].blend, segs[child].blend, d.copy(v).sub(segs[child].pivot).dot(seg.dir));
        if (into > 0) {
          infl.set(child, (infl.get(child) ?? 0) + infl.get(s) * into);
          infl.set(s, infl.get(s) * (1 - into));
        }
      }
      // Along the forearm, hand the weight over to the twist segment toward the wrist.
      for (const [k, w] of [...infl]) {
        if (segs[k].family !== 'forearm') continue;
        const twist = SEGMENT_INDEX.get(`${segs[k].side}-twist`);
        const u = smoothstep(0.2, 1, d.copy(v).sub(segs[k].pivot).dot(segs[k].dir) / segs[k].length);
        infl.set(k, w * (1 - u));
        infl.set(twist, (infl.get(twist) ?? 0) + w * u);
      }
    }
    const top = [...infl].filter(([, w]) => w > 1e-3).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((t, [, w]) => t + w, 0);
    top.forEach(([k, w], j) => {
      indices[i * 4 + j] = k;
      weights[i * 4 + j] = w / sum;
    });
  }
  return { indices, weights };
}

export { SEGMENT_BY_ID, UP, DOWN, ANTERIOR, POSTERIOR, LATERAL };
