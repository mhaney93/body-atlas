// Checks the shipped Muscular model against its layer data: every muscle in
// public/models/muscular.glb must resolve to a region, a 1-2 sentence
// description, an action and a depth for peeling; every tendon must belong to
// a muscle (or have its own entry); and every movement must name real parts.
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
  const doc = await io.read(new URL('../public/models/muscular.glb', import.meta.url).pathname);
  nodes = doc
    .getRoot()
    .listNodes()
    .filter((n) => n.getMesh())
    .map((n) => ({ name: n.getExtras()?.name ?? n.getName(), ...n.getExtras() }));
});
after(() => server?.close());

const muscular = () => layers.LAYERS.find((l) => l.id === 'muscular');
const sentences = (text) => (text ?? '').split(/(?<=[.!?])\s+/).filter(Boolean).length;

test('every muscle has a region, a 1-2 sentence description, an action and a depth', () => {
  const layer = muscular();
  const muscles = nodes.filter((n) => n.group === 'muscle');
  assert.ok(muscles.length > 400, `only ${muscles.length} muscle meshes`);
  const bad = [];
  for (const n of muscles) {
    const part = layers.partInfo(layer, n.name, n.group);
    const depth = part.depth;
    if (!part.region || !part.flow || sentences(part.description) < 1 || sentences(part.description) > 2 || !(depth >= 1 && depth <= layer.depthLevels.length))
      bad.push(`${n.name}: region=${part.region} flow=${!!part.flow} sentences=${sentences(part.description)} depth=${depth}`);
  }
  assert.deepEqual(bad, []);
});

test('tendons are their own paler parts, each tied to its muscle or described itself', () => {
  const layer = muscular();
  const tendons = nodes.filter((n) => n.group === 'tendon');
  assert.ok(tendons.length > 100, `only ${tendons.length} tendons`);
  const names = new Set(nodes.map((n) => n.name));
  const bad = [];
  for (const n of tendons) {
    if (n.of && !names.has(n.of)) bad.push(`${n.name}: its muscle "${n.of}" is not in the model`);
    const part = layers.partInfo(layer, n.name, n.group, undefined, n.of);
    if (!part.description || !part.region || !part.depth) bad.push(`${n.name}: no description, region or depth`);
  }
  assert.deepEqual(bad, []);
  assert.notEqual(layer.groups.tendon.color, layer.groups.muscle.color);
});

test('no ligaments, and no cardiac or visceral smooth muscle, in the Muscular model', () => {
  assert.deepEqual(
    nodes.filter((n) => /ligament|papillary|myocardium|heart|colon|stomach|intestin|bladder|detrusor/i.test(n.name)).map((n) => n.name),
    [],
  );
});

test('every part key a movement names exists, with prime movers and synergists kept apart', () => {
  const layer = muscular();
  assert.ok(layer.movements.length >= 5);
  const keys = new Set(nodes.map((n) => layers.canonical(n.of ?? n.name)));
  for (const m of layer.movements) {
    assert.ok(m.prime.length, `${m.id} has no prime movers`);
    for (const key of [...m.prime, ...m.synergist]) {
      assert.ok(layer.parts[key], `${m.id}: no part entry "${key}"`);
      assert.ok(keys.has(key), `${m.id}: no mesh for "${key}"`);
    }
    assert.deepEqual(m.prime.filter((k) => m.synergist.includes(k)), [], `${m.id} lists a muscle twice`);
  }
});

test('the fiber haze is labelled as an illustrative effect', () => {
  const haze = muscular().effects.find((e) => e.type === 'fiber-haze');
  assert.match(haze.note, /illustrative/i);
  assert.match(haze.note, /not modeled anatomy/i);
});
