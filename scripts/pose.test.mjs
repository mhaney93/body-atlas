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
  rig = R.buildRig((name) => bones.get(name)?.positions);
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
  const empty = R.SEGMENTS.filter((s) => s.family !== 'twist' && !owned.has(s.id)).map((s) => s.id);
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
        if (P.UNPOSED.has(joint)) continue; // the face, eyes, ribs…: words only, no angle
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
    const region = L.partInfo(muscular, name, m.extras.group, undefined, m.extras.of).region;
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
    region: (layer, mesh) => L.partInfo(layer, mesh.userData.name, mesh.userData.group, undefined, mesh.userData.of).region,
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
  poser.stop();
  assert.ok(!vastus.posed && Math.abs(lowest() - restLow) < 1e-6);
  // Unposed, nothing is hit up there.
  assert.equal(ray.intersectObject(legs, true).filter((h) => h.point.y > 0.8 && h.object === vastus).length, 0);
});
