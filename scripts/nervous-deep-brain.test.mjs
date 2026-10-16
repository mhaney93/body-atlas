// Checks the deep brain structures in public/models/nervous.glb (BodyParts3D
// meshes, plus the Z-Anatomy falx cerebri, tentorium cerebelli and septum
// pellucidum): every one is there with its own description and colour, sits
// inside the brain the layer shows and inside the skull, and the peel-away
// slider can uncover it.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MeshoptDecoder } from 'meshoptimizer';
import { createServer } from 'vite';
import { load } from './check-nerves.mjs';
import { Solid } from './solid.mjs';

const DEEP = [
  'Left thalamus', 'Right thalamus', 'Hypothalamus', 'Left mammillary body', 'Right mammillary body',
  'Left caudate nucleus', 'Right caudate nucleus', 'Left putamen', 'Right putamen',
  'Left globus pallidus', 'Right globus pallidus', 'Left hippocampus', 'Right hippocampus',
  'Left amygdala', 'Right amygdala',
  'Corpus callosum', 'Left internal capsule', 'Right internal capsule', 'Left fornix', 'Right fornix',
  'Commissure of fornix', 'Anterior commissure', 'Posterior commissure', 'Septum pellucidum',
  'Left lateral ventricle', 'Right lateral ventricle', 'Third ventricle', 'Fourth ventricle',
  'Cerebral aqueduct', 'Interventricular foramen', 'Left choroid plexus', 'Right choroid plexus',
];
const COVERINGS = ['Falx cerebri', 'Tentorium cerebelli'];
const CRANIUM = /^(frontal|occipital|sphenoid|ethmoid) bone$|^(left|right) (parietal|temporal) bone$/i;

let server;
let layer;
let partInfo;
let parts;
let cranium;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const layers = await server.ssrLoadModule('/src/layers.js');
  layer = layers.LAYERS.find((l) => l.id === 'nervous');
  partInfo = layers.partInfo;
  await MeshoptDecoder.ready;
  parts = new Map((await load('nervous.glb')).map((p) => [p.name, p]));
  cranium = (await load('skeletal.glb')).filter((b) => CRANIUM.test(b.name));
});
after(() => server?.close());

/** Bounds (mm) of the named parts together. */
function bounds(names) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const name of names) {
    const { positions } = parts.get(name);
    for (let i = 0; i < positions.length; i += 3)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], positions[i + k]);
        max[k] = Math.max(max[k], positions[i + k]);
      }
  }
  return { min, max };
}

const inside = (inner, outer, slack) =>
  [0, 1, 2].every((k) => inner.min[k] >= outer.min[k] - slack && inner.max[k] <= outer.max[k] + slack);

test('every deep brain structure and dura fold is a part of nervous.glb', () => {
  assert.deepEqual([...DEEP, ...COVERINGS].filter((n) => !parts.has(n)), []);
});

test('each has a region, colour, description and a depth the peel slider knows', () => {
  const problems = [];
  for (const name of [...DEEP, ...COVERINGS]) {
    const part = partInfo(layer, name);
    if (!part.region || !part.color || !part.description) problems.push(`${name}: missing info`);
    if (!(part.depth === undefined || (part.depth >= 1 && part.depth <= layer.depthLevels.length))) problems.push(`${name}: depth ${part.depth}`);
  }
  assert.deepEqual(problems, []);
});

test('peeling every level leaves the ventricles, and uncovers everything else in order', () => {
  // Brain surface first, so nothing deep is peeled before the lobes that hide it.
  for (const name of ['Left frontal lobe', 'Right temporal lobe', 'Cerebellum', 'Falx cerebri']) assert.equal(partInfo(layer, name).depth, 1, name);
  for (const name of ['Corpus callosum', 'Left internal capsule']) assert.equal(partInfo(layer, name).depth, 2, name);
  for (const name of ['Left thalamus', 'Right putamen', 'Hypothalamus']) assert.equal(partInfo(layer, name).depth, 3, name);
  for (const name of ['Left lateral ventricle', 'Third ventricle', 'Brainstem', 'Optic chiasm']) assert.equal(partInfo(layer, name).depth, undefined, name);
});

test('the deep structures sit inside the brain the layer shows', () => {
  const brain = bounds([...parts.keys()].filter((n) => /lobe$|insula$|^cerebellum$|^brainstem$/i.test(n)));
  const cerebrum = bounds([...parts.keys()].filter((n) => /lobe$|insula$/i.test(n)));
  const outside = DEEP.filter((n) => !inside(bounds([n]), n === 'Fourth ventricle' ? brain : cerebrum, 1));
  assert.deepEqual(outside, []);
  // Paired parts are on their own side (+x is the body's left).
  for (const name of DEEP.filter((n) => /^(Left|Right) /.test(n))) {
    const { min, max } = bounds([name]);
    const x = (min[0] + max[0]) / 2;
    assert.ok(name.startsWith('Left') ? x > 0 : x < 0, `${name} centre x ${x.toFixed(1)} mm`);
  }
});

test('the deep structures and dura folds are inside the skull and out of its bone', () => {
  const skull = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const { positions } of cranium)
    for (let i = 0; i < positions.length; i += 3)
      for (let k = 0; k < 3; k++) {
        skull.min[k] = Math.min(skull.min[k], positions[i + k]);
        skull.max[k] = Math.max(skull.max[k], positions[i + k]);
      }
  const solids = cranium.map((b) => ({ name: b.name, solid: new Solid(b.positions, b.indices, 4) }));
  const problems = [];
  for (const name of [...DEEP, ...COVERINGS]) {
    if (!inside(bounds([name]), skull, 0)) problems.push(`${name}: outside the skull`);
    const { positions } = parts.get(name);
    for (let i = 0; i < positions.length; i += 3) {
      const p = [positions[i], positions[i + 1], positions[i + 2]];
      const hit = solids.find((b) => b.solid.nearBox(p) && b.solid.contains(p) && b.solid.closest(p).distance > 1);
      if (hit) {
        problems.push(`${name}: in ${hit.name}`);
        break;
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('the not-shown list keeps naming what is still left out of the brain', () => {
  const names = layer.notShown.map((e) => e.name);
  for (const want of ['Substantia nigra', 'Subthalamic nucleus', 'Red nucleus', 'Nucleus accumbens', 'Claustrum', 'Arachnoid and pia mater']) {
    assert.ok(names.includes(want), want);
  }
  for (const gone of ['Thalamus and hypothalamus', 'Hippocampus and amygdala', 'Corpus callosum', 'Ventricles and choroid plexus']) {
    assert.ok(!names.includes(gone), gone);
  }
});
