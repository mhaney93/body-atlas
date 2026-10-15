// Checks the shipped Digestive model against its layer data: every mesh in
// public/models/digestive.glb must resolve to a group and a description, the
// requested organs must all be there, and the effects and the "Follow the
// food" tour must name parts that exist, with the tour running along tube
// centrelines in order.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { createServer } from 'vite';

let server;
let layers;
let nodes;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  layers = await server.ssrLoadModule('/src/layers.js');
  await MeshoptDecoder.ready;
  const doc = await io.read(new URL('../public/models/digestive.glb', import.meta.url).pathname);
  nodes = new Map(doc.getRoot().listNodes().filter((n) => n.getMesh()).map((n) => [n.getExtras().name, n.getExtras()]));
});
after(() => server?.close());

const digestive = () => layers.LAYERS.find((l) => l.id === 'digestive');

test('every digestive.glb mesh has a group and a 1-2 sentence description', () => {
  const missing = [];
  for (const name of nodes.keys()) {
    const part = layers.partInfo(digestive(), name);
    const sentences = (part.description ?? '').split(/(?<=[.!?])\s+/).filter(Boolean).length;
    if (!part.group || !part.description || sentences > 2) missing.push(`${name}: group=${!!part.group} sentences=${sentences}`);
  }
  assert.deepEqual(missing, []);
});

test('the whole tract and the accessory organs are there', () => {
  const names = [...nodes.keys()];
  const want = [
    'Lips', 'Tongue', 'Left parotid gland', 'Right parotid gland', 'Left submandibular gland', 'Right sublingual gland',
    'Pharynx', 'Esophagus', 'Stomach', 'Duodenum', 'Jejunum', 'Ileum', 'Cecum', 'Appendix', 'Ascending colon',
    'Transverse colon', 'Descending colon', 'Sigmoid colon', 'Rectum', 'Liver', 'Gallbladder', 'Pancreas',
  ];
  assert.deepEqual(want.filter((n) => !names.includes(n)), []);
  assert.equal(names.filter((n) => /(incisor|canine|premolar|molar)$/.test(n)).length, 28);
});

test('hazes are labelled illustrative and cover existing parts', () => {
  for (const effect of digestive().effects) {
    assert.match(effect.note, /^Illustrative effect, not modeled anatomy\./);
    assert.deepEqual(effect.parts.filter((p) => !nodes.has(p)), [], effect.id);
  }
});

test('the tour passes existing parts, joining one centreline to the next', () => {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let end = null;
  for (const stage of digestive().tour.stages) {
    assert.ok(stage.time && stage.seconds > 0, stage.name);
    for (const name of stage.parts) {
      assert.ok(nodes.has(name), `${stage.name}: no ${name}`);
      const line = nodes.get(name).centerline;
      if (!line) continue;
      // Each tube should start (either end) within a few cm of where the previous one ended. The
      // widest gap is the stomach's: the esophagus joins its side, its centreline runs fundus to pylorus.
      const [a, b] = [line[0], line.at(-1)];
      // Food enters each tube at the end nearer the last one's exit; the first enters from above.
      const entry = end ? (dist(end, a) <= dist(end, b) ? a : b) : a[1] > b[1] ? a : b;
      if (end) assert.ok(dist(end, entry) < 0.08, `${name} is ${dist(end, entry).toFixed(3)} m from the previous part`);
      end = entry === a ? b : a;
    }
  }
});
