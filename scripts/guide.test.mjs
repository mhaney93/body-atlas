// Checks the Guide (src/guide.js) and the reusable stepper it runs on
// (src/stepper.js): every layer's guide visits each clickable part exactly
// once, in a fixed head-to-toe order with paired sides together, and the
// ←/→/Esc keys step it without stealing keys from typing, sliders or the
// browser. Part positions are read from the built GLBs, as the viewer sees them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';
import { MESH_NAMES_FILE } from './mesh-names.mjs';
import { Stepper, stepperKey } from '../src/stepper.js';

const ROOT = new URL('../', import.meta.url);

let server;
let layers;
let guideOrder;
let index;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  ({ LAYERS: layers } = await server.ssrLoadModule('/src/layers.js'));
  ({ guideOrder } = await server.ssrLoadModule('/src/guide.js'));
  const { buildIndex } = await server.ssrLoadModule('/src/search.js');
  const { partInfo } = await server.ssrLoadModule('/src/layers.js');
  index = buildIndex(layers, JSON.parse(readFileSync(MESH_NAMES_FILE, 'utf8')), partInfo);
});
after(() => server?.close());

// --- part positions from the GLBs -------------------------------------------

const multiply = (a, b) => {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
};

/** Column-major matrix of a glTF node's `matrix` or translation/rotation/scale. */
function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** Largest value of a normalized integer accessor component type, which its min/max are stored in. */
const NORMALIZED_MAX = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

/** { name, center } for every mesh node of a .glb: the world centre of its POSITION bounds. */
function glbPartCenters(path) {
  const glb = readFileSync(path);
  const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  const parts = [];
  const visit = (i, parent) => {
    const node = gltf.nodes[i];
    const world = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (const prim of gltf.meshes[node.mesh].primitives) {
        const acc = gltf.accessors[prim.attributes.POSITION];
        const scale = acc.normalized ? NORMALIZED_MAX[acc.componentType] : 1;
        // Every corner of the local box, so a rotated node's box is right too.
        for (const cx of [acc.min[0], acc.max[0]]) for (const cy of [acc.min[1], acc.max[1]]) for (const cz of [acc.min[2], acc.max[2]]) {
          const [x, y, z] = [cx / scale, cy / scale, cz / scale];
          for (let k = 0; k < 3; k++) {
            const v = world[k] * x + world[4 + k] * y + world[8 + k] * z + world[12 + k];
            lo[k] = Math.min(lo[k], v);
            hi[k] = Math.max(hi[k], v);
          }
        }
      }
      const [x, y, z] = lo.map((v, k) => (v + hi[k]) / 2);
      parts.push({ meshName: node.extras?.name ?? node.name, center: { x, y, z } });
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const i of gltf.scenes[gltf.scene ?? 0].nodes) visit(i, identity);
  return parts;
}

/** What Viewer.partCenters returns for a layer: the meshes of its own models. */
const layerParts = (layer) => [layer.asset, ...(layer.extraAssets ?? [])].flatMap((a) => glbPartCenters(new URL(`public/${a}`, ROOT)));

const names = (parts) => parts.map((p) => p.meshName);

/** Same items in a scrambled but repeatable order. */
function shuffled(items, seed = 7) {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// --- guide order ---------------------------------------------------------------

test("every layer's guide visits each clickable part exactly once", () => {
  for (const layer of layers) {
    const order = names(guideOrder(layerParts(layer)));
    assert.equal(new Set(order).size, order.length, `${layer.id}: a part is visited twice`);
    // The search lists every clickable part (scripts/search.test.mjs).
    const clickable = index.filter((e) => e.kind === 'part' && e.layerId === layer.id).map((e) => e.meshName);
    assert.deepEqual([...order].sort(), [...clickable].sort(), `${layer.id}: guide and clickable parts differ`);
    assert.ok(order.length > 0, layer.id);
  }
});

test('the guide order is deterministic whatever order the parts come in', () => {
  for (const layer of layers) {
    const parts = layerParts(layer);
    const order = names(guideOrder(parts));
    assert.deepEqual(names(guideOrder(shuffled(parts))), order, layer.id);
    assert.deepEqual(names(guideOrder([...parts].reverse())), order, layer.id);
  }
});

test('the guide goes head to toe, with left and right sides of a pair together', async () => {
  const { sideOf, sidelessName } = await server.ssrLoadModule('/src/search.js');
  for (const layer of layers) {
    const order = guideOrder(layerParts(layer));
    const key = (p) => (sideOf(p.meshName) ? sidelessName(p.meshName) : p.meshName);
    // Each pair (or single part) is one contiguous run...
    const runs = [];
    for (const p of order) {
      if (runs.at(-1)?.key === key(p)) runs.at(-1).parts.push(p);
      else runs.push({ key: key(p), parts: [p] });
    }
    assert.equal(new Set(runs.map((r) => r.key)).size, runs.length, `${layer.id}: a pair is split up`);
    // ...left before right, and the runs go down the body.
    for (const r of runs) {
      const sides = r.parts.map((p) => sideOf(p.meshName)).filter(Boolean);
      assert.deepEqual(sides, [...sides].sort(), `${layer.id}: ${r.key}`);
    }
    const heights = runs.map((r) => r.parts.reduce((s, p) => s + p.center.y, 0) / r.parts.length);
    for (let i = 1; i < heights.length; i++) assert.ok(heights[i] <= heights[i - 1] + 0.001, `${layer.id}: ${runs[i].key} is above the part before it`);
  }
  const skeletal = names(guideOrder(layerParts(layers.find((l) => l.id === 'skeletal'))));
  assert.ok(skeletal.indexOf('Left femur') < skeletal.indexOf('Left tibia'));
  assert.equal(skeletal.indexOf('Right femur'), skeletal.indexOf('Left femur') + 1);
});

test('ties are broken by name', () => {
  const at = (meshName, y) => ({ meshName, center: { x: 0, y, z: 0 } });
  assert.deepEqual(names(guideOrder([at('Zygoma', 1), at('Atlas', 1), at('Right ulna', 0.9), at('Left ulna', 0.9), at('Sacrum', 0.95)])), [
    'Atlas',
    'Zygoma',
    'Sacrum',
    'Left ulna',
    'Right ulna',
  ]);
});

// --- stepper -------------------------------------------------------------------

const el = (tagName, extra = {}) => ({ tagName, isContentEditable: false, ...extra });
const key = (k, extra = {}) => ({ key: k, target: el('BODY'), preventDefault() {}, ...extra });

function fakeWindow() {
  const listeners = {};
  return {
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
    fire: (type, event) => listeners[type]?.forEach((fn) => fn(event)),
  };
}

test('→, ← and Esc step and end; other keys do nothing', () => {
  assert.equal(stepperKey(key('ArrowRight')), 'next');
  assert.equal(stepperKey(key('ArrowLeft')), 'prev');
  assert.equal(stepperKey(key('Escape')), 'exit');
  for (const k of ['ArrowUp', 'ArrowDown', 'w', 'd', 'Enter', ' ', '/']) assert.equal(stepperKey(key(k)), null, k);
});

test('stepper keys are left to text fields, sliders, menus and browser shortcuts', () => {
  for (const target of [el('INPUT'), el('INPUT', { type: 'search' }), el('TEXTAREA'), el('SELECT'), el('DIV', { isContentEditable: true })]) {
    assert.equal(stepperKey(key('ArrowRight', { target })), null, target.tagName);
  }
  assert.equal(stepperKey(key('ArrowRight', { target: el('INPUT', { type: 'range' }) })), null, 'peel slider');
  assert.equal(stepperKey(key('ArrowLeft', { target: el('INPUT', { type: 'radio' }) })), null, 'radio');
  assert.equal(stepperKey(key('ArrowRight', { target: el('INPUT', { type: 'checkbox' }) })), 'next', 'checkbox');
  assert.equal(stepperKey(key('ArrowRight', { target: el('BUTTON') })), 'next', 'button');
  for (const mod of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) assert.equal(stepperKey(key('ArrowLeft', { [mod]: true })), null, mod);
});

test('the stepper walks the items, stops at either end and can be ended', () => {
  const steps = [];
  let stopped = 0;
  const stepper = new Stepper({ onStep: (item, i, total) => steps.push(`${item}:${i}/${total}`), onStop: () => stopped++ });
  assert.equal(stepper.active, false);
  assert.equal(stepper.next(), false);
  stepper.start(['a', 'b', 'c']);
  assert.equal(stepper.current, 'a');
  assert.equal(stepper.prev(), false);
  stepper.next();
  stepper.next();
  assert.equal(stepper.next(), false);
  stepper.prev();
  assert.deepEqual(steps, ['a:0/3', 'b:1/3', 'c:2/3', 'b:1/3']);
  stepper.stop();
  stepper.stop();
  assert.equal(stopped, 1);
  assert.equal(stepper.active, false);
  stepper.start([]);
  assert.equal(stepper.active, false);
});

test('window keys drive a running stepper and are left alone otherwise', () => {
  const win = fakeWindow();
  const seen = [];
  const stepper = new Stepper({ onStep: (item) => seen.push(item) }).listen(win);
  let prevented = false;
  win.fire('keydown', key('ArrowRight', { preventDefault: () => (prevented = true) }));
  assert.equal(prevented, false, 'not running: the key is the page’s');
  stepper.start(['a', 'b', 'c']);
  win.fire('keydown', key('ArrowRight', { preventDefault: () => (prevented = true) }));
  assert.equal(prevented, true);
  win.fire('keydown', key('ArrowRight', { target: el('INPUT') }));
  win.fire('keydown', key('ArrowRight'));
  win.fire('keydown', key('ArrowLeft'));
  assert.deepEqual(seen, ['a', 'b', 'c', 'b']);
  win.fire('keydown', key('Escape'));
  assert.equal(stepper.active, false);
});

test('subscribers hear every move and the stop', () => {
  const stepper = new Stepper();
  const heard = [];
  stepper.subscribe((s) => heard.push(s.active ? s.index : 'stopped'));
  stepper.start(['a', 'b']);
  stepper.next();
  stepper.stop();
  assert.deepEqual(heard, [0, 1, 'stopped']);
});
