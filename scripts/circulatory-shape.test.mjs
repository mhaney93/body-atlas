// Checks that the shipped Circulatory model's vessels keep their smooth tube
// shape. The build moves vessels out of the bones they lie on (settle.mjs);
// moved vertex by vertex, a vessel on a rib was pushed flat and crumpled
// (the left superior intercostal vein became a folded sheet), so the
// circulatory layer is settled by a smooth field instead. A crumpled mesh
// folds back on itself: neighbouring triangles face apart, so this counts
// the edges between two triangles whose normals differ by more than 90°.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { readModel } from './placement.mjs';

// The most of a vessel's edges that may be folded (%). The unsettled vessels
// below fold at up to 1% (simplification leaves a few); crumpled, they
// folded at 6 to 22%.
const VESSEL_FOLDS = 5;
// The most of the whole model's edges that may be folded (%): about 0.85
// unsettled, 1.9 when the vessels were crumpled.
const MODEL_FOLDS = 1.2;

// Vessels lying on bone, which the build moves the most.
const VESSELS = [
  'Azygos vein',
  ...['Left', 'Right'].flatMap((side) =>
    ['superior intercostal vein', 'axillary artery', 'subclavian vein', 'basilic vein', 'popliteal artery', 'great saphenous vein'].map(
      (v) => `${side} ${v}`,
    ),
  ),
];

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

test('vessels lying on bone are not crumpled', () => {
  const crumpled = VESSELS.flatMap((name) => {
    const mesh = vessels.find((m) => m.name === name);
    assert.ok(mesh, `${name} is missing`);
    const { folded, shared } = folds(mesh);
    const share = (100 * folded) / shared;
    return share > VESSEL_FOLDS ? [`${name}: ${share.toFixed(1)}%`] : [];
  });
  assert.deepEqual(crumpled, [], `edges folded (at most ${VESSEL_FOLDS}%)`);
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
