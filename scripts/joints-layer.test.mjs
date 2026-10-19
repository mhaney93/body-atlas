// Checks the shipped Joints & connective tissue model against its layer data:
// every mesh in public/models/joints.glb must resolve to a name, a sub-group
// and a description, and the discs and costal cartilages Skeletal owns must be
// listed as not shown.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { createServer } from 'vite';

let server;
let layers;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

/** Original mesh names in a shipped model (the glTF node extra, else the node name). */
async function meshNames(file) {
  await MeshoptDecoder.ready;
  const doc = await io.read(new URL(`../public/models/${file}`, import.meta.url).pathname);
  return doc.getRoot().listNodes().filter((n) => n.getMesh()).map((n) => n.getExtras()?.name ?? n.getName());
}

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  layers = await server.ssrLoadModule('/src/layers.js');
});
after(() => server?.close());

const joints = () => layers.LAYERS.find((l) => l.id === 'joints');
const skeletal = () => layers.LAYERS.find((l) => l.id === 'skeletal');

test('Joints is its own layer, alongside Skeletal', () => {
  assert.equal(joints().name, 'Joints & connective tissue');
  assert.ok(skeletal());
});

test('every joints.glb mesh has a sub-group and a 1-2 sentence description', async () => {
  const names = await meshNames('joints.glb');
  assert.ok(names.length > 50, `only ${names.length} meshes`);
  const missing = [];
  for (const name of names) {
    const part = layers.partInfo(joints(), name);
    const sentences = (part.description ?? '').split(/(?<=[.!?])\s+/).filter(Boolean).length;
    if (!part.group || !part.description || sentences > 3) missing.push(`${name}: group=${!!part.group} sentences=${sentences}`);
  }
  assert.deepEqual(missing, []);
  const groups = new Set(names.map((n) => layers.partGroupId(joints(), n)));
  for (const g of ['ligaments', 'cartilage', 'capsules', 'fascia']) assert.ok(groups.has(g), `no ${g} meshes`);
});

test('ligaments live in Joints, not in the skeletal model, and tendons stay out', async () => {
  const joint = await meshNames('joints.glb');
  assert.ok(joint.some((n) => /ligament/i.test(n)));
  assert.ok(joint.some((n) => /meniscus/i.test(n)));
  assert.ok(!joint.some((n) => /tendon/i.test(n) && !/ligament|sheath|retinacul/i.test(n)), 'a tendon is in joints.glb');
});

test('intervertebral discs and costal cartilages live in Skeletal, and the Not shown list says so', async () => {
  const bones = await meshNames('skeletal.glb');
  const joint = await meshNames('joints.glb');
  assert.ok(bones.some((n) => /intervertebral disk/i.test(n)), 'no discs in skeletal.glb');
  assert.ok(bones.some((n) => /costal cartilage/i.test(n)), 'no costal cartilages in skeletal.glb');
  assert.deepEqual(joint.filter((n) => /intervertebral disk|costal cartilage/i.test(n)), [], 'duplicated in joints.glb');
  for (const name of ['Intervertebral discs', 'Costal cartilages']) {
    assert.equal(joints().notShown.find((e) => e.name === name)?.layer, 'skeletal', name);
  }
});
