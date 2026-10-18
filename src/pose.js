// Turns a stretch variant's joint moves ("hip.flex:80", "knee.ext") into
// rotations of the rig's segments (src/rig.js), and those into one world
// matrix per segment for a given fraction of the way into the stretch. Pure,
// so the tests can pose the rig in node; src/pose-view.js applies the matrices
// to the models.
import * as THREE from 'three';
import { DOWN, LATERAL, POSTERIOR, UP, ANTERIOR } from './rig.js';
import { STRETCHING, isSided, parseMove } from './stretching.js';

const FINGERS = ['index', 'middle', 'ring', 'little'];
const TOES = ['big', 'second', 'third', 'fourth', 'little'];

/** Joints that are shown by highlighting and the card's words only: there is no bone to turn (ribs, face…). */
export const UNPOSED = new Set(['ribs', 'palm', 'arch', 'hyoid', 'eye', 'face', 'tongue', 'pelvic-floor']);

/**
 * Angles (degrees; millimetres for the jaw's glides) for moves the joint's
 * `rom` in src/stretches.json doesn't give and the move doesn't set itself.
 * Directions whose end range is where the body already stands (the elbow's
 * and knee's extension) are 0.
 */
export const DEFAULT_ANGLE = {
  'head.flex': 20, 'head.ext': 20, 'head.sbi': 10, 'head.sbc': 10, 'head.roti': 30, 'head.rotc': 30,
  'scapula.elev': 15, 'scapula.dep': 8, 'scapula.protr': 15, 'scapula.retr': 12, 'scapula.uprot': 10, 'scapula.dnrot': 8,
  'clavicle.elev': 12, 'clavicle.dep': 5,
  'shoulder.hzadd': 40, 'shoulder.hzabd': 30,
  'fingers.ext': 30, 'finger-joints.ext': 0, 'finger-spread.spread': 15, 'finger-spread.squeeze': 6,
  'thumb-base.flex': 15, 'thumb-base.ext': 25, 'thumb-base.abd': 45, 'thumb-base.add': 10, 'thumb-base.opp': 40, 'thumb-base.repos': 20,
  'thumb-knuckle.ext': 10, 'thumb-tip.ext': 20,
  'toes.ext': 60, 'toes.flex': 35, 'toe-joints.flex': 45, 'toe-joints.ext': 0, 'toe-spread.spread': 10, 'toe-spread.squeeze': 5,
  'jaw.open': 25, 'jaw.close': 0, 'jaw.fwd': 6, 'jaw.back': 2, 'jaw.lati': 8, 'jaw.latc': 8,
};

/**
 * Order the turns at one joint compose in, innermost first: about the
 * segment's own length, side-to-side, front-back, then about the vertical.
 * Side-to-side inside front-back is the joint coordinate system's order
 * (Grood & Suntay 1983; ISB, Wu et al. 2002): the butterfly's flexed thigh
 * still swings out, where abducting after flexing would only spin it.
 */
const ORDER = { axial: 0, frontal: 1, sagittal: 2, transverse: 3, glide: 4 };

/**
 * What each direction does to which segments. A rotation turns the segment so
 * that the vector `ref` moves toward `toward` (both in the rest pose); an
 * axial one turns it about its own length in that sense. `share` splits a
 * joint's angle over several segments (the neck's and trunk's vertebrae).
 * Vectors: up, down, anterior, posterior, lateral, medial (of the side
 * posed), dir (the segment's own rest direction), and the hand's palmar,
 * dorsal, radial and ulnar.
 */
const turn = (ref, toward, plane, extra = {}) => ({ ref, toward, plane, ...extra });
const SPINE = (segs) => ({
  flex: segs.map(([seg, share]) => turn('up', 'anterior', 'sagittal', { seg, share })),
  ext: segs.map(([seg, share]) => turn('up', 'posterior', 'sagittal', { seg, share })),
  sbi: segs.map(([seg, share]) => turn('up', 'lateral', 'frontal', { seg, share })),
  sbc: segs.map(([seg, share]) => turn('up', 'medial', 'frontal', { seg, share })),
  roti: segs.map(([seg, share]) => turn('anterior', 'lateral', 'transverse', { seg, share })),
  rotc: segs.map(([seg, share]) => turn('anterior', 'medial', 'transverse', { seg, share })),
});
const pair = (seg, specs) => Object.fromEntries(Object.entries(specs).map(([dir, s]) => [dir, [{ seg, ...s }]]));
const each = (segs, spec) => segs.map((seg) => ({ seg, ...spec }));

export const DIRECTIONS = {
  head: SPINE([['head', 1]]),
  neck: SPINE([['upper-neck', 0.5], ['lower-neck', 0.5]]),
  trunk: SPINE([['thorax', 0.6], ['lumbar', 0.4]]),
  jaw: {
    open: [turn('anterior', 'down', 'sagittal', { seg: 'mandible' })],
    close: [turn('anterior', 'up', 'sagittal', { seg: 'mandible' })],
    fwd: [{ seg: 'mandible', glide: 'anterior', plane: 'glide' }],
    back: [{ seg: 'mandible', glide: 'posterior', plane: 'glide' }],
    lati: [turn('anterior', 'lateral', 'transverse', { seg: 'mandible' })],
    latc: [turn('anterior', 'medial', 'transverse', { seg: 'mandible' })],
  },
  scapula: pair('girdle', {
    elev: turn('lateral', 'up', 'frontal'), dep: turn('lateral', 'down', 'frontal'),
    protr: turn('lateral', 'anterior', 'transverse'), retr: turn('lateral', 'posterior', 'transverse'),
    uprot: turn('lateral', 'up', 'frontal'), dnrot: turn('lateral', 'down', 'frontal'),
  }),
  clavicle: pair('girdle', { elev: turn('lateral', 'up', 'frontal'), dep: turn('lateral', 'down', 'frontal') }),
  shoulder: pair('upperarm', {
    flex: turn('dir', 'anterior', 'sagittal'), ext: turn('dir', 'posterior', 'sagittal'),
    abd: turn('dir', 'lateral', 'frontal'), add: turn('dir', 'medial', 'frontal'),
    hzadd: turn('lateral', 'anterior', 'transverse'), hzabd: turn('anterior', 'lateral', 'transverse'),
    ir: turn('anterior', 'medial', 'axial'), er: turn('anterior', 'lateral', 'axial'),
  }),
  elbow: pair('forearm', { flex: turn('dir', 'anterior', 'sagittal'), ext: turn('dir', 'posterior', 'sagittal') }),
  // The forearm turns the hand about the forearm's length; rest is palm forward (see frames.forearmRest).
  forearm: pair('twist', { pro: turn('palmar', 'medial', 'axial'), sup: turn('palmar', 'lateral', 'axial') }),
  wrist: pair('hand', {
    flex: turn('dir', 'palmar', 'sagittal'), ext: turn('dir', 'dorsal', 'sagittal'),
    rd: turn('dir', 'radial', 'frontal'), ud: turn('dir', 'ulnar', 'frontal'),
  }),
  fingers: {
    flex: each(FINGERS.map((f) => `${f}1`), turn('dir', 'palmar', 'sagittal')),
    ext: each(FINGERS.map((f) => `${f}1`), turn('dir', 'dorsal', 'sagittal')),
  },
  'finger-joints': {
    flex: [...each(FINGERS.map((f) => `${f}2`), turn('dir', 'palmar', 'sagittal')), ...each(FINGERS.map((f) => `${f}3`), turn('dir', 'palmar', 'sagittal', { share: 0.7 }))],
    ext: [...each(FINGERS.map((f) => `${f}2`), turn('dir', 'dorsal', 'sagittal')), ...each(FINGERS.map((f) => `${f}3`), turn('dir', 'dorsal', 'sagittal', { share: 0.7 }))],
  },
  'finger-spread': {
    spread: [turn('dir', 'radial', 'frontal', { seg: 'index1' }), turn('dir', 'ulnar', 'frontal', { seg: 'ring1' }), turn('dir', 'ulnar', 'frontal', { seg: 'little1', share: 1.5 })],
    squeeze: [turn('dir', 'ulnar', 'frontal', { seg: 'index1' }), turn('dir', 'radial', 'frontal', { seg: 'ring1' }), turn('dir', 'radial', 'frontal', { seg: 'little1', share: 1.5 })],
  },
  // Thumb terms (OpenStax 9.5): flexion and extension in the plane of the palm, abduction away from it.
  'thumb-base': {
    flex: [turn('dir', 'ulnar', 'sagittal', { seg: 'thumb1' })],
    ext: [turn('dir', 'radial', 'sagittal', { seg: 'thumb1' })],
    abd: [turn('dir', 'palmar', 'frontal', { seg: 'thumb1' })],
    add: [turn('dir', 'dorsal', 'frontal', { seg: 'thumb1' })],
    // Opposition: palmar abduction, flexion and turning the thumb's pad toward the fingers.
    opp: [
      turn('dir', 'palmar', 'frontal', { seg: 'thumb1' }),
      turn('dir', 'ulnar', 'sagittal', { seg: 'thumb1', share: 0.4 }),
      turn('palmar', 'ulnar', 'axial', { seg: 'thumb1', share: 0.75 }),
    ],
    repos: [turn('dir', 'dorsal', 'frontal', { seg: 'thumb1', share: 0.4 }), turn('dir', 'radial', 'sagittal', { seg: 'thumb1' })],
  },
  'thumb-knuckle': pair('thumb2', { flex: turn('dir', 'thumbFlex', 'sagittal'), ext: turn('dir', 'thumbExt', 'sagittal') }),
  'thumb-tip': pair('thumb3', { flex: turn('dir', 'thumbFlex', 'sagittal'), ext: turn('dir', 'thumbExt', 'sagittal') }),
  hip: pair('thigh', {
    flex: turn('dir', 'anterior', 'sagittal'), ext: turn('dir', 'posterior', 'sagittal'),
    abd: turn('dir', 'lateral', 'frontal'), add: turn('dir', 'medial', 'frontal'),
    ir: turn('anterior', 'medial', 'axial'), er: turn('anterior', 'lateral', 'axial'),
  }),
  knee: pair('shank', { flex: turn('dir', 'posterior', 'sagittal'), ext: turn('dir', 'anterior', 'sagittal') }),
  shin: pair('shank', { ir: turn('anterior', 'medial', 'axial'), er: turn('anterior', 'lateral', 'axial') }),
  ankle: pair('foot', { df: turn('dir', 'up', 'sagittal'), pf: turn('dir', 'down', 'sagittal') }),
  subtalar: pair('foot', { inv: turn('down', 'medial', 'frontal'), ev: turn('down', 'lateral', 'frontal') }),
  toes: {
    ext: each(TOES.map((t) => `${t}toe1`), turn('dir', 'up', 'sagittal')),
    flex: each(TOES.map((t) => `${t}toe1`), turn('dir', 'down', 'sagittal')),
  },
  'toe-joints': {
    ext: [...each(['bigtoe2', ...TOES.slice(1).map((t) => `${t}toe2`)], turn('dir', 'up', 'sagittal')), ...each(TOES.slice(1).map((t) => `${t}toe3`), turn('dir', 'up', 'sagittal', { share: 0.7 }))],
    flex: [...each(['bigtoe2', ...TOES.slice(1).map((t) => `${t}toe2`)], turn('dir', 'down', 'sagittal')), ...each(TOES.slice(1).map((t) => `${t}toe3`), turn('dir', 'down', 'sagittal', { share: 0.7 }))],
  },
  'toe-spread': {
    spread: [turn('dir', 'medial', 'frontal', { seg: 'bigtoe1' }), ...each(['thirdtoe1', 'fourthtoe1', 'littletoe1'], turn('dir', 'lateral', 'frontal'))],
    squeeze: [turn('dir', 'lateral', 'frontal', { seg: 'bigtoe1' }), ...each(['thirdtoe1', 'fourthtoe1', 'littletoe1'], turn('dir', 'medial', 'frontal'))],
  },
};

/** A move's angle: its own, else the joint's normal range (src/stretches.json), else DEFAULT_ANGLE. */
export function moveAngle(code, data = STRETCHING) {
  const { joint, dir, angle } = parseMove(code);
  return angle ?? data.joints[joint]?.rom?.[dir] ?? DEFAULT_ANGLE[`${joint}.${dir}`];
}

/** The side whose segments a sided move turns: limbs and the shoulder girdle have one; the midline doesn't. */
const SIDED_SEGMENT = /^(girdle|upperarm|forearm|twist|hand|thumb\d|(index|middle|ring|little)\d|thigh|shank|foot|\w+toe\d)$/;

/**
 * The turns a variant makes on one side, as a list of
 * { seg, ref, toward, plane, angle } (or { seg, glide, angle } for the jaw):
 * its setup moves (holding the limb where the stretch is done) then its own
 * moves. A variant done once for both sides is posed as written (left side)
 * at the midline, and moves both limbs alike (the butterfly's two thighs).
 */
export function variantOps(stretch, variant, side, data = STRETCHING) {
  const sides = isSided(stretch, variant) ? [side] : ['left', 'right'];
  const ops = [];
  const setup = new Set(variant.setup ?? []);
  for (const code of [...setup, ...variant.moves]) {
    const { joint, dir } = parseMove(code);
    if (UNPOSED.has(joint)) continue;
    const specs = DIRECTIONS[joint]?.[dir];
    if (!specs) throw new Error(`no pose for "${code}"`);
    const total = moveAngle(code, data);
    // The forearm rests palm forward, already turned palm-up: pronation starts from there.
    const offset = joint === 'forearm' ? { pro: 1, sup: -1 }[dir] : 0;
    for (const spec of specs) {
      const limb = SIDED_SEGMENT.test(spec.seg);
      for (const poseSide of limb ? sides : sides.slice(0, 1)) {
        const seg = limb ? `${poseSide}-${spec.seg}` : spec.seg;
        ops.push({ ...spec, seg, side: poseSide, code, total, angle: total * (spec.share ?? 1), restOffset: offset, setup: setup.has(code) });
      }
    }
  }
  return ops;
}

/** A named direction for one segment of the rig, in the rest pose. */
export function vector(name, seg, side, rig) {
  const hand = rig.frames.hand[side];
  switch (name) {
    case 'up': return UP;
    case 'down': return DOWN;
    case 'anterior': return ANTERIOR;
    case 'posterior': return POSTERIOR;
    case 'lateral': return LATERAL[side];
    case 'medial': return LATERAL[side].clone().negate();
    case 'dir': return rig.segments.get(seg).dir;
    case 'palmar': return hand.palmar;
    case 'dorsal': return hand.palmar.clone().negate();
    case 'radial': return hand.radial;
    case 'ulnar': return hand.radial.clone().negate();
    case 'thumbFlex': return hand.palmar.clone().sub(hand.radial).normalize();
    case 'thumbExt': return hand.radial.clone().sub(hand.palmar).normalize();
    default: throw new Error(`unknown direction "${name}"`);
  }
}

/** The unit axis an op turns about, in the rest pose, so that a positive angle moves `ref` toward `toward`. */
export function opAxis(op, rig) {
  const seg = rig.segments.get(op.seg);
  const ref = vector(op.ref, op.seg, op.side, rig);
  const toward = vector(op.toward, op.seg, op.side, rig);
  const axis = ref.clone().cross(toward);
  if (op.plane === 'axial') {
    // About the segment's own length, in the sense that carries ref toward `toward`.
    return seg.dir.clone().multiplyScalar(Math.sign(axis.dot(seg.dir)) || 1);
  }
  if (axis.lengthSq() < 1e-8) throw new Error(`${op.code}: ${op.ref} and ${op.toward} are parallel for ${op.seg}`);
  return axis.normalize();
}

/**
 * Each segment's world matrix (from the rest pose) with the ops made
 * `fraction` (0..1) of the way from their start (opStart; rest for all but a
 * supination) to the full stretch. Segments without ops follow their parent.
 * @returns {Map<string, THREE.Matrix4>}
 */
export function poseMatrices(rig, ops, fraction = 1) {
  const bySeg = new Map();
  for (const op of ops) {
    if (!bySeg.has(op.seg)) bySeg.set(op.seg, []);
    bySeg.get(op.seg).push(op);
  }
  const out = new Map();
  for (const seg of rig.segments.values()) {
    const parent = seg.parent ? out.get(seg.parent) : new THREE.Matrix4();
    const mine = (bySeg.get(seg.id) ?? []).slice().sort((a, b) => ORDER[a.plane] - ORDER[b.plane]);
    if (!mine.length) {
      out.set(seg.id, parent.clone());
      continue;
    }
    // Each turn is about a body axis and composes outside the ones before it, so the axial turn goes first, about the segment's rest length.
    const rot = new THREE.Quaternion();
    const shift = new THREE.Vector3();
    for (const op of mine) {
      if (op.plane === 'glide') {
        shift.addScaledVector(vector(op.glide, op.seg, op.side, rig), (op.angle / 1000) * fraction);
        continue;
      }
      const angle = THREE.MathUtils.degToRad(opStart(op, rig) + opTurn(op, rig) * fraction);
      rot.premultiply(new THREE.Quaternion().setFromAxisAngle(opAxis(op, rig), angle));
    }
    const local = new THREE.Matrix4()
      .makeTranslation(seg.pivot.x + shift.x, seg.pivot.y + shift.y, seg.pivot.z + shift.z)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(rot))
      .multiply(new THREE.Matrix4().makeTranslation(-seg.pivot.x, -seg.pivot.y, -seg.pivot.z));
    out.set(seg.id, parent.clone().multiply(local));
  }
  return out;
}

/**
 * Where (degrees from rest, the named way) an op's turn starts. The forearm
 * rests palm forward, already supinated past thumb-forward
 * (frames.forearmRest), so a supination starts from thumb-forward and turns
 * palm-up into the stretch; every other turn starts at rest.
 */
export function opStart(op, rig) {
  return op.restOffset < 0 ? -(rig.frames.forearmRest[op.side] ?? 0) : 0;
}

/**
 * How far (degrees) an op turns its segment from its start to the full
 * stretch. Pronation first undoes the palm-forward rest; a supination turns
 * from thumb-forward to its range, or to the rest if that is already further.
 */
export function opTurn(op, rig) {
  if (!op.restOffset) return op.angle;
  const rest = rig.frames.forearmRest[op.side] ?? 0;
  return op.restOffset > 0 ? op.angle + rest : Math.max(rest, op.angle);
}

/** Where a rest-pose point of segment `segId` is once posed. */
export function posedPoint(matrices, segId, point) {
  return point.clone().applyMatrix4(matrices.get(segId));
}

/**
 * A box around everything the ops move, at the start of the stretch and at
 * its full extent: each moving segment's joint and end, so the camera can
 * frame the whole pose. Empty when nothing turns.
 */
export function poseBox(rig, ops) {
  const box = new THREE.Box3();
  const start = poseMatrices(rig, ops, 0);
  const full = poseMatrices(rig, ops, 1);
  const moving = new Set(ops.filter((op) => op.plane === 'glide' || opTurn(op, rig) || opStart(op, rig)).map((op) => op.seg));
  for (const seg of rig.segments.values()) if (seg.parent && moving.has(seg.parent)) moving.add(seg.id);
  for (const id of moving) {
    const seg = rig.segments.get(id);
    for (const p of [seg.pivot, seg.end]) box.expandByPoint(posedPoint(start, id, p)).expandByPoint(posedPoint(full, id, p));
  }
  return box;
}
