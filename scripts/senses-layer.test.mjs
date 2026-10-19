// Checks the shipped Sense organs models against their layer data: every mesh
// in public/models/senses.glb and senses-ear.glb must resolve to a group and a
// description, the eye, tear duct, ear and inner-ear parts must be there on
// both sides, the parts inside each eyeball must sit in its sclera and the
// Z-Anatomy ear parts by the ossicles of their side, the parts shared from
// other layers must exist there, the parts the free models lack must be
// listed as not shown, and nothing may lie outside the skin or inside bone
// (check-placement.mjs).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { createServer } from 'vite';
import { measure, outsideSkin, throughBone } from './check-placement.mjs';

let server;
let layers;
let parts;
let ossicles;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

/** Mesh name → { extras, min, max, center } (metres) for every mesh node of a model. */
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
    out.set(node.getExtras().name, { extras: node.getExtras(), min, max, center: min.map((v, k) => (v + max[k]) / 2) });
  }
  return out;
}

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  layers = await server.ssrLoadModule('/src/layers.js');
  await MeshoptDecoder.ready;
  parts = new Map([...(await readModel('senses.glb')), ...(await readModel('senses-ear.glb'))]);
  ossicles = await readModel('skeletal-ossicles.glb');
});
after(() => server?.close());

const senses = () => layers.LAYERS.find((l) => l.id === 'senses');

test('every Sense organs mesh has a group and a 1-2 sentence description', () => {
  const missing = [];
  for (const name of parts.keys()) {
    const part = layers.partInfo(senses(), name, parts.get(name).extras.group);
    const sentences = (part.description ?? '').split(/(?<=[.!?])\s+/).filter(Boolean).length;
    if (!part.group || !part.description || sentences > 2) missing.push(`${name}: group=${!!part.group} sentences=${sentences}`);
  }
  assert.deepEqual(missing, []);
});

test('the eye, tear duct, eyelid, ear and inner-ear parts are there on both sides', () => {
  const sided = [
    'sclera', 'cornea', 'choroid', 'ciliary body', 'iris', 'retina', 'lens', 'vitreous body',
    'lacrimal gland', 'lacrimal lake', 'lacrimal canaliculus', 'lacrimal sac', 'nasolacrimal duct',
    'auricle', 'tympanic membrane', 'auditory tube', 'cochlea', 'vestibule and semicircular canals',
  ];
  const named = [
    'Anterior chamber of {side} eyeball', 'Suspensory ligament of {side} lens',
    'Tarsal plate of {side} upper eyelid', 'Tarsal plate of {side} lower eyelid',
    'Check ligament of {side} lateral rectus', 'Check ligament of {side} medial rectus', 'Trochlea of {side} superior oblique',
  ];
  const want = ['Left', 'Right'].flatMap((Side) => [
    ...sided.map((p) => `${Side} ${p}`),
    ...named.map((p) => p.replace('{side}', Side.toLowerCase())),
  ]);
  assert.deepEqual([...parts.keys()].sort(), want.sort());
});

test('left and right parts are on their own sides', () => {
  // BodyParts3D's +X is the patient's left, which the build keeps as +X.
  for (const [name, p] of parts) assert.ok(/\bleft\b/i.test(name) ? p.center[0] > 0.005 : p.center[0] < -0.005, name);
});

test('the lens, retina, vitreous body and anterior chamber sit inside the sclera of their eye', () => {
  for (const side of ['left', 'right']) {
    const Side = side[0].toUpperCase() + side.slice(1);
    const sclera = parts.get(`${Side} sclera`);
    for (const inner of [`${Side} lens`, `${Side} retina`, `${Side} vitreous body`, `Anterior chamber of ${side} eyeball`]) {
      const p = parts.get(inner);
      for (let k = 0; k < 3; k++) assert.ok(p.min[k] >= sclera.min[k] - 0.002 && p.max[k] <= sclera.max[k] + 0.002, `${inner} on axis ${'xyz'[k]}`);
    }
  }
});

test('each eardrum and inner ear sits by the ossicles of its side', () => {
  // The ear parts and the ossicles are moved onto BodyParts3D by the same
  // temporal-bone offset, so the stapes stays in the vestibule's oval window.
  for (const Side of ['Left', 'Right']) {
    const dist = (a, b) => Math.hypot(...a.center.map((v, k) => v - b.center[k]));
    assert.ok(dist(parts.get(`${Side} tympanic membrane`), ossicles.get(`${Side} malleus`)) < 0.008, `${Side} eardrum by the malleus`);
    assert.ok(dist(parts.get(`${Side} vestibule and semicircular canals`), ossicles.get(`${Side} stapes`)) < 0.01, `${Side} vestibule by the stapes`);
    assert.ok(dist(parts.get(`${Side} cochlea`), ossicles.get(`${Side} stapes`)) < 0.01, `${Side} cochlea by the stapes`);
  }
});

test('the parts shared from other layers exist there', async () => {
  const meshNames = (await import('../src/mesh-names.json', { with: { type: 'json' } })).default;
  // Ossicles; 6 eye muscles, levator, common ring, palpebral orbicularis oculi (+2 levator tendons);
  // optic, vestibular and VIII nerves (+ left cochlear), olfactory nerves and chorda tympani; tongue; nasal cavity.
  const want = { skeletal: 6, muscular: 2 * 9 + 2, nervous: 7 + 2 + 2, digestive: 1, respiratory: 1 };
  for (const id of new Set(senses().shared.map((e) => e.layer))) {
    const matched = meshNames[id].filter((n) => layers.sharedEntry(senses(), id, n));
    assert.equal(matched.length, want[id], `${id}: ${matched.join(', ')}`);
  }
  for (const entry of senses().shared) assert.ok(senses().groups[entry.group], entry.group);
});

test('taste and smell are shown by the tongue, nasal cavity, olfactory nerves and chorda tympani', async () => {
  const meshNames = (await import('../src/mesh-names.json', { with: { type: 'json' } })).default;
  const groupOf = (id, name) => layers.sharedEntry(senses(), id, name)?.group;
  assert.equal(groupOf('digestive', 'Tongue'), 'taste');
  assert.equal(groupOf('respiratory', 'Nasal cavity'), 'smell');
  for (const Side of ['Left', 'Right']) {
    assert.ok(meshNames.nervous.includes(`${Side} olfactory nerve (I)`), `${Side} olfactory nerve`);
    assert.equal(groupOf('nervous', `${Side} olfactory nerve (I)`), 'smell');
    assert.equal(groupOf('nervous', `${Side} chorda tympani`), 'taste');
  }
  // The sense-organ descriptions win over the source layers' ones.
  assert.match(layers.partInfo(senses(), 'Tongue').description, /taste/i);
  assert.match(layers.partInfo(senses(), 'Nasal cavity').description, /smell/i);
});

test('the parts the free models lack are listed as not shown', () => {
  const names = senses().notShown.map((e) => e.name.toLowerCase()).join('\n');
  for (const want of ['conjunctiva', 'macula', 'rods and cones', 'ear canal', 'cochlear duct', 'organ of corti', 'stapedius', 'taste', 'smell', 'touch'])
    assert.ok(names.includes(want), want);
});

test('nothing lies outside the skin or inside solid bone', async () => {
  const { skin, bone } = await measure({ only: 'senses', organs: false });
  assert.deepEqual(skin.filter(outsideSkin).map((h) => `${h.part}: ${h.distance.toFixed(1)} mm out`), []);
  assert.deepEqual(bone.filter(throughBone).map((h) => `${h.part} in ${h.bone}: ${h.depth.toFixed(1)} mm`), []);
});
