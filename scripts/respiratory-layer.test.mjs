// Checks the shipped Respiratory model against its layer data: every mesh in
// public/models/respiratory.glb must resolve to a group and a description,
// the requested airway parts must all be there, the air-sac haze must name
// existing parts, and the Z-Anatomy parts must sit where the BodyParts3D
// skeleton says they should (lungs inside the rib cage and resting on the
// Muscular layer's diaphragm, nasal cavity and sinuses inside the skull).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { createServer } from 'vite';

let server;
let layers;
let parts;
let bones;
let muscles;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

/** Mesh name → { extras, min, max } (metres) for every mesh node of a model. */
async function readModel(file) {
  const doc = await io.read(new URL(`../public/models/${file}`, import.meta.url).pathname);
  const out = new Map();
  for (const node of doc.getRoot().listNodes().filter((n) => n.getMesh())) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    // Positions are quantized; the node's matrix scales them back to metres.
    const m = node.getWorldMatrix();
    for (const prim of node.getMesh().listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const v = [];
      for (let i = 0; i < pos.getCount(); i++) {
        const [x, y, z] = pos.getElement(i, v);
        for (let k = 0; k < 3; k++) v[k] = m[k] * x + m[4 + k] * y + m[8 + k] * z + m[12 + k];
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], v[k]);
          max[k] = Math.max(max[k], v[k]);
        }
      }
    }
    out.set(node.getExtras().name, { extras: node.getExtras(), min, max });
  }
  return out;
}

/** Union of the bounds of the named meshes. */
function boundsOf(model, test) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const [name, b] of model) {
    if (!test(name)) continue;
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.min[k]);
      max[k] = Math.max(max[k], b.max[k]);
    }
  }
  return { min, max };
}

/** Asserts `inner` lies within `outer`, give or take `slack` metres on each side. */
function assertInside(name, inner, outer, slack) {
  for (let k = 0; k < 3; k++) {
    assert.ok(inner.min[k] >= outer.min[k] - slack && inner.max[k] <= outer.max[k] + slack, `${name} pokes out on axis ${'xyz'[k]}`);
  }
}

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  layers = await server.ssrLoadModule('/src/layers.js');
  await MeshoptDecoder.ready;
  parts = await readModel('respiratory.glb');
  bones = await readModel('skeletal.glb');
  muscles = await readModel('muscular.glb');
});
after(() => server?.close());

const respiratory = () => layers.LAYERS.find((l) => l.id === 'respiratory');

test('every respiratory.glb mesh has a group and a 1-2 sentence description', () => {
  const missing = [];
  for (const name of parts.keys()) {
    const part = layers.partInfo(respiratory(), name);
    const sentences = (part.description ?? '').split(/(?<=[.!?])\s+/).filter(Boolean).length;
    if (!part.group || !part.description || sentences > 2) missing.push(`${name}: group=${!!part.group} sentences=${sentences}`);
  }
  assert.deepEqual(missing, []);
});

test('the airway, the bronchial tree and five lung lobes are there, and the diaphragm is left to Muscular', () => {
  const want = [
    'Nasal cavity', 'Frontal sinus', 'Sphenoidal sinus', 'Left anterior ethmoidal cells', 'Right posterior ethmoidal cells',
    'Nasopharynx', 'Oropharynx', 'Laryngopharynx',
    'Thyroid cartilage', 'Cricoid cartilage', 'Epiglottis', 'Left arytenoid cartilage', 'Right arytenoid cartilage',
    'Trachea', 'Left main bronchus', 'Right main bronchus',
    'Superior lobe of right lung', 'Middle lobe of right lung', 'Inferior lobe of right lung',
    'Superior lobe of left lung', 'Inferior lobe of left lung',
  ];
  const names = [...parts.keys()];
  assert.deepEqual(want.filter((n) => !names.includes(n)), []);
  assert.ok(!names.includes('Diaphragm'));
  assert.ok(respiratory().notShown.some((n) => n.name === 'Diaphragm' && n.layer === 'muscular'));
  assert.equal(names.filter((n) => /lobe of (left|right) lung$/.test(n)).length, 5);
  assert.ok(names.filter((n) => /bronchial tree$/.test(n)).length >= 18, 'segmental bronchial trees');
});

test('the air-sac haze is labelled illustrative and covers the lung lobes', () => {
  const [haze] = respiratory().effects;
  assert.match(haze.note, /^Illustrative effect, not modeled anatomy\./);
  assert.deepEqual(haze.parts.filter((p) => !parts.has(p)), []);
});

test('the Z-Anatomy parts sit inside the BodyParts3D skeleton', () => {
  const ribCage = boundsOf(bones, (n) => / rib$/.test(n));
  for (const name of parts.keys()) {
    if (/lobe of (left|right) lung$/.test(name)) assertInside(name, parts.get(name), ribCage, 0.01);
  }
  const skull = boundsOf(bones, (n) => /^(frontal|occipital|sphenoid) bone$|^(left |right )?maxilla$|^mandible$/i.test(n));
  for (const name of ['Frontal sinus', 'Sphenoidal sinus', 'Left middle ethmoidal cells', 'Nasopharynx']) {
    assertInside(name, parts.get(name), skull, 0.005);
  }
  // The nasal cavity reaches forward into the nose, up to the nostrils.
  const nose = boundsOf(parts, (n) => /nasal cartilage$/.test(n));
  assertInside('Nasal cavity', parts.get('Nasal cavity'), boundsOf(new Map([['skull', skull], ['nose', nose]]), () => true), 0.005);
  // The lungs reach up to the trachea's fork and down to the diaphragm.
  const lungs = boundsOf(parts, (n) => /lobe of (left|right) lung$/.test(n));
  const diaphragm = muscles.get('Diaphragm');
  assert.ok(lungs.min[1] < diaphragm.max[1] && lungs.min[1] > diaphragm.min[1] - 0.02, 'lung bases rest on the diaphragm');
});
