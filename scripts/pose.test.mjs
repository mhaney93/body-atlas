// Checks the stretching poses: the rig built from the shipped skeleton
// (src/rig.js) finds each joint where the bones say it is, the same on both
// sides; the pose math (src/pose.js) turns segments the way each direction
// means; every stretch variant poses on both sides within the joints' normal
// ranges; and the posed models (src/pose-view.js) move, bend across joints and
// stay pickable where they are drawn. Bone and muscle positions come from the
// built GLBs, as the viewer sees them.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import * as THREE from 'three';
import { createServer } from 'vite';

let server;
let R;
let P;
let S;
let V;
let L;
let rig;
let bones;
let muscles;
let senses;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

/** Every mesh of a GLB as [name, { positions (world, flat), index, extras }]. */
async function meshes(file) {
  const doc = await io.read(new URL(`../public/models/${file}`, import.meta.url).pathname);
  const out = new Map();
  for (const n of doc.getRoot().listNodes()) {
    const mesh = n.getMesh();
    if (!mesh) continue;
    const m = new THREE.Matrix4().fromArray(n.getWorldMatrix());
    const positions = [];
    const index = [];
    const e = [];
    const v = new THREE.Vector3();
    for (const p of mesh.listPrimitives()) {
      const base = positions.length / 3;
      const a = p.getAttribute('POSITION');
      for (let i = 0; i < a.getCount(); i++) {
        a.getElement(i, e);
        v.fromArray(e).applyMatrix4(m);
        positions.push(v.x, v.y, v.z);
      }
      const ix = p.getIndices();
      for (let i = 0; i < (ix?.getCount() ?? 0); i++) index.push(base + ix.getScalar(i));
    }
    out.set(n.getExtras()?.name ?? n.getName(), { positions: new Float32Array(positions), index, extras: n.getExtras() ?? {} });
  }
  return out;
}

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  R = await server.ssrLoadModule('/src/rig.js');
  P = await server.ssrLoadModule('/src/pose.js');
  S = await server.ssrLoadModule('/src/stretching.js');
  V = await server.ssrLoadModule('/src/pose-view.js');
  L = await server.ssrLoadModule('/src/layers.js');
  await MeshoptDecoder.ready;
  bones = await meshes('skeletal.glb');
  muscles = await meshes('muscular.glb');
  senses = await meshes('senses.glb');
  rig = R.buildRig((name) => bones.get(name)?.positions);
  // The eyeballs come from the Sense organs, as the viewer adds them once that layer loads.
  for (const side of ['left', 'right']) R.setEye(rig, side, senses.get(R.eyeballMesh(side)).positions);
});
after(() => server?.close());

const seg = (id) => rig.segments.get(id);
const mirror = (v) => new THREE.Vector3(-v.x, v.y, v.z);
/** Where the end of a segment is after the moves, on one side of a one-variant sided stretch. */
function endAfter(moves, side, id) {
  const ops = P.variantOps({ id: 'T', sided: true, variants: [] }, { id: 'a', moves }, side);
  return P.posedPoint(P.poseMatrices(rig, ops, 1), id, seg(id).end);
}

/** A Poser over the skeleton alone, for its arrows. */
function bonePoser() {
  const scene = new THREE.Scene();
  const skeletal = new THREE.Group();
  for (const [name, m] of bones) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.userData = { name, ...m.extras };
    skeletal.add(mesh);
  }
  scene.add(skeletal);
  const poser = new V.Poser(scene, { region: () => undefined, side: () => null });
  poser.setBones(skeletal);
  poser.adopt({ posable: 'bones' }, skeletal);
  return poser;
}

test('every bone belongs to a segment, and every segment the rig needs has bones', () => {
  assert.deepEqual([...bones.keys()].filter((name) => !R.segmentOfBone(name)), []);
  const owned = new Set([...bones.keys()].map(R.segmentOfBone));
  // The forearm's twist and the eyes turn without bones of their own.
  const empty = R.SEGMENTS.filter((s) => s.family !== 'twist' && s.family !== 'eye' && !owned.has(s.id)).map((s) => s.id);
  assert.deepEqual(empty, []);
});

test('joints sit where the bones are, the same on both sides', () => {
  const box = (name) => new THREE.Box3().setFromArray(bones.get(name).positions);
  // The hip and shoulder turn about the femoral and humeral heads: inside the top of the bone.
  for (const side of ['Left', 'Right']) {
    const femur = box(`${side} femur`);
    const hip = seg(`${side.toLowerCase()}-thigh`).pivot;
    assert.ok(femur.containsPoint(hip) && femur.max.y - hip.y < 0.04, `${side} hip pivot ${hip.toArray()}`);
    const humerus = box(`${side} humerus`);
    const shoulder = seg(`${side.toLowerCase()}-upperarm`).pivot;
    assert.ok(humerus.containsPoint(shoulder) && humerus.max.y - shoulder.y < 0.04, `${side} shoulder pivot ${shoulder.toArray()}`);
    // The knee is at the bottom of the femur, the ankle at the bottom of the shin bones.
    assert.ok(Math.abs(seg(`${side.toLowerCase()}-shank`).pivot.y - femur.min.y) < 0.04);
    assert.ok(Math.abs(seg(`${side.toLowerCase()}-foot`).pivot.y - box(`${side} tibia`).min.y) < 0.03);
  }
  for (const def of R.SEGMENTS.filter((s) => s.side === 'left')) {
    const left = seg(def.id).pivot;
    const right = seg(def.id.replace('left', 'right')).pivot;
    assert.ok(mirror(left).distanceTo(right) < 0.015, `${def.id} is not mirrored: ${left.toArray()} vs ${right.toArray()}`);
  }
  // At rest the palms face forward, so the forearm rests turned palm-up, near 90° from thumb-forward.
  for (const side of ['left', 'right']) {
    assert.ok(rig.frames.hand[side].palmar.z > 0.8);
    assert.ok(Math.abs(rig.frames.forearmRest[side] - 90) < 20);
  }
});

test('each direction turns its segment the way the word means', () => {
  const rest = (id) => seg(id).end;
  // Hip flexion 90° lifts the knee forward to hip height; knee flexion takes the ankle back.
  const knee = endAfter(['hip.flex:90'], 'right', 'right-thigh');
  assert.ok(Math.abs(knee.y - seg('right-thigh').pivot.y) < 0.03 && knee.z > 0.3);
  assert.ok(endAfter(['knee.flex:90'], 'left', 'left-shank').z < rest('left-shank').z - 0.3);
  // Abduction takes the limb away from the midline, on either side.
  assert.ok(endAfter(['hip.abd:45'], 'right', 'right-thigh').x < rest('right-thigh').x - 0.2);
  assert.ok(endAfter(['shoulder.abd:90'], 'left', 'left-upperarm').x > rest('left-upperarm').x + 0.2);
  // Elbow flexion brings the wrist forward; the wrist's extension takes the hand back (palms face forward).
  assert.ok(endAfter(['elbow.flex:90'], 'right', 'right-forearm').z > 0.15);
  assert.ok(endAfter(['wrist.ext:70'], 'right', 'right-hand').z < rest('right-hand').z - 0.04);
  // Pronation turns the thumb toward the body; dorsiflexion lifts the toes.
  assert.ok(endAfter(['forearm.pro:80'], 'right', 'right-thumb1').x > rest('right-thumb1').x + 0.03);
  assert.ok(endAfter(['ankle.df:20'], 'right', 'right-foot').y > rest('right-foot').y + 0.02);
  // Cross-body: the arm, raised forward, swings across toward the other side.
  assert.ok(endAfter(['shoulder.flex:90', 'shoulder.hzadd:40'], 'right', 'right-upperarm').x > rest('right-upperarm').x + 0.15);
  // Side-bending to the other side tips the trunk away from the side shown.
  assert.ok(endAfter(['trunk.sbc'], 'right', 'thorax').x > 0.1);
  // A pose is symmetrical between the sides.
  const l = endAfter(['hip.flex:60', 'hip.abd:20', 'knee.flex:45'], 'left', 'left-shank');
  const r = endAfter(['hip.flex:60', 'hip.abd:20', 'knee.flex:45'], 'right', 'right-shank');
  assert.ok(mirror(l).distanceTo(r) < 0.02);
  // Half way there is half the turn.
  const ops = P.variantOps({ id: 'T', sided: true, variants: [] }, { id: 'a', moves: ['knee.flex:90'] }, 'left');
  const half = P.posedPoint(P.poseMatrices(rig, ops, 0.5), 'left-shank', rest('left-shank'));
  const knee45 = endAfter(['knee.flex:45'], 'left', 'left-shank');
  assert.ok(half.distanceTo(knee45) < 1e-6);
});

test('every variant poses on both sides; only joints without bones are left unposed', () => {
  const bad = [];
  for (const st of S.STRETCHING.stretches)
    for (const v of st.variants)
      for (const side of ['left', 'right']) {
        try {
          P.poseMatrices(rig, P.variantOps(st, v, side), 1);
        } catch (e) {
          bad.push(`${st.id}${v.id} ${side}: ${e.message}`);
        }
      }
  assert.deepEqual(bad, []);
  const joints = Object.keys(S.STRETCHING.joints);
  assert.deepEqual(joints.filter((j) => !P.DIRECTIONS[j] && !P.UNPOSED.has(j)), []);
});

test('posed moves are real, with an angle, and no joint is posed past its normal range', () => {
  const bad = [];
  for (const st of S.STRETCHING.stretches)
    for (const v of st.variants) {
      const total = new Map();
      for (const code of [...(v.setup ?? []), ...v.moves]) {
        const { joint, dir } = S.parseMove(code);
        if (P.unposed(code)) continue; // the face, eyelids, ribs…: words only, no angle
        if (!S.STRETCHING.joints[joint] || !S.OPPOSITE[dir]) bad.push(`${st.id}${v.id}: bad move ${code}`);
        const key = `${joint}.${dir}`;
        total.set(key, (total.get(key) ?? 0) + P.moveAngle(code));
      }
      for (const [key, angle] of total) {
        const [joint, dir] = key.split('.');
        const rom = S.STRETCHING.joints[joint]?.rom?.[dir];
        if (rom !== undefined && angle > rom) bad.push(`${st.id}${v.id}: ${key} ${angle}° > ${rom}°`);
        if (angle === undefined || Number.isNaN(angle)) bad.push(`${st.id}${v.id}: ${key} has no angle`);
      }
    }
  assert.deepEqual(bad, []);
});

test('a stretch done with both limbs at once poses both sides alike', () => {
  const bad = [];
  let checked = 0;
  for (const st of S.STRETCHING.stretches)
    for (const v of st.variants) {
      // Both-sides variants that are the same for each side (the butterfly; not a head turn, which mirrors).
      if (S.isSided(st, v) || S.movesFor(st, v, 'right').some((code, i) => code !== v.moves[i])) continue;
      for (const side of ['left', 'right']) {
        const ops = P.variantOps(st, v, side);
        const limbs = ops.filter((op) => /^(left|right)-/.test(op.seg));
        if (!limbs.length) continue;
        checked++;
        const m = P.poseMatrices(rig, ops, 1);
        for (const def of R.SEGMENTS.filter((d) => d.side === 'left')) {
          const right = def.id.replace('left', 'right');
          const l = P.posedPoint(m, def.id, seg(def.id).end);
          const r = P.posedPoint(m, right, seg(right).end);
          if (mirror(l).distanceTo(r) > 0.03) bad.push(`${st.id}${v.id} (${side}): ${def.id} ${l.toArray()} vs ${right} ${r.toArray()}`);
        }
      }
    }
  assert.ok(checked >= 18, `only ${checked} both-limb poses checked`);
  assert.deepEqual(bad, []);
  // The butterfly takes both thighs out to the side.
  const p4 = S.STRETCHING.stretches.find((st) => st.id === 'P4');
  const m = P.poseMatrices(rig, P.variantOps(p4, p4.variants[0], 'left'), 1);
  assert.ok(P.posedPoint(m, 'right-thigh', seg('right-thigh').end).x < seg('right-thigh').end.x - 0.1);
  assert.ok(P.posedPoint(m, 'left-thigh', seg('left-thigh').end).x > seg('left-thigh').end.x + 0.1);
});

test('the forearm turns the way its move says, and its arrow sweeps as far as the hand turns', () => {
  const poser = bonePoser();
  const rot = (m) => new THREE.Matrix4().extractRotation(m);
  // The palm's turn about the forearm, measured from where the forearm alone would carry it.
  const palmTurn = (m, op) => {
    const palmar = rig.frames.hand[op.side].palmar;
    const forearm = rot(m.get(`${op.side}-forearm`));
    const from = palmar.clone().applyMatrix4(forearm);
    const to = palmar.clone().applyMatrix4(rot(m.get(op.seg)));
    const axis = P.opAxis(op, rig).applyMatrix4(forearm).normalize();
    return THREE.MathUtils.radToDeg(Math.atan2(axis.dot(from.clone().cross(to)), from.dot(to)));
  };
  let checked = 0;
  for (const st of S.STRETCHING.stretches)
    for (const v of st.variants) {
      if (!v.moves.some((code) => code.startsWith('forearm.'))) continue;
      for (const side of ['left', 'right']) {
        const ops = P.variantOps(st, v, side);
        const m0 = P.poseMatrices(rig, ops, 0);
        const m = P.poseMatrices(rig, ops, 1);
        // The loop starts at rest, but for the forearm twist of a supination, which starts thumb-forward.
        const startsTurned = new Set(ops.filter((op) => op.code.startsWith('forearm.sup')).map((op) => op.seg));
        for (const g of rig.segments.values()) {
          if (startsTurned.has(g.id)) continue;
          const parent = g.parent ? m0.get(g.parent) : new THREE.Matrix4();
          const local = parent.clone().invert().multiply(m0.get(g.id));
          assert.ok(local.elements.every((e, i) => Math.abs(e - (i % 5 === 0 ? 1 : 0)) < 1e-9), `${st.id}${v.id} ${side}: ${g.id} is not at rest at the start`);
        }
        poser.start(ops, { still: true });
        for (const op of ops.filter((o) => o.code.startsWith('forearm.') && !o.setup)) {
          // Positive is the named way, from the start of the loop to the full stretch.
          let turned = palmTurn(m, op) - palmTurn(m0, op);
          if (turned < -180) turned += 360;
          const name = `${st.id}${v.id} ${op.side} ${op.code}`;
          assert.ok(turned > 1, `${name} turns ${turned}°, not the named way`);
          assert.ok(Math.abs(turned - P.opTurn(op, rig)) < 1, `${name}: hand turns ${turned}°, opTurn ${P.opTurn(op, rig)}°`);
          const arrow = poser.arrows.children.find((a) => a.userData.code === op.code && a.userData.side === op.side);
          assert.ok(arrow && Math.abs(arrow.userData.sweep - turned) < 1, `${name}: arrow ${arrow?.userData.sweep}° over a ${turned}° turn`);
          checked++;
        }
        // Every arrow belongs to a move on the side it is drawn.
        for (const a of poser.arrows.children) assert.ok(ops.some((op) => op.code === a.userData.code && op.side === a.userData.side));
        poser.stop();
      }
    }
  assert.ok(checked >= 18, `only ${checked} forearm turns checked`);
  // Pronation turns the hand from the palm-forward rest most of a half turn; supination from thumb-forward back past palm-forward.
  const turn = (code) => P.opTurn(P.variantOps({ id: 'T', sided: true, variants: [] }, { id: 'a', moves: [code] }, 'right')[0], rig);
  assert.ok(turn('forearm.pro') > 150);
  assert.ok(turn('forearm.sup') > 60 && Math.abs(turn('forearm.sup') - rig.frames.forearmRest.right) < 1);
});

test('both-limb stretches draw an arrow on each side', () => {
  const poser = bonePoser();
  const p4 = S.STRETCHING.stretches.find((st) => st.id === 'P4');
  poser.start(P.variantOps(p4, p4.variants[0], 'right'), { still: true });
  const sides = (code) => poser.arrows.children.filter((a) => a.userData.code === code).map((a) => a.userData.side).sort();
  assert.deepEqual(sides('hip.abd:45'), ['left', 'right']);
  assert.deepEqual(sides('hip.flex:90'), ['left', 'right']);
  poser.stop();
});

test('the pose box holds every moving joint from the start of the stretch to its end', () => {
  const p1 = S.STRETCHING.stretches.find((st) => st.id === 'P1');
  const ops = P.variantOps(p1, p1.variants[0], 'right');
  const box = P.poseBox(rig, ops);
  const full = P.poseMatrices(rig, ops, 1);
  for (const id of ['right-thigh', 'right-shank', 'right-foot']) {
    assert.ok(box.containsPoint(seg(id).end), `${id} at rest`);
    assert.ok(box.containsPoint(P.posedPoint(full, id, seg(id).end)), `${id} posed`);
  }
  // The other leg and the arms stay out of it.
  assert.ok(!box.containsPoint(seg('left-shank').end) && !box.containsPoint(seg('left-forearm').end));
  // Words only (the tongue): nothing to frame.
  const tg1 = S.STRETCHING.stretches.find((st) => st.id === 'TG1');
  assert.ok(P.poseBox(rig, P.variantOps(tg1, tg1.variants[0], 'left')).isEmpty());
});

test('setup moves hold the limb but never count toward a muscle being stretched', () => {
  // The doorway stretch bends the elbow to rest the forearm on the frame; that doesn't stretch the triceps.
  const s1 = S.STRETCHING.stretches.find((st) => st.id === 'S1');
  assert.ok(s1.variants[1].setup.some((c) => c.startsWith('elbow.flex')));
  assert.ok(!s1.variants[1].moves.some((c) => c.startsWith('elbow.flex')));
  assert.equal(S.reverses('elbow.ext', s1.variants[1].moves), false);
  const ops = P.variantOps(s1, s1.variants[1], 'left');
  assert.ok(ops.some((op) => op.setup && op.code.startsWith('elbow.flex')));
});

test('soft parts follow their nearest bone, blending across the joints they cross', () => {
  const index = R.indexBones([...bones].map(([name, b]) => [name, b.positions]));
  const muscular = L.LAYERS.find((l) => l.id === 'muscular');
  const share = (name) => {
    const m = muscles.get(name);
    const region = L.partInfo(muscular, name, m.extras.group, m.extras.of).region;
    const { indices, weights } = R.skinWeights(rig, index, m.positions, R.candidateSegments(region, 'right'));
    const out = {};
    for (let i = 0; i < indices.length; i++) out[R.SEGMENTS[indices[i]].id] = (out[R.SEGMENTS[indices[i]].id] ?? 0) + weights[i] / (indices.length / 4);
    for (let i = 0; i < weights.length; i += 4) assert.ok(Math.abs(weights[i] + weights[i + 1] + weights[i + 2] + weights[i + 3] - 1) < 1e-5);
    return out;
  };
  // The soleus lies on the shin bones only; the long head of biceps femoris runs from the pelvis to the shin.
  assert.ok(share('Right soleus')['right-shank'] > 0.95);
  const bf = share('Long head of right biceps femoris');
  assert.ok(bf['right-thigh'] > 0.4 && bf['right-shank'] > 0.15);
  // A right-side muscle never follows a left-side segment.
  assert.ok(Object.keys(share('Right gluteus maximus')).every((id) => !id.startsWith('left-')));
});

test('a posed model moves, bends at the joint and is picked where it is drawn', () => {
  const scene = new THREE.Scene();
  const group = (map, keep) => {
    const g = new THREE.Group();
    for (const [name, m] of map) {
      if (!keep(name)) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      if (m.index.length) geometry.setIndex(m.index);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
      mesh.userData = { name, ...m.extras };
      g.add(mesh);
    }
    scene.add(g);
    return g;
  };
  const muscular = L.LAYERS.find((l) => l.id === 'muscular');
  const poser = new V.Poser(scene, {
    region: (layer, mesh) => L.partInfo(layer, mesh.userData.name, mesh.userData.group, mesh.userData.of).region,
    side: (mesh) => (/\bright\b/i.test(mesh.userData.name) ? 'right' : /\bleft\b/i.test(mesh.userData.name) ? 'left' : null),
  });
  const skeletal = group(bones, () => true);
  poser.setBones(skeletal);
  poser.adopt({ posable: 'bones' }, skeletal);
  const legs = group(muscles, (name) => /right (vastus lateralis|rectus femoris)$/i.test(name));
  poser.adopt({ ...muscular, posable: 'soft' }, legs);
  const vastus = legs.children.find((m) => /vastus lateralis/i.test(m.userData.name));
  assert.ok(vastus instanceof V.PoseMesh);
  const lowest = () => {
    let min = Infinity;
    const v = new THREE.Vector3();
    for (let i = 0; i < vastus.geometry.getAttribute('position').count; i++) min = Math.min(min, vastus.getVertexPosition(i, v).applyMatrix4(vastus.matrixWorld).y);
    return min;
  };
  const restLow = lowest();
  // Raise the right thigh 90°: the vastus's lowest point (above the knee) rises to about hip height.
  const ops = P.variantOps({ id: 'T', sided: true, variants: [] }, { id: 'a', moves: ['hip.flex:90'] }, 'right');
  poser.start(ops, { still: true });
  assert.ok(vastus.weighted && vastus.posed);
  assert.ok(lowest() > restLow + 0.25, `vastus lowest point ${restLow} → ${lowest()}`);
  // A ray down onto the raised thigh hits the vastus where it now is, not where it stood.
  const kneeNow = P.posedPoint(P.poseMatrices(rig, ops, 1), 'right-thigh', seg('right-thigh').end);
  const ray = new THREE.Raycaster(new THREE.Vector3(kneeNow.x - 0.03, 1.5, kneeNow.z - 0.12), new THREE.Vector3(0, -1, 0));
  const hits = ray.intersectObject(legs, true);
  assert.ok(hits.length && hits[0].point.y > 0.8, `hit ${hits[0]?.point.y}`);
  // Picking a posed mesh finds what skinning every vertex (three.js's own posed raycast) finds:
  // the femur follows one bone and is picked as a rigid mesh; the vastus blends the thigh and pelvis and is skinned once for them.
  const femur = skeletal.children.find((m) => m.userData.name === 'Right femur');
  assert.deepEqual(femur.segments, [R.SEGMENT_INDEX.get('right-thigh')]);
  assert.ok(vastus.segments.length > 1, `vastus follows ${vastus.segments}`);
  const v = new THREE.Vector3();
  const samePicks = (mesh) => {
    const index = mesh.geometry.getIndex();
    const faces = index.count / 3;
    let hit = 0;
    for (let k = 0; k < 40; k++) {
      // At the middle of a face, where the pose draws it.
      const face = Math.floor((k * faces) / 40);
      const aim = new THREE.Vector3();
      for (let c = 0; c < 3; c++) aim.add(mesh.getVertexPosition(index.getX(face * 3 + c), v).applyMatrix4(mesh.matrixWorld));
      aim.divideScalar(3);
      const dir = new THREE.Vector3(Math.cos(k), Math.sin(k * 1.7), Math.sin(k)).normalize();
      const caster = new THREE.Raycaster(aim.clone().addScaledVector(dir, 0.5), dir.negate());
      const fast = [];
      const exact = [];
      mesh.raycast(caster, fast);
      THREE.SkinnedMesh.prototype.raycast.call(mesh, caster, exact);
      const first = (list) => Math.min(...list.map((h) => h.distance));
      // A ray from behind a front face misses both ways.
      assert.ok(fast.length === exact.length && (!exact.length || Math.abs(first(fast) - first(exact)) < 1e-5), `${mesh.userData.name} ray ${k}`);
      assert.ok(fast.every((h) => h.object === mesh));
      if (exact.length) hit++;
    }
    assert.ok(hit >= 10, `${mesh.userData.name}: ${hit} of 40 rays hit`);
  };
  samePicks(femur);
  samePicks(vastus);
  // Nodding moves none of the vastus's bones apart, so it is picked as a rigid mesh again, still where it is drawn.
  poser.start(P.variantOps({ id: 'N', variants: [] }, { id: 'a', moves: ['head.flex:20'] }, 'left'), { still: true });
  samePicks(vastus);
  poser.stop();
  assert.ok(!vastus.posed && Math.abs(lowest() - restLow) < 1e-6);
  // Unposed, nothing is hit up there.
  assert.equal(ray.intersectObject(legs, true).filter((h) => h.point.y > 0.8 && h.object === vastus).length, 0);
});

test('cue arrows start from the rest-pose centre of a muscle, whether or not a pose is playing', async () => {
  const SP = await server.ssrLoadModule('/src/stretch-panel.js');
  const scene = new THREE.Scene();
  const poser = new V.Poser(scene, {
    region: (layer, mesh) => L.partInfo(layer, mesh.userData.name, mesh.userData.group, mesh.userData.of).region,
    side: (mesh) => (/\bright\b/i.test(mesh.userData.name) ? 'right' : /\bleft\b/i.test(mesh.userData.name) ? 'left' : null),
  });
  const skeletal = new THREE.Group();
  for (const [name, m] of bones) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.userData = { name, ...m.extras };
    skeletal.add(mesh);
  }
  scene.add(skeletal);
  poser.setBones(skeletal);
  poser.adopt({ posable: 'bones' }, skeletal);
  const name = 'Right vastus lateralis';
  const m = muscles.get(name);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  const legs = new THREE.Group();
  const plain = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  plain.userData = { name, ...m.extras };
  legs.add(plain);
  scene.add(legs);
  poser.adopt({ ...L.LAYERS.find((l) => l.id === 'muscular'), posable: 'soft' }, legs);
  const vastus = legs.children[0];
  const key = L.canonical(name);
  const rest = new THREE.Box3().setFromArray(m.positions).getCenter(new THREE.Vector3());
  const unposed = SP.cueCenters(legs)([key], 'right');
  assert.ok(unposed.distanceTo(rest) < 1e-6, `unposed ${unposed.toArray()} vs rest ${rest.toArray()}`);
  poser.start(P.variantOps({ id: 'T', sided: true, variants: [] }, { id: 'a', moves: ['hip.flex:90'] }, 'right'), { still: true });
  assert.ok(vastus.posed);
  const posed = SP.cueCenters(legs)([key], 'right');
  assert.ok(posed.distanceTo(rest) < 1e-6, `posed ${posed.toArray()} vs rest ${rest.toArray()}`);
  poser.stop();
});

test('nerves and joint parts follow the limb, so a glide or joint move shows them moving', async () => {
  const nerves = await meshes('nervous.glb');
  const joints = await meshes('joints.glb');
  const scene = new THREE.Scene();
  const nervous = L.LAYERS.find((l) => l.id === 'nervous');
  const jointsLayer = L.LAYERS.find((l) => l.id === 'joints');
  assert.equal(nervous.posable, 'soft');
  assert.equal(jointsLayer.posable, 'soft');
  const poser = new V.Poser(scene, {
    region: (layer, mesh) => L.partInfo(layer, mesh.userData.name, mesh.userData.group).region,
    side: (mesh) => (/\bright\b/i.test(mesh.userData.name) ? 'right' : /\bleft\b/i.test(mesh.userData.name) ? 'left' : null),
  });
  const skeletal = new THREE.Group();
  for (const [name, m] of bones) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.userData = { name, ...m.extras };
    skeletal.add(mesh);
  }
  scene.add(skeletal);
  poser.setBones(skeletal);
  poser.adopt({ posable: 'bones' }, skeletal);
  const soft = (map, name, layer) => {
    const m = map.get(name);
    assert.ok(m, name);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.userData = { name, ...m.extras };
    g.add(mesh);
    scene.add(g);
    poser.adopt(layer, g);
    return g.children[0];
  };
  const sciatic = soft(nerves, 'Right sciatic nerve', nervous);
  const capsule = soft(joints, 'Right articular capsule of hip joint', jointsLayer);
  const centre = (mesh) => {
    const v = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = mesh.geometry.getAttribute('position').count;
    for (let i = 0; i < n; i++) c.add(mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld));
    return c.divideScalar(n);
  };
  const lowest = (mesh) => {
    const v = new THREE.Vector3();
    let min = Infinity;
    for (let i = 0; i < mesh.geometry.getAttribute('position').count; i++) min = Math.min(min, mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld).y);
    return min;
  };
  const restNerve = centre(sciatic);
  const restLow = lowest(sciatic);
  const restCapsule = centre(capsule);
  // The seated sciatic slider raises the straight leg: the nerve's end behind the knee rises toward hip height.
  const g4 = S.STRETCHING.stretches.find((st) => st.id === 'G4');
  poser.start(P.variantOps(g4, g4.variants[0], 'right'), { still: true });
  assert.ok(lowest(sciatic) > restLow + 0.2, `sciatic lowest point ${restLow} → ${lowest(sciatic)}`);
  // The hip capsule wraps the joint it belongs to: it barely moves.
  assert.ok(centre(capsule).distanceTo(restCapsule) < 0.03);
  poser.stop();
  assert.ok(centre(sciatic).distanceTo(restNerve) < 1e-6);
});

/** The rest centre of the muscles `keys` on `side` (null: both), from the built model, as the viewer finds it. */
function muscleCenter(keys, side) {
  const want = new Set(keys);
  const box = new THREE.Box3();
  for (const [name, m] of muscles) {
    if (m.extras.of || !want.has(L.canonical(name))) continue;
    if (side && !new RegExp(`\\b${side}\\b`, 'i').test(name)) continue;
    box.union(new THREE.Box3().setFromArray(m.positions));
  }
  return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
}

test('every move no bone can show has arrows, at muscles that exist, pointing the way it goes', async () => {
  const C = await server.ssrLoadModule('/src/cues.js');
  const muscular = L.LAYERS.find((l) => l.id === 'muscular');
  const bad = [];
  for (const [code, specs] of Object.entries(C.CUES)) {
    // The eyes' gaze is posed and keeps its arrows; every other cue is for a move nothing turns.
    if (!P.unposed(code) && S.parseMove(code).joint !== 'eye') bad.push(`${code}: has a bone to turn`);
    for (const spec of specs) for (const key of spec.at) if (!muscular.parts[key]) bad.push(`${code}: no muscle "${key}"`);
  }
  for (const st of S.STRETCHING.stretches)
    for (const v of st.variants) {
      const unposed = [...(v.setup ?? []), ...v.moves].filter((c) => P.unposed(c));
      for (const code of unposed) if (!C.CUES[code.split(':')[0]]) bad.push(`${st.id}${v.id}: no arrow for ${code}`);
      for (const side of ['left', 'right']) {
        const cues = C.variantCues(st, v, side, rig, muscleCenter);
        if (unposed.length && !cues.length) bad.push(`${st.id}${v.id} ${side}: no arrows drawn`);
        for (const c of cues) if (Math.abs(c.dir.length() - 1) > 1e-6 || !rig.segments.has(c.seg)) bad.push(`${st.id}${v.id}: bad cue ${c.code}`);
      }
    }
  assert.deepEqual(bad, []);
  const stretch = (id) => S.STRETCHING.stretches.find((st) => st.id === id);
  const cuesOf = (id, vid, side = 'left') => {
    const st = stretch(id);
    return C.variantCues(st, st.variants.find((v) => v.id === vid), side, rig, muscleCenter);
  };
  // Raised brows point up; a wide smile pulls each corner of the mouth out to its own side.
  assert.ok(cuesOf('F1', 'a').filter((c) => c.code === 'face.browsup').every((c) => c.dir.y > 0.95));
  const wide = cuesOf('F4', 'a').filter((c) => c.code === 'face.lipswide');
  assert.equal(wide.length, 2);
  for (const c of wide) assert.ok(Math.sign(c.dir.x) === Math.sign(c.center.x), 'out to its own side');
  // Both eyes look the same way: "eye.in", written for the left eye, is a look to the right (the body's right is −x).
  const look = cuesOf('E1', 'c');
  assert.equal(look.length, 2);
  for (const c of look) assert.ok(c.dir.x < -0.95, `look ${c.dir.toArray()}`);
  // Breathing in, the diaphragm goes down; breathing out it rises. The pelvic floor drops.
  assert.ok(cuesOf('B2', 'a').find((c) => c.code === 'ribs.inh').dir.y < -0.95);
  assert.ok(cuesOf('B1', 'a').find((c) => c.code === 'ribs.exh').dir.y > 0.95);
  assert.ok(cuesOf('PF1', 'a').filter((c) => c.code === 'pelvic-floor.drop').every((c) => c.dir.y < -0.95));
  // A one-side stretch's arrows are on that side only (the flattened palm, right hand).
  const palm = cuesOf('H4', 'a', 'right').filter((c) => c.code === 'palm.flat');
  assert.ok(palm.length === 2 && palm.every((c) => c.center.x < 0 && c.seg === 'right-hand'));
});

test('the arrows ride with the pose, the jaw opens through its chin and its glide gets an arrow', async () => {
  const C = await server.ssrLoadModule('/src/cues.js');
  const poser = bonePoser();
  // The eyes' gaze: a straight arrow in front of each eye, and no arc at the eyes' turns.
  const e1 = S.STRETCHING.stretches.find((st) => st.id === 'E1');
  const eyeCues = C.variantCues(e1, e1.variants[0], 'left', rig, muscleCenter);
  poser.start(P.variantOps(e1, e1.variants[0], 'left'), { still: true, cues: eyeCues });
  assert.ok(poser.active);
  assert.equal(poser.arrows.children.filter((a) => a.userData.cue).length, 2);
  assert.equal(poser.arrows.children.filter((a) => !a.userData.cue).length, 0);
  poser.stop();
  // Closing the eyelids turns nothing: an arrow alone shows it.
  const lids = e1.variants.find((v) => v.moves.includes('eye.lidclose'));
  assert.deepEqual(P.variantOps(e1, lids, 'left'), []);
  assert.ok(C.variantCues(e1, lids, 'left', rig, muscleCenter).length);
  // The flattened palm's arrows go where the bent elbow carries the hand.
  const h4 = S.STRETCHING.stretches.find((st) => st.id === 'H4');
  const ops = P.variantOps(h4, h4.variants[0], 'right');
  const cues = C.variantCues(h4, h4.variants[0], 'right', rig, muscleCenter).filter((c) => c.code === 'palm.flat');
  poser.start(ops, { still: true, cues });
  const hand = P.poseMatrices(rig, ops, 1).get('right-hand');
  for (const a of poser.arrows.children.filter((x) => x.userData.cue)) {
    const want = cues.find((c) => c.code === a.userData.code && c.seg === a.userData.seg && c.center.clone().applyMatrix4(hand).distanceTo(a.userData.from) < 1e-9);
    assert.ok(want, 'arrow at the posed hand');
  }
  poser.stop();
  // Controlled jaw opening: the arc passes through the chin, and the forward glide is a straight arrow at the chin.
  const j1 = S.STRETCHING.stretches.find((st) => st.id === 'J1');
  poser.start(P.variantOps(j1, j1.variants[0], 'left'), { still: true });
  const arc = poser.arrows.children.find((a) => a.userData.code === 'jaw.open');
  assert.ok(Math.abs(arc.userData.radius - seg('mandible').length) < 1e-9);
  assert.ok(poser.arrows.children.some((a) => a.userData.code === 'jaw.fwd' && a.userData.glide));
  poser.stop();
});

test('the eyes turn about their eyeballs, both looking one way, lengthening the muscles that pull the other way', () => {
  // The viewer's order: a skeleton without the eyes, the muscles weighted by an earlier pose, then the Sense organs load.
  const scene = new THREE.Scene();
  const muscular = L.LAYERS.find((l) => l.id === 'muscular');
  const sensesLayer = L.LAYERS.find((l) => l.id === 'senses');
  assert.equal(sensesLayer.posable, 'soft');
  const poser = new V.Poser(scene, {
    region: (layer, mesh) => L.partInfo(layer, mesh.userData.name, mesh.userData.group, mesh.userData.of).region,
    side: (mesh) => (/\bright\b/i.test(mesh.userData.name) ? 'right' : /\bleft\b/i.test(mesh.userData.name) ? 'left' : null),
  });
  const group = (map, keep) => {
    const g = new THREE.Group();
    for (const [name, m] of map) {
      if (!keep(name)) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      if (m.index.length) geometry.setIndex(m.index);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
      mesh.userData = { name, ...m.extras };
      g.add(mesh);
    }
    scene.add(g);
    return g;
  };
  const skeletal = group(bones, () => true);
  poser.setBones(skeletal);
  poser.adopt({ posable: 'bones' }, skeletal);
  assert.ok(!poser.rig.segments.get('left-eye').radius);
  const eyeMuscles = group(muscles, (name) => /^(left|right) (medial|lateral) rectus$|^(left|right) common tendinous ring$/i.test(name));
  poser.adopt(muscular, eyeMuscles);
  poser.start(P.variantOps({ id: 'N', variants: [] }, { id: 'a', moves: ['head.flex:20'] }, 'left'), { still: true });
  poser.stop();
  const eyes = group(senses, (name) => /^(left|right) (sclera|cornea)$/i.test(name));
  poser.adopt(sensesLayer, eyes);
  for (const side of ['left', 'right']) {
    const sclera = senses.get(R.eyeballMesh(side)).positions;
    const eye = poser.rig.segments.get(`${side}-eye`);
    assert.ok(new THREE.Box3().setFromArray(sclera).getCenter(new THREE.Vector3()).distanceTo(eye.pivot) < 0.002, `${side} eye centre`);
    assert.ok(eye.radius > 0.01 && eye.radius < 0.015, `${side} eye radius ${eye.radius}`);
  }

  const mesh = (g, name) => g.children.find((m) => m.userData.name === name);
  const points = (m) => {
    const v = new THREE.Vector3();
    return Array.from({ length: m.geometry.getAttribute('position').count }, (_, i) => m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld).clone());
  };
  const centre = (m) => points(m).reduce((c, p) => c.add(p), new THREE.Vector3()).divideScalar(points(m).length);
  const ring = (side) => centre(mesh(eyeMuscles, `${side === 'left' ? 'Left' : 'Right'} common tendinous ring`));
  /** A muscle's length: from the tendinous ring at the back of the orbit to its farthest point, the insertion on the eyeball. */
  const reach = (name, side) => Math.max(...points(mesh(eyeMuscles, name)).map((p) => p.distanceTo(ring(side))));
  const names = ['Left lateral rectus', 'Left medial rectus', 'Right lateral rectus', 'Right medial rectus'];
  const rest = Object.fromEntries(names.map((n) => [n, reach(n, n.split(' ')[0].toLowerCase())]));
  const restCornea = { left: centre(mesh(eyes, 'Left cornea')), right: centre(mesh(eyes, 'Right cornea')) };
  const restSclera = { left: centre(mesh(eyes, 'Left sclera')), right: centre(mesh(eyes, 'Right sclera')) };
  const restRing = { left: ring('left'), right: ring('right') };

  // Look to the right (the body's right is −x): "eye.in" for the left eye, written once for both.
  const e1 = S.STRETCHING.stretches.find((st) => st.id === 'E1');
  const look = e1.variants.find((v) => v.moves.includes('eye.in'));
  const ops = P.variantOps(e1, look, 'left');
  assert.deepEqual(ops.map((op) => `${op.seg} ${op.toward}`).sort(), ['left-eye medial', 'right-eye lateral']);
  poser.start(ops, { still: true });
  for (const side of ['left', 'right']) {
    // Each cornea swings toward the body's right; the eyeball turns in place and the back of the orbit stays put.
    const shift = centre(mesh(eyes, `${side === 'left' ? 'Left' : 'Right'} cornea`)).sub(restCornea[side]);
    assert.ok(shift.x < -0.005, `${side} cornea moved ${shift.toArray()}`);
    assert.ok(centre(mesh(eyes, `${side === 'left' ? 'Left' : 'Right'} sclera`)).distanceTo(restSclera[side]) < 0.001, `${side} eyeball stays centred`);
    assert.ok(ring(side).distanceTo(restRing[side]) < 0.001, `${side} ring stays put`);
  }
  // The left eye turns in, so its lateral rectus lengthens and its medial rectus shortens; the right eye turns out, the other way round.
  const now = Object.fromEntries(names.map((n) => [n, reach(n, n.split(' ')[0].toLowerCase())]));
  assert.ok(now['Left lateral rectus'] > rest['Left lateral rectus'] + 0.001, `left lateral rectus ${rest['Left lateral rectus']} → ${now['Left lateral rectus']}`);
  assert.ok(now['Left medial rectus'] < rest['Left medial rectus'] - 0.001, `left medial rectus ${rest['Left medial rectus']} → ${now['Left medial rectus']}`);
  assert.ok(now['Right medial rectus'] > rest['Right medial rectus'] + 0.001, `right medial rectus ${rest['Right medial rectus']} → ${now['Right medial rectus']}`);
  assert.ok(now['Right lateral rectus'] < rest['Right lateral rectus'] - 0.001, `right lateral rectus ${rest['Right lateral rectus']} → ${now['Right lateral rectus']}`);
  // The eyeball follows its eye alone, so it is picked as a rigid mesh, with no vertex skinned on the CPU.
  assert.deepEqual(mesh(eyes, 'Left sclera').segments, [R.SEGMENT_INDEX.get('left-eye')]);
  assert.deepEqual(mesh(eyes, 'Right cornea').segments, [R.SEGMENT_INDEX.get('right-eye')]);
  const cornea = centre(mesh(eyes, 'Left cornea'));
  const hits = new THREE.Raycaster(cornea.clone().add(new THREE.Vector3(0, 0, 0.5)), new THREE.Vector3(0, 0, -1)).intersectObject(eyes, true);
  assert.ok(hits.length && mesh(eyes, 'Left sclera').blended === null && mesh(eyes, 'Left cornea').blended === null);
  poser.stop();
  assert.ok(centre(mesh(eyes, 'Left cornea')).distanceTo(restCornea.left) < 1e-6);
});

test('only the eyeballs turn with the eyes; every other Sense organs part stays fixed to the skull', async () => {
  const sensesLayer = L.LAYERS.find((l) => l.id === 'senses');
  const skeletal = L.LAYERS.find((l) => l.id === 'skeletal');
  const head = [R.SEGMENT_INDEX.get('head')];
  const ids = (set) => [...set].sort((a, b) => a - b).map((i) => R.SEGMENTS[i].id);
  const bad = [];
  for (const [name, m] of [...senses, ...(await meshes('senses-ear.glb'))]) {
    const { region } = L.partInfo(sensesLayer, name, m.extras?.group);
    const side = /\bright\b/i.test(name) ? 'right' : /\bleft\b/i.test(name) ? 'left' : null;
    const want = region === 'Eye' ? ['head', `${side}-eye`] : ['head'];
    const got = ids(R.candidateSegments(region, side));
    if (got.join() !== want.join()) bad.push(`${name} (${region}): ${got}`);
  }
  // The ossicles (Skeletal) stay fixed to the skull too.
  for (const name of ['malleus', 'incus', 'stapes']) {
    const got = ids(R.candidateSegments(L.partInfo(skeletal, name).region, null));
    if (got.join() !== head.map((i) => R.SEGMENTS[i].id).join()) bad.push(`${name}: ${got}`);
  }
  assert.deepEqual(bad, []);
});
