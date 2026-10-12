// Converts BodyParts3D OBJ meshes (fetched by scripts/fetch-bodyparts3d.mjs)
// into meshopt-compressed GLB files in public/models/, one per asset below.
//
// BodyParts3D is in millimetres with +Z up, -Y anterior and +X patient-left.
// Output is in metres, +Y up, +Z anterior (facing the default camera), with
// the feet resting on y = 0 and the body centred on the vertical axis.
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { meshopt, simplify, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { loadNervous } from './nervous-model.mjs';

const ROOT = join(import.meta.dirname, '..');
const OBJ_DIR = join(ROOT, '.cache', 'bodyparts3d', 'obj');
const OUT_DIR = join(ROOT, 'public', 'models');

// The skin mesh doubles as the reference frame for every asset.
const SKIN = 'FJ2810';

// Element files FJ3152–FJ3395 of BodyParts3D 4.0 are exactly the bones,
// costal cartilages and intervertebral disks (the FMA "skeletal system"
// concept in the PART-OF tree omits the limbs, so it can't be used directly).
// FJ3238 and FJ3363 are unused ids that don't exist in the dataset.
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `FJ${from + i}`);

// Specific names where the dataset's own name is generic or abbreviated.
const NAME_OVERRIDES = {
  // Sits between T12 and L1 (by its bounds); FMA names a disk after the vertebra above it.
  FJ3211: 'Intervertebral disk of twelfth thoracic vertebra',
  FJ3199: 'Ethmoid bone',
  // The dataset calls all four "Sesamoid bone of <side> foot"; they sit under
  // the first metatarsal head, and their x position tells medial from lateral.
  FJ3266: 'Medial sesamoid bone of left big toe',
  FJ3270: 'Lateral sesamoid bone of left big toe',
  FJ3372: 'Medial sesamoid bone of right big toe',
  // Vessel sets the dataset names without saying hand or foot; their bounds
  // place them (two "Dorsal metacarpal vein" elements are in fact in the feet).
  FJ2186: 'Dorsal metatarsal vein',
  FJ2199: 'Dorsal metatarsal vein',
  FJ2093: 'Set of dorsal digital arteries of foot',
  FJ2197: 'Set of dorsal digital arteries of foot',
  FJ2318: 'Set of dorsal digital arteries of hand',
  FJ2346: 'Set of dorsal digital arteries of hand',
  FJ2185: 'Set of dorsal digital veins of foot',
  FJ2198: 'Set of dorsal digital veins of foot',
  FJ2100: 'Set of perforating veins of foot',
  FJ2119: 'Set of perforating veins of foot',
  FJ2138: 'Set of perforating veins of foot',
  FJ2174: 'Set of perforating veins of foot',
  FJ3376: 'Lateral sesamoid bone of right big toe',
};

// Bones BodyParts3D lacks, taken from Z-Anatomy (CC BY-SA 4.0) by
// scripts/extract-z-anatomy.py. Each is translated so its recorded anchor
// (e.g. the sacrum's apex in Z-Anatomy) lands on the same point of the named
// BodyParts3D element; the two models share BodyParts3D's scale.
const Z_ANATOMY_DIR = join(ROOT, 'data-sources', 'z-anatomy');
const Z_ANATOMY_ANCHORS = { Sacrum: 'FJ3393', 'Temporal bone.l': 'FJ3281', 'Temporal bone.r': 'FJ3386' };

// The auditory ossicles are CC BY-NC-SA 4.0 (Z-Anatomy adapted them from the
// University of Dundee), so they ship as their own file rather than inside
// skeletal.glb; the Skeletal layer lists it under `extraAssets`.
const OSSICLES = ['malleus', 'incus', 'stapes'].flatMap((b) => [`ossicles/${b}-left.obj`, `ossicles/${b}-right.obj`]);

// Inner-ear nerves Z-Anatomy may have adapted from the University of Dundee's
// CC BY-NC-SA 4.0 "Anatomy of the Inner Ear", so they ship as their own file
// rather than inside nervous.glb; the Nervous layer lists it under `extraAssets`.
const INNER_EAR = /^(left |right )?(cochlear nerve|vestibular nerve|vestibulocochlear nerve \(viii\)|chorda tympani)$/i;

let nervousCache;
const nervousParts = () => (nervousCache ??= loadNervous(join(Z_ANATOMY_DIR, 'nervous'), skeletalBones(), parseObj));

const META_DIR = join(ROOT, '.cache', 'bodyparts3d');

// Circulatory: every element the IS-A tree files under a segment of the
// arterial or venous tree, the heart's own parts from the PART-OF tree (minus
// its coronary vessels, which are arteries or veins), and the few vessels that
// neither tree classifies, recognised by name (e.g. the pulmonary veins and
// the "Set of perforating arteries"). Maps element id → group; the heart is
// split into chamber cavities, walls, and the valve apparatus (cusps, leaflets
// and papillary muscles) so each can be styled on its own.
function heartGroup(name) {
  if (/^wall /i.test(name)) return 'wall';
  if (/cusp|leaflet|papillary/i.test(name)) return 'valve';
  return 'chamber';
}

function circulatoryGroups() {
  const elementsOf = (file, concept) =>
    new Set(
      readFileSync(join(META_DIR, file), 'utf8')
        .split('\n')
        .filter((line) => line.split('\t')[1] === concept)
        .map((line) => line.split('\t')[2].trim()),
    );
  const arteries = elementsOf('isa_element_parts.txt', 'segment of arterial tree organ');
  const veins = elementsOf('isa_element_parts.txt', 'segment of venous tree organ');
  const heart = elementsOf('partof_element_parts.txt', 'heart');
  heart.add('FJ2428'); // "Wall of ventricle" is filed under neither tree
  const groups = new Map();
  for (const file of readdirSync(OBJ_DIR)) {
    const id = file.replace(/\.obj$/, '');
    const name = englishName(id);
    if (arteries.has(id)) groups.set(id, 'artery');
    else if (veins.has(id)) groups.set(id, 'vein');
    else if (heart.has(id)) groups.set(id, heartGroup(name));
    else if (/\b(veins?|venous)\b/i.test(name)) groups.set(id, 'vein');
    else if (/\b(arter|aort)|palmar arch/i.test(name)) groups.set(id, 'artery');
  }
  return groups;
}

const ASSETS = [
  { file: 'skin.glb', elements: [SKIN], ratio: 0.35 },
  { file: 'skeletal.glb', elements: range(3152, 3395), extras: ['coccyx.obj'], ratio: 0.5 },
  { file: 'skeletal-ossicles.glb', elements: [], extras: OSSICLES, ratio: 0.5 },
  // BodyParts3D has no spinal cord or peripheral nerves and only part of the
  // cortex, so the whole system comes from Z-Anatomy (see nervous-model.mjs).
  { file: 'nervous.glb', elements: [], load: () => nervousParts().filter((p) => !INNER_EAR.test(p.name)), ratio: 0.25 },
  { file: 'nervous-inner-ear.glb', elements: [], load: () => nervousParts().filter((p) => INNER_EAR.test(p.name)), ratio: 0.25 },
  { file: 'circulatory.glb', groups: circulatoryGroups(), mergeByName: true, ratio: 0.2, error: 0.002 },
];

/** BodyParts3D bone positions (mm) by English name, for nervous-model.mjs. */
function skeletalBones() {
  const bones = new Map();
  for (const id of range(3152, 3395).filter((i) => available.has(i))) {
    const obj = parseObj(join(OBJ_DIR, `${id}.obj`));
    bones.set(obj.name, obj.positions);
  }
  return bones;
}

const SIDE_SPLIT_MM = 20;

/**
 * Joins elements that share a name (e.g. the 14 segments of the middle
 * cardiac vein) into one part. A name without "left"/"right" that occurs on
 * both sides of the body (e.g. "Lumbar artery") is split by side instead,
 * with "Left "/"Right " prepended (BodyParts3D's +X is the patient's left).
 */
function mergeByName(objs) {
  const centreX = (o) => {
    let sum = 0;
    for (let i = 0; i < o.positions.length; i += 3) sum += o.positions[i];
    return sum / (o.positions.length / 3) - center[0];
  };
  const xsByName = new Map();
  for (const o of objs) xsByName.set(o.name, [...(xsByName.get(o.name) ?? []), centreX(o)]);
  const merged = new Map();
  for (const o of objs) {
    const xs = xsByName.get(o.name);
    const bilateral =
      !/\b(left|right)\b/i.test(o.name) &&
      Math.max(...xs) > SIDE_SPLIT_MM &&
      Math.min(...xs) < -SIDE_SPLIT_MM;
    const x = centreX(o);
    const name =
      bilateral && Math.abs(x) > SIDE_SPLIT_MM
        ? `${x > 0 ? 'Left' : 'Right'} ${o.name[0].toLowerCase()}${o.name.slice(1)}`
        : o.name;
    const into = merged.get(name);
    if (!into) {
      merged.set(name, { ...o, name, ids: [o.id] });
      continue;
    }
    const base = into.positions.length / 3;
    into.positions = into.positions.concat(o.positions);
    into.indices = into.indices.concat(o.indices.map((i) => i + base));
    into.ids.push(o.id);
  }
  return [...merged.values()];
}

function nameIn(text) {
  return /^# English name : (.*)$/m.exec(text)?.[1].trim() ?? '';
}

/**
 * A few elements (e.g. FJ1656, the right anterior inferior cerebellar artery)
 * have an empty name; their mirror-image twin "<id>M" carries it.
 */
function englishName(id, text = readFileSync(join(OBJ_DIR, `${id}.obj`), 'utf8')) {
  const mirror = join(OBJ_DIR, `${id}M.obj`);
  return nameIn(text) || (existsSync(mirror) ? nameIn(readFileSync(mirror, 'utf8')) : '');
}

function parseObj(path) {
  const text = readFileSync(path, 'utf8');
  const id = /^# File ID : (\S+)$/m.exec(text)?.[1];
  const name = NAME_OVERRIDES[id] ?? englishName(id, text);
  const fma = /^# Concept ID : (\S+)$/m.exec(text)?.[1];
  const anchor = /^# Anchor : (.+) (\S+) (\S+) (\S+) (\S+)$/m.exec(text);
  const positions = [];
  const indices = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) {
      const [, x, y, z] = line.trim().split(/\s+/).map(Number);
      positions.push(x, y, z);
    } else if (line.startsWith('f ')) {
      // Faces are triangles of the form "a//a b//b c//c" (1-based).
      const v = line.trim().split(/\s+/).slice(1).map((t) => parseInt(t, 10) - 1);
      for (let i = 1; i + 1 < v.length; i++) indices.push(v[0], v[i], v[i + 1]);
    }
  }
  return {
    id,
    name,
    fma,
    positions,
    indices,
    anchor: anchor && { element: anchor[1], rule: anchor[2], point: anchor.slice(3).map(Number) },
  };
}

// Anchor rules; each must match anchor() in extract-z-anatomy.py.
const ANCHOR_RULES = {
  // Centroid of the lowest 2% of vertices (by Z).
  lowest(positions) {
    const zs = [];
    for (let i = 0; i < positions.length; i += 3) zs.push(i);
    zs.sort((a, b) => positions[a + 2] - positions[b + 2]);
    const n = Math.max(1, Math.floor(zs.length / 50));
    const c = [0, 0, 0];
    for (const i of zs.slice(0, n)) for (let k = 0; k < 3; k++) c[k] += positions[i + k] / n;
    return c;
  },
  // Centre of the bounding box.
  center(positions) {
    const { min, max } = boundsOf(positions);
    return min.map((m, k) => (m + max[k]) / 2);
  },
};

/** Loads a Z-Anatomy OBJ and moves it (metres → mm) onto the BodyParts3D skeleton. */
function parseZAnatomyObj(file) {
  const obj = parseObj(join(Z_ANATOMY_DIR, file));
  const rule = ANCHOR_RULES[obj.anchor?.rule];
  const element = Z_ANATOMY_ANCHORS[obj.anchor?.element];
  if (!rule || !element) throw new Error(`${file}: unsupported anchor`);
  const target = rule(parseObj(join(OBJ_DIR, `${element}.obj`)).positions);
  const offset = target.map((t, k) => t - obj.anchor.point[k] * 1000);
  obj.positions = obj.positions.map((v, i) => v * 1000 + offset[i % 3]);
  return { ...obj, id: file, source: 'z-anatomy' };
}

function boundsOf(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }
  return { min, max };
}

function computeNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
    const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
    const e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
    const fn = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) n[v + k] += fn[k];
  }
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= len;
    n[i + 1] /= len;
    n[i + 2] /= len;
  }
  return n;
}

const skinBounds = boundsOf(parseObj(join(OBJ_DIR, `${SKIN}.obj`)).positions);
const center = [
  (skinBounds.min[0] + skinBounds.max[0]) / 2,
  (skinBounds.min[1] + skinBounds.max[1]) / 2,
  skinBounds.min[2],
];

// mm, Z-up → m, Y-up, anterior toward +Z.
function transform(positions) {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = (positions[i] - center[0]) / 1000;
    out[i + 1] = (positions[i + 2] - center[2]) / 1000;
    out[i + 2] = -(positions[i + 1] - center[1]) / 1000;
  }
  return out;
}

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
mkdirSync(OUT_DIR, { recursive: true });

const available = new Set(readdirSync(OBJ_DIR).map((f) => f.replace(/\.obj$/, '')));

for (const asset of ASSETS) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene(asset.file.replace(/\.glb$/, ''));
  const material = doc.createMaterial('default');
  const wanted = asset.elements ?? [...asset.groups.keys()].sort();
  const elements = wanted.filter((id) => available.has(id));

  let objs = [
    ...elements.map((id) => ({ ...parseObj(join(OBJ_DIR, `${id}.obj`)), group: asset.groups?.get(id) })),
    ...(asset.extras ?? []).map(parseZAnatomyObj),
    ...(asset.load?.() ?? []),
  ];
  if (asset.mergeByName) objs = mergeByName(objs);

  const addNode = (obj) => {
    const pos = transform(obj.positions);
    const idx = new Uint32Array(obj.indices);
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buffer))
      .setMaterial(material);
    const mesh = doc.createMesh(obj.name).addPrimitive(prim);
    scene.addChild(
      doc.createNode(obj.name).setMesh(mesh).setExtras(
        obj.source === 'z-anatomy'
          ? { name: obj.name, source: 'Z-Anatomy' }
          : { name: obj.name, fma: obj.fma, bp3d: obj.ids?.join(' ') ?? obj.id, ...(obj.group && { group: obj.group }) },
      ),
    );
  };

  // Parts marked `simplify: false` (generated nerve tubes) skip simplification.
  objs.filter((o) => o.simplify !== false).forEach(addNode);
  await doc.transform(
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: asset.ratio, error: asset.error ?? 0.0005 }),
  );
  objs.filter((o) => o.simplify === false).forEach(addNode);

  // Smooth normals after simplification so shading matches the reduced mesh.
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION').getArray();
      const idx = prim.getIndices().getArray();
      prim.setAttribute(
        'NORMAL',
        doc.createAccessor().setType('VEC3').setArray(computeNormals(pos, idx)).setBuffer(buffer),
      );
    }
  }

  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));

  const path = join(OUT_DIR, asset.file);
  await io.write(path, doc);
  const tris = doc
    .getRoot()
    .listMeshes()
    .flatMap((m) => m.listPrimitives())
    .reduce((n, p) => n + p.getIndices().getCount() / 3, 0);
  const missing = wanted.length - elements.length;
  console.log(
    `${asset.file}: ${objs.length} meshes${missing ? ` (${missing} ids absent from dataset)` : ''}, ` +
      `${Math.round(tris).toLocaleString()} triangles, ${(readFileSync(path).length / 1e6).toFixed(2)} MB`,
  );
}
