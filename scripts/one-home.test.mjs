// Every part lives in exactly one body system: its mesh ships in one layer's
// model and only that layer describes it. A layer that leaves out a part
// another system shows says where it lives in its "Not shown" list
// (reason "other-system" with `layer`), rather than showing it too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';
import { MESH_NAMES_FILE } from './mesh-names.mjs';

let server;
let layers;
let meshNames;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  layers = await server.ssrLoadModule('/src/layers.js');
  meshNames = JSON.parse(readFileSync(MESH_NAMES_FILE, 'utf8'));
});
after(() => server?.close());

test('no layer borrows parts from another layer', () => {
  // The old `shared` field showed another layer's meshes as this layer's too.
  assert.deepEqual(layers.LAYERS.filter((l) => 'shared' in l).map((l) => l.id), []);
});

test('every mesh ships in one layer only', () => {
  const homes = new Map();
  for (const [id, names] of Object.entries(meshNames)) {
    for (const name of names) homes.set(name, [...(homes.get(name) ?? []), id]);
  }
  const twice = [...homes].filter(([, ids]) => ids.length > 1);
  assert.deepEqual(twice.map(([name, ids]) => `${name}: ${ids.join(', ')}`), []);
});

test("every part entry describes one of its layer's own meshes", () => {
  const stray = [];
  for (const layer of layers.LAYERS) {
    const own = new Set((meshNames[layer.id] ?? []).flatMap((n) => [n.toLowerCase(), layers.canonical(n)]));
    for (const key of Object.keys(layer.parts)) if (!own.has(key)) stray.push(`${layer.id}: ${key}`);
  }
  assert.deepEqual(stray, []);
});
