// Checks the shipped Urinary model against its layer data: every mesh in
// public/models/urinary.glb must resolve to a group and a description, the
// kidneys, renal pelves, ureters, bladder and urethra must be there on the
// right sides, each Z-Anatomy renal pelvis must sit in its BodyParts3D kidney,
// the tour must name existing parts, the parts the free models lack must be
// listed as not shown, and nothing may lie outside the skin or inside bone
// (check-placement.mjs).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { createServer } from 'vite';
import { measure, throughBone } from './check-placement.mjs';
import { SKIN_TOLERANCE } from './placement.mjs';

let server;
let layers;
let parts;
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
  parts = await readModel('urinary.glb');
});
after(() => server?.close());

const urinary = () => layers.LAYERS.find((l) => l.id === 'urinary');

test('every urinary.glb mesh has a group and a 1-2 sentence description', () => {
  const missing = [];
  for (const name of parts.keys()) {
    const part = layers.partInfo(urinary(), name);
    const sentences = (part.description ?? '').split(/(?<=[.!?])\s+/).filter(Boolean).length;
    if (!part.group || !part.description || sentences > 2) missing.push(`${name}: group=${!!part.group} sentences=${sentences}`);
  }
  assert.deepEqual(missing, []);
});

test('the kidneys, renal pelves, ureters, bladder and urethra are there', () => {
  const want = [
    'Left kidney', 'Right kidney', 'Left renal pelvis', 'Right renal pelvis',
    'Left ureter', 'Right ureter', 'Urinary bladder', 'Urethra',
  ];
  assert.deepEqual([...parts.keys()].sort(), want.sort());
});

test('left and right parts are on their own sides, the bladder and urethra in the middle', () => {
  // BodyParts3D's +X is the patient's left, which the build keeps as +X.
  for (const [name, p] of parts) {
    if (name.startsWith('Left ')) assert.ok(p.center[0] > 0.02, name);
    else if (name.startsWith('Right ')) assert.ok(p.center[0] < -0.02, name);
    else assert.ok(Math.abs(p.center[0]) < 0.01, name);
  }
});

test('each renal pelvis sits in its kidney, and each ureter runs down to the bladder', () => {
  for (const side of ['Left', 'Right']) {
    const kidney = parts.get(`${side} kidney`);
    const pelvis = parts.get(`${side} renal pelvis`);
    // Inside the kidney's bounds, apart from where it leaves the hilum
    // toward the ureter (on the midline side, within 1 cm).
    for (let k = 0; k < 3; k++) {
      const slack = k === 0 ? 0.01 : 0.002;
      assert.ok(pelvis.min[k] >= kidney.min[k] - slack && pelvis.max[k] <= kidney.max[k] + slack, `${side} renal pelvis on axis ${'xyz'[k]}`);
    }
    const ureter = parts.get(`${side} ureter`);
    assert.ok(ureter.max[1] > pelvis.min[1] && ureter.min[1] < parts.get('Urinary bladder').max[1], `${side} ureter runs from the kidney to the bladder`);
  }
  assert.ok(parts.get('Urethra').max[1] > parts.get('Urinary bladder').min[1] - 0.03, 'the urethra starts below the bladder');
});

test('the tour names existing parts and gives each stage a caption', () => {
  const { tour } = urinary();
  assert.deepEqual(tour.stages.flatMap((s) => s.parts).filter((p) => !parts.has(p)), []);
  for (const stage of tour.stages) assert.ok(stage.caption, stage.name);
});

test('the parts the free models lack are listed as not shown', () => {
  const names = urinary().notShown.map((e) => e.name.toLowerCase()).join('\n');
  for (const want of ['cortex', 'nephrons', 'renal arteries', 'adrenal', 'prostate', 'sphincter'])
    assert.ok(names.includes(want), want);
});

test('nothing lies outside the skin or inside solid bone', async () => {
  const { skin, bone } = await measure({ only: 'urinary', organs: false });
  assert.deepEqual(skin.filter((h) => h.distance > SKIN_TOLERANCE).map((h) => `${h.part}: ${h.distance.toFixed(1)} mm out`), []);
  assert.deepEqual(bone.filter(throughBone).map((h) => `${h.part} in ${h.bone}: ${h.depth.toFixed(1)} mm`), []);
});
