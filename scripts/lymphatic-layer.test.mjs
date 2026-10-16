// Checks the shipped Lymphatic model against its layer data: every mesh in
// public/models/lymphatic.glb must resolve to a group and a description, the
// requested lymphoid organs and node groups must be there on the right sides,
// the tour must name existing parts, the parts the free models lack must be
// listed as not shown, and nothing may lie outside the skin or inside bone
// (check-lymphatic.mjs).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { createServer } from 'vite';
import { BONE_TOLERANCE, SKIN_TOLERANCE, measure } from './check-lymphatic.mjs';

let server;
let layers;
let parts;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

/** Mesh name → { extras, center } (metres) for every mesh node of a model. */
async function readModel(file) {
  const doc = await io.read(new URL(`../public/models/${file}`, import.meta.url).pathname);
  const out = new Map();
  for (const node of doc.getRoot().listNodes().filter((n) => n.getMesh())) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const m = node.getWorldMatrix();
    for (const prim of node.getMesh().listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const v = [];
      for (let i = 0; i < pos.getCount(); i++) {
        const [x, y, z] = pos.getElement(i, v);
        for (let k = 0; k < 3; k++) {
          const w = m[k] * x + m[4 + k] * y + m[8 + k] * z + m[12 + k];
          min[k] = Math.min(min[k], w);
          max[k] = Math.max(max[k], w);
        }
      }
    }
    out.set(node.getExtras().name, { extras: node.getExtras(), center: min.map((v, k) => (v + max[k]) / 2) });
  }
  return out;
}

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  layers = await server.ssrLoadModule('/src/layers.js');
  await MeshoptDecoder.ready;
  parts = await readModel('lymphatic.glb');
});
after(() => server?.close());

const lymphatic = () => layers.LAYERS.find((l) => l.id === 'lymphatic');

test('every lymphatic.glb mesh has a group and a 1-2 sentence description', () => {
  const missing = [];
  for (const [name, { extras }] of parts) {
    const part = layers.partInfo(lymphatic(), name, extras.group);
    const sentences = (part.description ?? '').split(/(?<=[.!?])\s+/).filter(Boolean).length;
    if (!part.group || !part.description || !part.region || sentences > 2) missing.push(`${name}: group=${!!part.group} sentences=${sentences}`);
  }
  assert.deepEqual(missing, []);
});

test('the spleen, thymus, tonsils and the main node groups are there', () => {
  const want = [
    'Spleen', 'Left lobe of thymus', 'Right lobe of thymus', 'Left palatine tonsil', 'Right palatine tonsil',
    'Left submandibular nodes', 'Right jugulodigastric node', 'Left supraclavicular nodes',
    'Left central axillary nodes', 'Right apical axillary nodes', 'Left cubital nodes',
    'Paratracheal thoracic nodes', 'Inferior tracheobronchial nodes', 'Left parasternal nodes',
    'Coeliac nodes', 'Central superior mesenteric nodes', 'Pre-aortic nodes', 'Lateral aortic nodes',
    'Medial common iliac nodes', 'Right medial external iliac nodes', 'Left obturator nodes',
    'Left inferior superficial inguinal nodes', 'Right proximal deep inguinal node', 'Left deep popliteal nodes',
  ];
  assert.deepEqual(want.filter((n) => !parts.has(n)), []);
  assert.ok(parts.size >= 150, `${parts.size} parts`);
  const groups = new Set([...parts.values()].map((p) => p.extras.group));
  assert.deepEqual([...groups].sort(), Object.keys(lymphatic().groups).sort());
});

test('left and right nodes are on their own sides', () => {
  // The spleen lies on the body's left.
  const left = Math.sign(parts.get('Spleen').center[0]);
  const wrong = [...parts].filter(([name, p]) => /^(Left|Right) /.test(name) && !/^(Left|Right) (colic|gastric|gastro-omental) /.test(name))
    .filter(([name, p]) => Math.sign(p.center[0]) !== (name.startsWith('Left') ? left : -left))
    .map(([name]) => name);
  assert.deepEqual(wrong, []);
});

test('the tour names existing parts and says the vessels are not modeled', () => {
  const { tour } = lymphatic();
  assert.deepEqual(tour.stages.flatMap((s) => s.parts).filter((p) => !parts.has(p)), []);
  assert.match(tour.note, /not have|not modeled/);
  for (const stage of tour.stages) assert.ok(stage.caption, stage.name);
});

test('the parts the free models lack are listed as not shown', () => {
  const names = lymphatic().notShown.map((e) => e.name.toLowerCase()).join('\n');
  for (const want of ['lymphatic vessels', 'thoracic duct', 'cisterna chyli', 'adenoids', 'lingual'])
    assert.ok(names.includes(want), want);
});

test('nothing lies outside the skin or inside solid bone', async () => {
  const { skin, bone } = await measure();
  assert.deepEqual(skin.filter((h) => h.distance > SKIN_TOLERANCE).map((h) => `${h.part}: ${h.distance.toFixed(1)} mm out`), []);
  assert.deepEqual(bone.filter((h) => h.depth > BONE_TOLERANCE).map((h) => `${h.part} in ${h.bone}: ${h.depth.toFixed(1)} mm`), []);
});
