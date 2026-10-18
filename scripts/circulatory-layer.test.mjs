// Checks that the shipped Circulatory model's great vessels of the neck and
// chest are continuous: BodyParts3D models the carotid, vertebral and
// internal jugular vessels in pieces with gaps of 4 to 6 cm between them,
// which the build bridges from Z-Anatomy (circulatory-model.mjs). Each vessel
// must meet the vessels it runs on from, no part may break into pieces that
// lie apart, and the internal jugular veins must reach the skull base.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { readModel } from './placement.mjs';

// The most mm apart two vessels that join may be. The simplified meshes of
// joined vessels come within about 2.5 mm of each other (BodyParts3D's own
// joins, e.g. the arch of the aorta and the left common carotid); the gaps
// this guards against were 50 mm and more.
const JOIN = 3;

// [vessel, vessel it joins]
const JUNCTIONS = [
  ['Arch of aorta', 'Brachiocephalic artery'],
  ['Arch of aorta', 'Left common carotid artery'],
  ['Arch of aorta', 'Left subclavian artery'],
  ['Brachiocephalic artery', 'Right common carotid artery'],
  ['Brachiocephalic artery', 'Right subclavian artery'],
  ...['Right', 'Left'].flatMap((side) => [
    [`${side} common carotid artery`, `${side} internal carotid artery`],
    [`${side} subclavian artery`, `${side} vertebral artery`],
    [`${side} vertebral artery`, 'Basilar artery'],
    [`${side} internal jugular vein`, `${side} brachiocephalic vein`],
    [`${side} subclavian vein`, `${side} brachiocephalic vein`],
    [`${side} brachiocephalic vein`, 'Superior vena cava'],
  ]),
];

// The bridged vessels, which must each be one continuous vessel.
const BRIDGED = ['Right', 'Left'].flatMap((side) =>
  ['common carotid artery', 'internal carotid artery', 'vertebral artery', 'internal jugular vein'].map((v) => `${side} ${v}`),
);

let vessels;
let skull;
before(async () => {
  const model = (file) => readModel(new URL(`../public/models/${file}`, import.meta.url).pathname);
  vessels = new Map((await model('circulatory.glb')).map((m) => [m.name, m]));
  skull = (await model('skeletal.glb')).filter((m) => /temporal bone$|^occipital bone$/i.test(m.name));
});

const points = ({ positions }) => {
  const out = [];
  for (let i = 0; i < positions.length; i += 3) out.push([positions[i], positions[i + 1], positions[i + 2]]);
  return out;
};

/** The smallest distance (mm) between two point sets. */
function gap(a, b) {
  let best = Infinity;
  for (const p of a)
    for (const q of b) {
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      if (d < best) best = d;
    }
  return Math.sqrt(best);
}

/** A mesh's connected pieces (vertices joined by triangles, matched by position), as point sets. */
function pieces({ positions, indices }) {
  const ids = new Map();
  const id = [];
  for (let i = 0; i < positions.length / 3; i++) {
    const key = `${positions[i * 3].toFixed(3)},${positions[i * 3 + 1].toFixed(3)},${positions[i * 3 + 2].toFixed(3)}`;
    if (!ids.has(key)) ids.set(key, ids.size);
    id.push(ids.get(key));
  }
  const root = [...ids.values()];
  const find = (x) => (root[x] === x ? x : (root[x] = find(root[x])));
  for (let t = 0; t < indices.length; t += 3)
    for (const k of [1, 2]) root[find(id[indices[t + k]])] = find(id[indices[t]]);
  const out = new Map();
  for (let i = 0; i < id.length; i++) {
    const r = find(id[i]);
    if (!out.has(r)) out.set(r, []);
    out.get(r).push([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
  }
  return [...out.values()];
}

test('the great vessels of the neck and chest meet the vessels they run on from', () => {
  for (const [a, b] of JUNCTIONS) {
    assert.ok(vessels.has(a), `${a} is in circulatory.glb`);
    assert.ok(vessels.has(b), `${b} is in circulatory.glb`);
    const d = gap(points(vessels.get(a)), points(vessels.get(b)));
    assert.ok(d <= JOIN, `${a} and ${b} are ${d.toFixed(1)} mm apart (at most ${JOIN} mm)`);
  }
});

test('each bridged neck vessel is one continuous vessel', () => {
  for (const name of BRIDGED) {
    // Overlapping pieces (a bridge inside the cut end it continues) are one;
    // every piece must reach the rest.
    const parts = pieces(vessels.get(name));
    const reached = [parts.shift()];
    while (parts.length) {
      const next = parts.findIndex((p) => reached.some((r) => gap(p, r) <= JOIN));
      assert.ok(next >= 0, `${name} breaks into pieces that lie more than ${JOIN} mm apart`);
      reached.push(...parts.splice(next, 1));
    }
  }
});

test('the internal jugular veins reach the skull base at the jugular foramen', () => {
  const bones = skull.map(points).flat();
  for (const side of ['Right', 'Left']) {
    const d = gap(points(vessels.get(`${side} internal jugular vein`)), bones);
    assert.ok(d <= JOIN, `${side} internal jugular vein stops ${d.toFixed(1)} mm short of the skull base`);
  }
});
