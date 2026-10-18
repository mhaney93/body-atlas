// Stretching data (src/stretches.json) and the rules that read it: which
// joint moves a stretch makes, which muscles each variant lengthens, and
// whether every action of a muscle is reversed by one of its stretches. A
// muscle's action is written "<joint>.<direction>" (e.g. "hip.flex"), relative
// to the muscle's own side; a stretch variant's moves use the same codes, so a
// move reverses an action when it is the opposite direction at the same joint.
// The app (src/stretch-panel.js, src/pose.js) and scripts/stretches.test.mjs
// read the data only through here.
import STRETCHING from './stretches.json';

/** Each direction and its opposite ("sbi" = side-bend to its own side, "rotc" = rotate to the other side). */
export const OPPOSITE = Object.fromEntries(
  [
    ['flex', 'ext'], ['abd', 'add'], ['ir', 'er'], ['hzadd', 'hzabd'], ['pro', 'sup'], ['rd', 'ud'],
    ['elev', 'dep'], ['protr', 'retr'], ['uprot', 'dnrot'], ['sbi', 'sbc'], ['roti', 'rotc'], ['inv', 'ev'],
    ['df', 'pf'], ['open', 'close'], ['fwd', 'back'], ['lati', 'latc'], ['inh', 'exh'], ['opp', 'repos'],
    ['spread', 'squeeze'], ['lift', 'drop'], ['cup', 'flat'],
  ].flatMap(([a, b]) => [[a, b], [b, a]]),
);

/**
 * Moves that swap between the two sides when a midline part (head, neck,
 * trunk, jaw) or both eyes move one way: turning the head left rotates the left
 * side's muscles toward their own side and the right side's away from theirs.
 * Side-relative directions mirror at any joint; the eye's in/out only at the eye.
 */
export const MIRROR = Object.fromEntries(
  [
    ['roti', 'rotc'], ['sbi', 'sbc'], ['lati', 'latc'],
    ['eye.in', 'eye.out'], ['eye.downin', 'eye.downout'], ['eye.upin', 'eye.upout'],
  ].flatMap(([a, b]) => [[a, b], [b, a]]),
);

/**
 * Sections of the run, in order: the muscle stretches head to toe, then the
 * joint and spine moves, the nerve glides and the foam rolling. `optIn`
 * stretches only run when their opt-in section (OPT_IN) is asked for.
 */
export const GROUPS = ['neck', 'jaw', 'face', 'eye', 'shoulder', 'arm', 'hand', 'trunk', 'hip', 'leg', 'joint', 'nerve', 'roll'];

/** Each section's name in Stretching mode. */
export const GROUP_NAMES = {
  neck: 'Neck', jaw: 'Jaw and tongue', face: 'Face', eye: 'Eyes', shoulder: 'Shoulder', arm: 'Arm',
  hand: 'Hand', trunk: 'Trunk and breathing', hip: 'Hip and thigh', leg: 'Leg and foot',
  joint: 'Joints and spine', nerve: 'Nerve glides', roll: 'Foam rolling',
};

/** The opt-in sections a stretch's `optIn` names, with what Stretching mode says about each. */
export const OPT_IN = {
  lengthen: { name: 'Face, eyes and tongue', note: 'These lengthen only; none is a proven stretch.' },
  rolling: { name: 'Foam rolling', note: 'Eases soreness and briefly adds range; it does not release fascia.' },
};

/** What each kind of item is, on its card. */
export const KIND_NAMES = {
  stretch: 'Stretch', lengthen: 'Lengthens only: no proven stretch effect', joint: 'Joint mobility',
  glide: 'Nerve glide: move in and out, never hold', roll: 'Foam rolling',
};

/** Printed on every foam-rolling card: what rolling does and doesn't do (Behm & Wilke 2019; Chaudhry 2008). */
export const ROLLING_NOTE =
  'Foam rolling can briefly increase range of motion and ease soreness, probably by changing how your nervous system senses the area. It does not ‘break up’ fascia or adhesions; the forces involved are far too small. Roll each area about 30–120 s at a tolerable pressure. Avoid wounds, fractures, inflamed areas or suspected blood clots.';

/** A joint's short name on a stretch card; `joints[joint].name` in the data is the full one. */
export const JOINT_NAMES = {
  head: 'Head', neck: 'Neck', trunk: 'Trunk', ribs: 'Ribs', scapula: 'Shoulder blade', clavicle: 'Collarbone',
  shoulder: 'Shoulder', elbow: 'Elbow', forearm: 'Forearm', wrist: 'Wrist', fingers: 'Finger knuckles',
  'finger-joints': 'Finger joints', 'finger-spread': 'Fingers', palm: 'Palm', 'thumb-base': 'Thumb base',
  'thumb-knuckle': 'Thumb knuckle', 'thumb-tip': 'Thumb end joint', hip: 'Hip', knee: 'Knee', shin: 'Shin (knee bent)',
  ankle: 'Ankle', subtalar: 'Heel', toes: 'Toe knuckles', 'toe-joints': 'Toe joints', 'toe-spread': 'Toes',
  arch: 'Arch', jaw: 'Jaw', hyoid: 'Hyoid', tongue: 'Tongue', eye: 'Eyes', face: 'Face', 'pelvic-floor': 'Pelvic floor',
};

/**
 * What a direction asks you to do, in words (a joint's own wording first:
 * "neck.ext" bends the neck back where "knee.ext" straightens the knee).
 * `{toward}` and `{away}` are filled with the side: the posed side for a
 * one-side stretch, the left for one done once ("turn the head to the left").
 */
const DIRECTION_WORDS = {
  flex: 'bend (flexion)', ext: 'straighten (extension)', abd: 'out to the side (abduction)', add: 'in across the midline (adduction)',
  ir: 'turn in (internal rotation)', er: 'turn out (external rotation)', hzadd: 'across the body (horizontal adduction)',
  hzabd: 'back and out (horizontal abduction)', pro: 'palm down (pronation)', sup: 'palm up (supination)',
  rd: 'toward the thumb (radial deviation)', ud: 'toward the little finger (ulnar deviation)', elev: 'up (elevation)',
  dep: 'down (depression)', protr: 'forward (protraction)', retr: 'back (retraction)', uprot: 'turn up (upward rotation)',
  dnrot: 'turn down (downward rotation)', sbi: 'side-bend to the {toward}', sbc: 'side-bend to the {away}',
  roti: 'turn to the {toward}', rotc: 'turn to the {away}', inv: 'sole in (inversion)', ev: 'sole out (eversion)',
  df: 'toes up (dorsiflexion)', pf: 'point the foot (plantarflexion)', open: 'open', close: 'close', fwd: 'jut forward',
  back: 'pull back', lati: 'shift to the {toward}', latc: 'shift to the {away}', inh: 'breathe in fully', exh: 'breathe out fully',
  opp: 'across to the little finger (opposition)', repos: 'back out to the side (reposition)', spread: 'spread apart',
  squeeze: 'squeeze together', drop: 'let go and drop', flat: 'flatten',
  'head.flex': 'nod forward (flexion)', 'head.ext': 'tip back (extension)', 'neck.flex': 'bend forward (flexion)',
  'neck.ext': 'bend back (extension)', 'trunk.flex': 'round forward (flexion)', 'trunk.ext': 'arch back (extension)',
  'wrist.flex': 'bend toward the palm (flexion)', 'wrist.ext': 'bend back (extension)', 'fingers.flex': 'bend (flexion)',
  'toes.ext': 'pull up (extension)', 'toes.flex': 'curl down (flexion)', 'toe-joints.ext': 'straighten (extension)',
  'toe-joints.flex': 'curl (flexion)', 'thumb-base.flex': 'across the palm (flexion)', 'thumb-base.ext': 'out in line with the palm (extension)',
  'thumb-base.abd': 'up away from the palm (abduction)', 'thumb-base.add': 'back against the palm (adduction)',
  'ribs.elev': 'lift (breathing in)', 'ribs.dep': 'lower (breathing out)', 'arch.drop': 'let the arch flatten',
  'palm.flat': 'flatten the hollow of the palm', 'pelvic-floor.drop': 'let it relax and drop',
  'tongue.out': 'stick out and up toward the nose', 'tongue.back': 'curl back along the roof of the mouth',
  'eye.up': 'look up', 'eye.down': 'look down', 'eye.in': 'look to the {away}', 'eye.out': 'look to the {toward}',
  'eye.upin': 'look up and to the {away}', 'eye.upout': 'look up and to the {toward}', 'eye.downin': 'look down and to the {away}',
  'eye.downout': 'look down and to the {toward}', 'eye.lidclose': 'close the eyes gently',
  'face.browsdown': 'frown, brows down', 'face.browsup': 'raise the brows', 'face.eyeswide': 'open the eyes wide',
  'face.flare': 'flare the nostrils', 'face.lipswide': 'stretch the lips wide', 'face.lowerlipdown': 'pull the lower lip down',
  'face.pout': 'pout', 'face.pucker': 'pucker the lips', 'face.puff': 'puff the cheeks out', 'face.smile': 'smile wide',
  'face.sniff': 'wrinkle the nose up',
};

const OTHER_SIDE = { left: 'right', right: 'left' };

/**
 * A move in words for the card: { joint: "Hip", action: "bend (flexion)",
 * angle: 80 } (angle only where the move sets one). `side` fills "turn to the …".
 */
export function describeMove(code, side = 'left') {
  const { joint, dir, angle } = parseMove(code);
  const words = DIRECTION_WORDS[`${joint}.${dir}`] ?? DIRECTION_WORDS[dir];
  if (!words) throw new Error(`no words for "${code}"`);
  return {
    joint: JOINT_NAMES[joint] ?? joint,
    action: words.replace('{toward}', side).replace('{away}', OTHER_SIDE[side]),
    angle,
  };
}

/**
 * A hold the card can time ("30 s x 2" → 30 s, 2 rounds), or null for one
 * counted another way (reps, breaths, "2 s each").
 */
export function holdTimer(hold) {
  const [, seconds, rounds] = /^(\d+) s x (\d+)$/.exec(hold ?? '') ?? [];
  return seconds ? { seconds: Number(seconds), rounds: Number(rounds) } : null;
}

export { STRETCHING };

/** "hip.flex:80" → { joint: "hip", dir: "flex", angle: 80 } (angle is optional, in degrees). */
export function parseMove(code) {
  const [, joint, dir, angle] = /^([a-z-]+)\.([a-z]+)(?::(-?\d+(?:\.\d+)?))?$/.exec(code) ?? [];
  if (!joint) throw new Error(`bad move "${code}"`);
  return { joint, dir, angle: angle === undefined ? undefined : Number(angle) };
}

/** Does any of `moves` reverse `action` (the opposite direction at the same joint)? */
export function reverses(action, moves) {
  const { joint, dir } = parseMove(action);
  return moves.some((m) => {
    const move = parseMove(m);
    return move.joint === joint && move.dir === OPPOSITE[dir];
  });
}

/**
 * The variants a stretch reference names: "P1a" is variant a of P1, a bare
 * "P1" means every variant of P1. Empty for an unknown reference.
 * @returns {{ stretch: object, variant: object }[]}
 */
export function variantsOf(ref, data = STRETCHING) {
  const whole = data.stretches.find((s) => s.id === ref);
  if (whole) return whole.variants.map((variant) => ({ stretch: whole, variant }));
  const [, id, vid] = /^(.*\d)([a-z])$/.exec(ref) ?? [];
  const stretch = data.stretches.find((s) => s.id === id);
  const variant = stretch?.variants.find((v) => v.id === vid);
  return variant ? [{ stretch, variant }] : [];
}

/** Whether a variant is done one side at a time (the Left/Right toggle); a variant's own `sided` overrides its stretch's. */
export function isSided(stretch, variant) {
  return variant.sided ?? stretch.sided ?? false;
}

/**
 * A variant's moves as one side's muscles see them. A sided variant is done on
 * the chosen side, so its moves are that side's; a variant done once for both
 * sides ("turn the head to the left") is written for the left side, and the
 * right side gets the mirror.
 */
export function movesFor(stretch, variant, side) {
  if (side === 'left' || isSided(stretch, variant)) return variant.moves;
  return variant.moves.map((code) => {
    const { joint, dir } = parseMove(code);
    const move = `${joint}.${dir}`;
    const mirrored = MIRROR[move] ?? (MIRROR[dir] && `${joint}.${MIRROR[dir]}`);
    return mirrored ? code.replace(move, mirrored) : code;
  });
}

/** Is `action` reversed on each side by one of the `shown` variants? */
function reversedOnBothSides(action, shown) {
  return ['left', 'right'].every((side) =>
    reverses(action, shown.flatMap(({ stretch, variant }) => movesFor(stretch, variant, side))),
  );
}

/** "P1" + "a" → "P1a"; a stretch with one variant is named by its id alone. */
export function variantRef(stretch, variant) {
  return stretch.variants.length > 1 ? `${stretch.id}${variant.id}` : stretch.id;
}

/** The actions of a muscle (part key) that none of its listed stretches reverses. */
export function unreversedActions(key, data = STRETCHING) {
  const entry = data.muscles[key];
  if (!entry?.actions) return [];
  const shown = entry.stretches.flatMap((ref) => variantsOf(ref, data));
  return entry.actions.filter((action) => !reversedOnBothSides(action, shown));
}

/** The muscles (part keys) that list this variant among their stretches, sorted. */
export function targetsOf(stretch, variant, data = STRETCHING) {
  const refs = new Set([stretch.id, `${stretch.id}${variant.id}`]);
  return Object.keys(data.muscles)
    .filter((key) => data.muscles[key].stretches?.some((ref) => refs.has(ref)))
    .sort();
}

/**
 * Whether a muscle counts as stretched once the variants in `seen` (a Set of
 * variant refs as variantRef gives them) have been shown: every action is
 * reversed by a seen variant among its own stretches, or, for a lengthen-only
 * muscle, one of its variants was seen. Muscles that can't be stretched never count.
 */
export function isStretched(key, seen, data = STRETCHING) {
  const entry = data.muscles[key];
  if (!entry?.stretches) return false;
  const shown = entry.stretches.flatMap((ref) =>
    variantsOf(ref, data).filter(({ stretch, variant }) => seen.has(variantRef(stretch, variant))),
  );
  if (!shown.length) return false;
  if (!entry.actions?.length) return true;
  return entry.actions.every((action) => reversedOnBothSides(action, shown));
}

/**
 * The sides on which a variant, done on `side`, lengthens the muscle `key`
 * (one of its targets). A one-side stretch lengthens that side's. One done
 * once for both sides lengthens a side's muscle where that side's moves
 * (movesFor) reverse one of its actions: both sides for the butterfly, but
 * only the right splenius when the head turns left. A lengthen-only muscle,
 * which has no actions to reverse, is lengthened on both.
 */
export function stretchedSides(key, stretch, variant, side, data = STRETCHING) {
  if (isSided(stretch, variant)) return [side];
  const actions = data.muscles[key]?.actions;
  if (!actions?.length) return ['left', 'right'];
  return ['left', 'right'].filter((s) => actions.some((action) => reverses(action, movesFor(stretch, variant, s))));
}

/**
 * Stretching mode's progress, once the variants in `seen` (refs) are done:
 * muscles stretched out of those the run can stretch (opt-in sections as in
 * runOrder), how many more the opt-in sections would add, each section's
 * variants done, and the muscles that can't be stretched with the reason.
 */
export function coverage(seen, { optIn = false } = {}, data = STRETCHING) {
  const run = runOrder({ optIn }, data);
  const inRun = new Set(run.map(({ ref }) => ref));
  const reachable = (key) =>
    data.muscles[key].stretches?.some((ref) => variantsOf(ref, data).some(({ stretch, variant }) => inRun.has(variantRef(stretch, variant))));
  const stretchable = Object.keys(data.muscles).filter((key) => !data.muscles[key].cannot);
  const counted = stretchable.filter(reachable);
  const done = new Set([...seen].filter((ref) => inRun.has(ref)));
  return {
    stretched: counted.filter((key) => isStretched(key, done, data)).length,
    total: counted.length,
    optInMore: stretchable.length - counted.length,
    groups: GROUPS.map((group) => {
      const refs = run.filter(({ stretch }) => stretch.group === group).map(({ ref }) => ref);
      return { group, name: GROUP_NAMES[group], done: refs.filter((ref) => done.has(ref)).length, total: refs.length };
    }).filter((g) => g.total),
    cannot: Object.keys(data.muscles)
      .filter((key) => data.muscles[key].cannot)
      .sort()
      .map((key) => ({ key, reason: data.muscles[key].cannot })),
  };
}

/**
 * Every variant in run order: by section (GROUPS), then in the data's order.
 * Opt-in stretches run only when their section is asked for: `optIn` is a
 * list of OPT_IN sections, or true for all of them.
 * @returns {{ stretch: object, variant: object, ref: string }[]}
 */
export function runOrder({ optIn = false } = {}, data = STRETCHING) {
  const on = (section) => optIn === true || (Array.isArray(optIn) && optIn.includes(section));
  return GROUPS.flatMap((group) =>
    data.stretches
      .filter((s) => s.group === group && (!s.optIn || on(s.optIn)))
      .flatMap((stretch) => stretch.variants.map((variant) => ({ stretch, variant, ref: variantRef(stretch, variant) }))),
  );
}

/**
 * The parts a joint move, nerve glide or rolling card shows, by layer id
 * ({ joints: [...], muscular: [...] }): the variant's own, else its item's.
 * Empty for a muscle stretch, whose muscles are its targets (targetsOf).
 */
export function partsOf(stretch, variant) {
  return variant.parts ?? stretch.parts ?? {};
}
