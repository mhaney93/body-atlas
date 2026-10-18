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
    if (!['stretch', 'lengthen', 'joint', 'glide', 'roll'].includes(st.kind)) bad.push(`${st.id}: unknown kind ${st.kind}`);
    if (!st.name || !st.how || !st.hold || !st.variants?.length) bad.push(`${st.id}: needs name, how, hold and variants`);
    if (st.optIn && !s.OPT_IN[st.optIn]) bad.push(`${st.id}: unknown opt-in section ${st.optIn}`);
    const vids = st.variants.map((v) => v.id);
    if (new Set(vids).size !== vids.length || vids.some((v) => !/^[a-z]$/.test(v))) bad.push(`${st.id}: variant ids must be unique letters`);
    for (const v of st.variants) {
      // A rolling card shows a position the model can't take (lying on a roller): words only.
      if (!v.label || (!v.moves?.length && st.kind !== 'roll')) bad.push(`${st.id}${v.id}: needs a label and moves`);
      if (['stretch', 'lengthen'].includes(st.kind) && !s.targetsOf(st, v).length) bad.push(`${st.id}${v.id}: lengthens no muscle`);
    }
  }
  assert.deepEqual(bad, []);
});

test('joint moves, nerve glides and rolling cards name real parts of their layers, with the evidence', () => {
  const extras = s.STRETCHING.stretches.filter((st) => ['joint', 'glide', 'roll'].includes(st.kind));
  const home = { joint: ['joints', 'joint'], glide: ['nervous', 'nerve'], roll: ['joints', 'roll'] };
  const bad = [];
  for (const st of extras) {
    const [layer, group] = home[st.kind];
    if (st.layer !== layer || st.group !== group) bad.push(`${st.id}: a ${st.kind} lives in ${layer}, section ${group}`);
    if (!st.evidence?.trim()) bad.push(`${st.id}: needs an evidence note`);
    // None of these lengthens a muscle toward the muscle coverage.
    if (Object.values(s.STRETCHING.muscles).some((e) => e.stretches?.some((ref) => ref === st.id || ref.startsWith(st.id) && /^[a-z]$/.test(ref.slice(st.id.length)))))
      bad.push(`${st.id}: listed as a muscle's stretch`);
    for (const v of st.variants) {
      const parts = s.partsOf(st, v);
      if (!parts[layer]?.length) bad.push(`${st.id}${v.id}: shows no ${layer} part`);
      for (const [id, keys] of Object.entries(parts)) {
        const known = layers.LAYERS.find((l) => l.id === id)?.parts ?? {};
        for (const key of keys) if (!known[key]) bad.push(`${st.id}${v.id}: no ${id} part "${key}"`);
      }
    }
  }
  assert.deepEqual(bad, []);
  const count = (kind) => extras.filter((st) => st.kind === kind).length;
  assert.deepEqual([count('joint'), count('glide'), count('roll')], [8, 5, 11]);
  // Each glide is a slider first, then a tensioner labelled as the harder option.
  for (const st of extras.filter((x) => x.kind === 'glide')) {
    assert.deepEqual(st.variants.map((v) => v.label.split(/[:,]/)[0]), ['slider', 'tensioner'], st.id);
    assert.match(st.variants[1].label, /only if the slider feels easy/);
    assert.match(st.cue, /never hold/);
  }
  // Rolling is opt-in, and every card says it does not release fascia.
  assert.ok(extras.filter((x) => x.kind === 'roll').every((x) => x.optIn === 'rolling'));
  assert.match(s.ROLLING_NOTE, /does not .break up. fascia/);
});

test('each variant is one pose: no joint moved both ways, and the shin only turns with the knee bent', () => {
  const bad = [];
  for (const st of s.STRETCHING.stretches)
    for (const v of st.variants) {
      const moves = v.moves.map(s.parseMove);
      for (const m of moves)
        if (moves.some((o) => o.joint === m.joint && o.dir === s.OPPOSITE[m.dir])) bad.push(`${st.id}${v.id}: ${m.joint} both ways`);
      if (moves.some((m) => m.joint === 'shin') && !moves.some((m) => m.joint === 'knee' && m.dir === 'flex'))
        bad.push(`${st.id}${v.id}: shin rotation with the knee not bent`);
    }
  assert.deepEqual(bad, []);
});

test('sided is a boolean, and holds leave "each side" to it', () => {
  const bad = [];
  for (const st of s.STRETCHING.stretches) {
    if (/each (side|way)/.test(st.hold)) bad.push(`${st.id}: hold says "${st.hold}"`);
    for (const v of [st, ...st.variants]) if ('sided' in v && typeof v.sided !== 'boolean') bad.push(`${st.id}: sided ${v.sided}`);
  }
  assert.deepEqual(bad, []);
  const sided = (ref) => s.variantsOf(ref).map(({ stretch, variant }) => s.isSided(stretch, variant));
  assert.deepEqual(sided('N2'), [false]);
  assert.deepEqual(sided('P1'), [true, true, true]);
  assert.deepEqual(sided('P4'), [false, false, true]);
});

test('a pose done once for both sides is mirrored for the right side', () => {
  const n8 = s.STRETCHING.stretches.find((st) => st.id === 'N8');
  const [left] = n8.variants;
  assert.equal(s.isSided(n8, left), false);
  assert.deepEqual(s.movesFor(n8, left, 'left'), ['neck.roti:50', 'head.roti:30']);
  assert.deepEqual(s.movesFor(n8, left, 'right'), ['neck.rotc:50', 'head.rotc:30']);
  const p4 = s.STRETCHING.stretches.find((st) => st.id === 'P4');
  assert.deepEqual(s.movesFor(p4, p4.variants[0], 'right'), p4.variants[0].moves);
  const tg1 = s.STRETCHING.stretches.find((st) => st.id === 'TG1');
  for (const side of ['left', 'right']) assert.deepEqual(s.movesFor(tg1, tg1.variants[0], side), ['tongue.out']);
  const e1 = s.STRETCHING.stretches.find((st) => st.id === 'E1');
  assert.deepEqual(s.movesFor(e1, e1.variants.find((v) => v.id === 'c'), 'right'), ['eye.out']);
  // Turning only to the left stretches the left semispinalis capitis's rotation, not the right one's.
  const key = 'semispinalis capitis';
  assert.equal(s.isStretched(key, new Set(['N2', 'N8a'])), false);
  assert.equal(s.isStretched(key, new Set(['N2', 'N8a', 'N8b'])), true);
  const data = { ...s.STRETCHING, muscles: { [key]: { ...s.STRETCHING.muscles[key], stretches: ['N2', 'N8a'] } } };
  assert.deepEqual(s.unreversedActions(key, data), ['neck.rotc']);
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
  // Each opt-in section adds only its own items.
  for (const section of Object.keys(s.OPT_IN)) {
    const added = s.runOrder({ optIn: [section] }).filter((r) => r.stretch.optIn);
    assert.ok(added.length && added.every((r) => r.stretch.optIn === section), section);
  }
  // After the muscle stretches, head to toe: the joint and spine moves, the nerve glides, then rolling.
  assert.deepEqual([...new Set(full.map((ref) => s.variantsOf(ref)[0].stretch.group))].slice(-3), ['joint', 'nerve', 'roll']);
  const groups = main.map((r) => s.GROUPS.indexOf(r.stretch.group));
  assert.deepEqual(groups, [...groups].sort((a, b) => a - b));
  const foot = ['ankle', 'subtalar', 'toes', 'toe-joints', 'toe-spread', 'arch'];
  const leg = [...new Set(main.filter((r) => r.stretch.group === 'leg').map((r) => r.stretch))];
  const touchesFoot = (st) => st.variants.some((v) => v.moves.some((m) => foot.includes(s.parseMove(m).joint)));
  const firstFoot = leg.findIndex(touchesFoot);
  assert.ok(firstFoot > 0 && leg.slice(firstFoot).every(touchesFoot), 'knee-only leg stretches come before the ankle and toes');
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
  // straight-leg raise (P1a) reverses the first two; only the bent-knee shin turn out (C7a) adds the third.
  const key = 'semitendinosus';
  assert.deepEqual(s.unreversedActions(key), []);
  assert.equal(s.isStretched(key, new Set()), false);
  assert.equal(s.isStretched(key, new Set(['P2'])), false);
  assert.equal(s.isStretched(key, new Set(['P1a'])), false);
  assert.equal(s.isStretched(key, new Set(['P1a', 'P1c'])), false);
  assert.equal(s.isStretched(key, new Set(['P1a', 'C7a'])), true);
  assert.equal(s.reverses('knee.flex', ['knee.ext']), true);
  assert.equal(s.reverses('knee.flex', ['hip.flex']), false);
  assert.deepEqual(s.parseMove('hip.flex:80'), { joint: 'hip', dir: 'flex', angle: 80 });
});
