// Checks the shipped Endocrine model against its layer data: every mesh in
// public/models/endocrine.glb must resolve to a group and a description, the
// glands no other layer has must be there on the right sides, the glands
// other layers own must be listed as not shown with where they live, as must
// the parts the free models lack, and nothing may lie outside
// the skin, inside bone or in another system's part (check-placement.mjs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';
import { measure, throughBone } from './check-placement.mjs';
import { MESH_NAMES_FILE } from './mesh-names.mjs';
import { readModel, SKIN_TOLERANCE } from './placement.mjs';

let server;
let layers;
let parts;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  layers = await server.ssrLoadModule('/src/layers.js');
  const meshes = await readModel(new URL('../public/models/endocrine.glb', import.meta.url).pathname);
  parts = new Map(meshes.map((m) => [m.name, m]));
});
after(() => server?.close());

const endocrine = () => layers.LAYERS.find((l) => l.id === 'endocrine');
const sentences = (text) => (text ?? '').split(/(?<=[.!?])\s+/).filter(Boolean).length;
const centreX = ({ positions }) => {
  let sum = 0;
  for (let i = 0; i < positions.length; i += 3) sum += positions[i];
  return sum / (positions.length / 3);
};

test('every endocrine.glb mesh has a group and a 1-2 sentence description', () => {
  const missing = [];
  for (const [name, { extras }] of parts) {
    const part = layers.partInfo(endocrine(), name, extras.group);
    const n = sentences(part.description);
    if (!part.group || !part.description || !part.region || n > 2) missing.push(`${name}: group=${!!part.group} sentences=${n}`);
  }
  assert.deepEqual(missing, []);
});

test('the pituitary lobes, pineal, thyroid, parathyroids and adrenals are there, each side on its own side', () => {
  const paired = ['superior parathyroid gland', 'inferior parathyroid gland', 'adrenal gland'];
  const want = [...paired.flatMap((p) => [`Left ${p}`, `Right ${p}`]), 'Anterior pituitary', 'Posterior pituitary', 'Pineal gland', 'Thyroid gland'];
  assert.deepEqual([...parts.keys()].sort(), want.sort());
  // BodyParts3D's +X is the patient's left, which the build keeps.
  const wrong = paired.flatMap((p) => [
    ...(centreX(parts.get(`Left ${p}`)) > 0 ? [] : [`Left ${p}`]),
    ...(centreX(parts.get(`Right ${p}`)) < 0 ? [] : [`Right ${p}`]),
  ]);
  assert.deepEqual(wrong, []);
});

test('the hypothalamus, thymus, pancreas and testes live in their own layers, and the Not shown list says where', () => {
  const meshNames = JSON.parse(readFileSync(MESH_NAMES_FILE, 'utf8'));
  const homes = [
    ['Hypothalamus', 'nervous', 'Hypothalamus'],
    ['Thymus', 'lymphatic', 'Left lobe of thymus'],
    ['Pancreas', 'digestive', 'Pancreas'],
    ['Testes', 'reproductive', 'Left testis'],
  ];
  for (const [name, layer, mesh] of homes) {
    const entry = endocrine().notShown.find((e) => e.name === name);
    assert.equal(entry?.layer, layer, name);
    assert.match(entry.note, /hormone|insulin|testosterone|thymosin/i, name);
    assert.ok(meshNames[layer].includes(mesh) && !parts.has(mesh), `${mesh} in ${layer} only`);
  }
  // Every group has a gland of its own.
  const groups = new Set([...parts.values()].map((p) => p.extras.group));
  assert.deepEqual([...groups].sort(), Object.keys(endocrine().groups).sort());
});

test('the parts the free models lack, and those other layers show, are listed as not shown', () => {
  const names = endocrine().notShown.map((e) => e.name.toLowerCase()).join('\n');
  for (const want of ['islets', 'hypothalamic nuclei', 'adrenal cortex', 'ovaries', 'kidneys', 'heart']) assert.ok(names.includes(want), want);
  const nervous = layers.LAYERS.find((l) => l.id === 'nervous').notShown.find((e) => /pituitary/i.test(e.name));
  assert.equal(nervous.layer, 'endocrine');
});

test('nothing lies outside the skin, inside solid bone or in another system', async () => {
  const { skin, bone, organ } = await measure({ only: 'endocrine' });
  assert.deepEqual(skin.filter((h) => h.distance > SKIN_TOLERANCE).map((h) => `${h.part}: ${h.distance.toFixed(1)} mm out`), []);
  assert.deepEqual(bone.filter(throughBone).map((h) => `${h.part} in ${h.bone}: ${h.depth.toFixed(1)} mm`), []);
  assert.deepEqual(organ.filter((h) => h.verdict.fail).map((h) => `${h.a.part} / ${h.b.part}: ${h.depth.toFixed(1)} mm`), []);
});
