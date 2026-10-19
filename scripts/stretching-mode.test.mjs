// Checks Stretching mode's rules (src/stretching.js, src/stretching-mode.js):
// every move a card shows has words, every hold is said in words, a
// stretch done once for both sides lights the side it really lengthens,
// coverage counts every muscle the run can stretch and lists the ones it
// can't, a one-side step is done only once both sides are, and saved progress survives a reload and a broken or blocked store.
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

test('the card says how long to hold each stretch, in words', () => {
  assert.equal(s.holdText({ hold: '30 s x 2', kind: 'stretch' }), 'Hold 30 s, 2 times');
  assert.equal(s.holdText({ hold: '5 s x 6', kind: 'lengthen' }), 'Hold 5 s, 6 times');
  assert.equal(s.holdText({ hold: '60 s x 1', kind: 'roll' }), 'Roll for 60 s');
  assert.equal(s.holdText({ hold: '3 slow breaths', kind: 'lengthen' }), 'Hold for 3 slow breaths');
  assert.equal(s.holdText({ hold: '10 smooth reps', kind: 'glide' }), '10 smooth reps');
  assert.equal(s.holdText({ hold: '6 reps x 6 / day (Rocabado)', kind: 'stretch' }), '6 reps x 6 / day (Rocabado)');
  // Every stretch says how long to hold it.
  for (const st of s.STRETCHING.stretches) assert.ok(s.holdText(st), st.id);
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

test('a one-side step stretches its muscles only once both sides are done', () => {
  const items = s.runOrder();
  const p1a = items.find(({ ref }) => ref === 'P1a');
  assert.ok(s.isSided(p1a.stretch, p1a.variant));
  assert.equal(m.doneEntry(p1a, 'left'), 'P1a:left');
  // Every one-side step of the semitendinosus done on the left only: not stretched; on both sides: stretched.
  const steps = items.filter(({ stretch, variant }) => s.targetsOf(stretch, variant).includes('semitendinosus'));
  assert.ok(steps.length && steps.every((item) => s.isSided(item.stretch, item.variant)));
  const leftOnly = new Set(steps.map((item) => m.doneEntry(item, 'left')));
  assert.equal(s.isStretched('semitendinosus', m.completedSteps(leftOnly)), false);
  assert.ok(s.isStretched('semitendinosus', m.completedSteps(new Set(steps.flatMap(m.entriesOf)))));
  // One side done (stepping past it, or marking it): the step is not done.
  const left = new Set([m.doneEntry(p1a, 'left')]);
  assert.equal(m.completedSteps(left).has('P1a'), false);
  assert.equal(s.coverage(m.completedSteps(left)).groups.find((g) => g.group === 'hip').done, 0);
  // Both sides: done.
  const both = new Set([m.doneEntry(p1a, 'left'), m.doneEntry(p1a, 'right')]);
  assert.ok(m.completedSteps(both).has('P1a'));
  assert.equal(s.coverage(m.completedSteps(both)).groups.find((g) => g.group === 'hip').done, 1);
  // The entries a one-side step needs are both sides'.
  assert.deepEqual(new Set(m.entriesOf(p1a)), both);
  const all = new Set(items.flatMap(m.entriesOf));
  const c = s.coverage(m.completedSteps(all));
  assert.equal(c.stretched, c.total);
  // A step done once for both sides is its ref alone, whatever side is shown.
  const both1 = items.find((item) => !s.isSided(item.stretch, item.variant));
  assert.equal(m.doneEntry(both1, 'right'), both1.ref);
  assert.deepEqual(m.entriesOf(both1), [both1.ref]);
  assert.ok(m.completedSteps(new Set([both1.ref])).has(both1.ref));
  // An older save's bare ref for a one-side step counts for neither side.
  assert.equal(m.completedSteps(new Set(['P1a'])).has('P1a'), false);
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
  const fresh = { done: new Set(), optIn: [], ref: null, side: 'left' };
  const storage = store();
  assert.deepEqual(m.loadProgress(storage), fresh);
  m.saveProgress(storage, { done: new Set(['N1', 'P1a']), optIn: ['rolling'], ref: 'P1b', side: 'right' });
  assert.deepEqual(m.loadProgress(storage), { done: new Set(['N1', 'P1a']), optIn: ['rolling'], ref: 'P1b', side: 'right' });
  // A save from before rolling was opt-in said true for the face, eyes and tongue.
  storage.data.set('body-atlas:stretching', '{"optIn":true}');
  assert.deepEqual(m.loadProgress(storage).optIn, ['lengthen']);
  storage.data.set('body-atlas:stretching', '{"optIn":["rolling","nope","rolling",3]}');
  assert.deepEqual(m.loadProgress(storage).optIn, ['rolling']);
  // No storage at all, one that throws, or junk in it: a fresh start, never an error.
  assert.deepEqual(m.loadProgress(null), fresh);
  assert.deepEqual(m.loadProgress(store({ fail: 'read' })), fresh);
  assert.doesNotThrow(() => m.saveProgress(store({ fail: 'write' }), fresh));
  assert.doesNotThrow(() => m.saveProgress(null, fresh));
  const junk = store();
  for (const value of ['{not json', '42', '{"done":"N1","optIn":"yes","side":"up"}', '{"done":[1,"N2",null]}']) {
    junk.data.set('body-atlas:stretching', value);
    const p = m.loadProgress(junk);
    assert.deepEqual(p.optIn, []);
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

test('an eye step shows the eyeballs with the bones and muscles; other steps leave them off', () => {
  for (const v of stretch('E1').variants) assert.deepEqual(m.layersFor(stretch('E1'), v), ['skeletal', 'muscular', 'senses'], v.id);
  assert.ok(!m.layersFor(stretch('F1'), stretch('F1').variants[0]).includes('senses'));
});

test("an eye muscle's demo lends the Sense organs, and leaves them as the user has them once they take over", async () => {
  const { layerLoan } = await server.ssrLoadModule('/src/stretch-panel.js');
  let on = false;
  let loaded = 0;
  const calls = [];
  const loan = layerLoan({
    isOn: () => on,
    setOn: async (v) => {
      calls.push(v);
      on = v;
    },
    load: async () => loaded++,
  });
  // Played and stopped untouched: the layer goes back off.
  let eyes = loan.borrow();
  await eyes.ready;
  assert.equal(on, true);
  eyes.restore();
  assert.equal(on, false);
  // Clicking an eyeball the demo showed selects it (keep) and then stops the demo: the eyeball stays.
  eyes = loan.borrow();
  await eyes.ready;
  loan.keep();
  eyes.restore();
  assert.equal(on, true);
  // Already on (even still loading): left on, and the demo still waits for the load.
  calls.length = 0;
  eyes = loan.borrow();
  await eyes.ready;
  eyes.restore();
  assert.deepEqual(calls, []);
  assert.equal(loaded, 1);
  // Toggled off and on by the user mid-demo: still theirs.
  on = false;
  eyes = loan.borrow();
  await eyes.ready;
  loan.keep();
  on = false;
  loan.keep();
  on = true;
  eyes.restore();
  assert.equal(on, true);
});
