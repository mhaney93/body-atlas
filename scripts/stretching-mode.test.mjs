// Checks Stretching mode's rules (src/stretching.js, src/stretching-mode.js):
// every move a card shows has words, holds are timed where they can be, a
// stretch done once for both sides lights the side it really lengthens,
// coverage counts every muscle the run can stretch and lists the ones it
// can't, and saved progress survives a reload and a broken or blocked store.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

let server;
let s;
let m;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  s = await server.ssrLoadModule('/src/stretching.js');
  m = await server.ssrLoadModule('/src/stretching-mode.js');
});
after(() => server?.close());

const stretch = (id) => s.STRETCHING.stretches.find((st) => st.id === id);

test('every move a stretch card shows is put in words, with the side filled in', () => {
  const bad = [];
  for (const st of s.STRETCHING.stretches)
    for (const v of st.variants)
      for (const code of [...(v.setup ?? []), ...v.moves])
        for (const side of ['left', 'right']) {
          try {
            const { joint, action } = s.describeMove(code, side);
            if (!joint || !action || /[{}]/.test(action)) bad.push(`${code}: ${joint} · ${action}`);
          } catch (e) {
            bad.push(e.message);
          }
        }
  assert.deepEqual(bad, []);
  assert.deepEqual(s.describeMove('hip.flex:80'), { joint: 'Hip', action: 'bend (flexion)', angle: 80 });
  assert.equal(s.describeMove('neck.ext').action, 'bend back (extension)');
  assert.equal(s.describeMove('knee.ext').action, 'straighten (extension)');
  // "Turn the head to the left" is written for the left side; on the right a one-side move reads the other way.
  assert.equal(s.describeMove('neck.roti:50', 'left').action, 'turn to the left');
  assert.equal(s.describeMove('neck.rotc', 'right').action, 'turn to the left');
  // The left eye turning in looks to the right.
  assert.equal(s.describeMove('eye.in', 'left').action, 'look to the right');
  assert.throws(() => s.describeMove('hip.wiggle'), /no words/);
});

test('holds in seconds get a timer; reps and breaths do not', () => {
  assert.deepEqual(s.holdTimer('30 s x 2'), { seconds: 30, rounds: 2 });
  assert.deepEqual(s.holdTimer('5 s x 6'), { seconds: 5, rounds: 6 });
  assert.equal(s.holdTimer('3 slow breaths'), null);
  assert.equal(s.holdTimer('6 reps x 6 / day (Rocabado)'), null);
  assert.equal(s.holdTimer(undefined), null);
  assert.ok(s.STRETCHING.stretches.filter((st) => s.holdTimer(st.hold)).length > 40);
  // The countdown rounds up, so it shows 0:00 only when the hold is over.
  assert.deepEqual([30, 29.2, 59.5, 60, 61, 0.1, 0, -1].map(m.clock), ['0:30', '0:30', '1:00', '1:00', '1:01', '0:01', '0:00', '0:00']);
});

test('a stretch lights the muscles it lengthens on the side it lengthens them', () => {
  // One side at a time: that side.
  assert.deepEqual(s.stretchedSides('semitendinosus', stretch('P1'), stretch('P1').variants[0], 'right'), ['right']);
  // Both legs at once, the same for each: both sides.
  const p4 = stretch('P4');
  assert.ok(s.STRETCHING.muscles['adductor magnus'].actions.length && s.targetsOf(p4, p4.variants[0]).includes('adductor magnus'));
  assert.deepEqual(s.stretchedSides('adductor magnus', p4, p4.variants[0], 'left'), ['left', 'right']);
  // Turning the head to the left lengthens the right splenius capitis (it turns the head to its own side), not the left.
  const n8 = stretch('N8');
  const [toLeft, toRight] = n8.variants;
  assert.ok(s.targetsOf(n8, toLeft).includes('splenius capitis'));
  assert.deepEqual(s.stretchedSides('splenius capitis', n8, toLeft, 'left'), ['right']);
  assert.deepEqual(s.stretchedSides('splenius capitis', n8, toLeft, 'right'), ['right']);
  assert.deepEqual(s.stretchedSides('splenius capitis', n8, toRight, 'left'), ['left']);
  // A lengthen-only muscle has no actions to reverse: both sides.
  const tg1 = stretch('TG1');
  const key = s.targetsOf(tg1, tg1.variants[0])[0];
  assert.deepEqual(s.stretchedSides(key, tg1, tg1.variants[0], 'left'), ['left', 'right']);
});

test('coverage counts every muscle the run can stretch, by section, and lists the rest with reasons', () => {
  const none = s.coverage(new Set());
  const all = (optIn) => new Set(s.runOrder({ optIn }).map(({ ref }) => ref));
  const muscles = Object.values(s.STRETCHING.muscles);
  const cannot = muscles.filter((e) => e.cannot).length;
  assert.equal(none.stretched, 0);
  assert.equal(none.cannot.length, cannot);
  assert.ok(none.cannot.every(({ key, reason }) => s.STRETCHING.muscles[key].cannot === reason));
  // The opt-in sections hold the rest: with them, every muscle that isn't on the cannot list counts.
  assert.equal(none.total + none.optInMore, muscles.length - cannot);
  const full = s.coverage(all(true), { optIn: true });
  assert.deepEqual([full.stretched, full.total, full.optInMore], [muscles.length - cannot, muscles.length - cannot, 0]);
  // The main run alone stretches every muscle it counts.
  const main = s.coverage(all(false));
  assert.equal(main.stretched, main.total);
  assert.ok(main.optInMore > 0);
  // Sections in head-to-toe order, each step counted once; done steps outside the run don't count.
  assert.deepEqual(main.groups.map((g) => g.group), s.GROUPS.filter((g) => main.groups.some((x) => x.group === g)));
  assert.equal(main.groups.reduce((n, g) => n + g.total, 0), s.runOrder().length);
  assert.ok(main.groups.every((g) => g.done === g.total));
  assert.ok(!main.groups.some((g) => ['face', 'eye'].includes(g.group)));
  assert.equal(s.coverage(new Set(['TG1a', 'E1a'])).groups.reduce((n, g) => n + g.done, 0), 0);
  // Half the hamstring stretch is not the hamstrings stretched.
  const some = s.coverage(new Set(['P1a']));
  assert.equal(some.groups.find((g) => g.group === 'hip').done, 1);
});

/** A localStorage stand-in; `fail` makes reads or writes throw as a blocked store does. */
function store({ fail } = {}) {
  const data = new Map();
  return {
    data,
    getItem(k) {
      if (fail === 'read') throw new Error('blocked');
      return data.has(k) ? data.get(k) : null;
    },
    setItem(k, v) {
      if (fail === 'write') throw new Error('quota');
      data.set(k, String(v));
    },
  };
}

test('progress is saved and read back, and a missing, broken or blocked store starts fresh', () => {
  const fresh = { done: new Set(), optIn: false, ref: null, side: 'left' };
  const storage = store();
  assert.deepEqual(m.loadProgress(storage), fresh);
  m.saveProgress(storage, { done: new Set(['N1', 'P1a']), optIn: true, ref: 'P1b', side: 'right' });
  assert.deepEqual(m.loadProgress(storage), { done: new Set(['N1', 'P1a']), optIn: true, ref: 'P1b', side: 'right' });
  // No storage at all, one that throws, or junk in it: a fresh start, never an error.
  assert.deepEqual(m.loadProgress(null), fresh);
  assert.deepEqual(m.loadProgress(store({ fail: 'read' })), fresh);
  assert.doesNotThrow(() => m.saveProgress(store({ fail: 'write' }), fresh));
  assert.doesNotThrow(() => m.saveProgress(null, fresh));
  const junk = store();
  for (const value of ['{not json', '42', '{"done":"N1","optIn":"yes","side":"up"}', '{"done":[1,"N2",null]}']) {
    junk.data.set('body-atlas:stretching', value);
    const p = m.loadProgress(junk);
    assert.equal(p.optIn, false);
    assert.equal(p.side, 'left');
    assert.ok([...p.done].every((ref) => typeof ref === 'string'));
  }
  assert.deepEqual([...m.loadProgress(junk).done], ['N2']);
});

test('the lit meshes are the lengthened side’s: the head turned left lights the right splenius only', async () => {
  const THREE = await import('three');
  const { stretchedMeshes } = await server.ssrLoadModule('/src/stretch-panel.js');
  const group = new THREE.Group();
  for (const name of ['Left splenius capitis', 'Right splenius capitis', 'Left adductor magnus', 'Right adductor magnus']) {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    mesh.userData.name = name;
    group.add(mesh);
  }
  const names = (meshes) => meshes.map((o) => o.userData.name).sort();
  const n8 = stretch('N8');
  // From either side's card, the turn to the left lights the right splenius.
  for (const side of ['left', 'right']) assert.deepEqual(names(stretchedMeshes(group, n8, n8.variants[0], side)), ['Right splenius capitis']);
  const p4 = stretch('P4');
  assert.deepEqual(names(stretchedMeshes(group, p4, p4.variants[0], 'right')), ['Left adductor magnus', 'Right adductor magnus']);
});
