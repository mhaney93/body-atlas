// Checks the small brain nuclei mapped from the Allen Human Reference Atlas
// into public/models/nervous.glb (scripts/allen-model.mjs): each is there on
// both sides, labelled as approximate, credited to the atlas, inside the part
// that holds it and no more than a millimetre into any shown neighbour.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MeshoptDecoder } from 'meshoptimizer';
import { join } from 'node:path';
import { createServer } from 'vite';
import { NEIGHBOURS, NUCLEI, shapeOf } from './allen-model.mjs';
import { readModel } from './placement.mjs';

const MODELS = join(import.meta.dirname, '..', 'public', 'models');
// mm a nucleus may lie outside its part or inside a neighbour: simplification
// after the fit moves surfaces by a fraction of a millimetre.
const TOLERANCE = 1;
const NAMES = NUCLEI.flatMap((n) => ['Left', 'Right'].map((side) => `${side} ${n.name}`));

let server;
let layers;
let layer;
let parts;
// The parts in the frame the build places the nuclei in (BodyParts3D's: +z
// up, -y forward; the GLB has +y up, +z forward), since how a filled part's
// voxels fall depends on its axes.
let built;
const shape = (name) => shapeOf(built.get(name));

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  layers = await server.ssrLoadModule('/src/layers.js');
  layer = layers.LAYERS.find((l) => l.id === 'nervous');
  await MeshoptDecoder.ready;
  parts = new Map((await readModel(join(MODELS, 'nervous.glb'))).map((p) => [p.name, p]));
  built = new Map(
    [...parts].map(([name, { positions, indices }]) => {
      const out = new Float64Array(positions.length);
      for (let i = 0; i < out.length; i += 3) [out[i], out[i + 1], out[i + 2]] = [positions[i], -positions[i + 2], positions[i + 1]];
      return [name, { positions: out, indices }];
    }),
  );
});
after(() => server?.close());

const vertices = ({ positions }) => Array.from({ length: positions.length / 3 }, (_, i) => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]]);

test('each nucleus is in nervous.glb on both sides, credited to the Allen atlas', () => {
  assert.deepEqual(NAMES.filter((n) => !parts.has(n)), []);
  for (const name of NAMES) assert.equal(parts.get(name).extras.source, 'Allen Human Reference Atlas 3D 2020', name);
  // Only these come from the atlas.
  assert.deepEqual([...parts.values()].filter((p) => p.extras.source?.startsWith('Allen')).map((p) => p.name).sort(), [...NAMES].sort());
});

test('each is labelled as approximate, with a region, colour and description', () => {
  for (const name of NAMES) {
    const part = layers.partInfo(layer, name);
    assert.ok(part.approximate && part.region && part.color && part.description, name);
  }
  assert.equal(layers.APPROXIMATE_LABEL, 'Position approximate (population-average atlas)');
  // No part modelled on this body is labelled approximate.
  for (const name of parts.keys()) if (!NAMES.includes(name)) assert.ok(!layers.partInfo(layer, name).approximate, name);
});

test('the not-shown list no longer names them', () => {
  const names = layer.notShown.map((e) => e.name.toLowerCase());
  for (const { name } of NUCLEI) assert.ok(!names.includes(name), name);
  assert.ok(names.some((n) => n.includes('deep cerebellar nuclei') && n.includes('dentate')), 'the separate deep cerebellar nuclei stay listed');
});

test('each lies inside the part that holds it and on its own side', () => {
  const problems = [];
  for (const { name, within } of NUCLEI)
    for (const side of ['Left', 'Right']) {
      const pts = vertices(built.get(`${side} ${name}`));
      const x = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      if (side === 'Left' ? x <= 0 : x >= 0) problems.push(`${side} ${name}: centre x ${x.toFixed(1)} mm`);
      if (!within) continue;
      const holder = shape(within);
      const out = Math.max(0, ...pts.filter((p) => !holder.encloses(p)).map((p) => holder.closest(p).distance));
      if (out > TOLERANCE) problems.push(`${side} ${name}: ${out.toFixed(1)} mm out of the ${within.toLowerCase()}`);
    }
  assert.deepEqual(problems, []);
});

test('none runs more than a millimetre into a neighbouring part', () => {
  const problems = [];
  for (const { name, within } of NUCLEI)
    for (const side of ['Left', 'Right']) {
      const own = `${side} ${name}`;
      const pts = vertices(built.get(own));
      for (const other of built.keys()) {
        if (other === own || other === within || !NEIGHBOURS.test(other)) continue;
        const neighbour = shape(other);
        let deepest = 0;
        for (const p of pts) if (neighbour.solid.nearBox(p) && neighbour.encloses(p)) deepest = Math.max(deepest, neighbour.closest(p).distance);
        if (deepest > TOLERANCE) problems.push(`${own}: ${deepest.toFixed(1)} mm into ${other}`);
      }
    }
  assert.deepEqual(problems, []);
});

test('they sit where the atlas has them relative to their neighbours', () => {
  const centre = (name) => {
    const pts = vertices(parts.get(name));
    return [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  };
  // +y is up, +z is forward, +x the body's left.
  for (const side of ['Left', 'Right']) {
    const s = (n) => `${side} ${n}`;
    const lateral = (n) => Math.abs(centre(s(n))[0]);
    assert.ok(centre(s('subthalamic nucleus'))[1] < centre(s('thalamus'))[1], 'the subthalamic nucleus is lower than the thalamus');
    assert.ok(centre(s('subthalamic nucleus'))[1] > centre(s('substantia nigra'))[1], 'and above the substantia nigra');
    assert.ok(centre(s('red nucleus'))[2] < centre(s('substantia nigra'))[2], 'the red nucleus is behind the substantia nigra');
    assert.ok(centre(s('inferior olive'))[1] < centre(s('red nucleus'))[1] - 20, 'the inferior olive is down in the medulla');
    assert.ok(centre(s('nucleus accumbens'))[1] < centre(s('caudate nucleus'))[1], 'the nucleus accumbens is below the caudate');
    assert.ok(lateral('claustrum') > lateral('putamen') && lateral('claustrum') < lateral('insula'), 'the claustrum is between the putamen and the insula');
    assert.ok(lateral('deep cerebellar nuclei') > 5, 'the deep cerebellar nuclei are off the midline');
  }
});
