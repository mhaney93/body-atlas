// Stretching data (src/stretches.json) and the rules that read it: which
// joint moves a stretch makes, which muscles each variant lengthens, and
// whether every action of a muscle is reversed by one of its stretches. A
// muscle's action is written "<joint>.<direction>" (e.g. "hip.flex"), relative
// to the muscle's own side; a stretch variant's moves use the same codes, so a
// move reverses an action when it is the opposite direction at the same joint.
// The upcoming Stretching mode, the part info panel and
// scripts/stretches.test.mjs all go through here.
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
 * Directions that swap between the two sides when a midline part (head, neck,
 * trunk, jaw) or both eyes move one way: turning the head left rotates the left
 * side's muscles toward their own side and the right side's away from theirs.
 */
export const MIRROR = Object.fromEntries(
  [['roti', 'rotc'], ['sbi', 'sbc'], ['lati', 'latc'], ['in', 'out'], ['downin', 'downout'], ['upin', 'upout']].flatMap(
    ([a, b]) => [[a, b], [b, a]],
  ),
);

/** Sections of the head-to-toe run, in order; `optIn` stretches (face, eyes, tongue) only run when asked for. */
export const GROUPS = ['neck', 'jaw', 'face', 'eye', 'shoulder', 'arm', 'hand', 'trunk', 'hip', 'leg'];

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
    return MIRROR[dir] ? code.replace(`${joint}.${dir}`, `${joint}.${MIRROR[dir]}`) : code;
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
 * Every variant in run order: by section head to toe (GROUPS), then in the
 * data's order. Opt-in stretches are left out unless `optIn` is set.
 * @returns {{ stretch: object, variant: object, ref: string }[]}
 */
export function runOrder({ optIn = false } = {}, data = STRETCHING) {
  return GROUPS.flatMap((group) =>
    data.stretches
      .filter((s) => s.group === group && (optIn || !s.optIn))
      .flatMap((stretch) => stretch.variants.map((variant) => ({ stretch, variant, ref: variantRef(stretch, variant) }))),
  );
}
