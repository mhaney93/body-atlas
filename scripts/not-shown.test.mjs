// Every body-system layer must say what it leaves out (`notShown` in its data,
// README "Adding a body system"), so the site never hides parts silently. An
// empty list is allowed only alongside `nothingLeftOut`, a sentence saying why.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

let server;
let layers;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  layers = await server.ssrLoadModule('/src/layers.js');
});
after(() => server?.close());

test('every data file in src/data is a layer in LAYERS', () => {
  const files = readdirSync(new URL('../src/data/', import.meta.url)).filter((f) => f.endsWith('.json'));
  const ids = layers.LAYERS.map((l) => l.id);
  assert.deepEqual(files.map((f) => f.replace(/\.json$/, '')).filter((id) => !ids.includes(id)), []);
});

test('every layer has a not-shown list, empty only when declared', () => {
  for (const layer of layers.LAYERS) {
    assert.ok(Array.isArray(layer.notShown), `${layer.id}: no notShown list`);
    if (!layer.notShown.length) {
      assert.ok(
        typeof layer.nothingLeftOut === 'string' && layer.nothingLeftOut.trim(),
        `${layer.id}: an empty notShown list needs a nothingLeftOut sentence`,
      );
    }
  }
});

test('not-shown entries have a name, a known reason and, for another system, where it lives', () => {
  const reasons = Object.keys(layers.NOT_SHOWN_REASONS);
  const ids = layers.LAYERS.map((l) => l.id);
  const problems = [];
  for (const layer of layers.LAYERS) {
    const names = new Set();
    for (const entry of layer.notShown ?? []) {
      const where = `${layer.id}: ${entry.name}`;
      if (typeof entry.name !== 'string' || !entry.name.trim()) problems.push(`${layer.id}: entry without a name`);
      if (names.has(entry.name)) problems.push(`${where}: listed twice`);
      names.add(entry.name);
      if (!reasons.includes(entry.reason)) problems.push(`${where}: unknown reason "${entry.reason}"`);
      if (entry.layer !== undefined && (!ids.includes(entry.layer) || entry.layer === layer.id)) {
        problems.push(`${where}: layer "${entry.layer}" is not another layer`);
      }
      if (entry.reason === 'other-system' && !entry.layer && !entry.system && !entry.note) {
        problems.push(`${where}: say which system (layer, system or note)`);
      }
      if (entry.reason !== 'other-system' && (entry.layer || entry.system)) {
        problems.push(`${where}: layer/system only go with reason "other-system"`);
      }
      if (layer.parts[entry.name.toLowerCase()]) problems.push(`${where}: the layer shows this part`);
    }
  }
  assert.deepEqual(problems, []);
});
