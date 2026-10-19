// Checks that the shipped Circulatory model's vessels keep their smooth tube
// shape. The build moves vessels out of the bones they lie on (settle.mjs);
// moved vertex by vertex, a vessel on a rib was pushed flat and crumpled
// (the left superior intercostal vein became a folded sheet), so the
// circulatory layer is settled by a smooth field instead, in which a vessel
// cutting through a bone's edge leaves the bone all on one side (the right
// suprascapular vein, through the clavicle, crumpled as its sides were pulled
// apart). A crumpled mesh folds back on itself: neighbouring triangles face
// apart, so this counts the edges between two triangles whose normals differ
// by more than 90°, on every vessel.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { readModel } from './placement.mjs';

// The most of a vessel's edges that may be folded (%). Simplification leaves
// a few folds, so most vessels fold at up to 3% unsettled; crumpled, they
// folded at 4.4% (right subclavian vein) to 22% (left superior intercostal
// vein).
const VESSEL_FOLDS = 4;
// The most of the whole model's edges that may be folded (%): about 0.85
// unsettled, 1.9 when the vessels were crumpled.
const MODEL_FOLDS = 1.2;

// Vessels whose own BodyParts3D mesh, simplified, already folds more than
// VESSEL_FOLDS (long thin triangles along a thin vessel), each with the most
// it may fold: its share before settling plus a point, rounded up to 0.5.
const SIMPLIFIED = new Map([
  ['Anterior division of right renal artery', 6],
  ['Caudal pancreatic artery', 5.5],
  ['Inferior phrenic vein', 7.5],
  ['Left medial occipital artery', 7],
  ['Left portal vein', 6],
  ['Left posterior inferior cerebellar artery', 7],
  ['Left posterior medial choroidal artery', 5.5],
  ['Left renal vein', 6],
  ['Left set of dorsal digital veins of foot', 7],
  ['Left suprascapular artery', 4.5],
  ['Paracentral branch of left callosomarginal artery', 7],
  ['Paracentral branch of right callosomarginal artery', 6.5],
  ['Posterior cecal artery', 7],
  ['Posterior superior segmental hepatic artery', 7],
  ['Precuneal branch of left pericallosal artery', 7.5],
  ['Precuneal branch of right pericallosal artery', 7],
  ['Right fourth common palmar digital artery', 5.5],
  ['Right inferior phrenic artery', 6.5],
  ['Right medial occipital artery', 8.5],
  ['Right portal vein', 7.5],
  ['Right posterior inferior cerebellar artery', 6.5],
  ['Right set of dorsal digital veins of foot', 6.5],
  ['Splenic artery', 8],
  ['Superior phrenic vein', 13.5],
  ['Temporo-occipital branch of left middle cerebral artery', 9],
  ['Temporo-occipital branch of right middle cerebral artery', 8],
]);

let vessels;
before(async () => {
  vessels = await readModel(new URL('../public/models/circulatory.glb', import.meta.url).pathname);
});

/** A mesh's folded edges and its edges shared by two triangles (vertices matched by position). */
function folds({ positions, indices }) {
  const ids = new Map();
  const id = (i) => {
    const key = `${positions[i * 3].toFixed(3)},${positions[i * 3 + 1].toFixed(3)},${positions[i * 3 + 2].toFixed(3)}`;
    if (!ids.has(key)) ids.set(key, ids.size);
    return ids.get(key);
  };
  const at = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  const normals = [];
  const edges = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [at(indices[t]), at(indices[t + 1]), at(indices[t + 2])];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    normals.push([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
    const corners = [id(indices[t]), id(indices[t + 1]), id(indices[t + 2])];
    for (let e = 0; e < 3; e++) {
      const [x, y] = [corners[e], corners[(e + 1) % 3]].sort((p, q) => p - q);
      const key = x * 4294967296 + y;
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push(t / 3);
    }
  }
  let folded = 0;
  let shared = 0;
  for (const tris of edges.values()) {
    if (tris.length !== 2) continue;
    shared++;
    const [n, m] = tris.map((t) => normals[t]);
    if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < 0) folded++;
  }
  return { folded, shared };
}

test('no vessel is crumpled', () => {
  for (const name of SIMPLIFIED.keys()) assert.ok(vessels.some((m) => m.name === name), `${name} is missing`);
  const crumpled = vessels.flatMap((mesh) => {
    const { folded, shared } = folds(mesh);
    const share = shared ? (100 * folded) / shared : 0;
    const most = SIMPLIFIED.get(mesh.name) ?? VESSEL_FOLDS;
    return share > most ? [`${mesh.name}: ${share.toFixed(1)}% (at most ${most}%)`] : [];
  });
  assert.deepEqual(crumpled, [], 'edges folded');
});

test('the model as a whole is not crumpled', () => {
  let folded = 0;
  let shared = 0;
  for (const mesh of vessels) {
    const f = folds(mesh);
    folded += f.folded;
    shared += f.shared;
  }
  const share = (100 * folded) / shared;
  assert.ok(share <= MODEL_FOLDS, `${share.toFixed(2)}% of edges folded (at most ${MODEL_FOLDS}%)`);
});
