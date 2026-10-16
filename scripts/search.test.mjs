// Checks the part search: matching (src/search.js) against the real layer data,
// the generated mesh-name list it reads (src/mesh-names.json), and what picking
// a result does (src/search-select.js), with a stand-in for the page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';
import { collectMeshNames, MESH_NAMES_FILE, serialize } from './mesh-names.mjs';
import { isTypingTarget, movementKey } from '../src/keyboard-nav.js';
import { editDistance, isSearchShortcut, normalize, search, sidelessName, sideOf } from '../src/search.js';
import { fadeNote, fadeNoteKeeper, frameView, searchSelector } from '../src/search-select.js';

let server;
let layers;
let index;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  layers = await server.ssrLoadModule('/src/layers.js');
  const { buildIndex } = await server.ssrLoadModule('/src/search.js');
  const meshNames = JSON.parse(readFileSync(MESH_NAMES_FILE, 'utf8'));
  index = buildIndex(layers.LAYERS, meshNames, layers.partInfo);
});
after(() => server?.close());

const top = (query, n = 1) => search(index, query).slice(0, n);
const label = (e) => `${e.kind}/${e.layerId}/${e.name}${e.side ? `/${e.side}` : ''}`;

test('src/mesh-names.json matches the models (run `npm run mesh-names`)', () => {
  assert.equal(readFileSync(MESH_NAMES_FILE, 'utf8'), serialize(collectMeshNames()));
});

test('names are compared without case, accents or punctuation', () => {
  assert.equal(normalize('  Malléus, LEFT! '), 'malleus left');
  assert.equal(normalize('Vagus nerve (X)'), 'vagus nerve x');
});

test('a paired part is found by its side-less name', () => {
  assert.equal(sideOf('Navicular bone of left foot'), 'left');
  assert.equal(sideOf('Spinal cord'), null);
  assert.equal(sidelessName('Navicular bone of left foot'), 'Navicular bone of foot');
  assert.equal(sidelessName('Right femur'), 'Femur');
});

test('a name whose side words disagree keeps its full name and gets no side', () => {
  const name = 'First right anterior branch of anterior interventricular branch of left coronary artery';
  assert.equal(sideOf(name), null);
  const [hit] = top('first right anterior branch');
  assert.equal(label(hit), `part/circulatory/${name}`);
  for (const n of ['Second', 'Third']) {
    const entry = index.find((e) => e.meshName === `${n} right anterior branch of anterior interventricular branch of left coronary artery`);
    assert.equal(entry.side, null);
    assert.equal(entry.name, entry.meshName);
  }
  // Side words that agree still name the side.
  const lobe = index.find((e) => e.meshName === 'Left lobe branch of left hepatic artery');
  assert.equal(lobe.side, 'left');
  assert.equal(lobe.name, 'Lobe branch of hepatic artery');
});

test('the faded-parts note follows the current count and goes away at zero', () => {
  assert.equal(fadeNote(0), null);
  assert.deepEqual(fadeNote(1), { text: 'One part in front of it is faded so you can see it.', action: 'Show it' });
  assert.deepEqual(fadeNote(3), { text: '3 parts in front of it are faded so you can see it.', action: 'Show them' });
});

test('edit distance counts swaps as one typo', () => {
  assert.equal(editDistance('femur', 'femur'), 0);
  assert.equal(editDistance('hipocampus', 'hippocampus'), 1);
  assert.equal(editDistance('feumr', 'femur'), 1);
  assert.ok(editDistance('heart', 'kidney', 2) > 2);
});

test('every mesh and every not-shown entry is in the index', () => {
  const meshNames = JSON.parse(readFileSync(MESH_NAMES_FILE, 'utf8'));
  for (const layer of layers.LAYERS) {
    const parts = index.filter((e) => e.kind === 'part' && e.layerId === layer.id).map((e) => e.meshName);
    assert.deepEqual(parts, meshNames[layer.id], layer.id);
    const missing = index.filter((e) => e.kind === 'notShown' && e.layerId === layer.id).map((e) => e.name);
    assert.deepEqual(missing, layer.notShown.map((e) => e.name), layer.id);
  }
});

test('"femur" offers both femurs, left then right, before anything else', () => {
  assert.deepEqual(top('femur', 2).map(label), ['part/skeletal/Femur/left', 'part/skeletal/Femur/right']);
  assert.equal(top('femur', 2)[0].meshName, 'Left femur');
});

test('naming a side puts that side first', () => {
  assert.deepEqual(top('right femur').map(label), ['part/skeletal/Femur/right']);
  assert.deepEqual(top('navicular bone of left foot').map(label), ['part/skeletal/Navicular bone of foot/left']);
});

test('prefixes match while typing', () => {
  assert.equal(top('cerebe')[0].name, 'Cerebellum');
  assert.equal(top('sciat')[0].name, 'Sciatic nerve');
});

test('typos and accents still match', () => {
  assert.equal(top('hipocampus')[0].name, 'Hippocampus and amygdala');
  assert.equal(top('sciatic nevre')[0].name, 'Sciatic nerve');
  assert.equal(top('MALLÉUS')[0].name, 'Malleus');
});

test('a left-out part is found and says why', () => {
  const [hit] = top('hippocampus');
  assert.equal(hit.kind, 'notShown');
  assert.equal(hit.layerId, 'nervous');
  assert.equal(hit.reason, 'not-added');
  assert.ok(layers.NOT_SHOWN_REASONS[hit.reason]);
});

test('aliases find parts by everyday names and say which alias matched', () => {
  assert.deepEqual(
    top('kneecap', 2).map((e) => [label(e), e.alias]),
    [
      ['part/skeletal/Patella/left', 'kneecap'],
      ['part/skeletal/Patella/right', 'kneecap'],
    ],
  );
  assert.equal(top('windpipe')[0].name, 'Trachea');
  assert.equal(top('femur')[0].alias, undefined);
});

test('every alias belongs to a part that is in its model', () => {
  for (const layer of layers.LAYERS) {
    for (const [key, part] of Object.entries(layer.parts)) {
      if (!part.aliases) continue;
      assert.ok(Array.isArray(part.aliases) && part.aliases.length, `${layer.id}/${key}`);
      assert.ok(
        index.some((e) => e.kind === 'part' && e.layerId === layer.id && e.aliases === part.aliases),
        `${layer.id}/${key}: no mesh for this part`,
      );
    }
  }
});

test('near misses are dropped when something matches properly, and nonsense finds nothing', () => {
  assert.ok(top('shin', 30).every((e) => e.name === 'Tibia'));
  assert.deepEqual(search(index, 'zzzzqx'), []);
  assert.deepEqual(search(index, '   '), []);
});

test('"/" focuses the search unless the user is typing somewhere', () => {
  const body = { tagName: 'BODY' };
  assert.equal(isSearchShortcut({ key: '/', target: body }, isTypingTarget), true);
  assert.equal(isSearchShortcut({ key: '/', target: { tagName: 'INPUT', type: 'search' } }, isTypingTarget), false);
  assert.equal(isSearchShortcut({ key: '/', target: body, ctrlKey: true }, isTypingTarget), false);
  assert.equal(isSearchShortcut({ key: 'w', target: body }, isTypingTarget), false);
});

test('WASD do not move the camera while typing in the search box', () => {
  const searchInput = { tagName: 'INPUT', type: 'search', isContentEditable: false };
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']) {
    assert.equal(movementKey({ code, target: searchInput }), null, code);
  }
});

/** A stand-in page that records what the selector asks of it. */
test('the faded-parts note follows the faded set after a pick, until another note replaces it', () => {
  const shown = [];
  const notes = fadeNoteKeeper({ show: (note) => shown.push(note.text), hide: () => shown.push('hidden') });
  notes.fadedChanged(0); // a selection change before any pick leaves other notes alone
  notes.focused(3);
  notes.fadedChanged(1); // a layer holding faded parts is switched off
  notes.fadedChanged(0); // the last one goes too, or "Show it" is pressed
  notes.fadedChanged(2);
  notes.focused(2);
  notes.replaced(); // e.g. a left-out part's note
  notes.fadedChanged(0);
  assert.deepEqual(shown, [
    '3 parts in front of it are faded so you can see it.',
    'One part in front of it is faded so you can see it.',
    'hidden',
    '2 parts in front of it are faded so you can see it.',
  ]);
});

function fakeHost({ meshes = {}, hiddenGroups = [], loadDelay = {} } = {}) {
  const calls = [];
  return {
    calls,
    async showLayer(id) {
      calls.push(['showLayer', id]);
      await new Promise((r) => setTimeout(r, loadDelay[id] ?? 0));
    },
    findMesh: (id, name) => meshes[`${id}/${name}`] ?? null,
    isGroupVisible: (id, group) => !hiddenGroups.includes(`${id}/${group}`),
    showGroup: (id, group) => calls.push(['showGroup', id, group]),
    unpeel: (id, mesh) => calls.push(['unpeel', id, mesh.name]),
    focus: (mesh) => calls.push(['focus', mesh.name]),
    showNotShown: (entry) => calls.push(['showNotShown', entry.name]),
    showMissing: (entry) => calls.push(['showMissing', entry.meshName]),
  };
}

const mesh = (name, group) => ({ name, userData: { group } });

test('picking a part turns its system on, reveals it, then frames and selects it', async () => {
  const host = fakeHost({ meshes: { 'skeletal/Left femur': mesh('Left femur') } });
  const [femur] = top('femur');
  await searchSelector(host)(femur);
  assert.deepEqual(host.calls, [
    ['showLayer', 'skeletal'],
    ['unpeel', 'skeletal', 'Left femur'],
    ['focus', 'Left femur'],
  ]);
});

test('a part in a hidden sub-group gets its group shown first', async () => {
  const fascia = mesh('Left brachial fascia', 'fascia');
  const host = fakeHost({ meshes: { 'joints/Left brachial fascia': fascia }, hiddenGroups: ['joints/fascia'] });
  await searchSelector(host)(top('left brachial fascia')[0]);
  assert.deepEqual(host.calls, [
    ['showLayer', 'joints'],
    ['showGroup', 'joints', 'fascia'],
    ['unpeel', 'joints', 'Left brachial fascia'],
    ['focus', 'Left brachial fascia'],
  ]);
});

test('picking a left-out part shows why, without touching the 3D view', async () => {
  const host = fakeHost();
  await searchSelector(host)(top('hippocampus')[0]);
  assert.deepEqual(host.calls, [['showNotShown', 'Hippocampus and amygdala']]);
});

test('a part missing from its loaded model is reported, not silently ignored', async () => {
  const host = fakeHost();
  await searchSelector(host)(top('femur')[0]);
  assert.deepEqual(host.calls, [
    ['showLayer', 'skeletal'],
    ['showMissing', 'Left femur'],
  ]);
});

test('a later pick wins over one whose system is still loading', async () => {
  const host = fakeHost({
    meshes: { 'circulatory/Left femoral artery': mesh('Left femoral artery'), 'skeletal/Left femur': mesh('Left femur') },
    loadDelay: { circulatory: 30 },
  });
  const pick = searchSelector(host);
  const slow = pick(top('left femoral artery')[0]);
  const fast = pick(top('femur')[0]);
  await Promise.all([slow, fast]);
  assert.deepEqual(
    host.calls.filter(([what]) => what === 'focus'),
    [['focus', 'Left femur']],
  );
});

test('framing puts the part at the centre, whole, from outside the body', () => {
  const opts = { camera: { x: 0.8, y: 1.1, z: 3.6 }, fov: 35, aspect: 1.6, minDistance: 0.1, maxDistance: 6 };
  // A left thigh bone (x > 0 is the body's left), about 45 cm long.
  const thigh = frameView({ ...opts, center: { x: 0.1, y: 0.7, z: 0 }, radius: 0.23 });
  assert.deepEqual(thigh.target, { x: 0.1, y: 0.7, z: 0 });
  assert.ok(thigh.position.x > thigh.target.x, 'seen from its own side');
  const half = ((35 / 2) * Math.PI) / 180;
  assert.ok(Math.sin(half) * thigh.distance >= 0.23, 'whole part in view');
  // A tiny ear bone is framed no closer than minDistance.
  const ear = frameView({ ...opts, center: { x: 0.06, y: 1.6, z: 0 }, radius: 0.004 });
  assert.equal(ear.distance, 0.1);
  // A midline part is looked at from where the camera already is.
  const spine = frameView({ ...opts, center: { x: 0, y: 1.2, z: -0.02 }, radius: 0.05 });
  assert.ok(spine.position.z > 0);
});

test('framing for a portrait screen shows the part above the bottom sheet', () => {
  const opts = { center: { x: 0.1, y: 0.7, z: 0 }, radius: 0.23, camera: { x: 0, y: 1, z: 3 }, fov: 46, aspect: 0.46, minDistance: 0.1, maxDistance: 6 };
  const plain = frameView(opts);
  const raised = frameView({ ...opts, raise: 0.2 });
  assert.ok(raised.target.y < opts.center.y, 'looks below the part, so it shows higher up');
  assert.ok(raised.distance > plain.distance, 'and from further back, so it still fits');
});
