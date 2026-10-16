// Converts BodyParts3D OBJ meshes (fetched by scripts/fetch-bodyparts3d.mjs)
// into meshopt-compressed GLB files in public/models/, one per asset below.
//
// BodyParts3D is in millimetres with +Z up, -Y anterior and +X patient-left.
// Output is in metres, +Y up, +Z anterior (facing the default camera), with
// the feet resting on y = 0 and the body centred on the vertical axis.
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { meshopt, simplify, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { loadMuscular } from './muscular-model.mjs';
import { loadNervous } from './nervous-model.mjs';
import { settleLymphatic } from './lymphatic-model.mjs';

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
  FJ2539: 'Right main bronchus', // "Right main bronchus proper"
};

// Bones and glands BodyParts3D lacks, taken from Z-Anatomy (CC BY-SA 4.0) by
// scripts/extract-z-anatomy.py. Each is translated so its recorded anchor
// (e.g. the sacrum's apex in Z-Anatomy) lands on the same point of the named
// BodyParts3D element; the two models share BodyParts3D's scale.
const Z_ANATOMY_DIR = join(ROOT, 'data-sources', 'z-anatomy');
const Z_ANATOMY_ANCHORS = {
  Sacrum: 'FJ3393',
  'Temporal bone.l': 'FJ3281',
  'Temporal bone.r': 'FJ3386',
  'Submandibular gland.l': 'FJ2766',
  'Submandibular gland.r': 'FJ2768',
};

// The auditory ossicles are CC BY-NC-SA 4.0 (Z-Anatomy adapted them from the
// University of Dundee), so they ship as their own file rather than inside
// skeletal.glb; the Skeletal layer lists it under `extraAssets`.
const OSSICLES = ['malleus', 'incus', 'stapes'].flatMap((b) => [`ossicles/${b}-left.obj`, `ossicles/${b}-right.obj`]);

// Inner-ear nerves Z-Anatomy may have adapted from the University of Dundee's
// CC BY-NC-SA 4.0 "Anatomy of the Inner Ear", so they ship as their own file
// rather than inside nervous.glb; the Nervous layer lists it under `extraAssets`.
const INNER_EAR = /^(left |right )?(cochlear nerve|vestibular nerve|vestibulocochlear nerve \(viii\)|chorda tympani)$/i;

// Nerves are kept beneath the skin and out of bone as skin.glb and
// skeletal.glb show them: simplifying the skin moves it inward by up to ~3 mm
// at the fingertips. Each is set once that asset is built (they come first).
const shown = new Map();
let nervousCache;
const nervousParts = () =>
  (nervousCache ??= loadNervous(join(Z_ANATOMY_DIR, 'nervous'), skeletalBones(), shown.get('skin.glb')[0], shown.get('skeletal.glb'), parseObj));

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

// The few ligaments, membranes and fascial bands BodyParts3D has (both sides
// where it has two; the "M" files are the left-side mirrors). Z-Anatomy's
// versions of these are left out by scripts/extract-z-anatomy.py.
const CONNECTIVE_TISSUE = [
  'FJ1392', 'FJ1392M', // interosseous membrane of leg
  'FJ1476', 'FJ1476M', // interosseous membrane of forearm
  'FJ1471', 'FJ1471M', // flexor retinaculum of wrist
  'FJ1423', 'FJ1423M', // iliotibial tract
  'FJ1424', 'FJ1424M', // long plantar ligament
  'FJ2763', 'FJ2764', // stylohyoid ligaments
  'FJ2771', 'FJ2807', // hyo-epiglottic and thyro-epiglottic ligaments
  'FJ2779', 'FJ2797', 'FJ2790', // lateral and median thyrohyoid ligaments
  'FJ2786', 'FJ2804', // thyrohyoid membrane
  'FJ2787', 'FJ2805', // vocal ligaments
  'FJ2789', // median cricothyroid ligament
];

// Digestive system. BodyParts3D models the liver, jejunum and ileum as many
// pieces (liver segments, tube segments) and the pharynx as its constrictor
// muscles; each is merged into one clickable part. Its ascending and
// descending colon meshes include the cecum and sigmoid colon, which are cut
// off at an approximate boundary (a horizontal plane, source mm).
const DIGESTIVE = {
  file: 'digestive.glb',
  elements: [
    ...['FJ2814', 'FJ1252', 'FJ1253', ...range(1254, 1281), 'FJ2761'], // lip, gums, 28 teeth, tongue
    ...['FJ2765', 'FJ2767', 'FJ2766', 'FJ2768'], // sublingual and submandibular glands
    ...['FJ2747', 'FJ2759', 'FJ2754', 'FJ2742', 'FJ2740', 'FJ2752'], // pharyngeal constrictors
    ...['FJ2563', 'FJ2564', 'FJ2573', ...range(2574, 2628)], // esophagus, stomach, small intestine
    ...['FJ2565', 'FJ2566', 'FJ2572', 'FJ2567', 'FJ2571', 'FJ2543', 'FJ2548'], // large intestine, anal sphincter
    ...['FJ2816', 'FJ2818', 'FJ2819', 'FJ2820', 'FJ2821', 'FJ2822', 'FJ2409', 'FJ2823', 'FJ2824', 'FJ1858'], // liver
    ...['FJ2817', 'FJ3079', 'FJ3080', 'FJ3096', 'FJ3123', 'FJ1895'], // gallbladder, bile ducts, pancreas
  ],
  extras: ['parotid-gland-left.obj', 'parotid-gland-right.obj'],
  split: [
    { element: 'FJ2566', below: 895, name: 'Cecum' },
    { element: 'FJ2567', below: 880, name: 'Sigmoid colon' },
  ],
  merge: [
    { name: 'Pharynx', elements: ['FJ2747', 'FJ2759', 'FJ2754', 'FJ2742', 'FJ2740', 'FJ2752'] },
    {
      name: 'Liver',
      elements: ['FJ2816', 'FJ2818', 'FJ2819', 'FJ2820', 'FJ2821', 'FJ2822', 'FJ2409', 'FJ2823', 'FJ2824', 'FJ1858'],
    },
    { name: 'Bile ducts', elements: ['FJ3079', 'FJ3080', 'FJ3096', 'FJ3123'] },
    { name: 'External anal sphincter', elements: ['FJ2543', 'FJ2548'] },
    {
      name: 'Jejunum',
      elements: [
        ['FJ2606', 'FJ2617', ...range(2622, 2627)], // proximal
        [...range(2607, 2610), 'FJ2628'], // middle
        [...range(2611, 2616), ...range(2618, 2621)], // distal
      ],
      chain: { startNear: 'FJ2573' },
    },
    {
      name: 'Ileum',
      elements: [
        ['FJ2574', 'FJ2575', 'FJ2585', 'FJ2596', ...range(2600, 2605)], // proximal
        [...range(2576, 2584), 'FJ2586'], // middle
        [...range(2587, 2595), 'FJ2597', 'FJ2598'], // distal
      ],
      chain: { startNear: 'Jejunum' },
    },
  ],
  // "Left lower first secondary molar tooth" → "Left lower first molar".
  rename: (name) =>
    ({ 'Gingiva of upper jaw': 'Upper gum', 'Gingiva of lower jaw': 'Lower gum', Lip: 'Lips' })[name] ??
    name.replace(/ secondary (.+) tooth$/, ' $1'),
  // Parts the "follow the food" pulse travels along, rather than through their centre.
  centerlines: [
    'Esophagus',
    'Stomach',
    'Duodenum',
    'Jejunum',
    'Ileum',
    'Ileocecal junction',
    'Cecum',
    'Ascending colon',
    'Transverse colon',
    'Descending colon',
    'Sigmoid colon',
    'Rectum',
  ],
  ratio: 0.5,
};

// Respiratory system. Element files FJ2441–FJ2541 are the trachea, the main
// bronchi and the segmental bronchial trees (each tree is split into several
// files that share its name, which `mergeByName` joins into one part). The
// lung lobes, nasal cavity, sinuses and pharynx come from Z-Anatomy. The
// vocal ligaments stay in joints.glb.
const RESPIRATORY = {
  file: 'respiratory.glb',
  elements: [
    ...range(2441, 2541),
    'FJ2554', 'FJ2555', 'FJ2556', 'FJ2557', 'FJ2558', // nasal cartilages
    'FJ2808', 'FJ2440', 'FJ2770', // thyroid and cricoid cartilages, epiglottis
    'FJ2775', 'FJ2792', 'FJ2776', 'FJ2793', 'FJ2773', 'FJ2795', // arytenoid, corniculate, cuneiform cartilages
    'FJ2777', 'FJ2794', // conus elasticus
    'FJ3131', // diaphragm
  ],
  load: () => parseRegisteredObjs('respiratory.obj.gz'),
  mergeByName: true,
  ratio: 0.5,
};

// Lymphatic system. BodyParts3D has the spleen and the thymus lobes; the
// lymph nodes and palatine tonsils come from Z-Anatomy, each tagged with its
// body region (the layer's sub-group) by the extract script. `fit` then
// moves any node left in bone or outside the skin (see lymphatic-model.mjs).
const LYMPHATIC = {
  file: 'lymphatic.glb',
  elements: ['FJ2561', 'FJ3150', 'FJ3151'], // spleen, left and right lobes of the thymus
  groups: new Map(['FJ2561', 'FJ3150', 'FJ3151'].map((id) => [id, 'organs'])),
  load: () => parseRegisteredObjs('lymphatic.obj.gz'),
  fit: (objs) => {
    const { moved, stuck } = settleLymphatic(objs, shown.get('skin.glb')[0], shown.get('skeletal.glb'));
    console.log(`  moved ${moved} lymphatic pieces out of bone or back under the skin`);
    if (stuck.length) throw new Error(`could not free: ${stuck.join(', ')}`);
  },
  ratio: 0.5,
};

const ASSETS = [
  { file: 'skin.glb', elements: [SKIN], ratio: 0.35 },
  { file: 'skeletal.glb', elements: range(3152, 3395), extras: ['coccyx.obj'], ratio: 0.5 },
  { file: 'skeletal-ossicles.glb', elements: [], extras: OSSICLES, ratio: 0.5 },
  // BodyParts3D has no spinal cord or peripheral nerves and only part of the
  // cortex, so the whole system comes from Z-Anatomy (see nervous-model.mjs).
  { file: 'nervous.glb', elements: [], load: () => nervousParts().filter((p) => !INNER_EAR.test(p.name)), ratio: 0.25 },
  { file: 'nervous-inner-ear.glb', elements: [], load: () => nervousParts().filter((p) => INNER_EAR.test(p.name)), ratio: 0.25 },
  { file: 'circulatory.glb', groups: circulatoryGroups(), mergeByName: true, ratio: 0.2, error: 0.002 },
  // Intervertebral discs and costal cartilages are shared from skeletal.glb
  // at runtime (see "shared" in src/data/joints.json), not duplicated here.
  { file: 'joints.glb', elements: CONNECTIVE_TISSUE, load: () => parseRegisteredObjs('connective-tissue.obj.gz'), ratio: 0.25, error: 0.01 },
  DIGESTIVE,
  // BodyParts3D muscles plus the ones it lacks from Z-Anatomy, with tendons
  // split off (see muscular-model.mjs). Borders stay put so a muscle and its
  // tendon still meet after simplification.
  {
    file: 'muscular.glb',
    elements: [],
    load: () =>
      loadMuscular(
        { objDir: OBJ_DIR, metaDir: META_DIR, zDir: join(Z_ANATOMY_DIR, 'muscular') },
        skeletalBones(),
        shown.get('skeletal.glb'),
        parseObj,
        mergeByName,
      ),
    ratio: 0.08,
    error: 0.004,
    lockBorder: true,
  },
  RESPIRATORY,
  LYMPHATIC,
];

/** BodyParts3D bone meshes (mm) by English name, for nervous-model.mjs. */
function skeletalBones() {
  const bones = new Map();
  for (const id of range(3152, 3395).filter((i) => available.has(i))) {
    const obj = parseObj(join(OBJ_DIR, `${id}.obj`));
    bones.set(obj.name, obj);
  }
  return bones;
}

const SIDE_SPLIT_MM = 20;

/**
 * Joins elements that share a name (e.g. the 14 segments of the middle
 * cardiac vein) into one part. A name without "left"/"right" that occurs on
 * both sides of the body (e.g. "Lumbar artery") is split by side instead,
 * with "Left "/"Right " prepended (BodyParts3D's +X is the patient's left).
 * A bare name that also occurs as "Left …"/"Right …" never stays a third
 * part: if its sides lie apart it joins the nearer one, and if every element
 * sits on the midline (e.g. the superficial dorsal vein of the penis) they
 * all become one unsided part.
 */
function mergeByName(objs) {
  const centreX = (o) => {
    let sum = 0;
    for (let i = 0; i < o.positions.length; i += 3) sum += o.positions[i];
    return sum / (o.positions.length / 3) - center[0];
  };
  const sideOf = (name) => /^(left|right) /i.exec(name)?.[1].toLowerCase();
  const keyOf = (name) => name.replace(/^(left|right) /i, '').toLowerCase();
  const byKey = new Map();
  for (const o of objs) byKey.set(keyOf(o.name), [...(byKey.get(keyOf(o.name)) ?? []), o]);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const nameFor = new Map();
  for (const group of byKey.values()) {
    const bare = group.find((o) => !sideOf(o.name))?.name;
    if (!bare) continue;
    const xs = group.map(centreX);
    const sideX = (side, fallback) => {
      const own = group.filter((o) => sideOf(o.name) === side);
      return own.length ? mean(own.map(centreX)) : fallback;
    };
    const left = sideX('left', SIDE_SPLIT_MM);
    const right = sideX('right', -SIDE_SPLIT_MM);
    const bilateral = group.some((o) => sideOf(o.name))
      ? Math.abs(left - right) > SIDE_SPLIT_MM
      : !/\b(left|right)\b/i.test(bare) && Math.max(...xs) > SIDE_SPLIT_MM && Math.min(...xs) < -SIDE_SPLIT_MM;
    group.forEach((o, i) => {
      if (!bilateral) nameFor.set(o, bare);
      else if (!sideOf(o.name)) {
        const side = Math.abs(xs[i] - left) < Math.abs(xs[i] - right) ? 'Left' : 'Right';
        nameFor.set(o, `${side} ${bare[0].toLowerCase()}${bare.slice(1)}`);
      }
    });
  }
  const merged = new Map();
  for (const o of objs) {
    const name = nameFor.get(o) ?? o.name;
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

/**
 * Loads a gzipped multi-object OBJ written by scripts/extract-z-anatomy.py
 * whose parts are already registered onto BodyParts3D (millimetres).
 */
function parseRegisteredObjs(file) {
  const text = gunzipSync(readFileSync(join(Z_ANATOMY_DIR, file))).toString('utf8');
  const objs = [];
  let obj = null;
  let base = 0;
  let seen = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('o ')) {
      base = seen;
      obj = { id: line.slice(2).trim(), name: null, positions: [], indices: [], source: 'z-anatomy' };
      objs.push(obj);
    } else if (line.startsWith('# English name : ')) {
      obj.name = line.slice('# English name : '.length).trim();
    } else if (line.startsWith('# Group : ')) {
      obj.group = line.slice('# Group : '.length).trim();
    } else if (line.startsWith('v ')) {
      obj.positions.push(...line.trim().split(/\s+/).slice(1).map(Number));
      seen++;
    } else if (line.startsWith('f ')) {
      obj.indices.push(...line.trim().split(/\s+/).slice(1).map((t) => parseInt(t, 10) - 1 - base));
    }
  }
  return objs;
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

// The inverse of transform(): m, Y-up → BodyParts3D mm, Z-up.
function untransform(positions) {
  const out = new Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i] * 1000 + center[0];
    out[i + 1] = -positions[i + 2] * 1000 + center[1];
    out[i + 2] = positions[i + 1] * 1000 + center[2];
  }
  return out;
}

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

/** Dijkstra over mesh edges from `start`; returns the distance (mm) to every vertex (Infinity if unreachable). */
function geodesic(positions, indices, start) {
  const n = positions.length / 3;
  const adj = Array.from({ length: n }, () => []);
  const len = (a, b) =>
    Math.hypot(positions[3 * a] - positions[3 * b], positions[3 * a + 1] - positions[3 * b + 1], positions[3 * a + 2] - positions[3 * b + 2]);
  for (let i = 0; i < indices.length; i += 3) {
    for (const [a, b] of [[indices[i], indices[i + 1]], [indices[i + 1], indices[i + 2]], [indices[i + 2], indices[i]]]) {
      const d = len(a, b);
      adj[a].push(b, d);
      adj[b].push(a, d);
    }
  }
  const dist = new Float64Array(n).fill(Infinity);
  dist[start] = 0;
  const heap = [[0, start]];
  const push = (item) => {
    heap.push(item);
    for (let i = heap.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, v] = pop();
    if (d > dist[v]) continue;
    const edges = adj[v];
    for (let k = 0; k < edges.length; k += 2) {
      const nd = d + edges[k + 1];
      if (nd < dist[edges[k]]) {
        dist[edges[k]] = nd;
        push([nd, edges[k]]);
      }
    }
  }
  return dist;
}

/**
 * Approximate centreline (mm, source frame) of a tube-shaped mesh, running
 * from one end to the other: vertices are bucketed by their distance along the
 * surface from one end, and each bucket's centroid becomes a point.
 */
function centerlineMm(positions, indices, spacing = 12) {
  const farthest = (dist) => dist.reduce((best, d, i) => (d !== Infinity && d > dist[best] ? i : best), 0);
  const start = farthest(geodesic(positions, indices, 0));
  const dist = geodesic(positions, indices, start);
  const total = dist[farthest(dist)];
  const bins = Math.max(2, Math.min(40, Math.round(total / spacing)));
  const sums = Array.from({ length: bins }, () => [0, 0, 0, 0]);
  dist.forEach((d, i) => {
    if (d === Infinity) return;
    const s = sums[Math.min(bins - 1, Math.floor((d / total) * bins))];
    for (let k = 0; k < 3; k++) s[k] += positions[3 * i + k];
    s[3]++;
  });
  return sums.filter((s) => s[3]).map((s) => [s[0] / s[3], s[1] / s[3], s[2] / s[3]]);
}

/** Converts a centreline from source millimetres to the output frame, rounded to 1 mm. */
function toOutputPath(points) {
  const out = transform(points.flat());
  return points.map((_, i) => [0, 1, 2].map((k) => Math.round(out[3 * i + k] * 1000) / 1000));
}

const centerlineOf = (obj) => toOutputPath(centerlineMm(obj.positions, obj.indices));

/**
 * Applies an asset's `split` list: the triangles of `element` whose centroid
 * lies below the horizontal plane z = `below` (source mm) become a new part
 * called `name`.
 */
function applySplits(objs, splits = []) {
  const out = [...objs];
  for (const { element, below, name } of splits) {
    const obj = out.find((o) => o.id === element);
    if (!obj) continue;
    const keep = [];
    const cut = [];
    const { positions: p, indices } = obj;
    for (let i = 0; i < indices.length; i += 3) {
      const z = (p[3 * indices[i] + 2] + p[3 * indices[i + 1] + 2] + p[3 * indices[i + 2] + 2]) / 3;
      (z < below ? cut : keep).push(indices[i], indices[i + 1], indices[i + 2]);
    }
    obj.indices = keep;
    out.push({ ...obj, id: `${element}-below-${below}`, name, fma: undefined, indices: cut });
  }
  // Drop vertices no triangle uses any more (the welder would keep them).
  return out.map((o) => {
    const remap = new Map();
    const positions = [];
    const indices = o.indices.map((i) => {
      if (!remap.has(i)) {
        remap.set(i, remap.size);
        positions.push(o.positions[3 * i], o.positions[3 * i + 1], o.positions[3 * i + 2]);
      }
      return remap.get(i);
    });
    return { ...o, positions, indices };
  });
}

/**
 * Applies an asset's `merge` list: each entry folds several elements into one
 * node called `name`. With `chain`, the pieces are consecutive segments of one
 * tube, listed in order of groups (e.g. proximal, middle, distal); their
 * centrelines are joined into a single path that starts at the end nearest
 * the element `chain.startNear`.
 */
function applyMerges(objs, merges = []) {
  const byId = new Map(objs.map((o) => [o.id, o]));
  const used = new Set();
  const merged = [];
  const pathEnds = new Map(); // merged name → last centreline point (mm)
  for (const { name, elements, chain } of merges) {
    const parts = elements.flat().map((id) => byId.get(id)).filter(Boolean);
    parts.forEach((p) => used.add(p.id));
    const positions = [];
    const indices = [];
    for (const p of parts) {
      const base = positions.length / 3;
      positions.push(...p.positions);
      for (const i of p.indices) indices.push(i + base);
    }
    const obj = { id: parts[0]?.id, ids: parts.flatMap((p) => p.ids ?? [p.id]), name, fma: undefined, positions, indices };
    if (chain) {
      // Start near an element's surface, or at the end of an earlier chain.
      const anchor = pathEnds.get(chain.startNear) ?? byId.get(chain.startNear).positions;
      const nearAnchor = (pt) => {
        let best = Infinity;
        for (let i = 0; i < anchor.length; i += 3) {
          best = Math.min(best, Math.hypot(anchor[i] - pt[0], anchor[i + 1] - pt[1], anchor[i + 2] - pt[2]));
        }
        return best;
      };
      const gap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      const path = [];
      for (const group of elements) {
        const pending = group
          .map((id) => byId.get(id))
          .filter(Boolean)
          .map((p) => centerlineMm(p.positions, p.indices));
        while (pending.length) {
          // Next: the piece with an end closest to where the path is now.
          const score = (line, end) => (path.length ? gap(path.at(-1), end) : nearAnchor(end));
          let best = null;
          pending.forEach((line, i) => {
            for (const flip of [false, true]) {
              const s = score(line, flip ? line.at(-1) : line[0]);
              if (!best || s < best.s) best = { s, i, flip };
            }
          });
          const [line] = pending.splice(best.i, 1);
          path.push(...(best.flip ? line.reverse() : line));
        }
      }
      pathEnds.set(name, path.at(-1));
      obj.centerline = toOutputPath(path);
    }
    merged.push(obj);
  }
  return [...objs.filter((o) => !used.has(o.id)), ...merged];
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
  objs = applyMerges(applySplits(objs, asset.split), asset.merge);
  if (asset.rename) for (const obj of objs) obj.name = asset.rename(obj.name);
  asset.fit?.(objs);

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
      doc.createNode(obj.name).setMesh(mesh).setExtras({
        ...(obj.source === 'z-anatomy'
          ? { name: obj.name, source: 'Z-Anatomy', ...(obj.group && { group: obj.group }), ...(obj.of && { of: obj.of }) }
          : {
              name: obj.name,
              fma: obj.fma,
              bp3d: obj.ids?.join(' ') ?? obj.id,
              ...(obj.group && { group: obj.group }),
              ...(obj.of && { of: obj.of }),
            }),
        ...(asset.centerlines?.includes(obj.name) && { centerline: obj.centerline ?? centerlineOf(obj) }),
      }),
    );
  };

  // Parts marked `simplify: false` (generated nerve tubes) skip simplification.
  objs.filter((o) => o.simplify !== false).forEach(addNode);
  await doc.transform(
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: asset.ratio, error: asset.error ?? 0.0005, lockBorder: asset.lockBorder ?? false }),
  );
  if (asset.file === 'skin.glb' || asset.file === 'skeletal.glb') {
    shown.set(
      asset.file,
      doc.getRoot().listMeshes().map((mesh) => {
        const prim = mesh.listPrimitives()[0];
        return { name: mesh.getName(), positions: untransform(prim.getAttribute('POSITION').getArray()), indices: prim.getIndices().getArray() };
      }),
    );
  }
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
