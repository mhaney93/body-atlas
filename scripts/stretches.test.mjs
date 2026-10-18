// Checks the stretching data (src/stretches.json, read through
// src/stretching.js) against the Muscular layer: every muscle has a stretch,
// is lengthen-only, or says why it can't be stretched; every action of a
// stretchable muscle is reversed by one of its own stretches; every reference,
// joint and direction is real; and the head-to-toe run shows every variant once.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

let server;
let layers;
let s;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  layers = await server.ssrLoadModule('/src/layers.js');
  s = await server.ssrLoadModule('/src/stretching.js');
});
after(() => server?.close());

const muscular = () => layers.LAYERS.find((l) => l.id === 'muscular');

test('every Muscular part has a stretching entry, and nothing else does', () => {
  const parts = Object.keys(muscular().parts).sort();
  const entries = Object.keys(s.STRETCHING.muscles).sort();
  assert.deepEqual(
    { missing: parts.filter((k) => !entries.includes(k)), extra: entries.filter((k) => !parts.includes(k)) },
    { missing: [], extra: [] },
  );
});

test('each entry is a stretch (actions + stretches), lengthen-only, or a reason it cannot be stretched', () => {
  const bad = [];
  for (const [key, e] of Object.entries(s.STRETCHING.muscles)) {
    if ('cannot' in e) {
      if (typeof e.cannot !== 'string' || !e.cannot.trim() || e.stretches || e.actions) bad.push(`${key}: cannot needs a reason and nothing else`);
    } else if (e.lengthenOnly) {
      if (!e.stretches?.length || e.actions) bad.push(`${key}: lengthen-only needs stretches and no actions`);
    } else if (!e.actions?.length || !e.stretches?.length) {
      bad.push(`${key}: needs actions and stretches`);
    }
  }
  assert.deepEqual(bad, []);
});

test('every stretch reference names a real variant', () => {
  const bad = [];
  for (const [key, e] of Object.entries(s.STRETCHING.muscles))
    for (const ref of e.stretches ?? []) if (!s.variantsOf(ref).length) bad.push(`${key}: ${ref}`);
  assert.deepEqual(bad, []);
});

test('moves and actions use known joints, and stretch directions have an opposite', () => {
  const { joints, stretches, muscles } = s.STRETCHING;
  const bad = [];
  const check = (where, code, needOpposite) => {
    const { joint, dir } = s.parseMove(code);
    if (!joints[joint]) bad.push(`${where}: unknown joint in "${code}"`);
    if (needOpposite && !s.OPPOSITE[dir]) bad.push(`${where}: "${code}" has no opposite direction`);
  };
  for (const st of stretches)
    for (const v of st.variants) for (const m of v.moves) check(`${st.id}${v.id}`, m, st.kind === 'stretch');
  for (const [key, e] of Object.entries(muscles)) for (const a of e.actions ?? []) check(key, a, true);
  assert.deepEqual(bad, []);
});

test('every action of a stretchable muscle is reversed by one of its own stretches', () => {
  const bad = Object.keys(s.STRETCHING.muscles).flatMap((key) => s.unreversedActions(key).map((a) => `${key}: ${a}`));
  assert.deepEqual(bad, []);
});

test('stretches have unique ids, a known section and kind, and every variant lengthens some muscle', () => {
  const ids = new Set();
  const bad = [];
  for (const st of s.STRETCHING.stretches) {
    if (ids.has(st.id)) bad.push(`${st.id}: duplicate id`);
    ids.add(st.id);
    if (!s.GROUPS.includes(st.group)) bad.push(`${st.id}: unknown group ${st.group}`);
    if (!['stretch', 'lengthen'].includes(st.kind)) bad.push(`${st.id}: unknown kind ${st.kind}`);
    if (!st.name || !st.how || !st.hold || !st.variants?.length) bad.push(`${st.id}: needs name, how, hold and variants`);
    const vids = st.variants.map((v) => v.id);
    if (new Set(vids).size !== vids.length || vids.some((v) => !/^[a-z]$/.test(v))) bad.push(`${st.id}: variant ids must be unique letters`);
    for (const v of st.variants) {
      if (!v.label || !v.moves?.length) bad.push(`${st.id}${v.id}: needs a label and moves`);
      if (!s.targetsOf(st, v).length) bad.push(`${st.id}${v.id}: lengthens no muscle`);
    }
  }
  assert.deepEqual(bad, []);
});

test('joint ranges are whole degrees for directions the joint has', () => {
  const bad = [];
  for (const [id, j] of Object.entries(s.STRETCHING.joints)) {
    if (!j.name) bad.push(`${id}: no name`);
    for (const [dir, deg] of Object.entries(j.rom ?? {}))
      if (!s.OPPOSITE[dir] || !Number.isInteger(deg) || deg < 0 || deg > 180) bad.push(`${id}.${dir}: ${deg}`);
  }
  assert.deepEqual(bad, []);
});

test('the run goes head to toe through every variant once, opt-in ones only when asked', () => {
  const all = s.STRETCHING.stretches.flatMap((st) => st.variants.map((v) => s.variantRef(st, v)));
  const full = s.runOrder({ optIn: true }).map((r) => r.ref);
  assert.deepEqual([...full].sort(), [...all].sort());
  assert.equal(new Set(full).size, full.length);
  const main = s.runOrder();
  assert.ok(main.every((r) => !r.stretch.optIn));
  assert.ok(main.length < full.length);
  const groups = main.map((r) => s.GROUPS.indexOf(r.stretch.group));
  assert.deepEqual(groups, [...groups].sort((a, b) => a - b));
});

test('watching the whole run stretches every stretchable muscle; none of the cannot list', () => {
  const seen = new Set(s.runOrder({ optIn: true }).map((r) => r.ref));
  const entries = Object.entries(s.STRETCHING.muscles);
  assert.deepEqual(
    entries.filter(([key, e]) => !e.cannot && !s.isStretched(key, seen)).map(([key]) => key),
    [],
  );
  assert.deepEqual(entries.filter(([key, e]) => e.cannot && s.isStretched(key, seen)).map(([key]) => key), []);
});

test('a two-joint muscle is not counted stretched from a variant that leaves one of its actions alone', () => {
  // Semitendinosus bends the knee, extends the hip and turns the bent knee's shin inward: the
  // straight-leg raise (P1a) reverses the first two; only the foot-out variant (P1c) adds the third.
  const key = 'semitendinosus';
  assert.deepEqual(s.unreversedActions(key), []);
  assert.equal(s.isStretched(key, new Set()), false);
  assert.equal(s.isStretched(key, new Set(['P2'])), false);
  assert.equal(s.isStretched(key, new Set(['P1a'])), false);
  assert.equal(s.isStretched(key, new Set(['P1a', 'P1c'])), true);
  assert.equal(s.reverses('knee.flex', ['knee.ext']), true);
  assert.equal(s.reverses('knee.flex', ['hip.flex']), false);
  assert.deepEqual(s.parseMove('hip.flex:80'), { joint: 'hip', dir: 'flex', angle: 80 });
});
