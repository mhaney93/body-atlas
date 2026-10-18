// Checks the shipped Reproductive model against its layer data: every mesh in
// public/models/reproductive.glb must resolve to a group and a description,
// the organs the free models have must be there on the right sides, the
// parts they lack must be listed as not shown, and nothing may lie outside
// the skin, inside bone or in another system's part (check-placement.mjs).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';
import { measure, throughBone } from './check-placement.mjs';
import { readModel, SKIN_TOLERANCE } from './placement.mjs';

let server;
let layers;
let parts;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  layers = await server.ssrLoadModule('/src/layers.js');
  const meshes = await readModel(new URL('../public/models/reproductive.glb', import.meta.url).pathname);
  parts = new Map(meshes.map((m) => [m.name, m]));
});
after(() => server?.close());

const reproductive = () => layers.LAYERS.find((l) => l.id === 'reproductive');
const centreX = ({ positions }) => {
  let sum = 0;
  for (let i = 0; i < positions.length; i += 3) sum += positions[i];
  return sum / (positions.length / 3);
};

test('every reproductive.glb mesh has a group and a 1-2 sentence description', () => {
  const missing = [];
  for (const [name, { extras }] of parts) {
    const part = layers.partInfo(reproductive(), name, extras.group);
    const sentences = (part.description ?? '').split(/(?<=[.!?])\s+/).filter(Boolean).length;
    if (!part.group || !part.description || !part.region || sentences > 2) missing.push(`${name}: group=${!!part.group} sentences=${sentences}`);
  }
  assert.deepEqual(missing, []);
});

test('the testes, ducts, glands and penis are there, each side on its own side', () => {
  const paired = ['testis', 'epididymis', 'deferent duct', 'ejaculatory duct', 'seminal vesicle'];
  const want = [
    ...paired.flatMap((p) => [`Left ${p}`, `Right ${p}`]),
    'Prostate', 'Corpora cavernosa of penis', 'Corpus spongiosum of penis', 'Glans penis',
  ];
  assert.deepEqual([...parts.keys()].sort(), want.sort());
  const groups = new Set([...parts.values()].map((p) => p.extras.group));
  assert.deepEqual([...groups].sort(), Object.keys(reproductive().groups).sort());
  // BodyParts3D's +X is the patient's left, which the build keeps.
  const wrong = paired.flatMap((p) => [
    ...(centreX(parts.get(`Left ${p}`)) > 0 ? [] : [`Left ${p}`]),
    ...(centreX(parts.get(`Right ${p}`)) < 0 ? [] : [`Right ${p}`]),
  ]);
  assert.deepEqual(wrong, []);
});

test('the parts the free models lack, and those other layers show, are listed as not shown', () => {
  const names = reproductive().notShown.map((e) => e.name.toLowerCase()).join('\n');
  for (const want of ['scrotum', 'bulbourethral', 'urethra', 'spermatic cord', 'testicular arteries'])
    assert.ok(names.includes(want), want);
});

test('nothing lies outside the skin, inside solid bone or in another system', async () => {
  const { skin, bone, organ } = await measure({ only: 'reproductive' });
  assert.deepEqual(skin.filter((h) => h.distance > SKIN_TOLERANCE).map((h) => `${h.part}: ${h.distance.toFixed(1)} mm out`), []);
  assert.deepEqual(bone.filter(throughBone).map((h) => `${h.part} in ${h.bone}: ${h.depth.toFixed(1)} mm`), []);
  assert.deepEqual(organ.filter((h) => h.verdict.fail).map((h) => `${h.a.part} / ${h.b.part}: ${h.depth.toFixed(1)} mm`), []);
});
