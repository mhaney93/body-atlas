// Fills in the neck vessels BodyParts3D models only in pieces, from the
// Z-Anatomy export in data-sources/z-anatomy/circulatory/ (written by
// scripts/export-z-anatomy.py).
//
// BodyParts3D's common carotid arteries stop about 6 cm below the start of its
// internal carotids, its vertebral arteries start about 5 cm above the
// subclavian arteries they branch from, and its internal jugular veins stop in
// the lower neck, well below the jugular foramen. Z-Anatomy draws these
// vessels whole, as bevelled curves (centrelines with a radius). Each curve is
// moved onto the BodyParts3D skeleton with the nervous system's bone-by-bone
// warp (nervous-model.mjs), and the stretch that BodyParts3D lacks becomes a
// tube added to the BodyParts3D part it continues:
// - each end is pinned to the BodyParts3D vessel it joins (the centre of its
//   cut end, or a point inside the subclavian artery the vertebral artery
//   leaves), and the rest of the curve follows by an offset that fades along
//   it, so the bridge keeps Z-Anatomy's course between the two;
// - near each pinned end the tube turns smoothly into the direction of the
//   vessel it joins, starts inside it, and takes its radius, so the two read
//   as one vessel;
// - the carotid bridge is split where Z-Anatomy's common carotid ends (the
//   carotid bifurcation): below it is common carotid, above it internal
//   carotid;
// - the internal jugular vein runs on up Z-Anatomy's curve to the skull base,
//   where it leaves the jugular foramen: it stops where the curve first enters
//   the temporal or occipital bone (above, inside the skull, it is the sigmoid
//   sinus, which is not shown).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWarp, tube } from './nervous-model.mjs';

/**
 * Each bridge: the Z-Anatomy curves it follows, in order (with the part that
 * stretch of the curve belongs to), and the BodyParts3D vessel at each end:
 * `tip` +1/-1 for the vessel's upper/lower cut end, `side` for a point inside
 * a vessel the bridge branches off. Without an `end` the bridge runs along the
 * curve until it enters one of the `stopAt` bones.
 */
const BRIDGES = ['Right', 'Left'].flatMap((side) => {
  const s = side[0].toLowerCase();
  return [
    {
      curves: [
        [`${side} common carotid artery`, `${side} common carotid artery`],
        [`Internal carotid artery.${s}`, `${side} internal carotid artery`],
      ],
      start: { part: `${side} common carotid artery`, tip: 1 },
      end: { part: `${side} internal carotid artery`, tip: -1 },
    },
    {
      curves: [[`Vertebral artery.${s}`, `${side} vertebral artery`]],
      start: { part: `${side} subclavian artery`, side: true },
      end: { part: `${side} vertebral artery`, tip: -1 },
    },
    {
      curves: [[`Internal jugular vein.${s}`, `${side} internal jugular vein`]],
      start: { part: `${side} internal jugular vein`, tip: 1 },
      stopAt: /temporal bone$|^occipital bone$/i,
    },
  ];
});

// A cut end's centre, direction and radius are measured on the
// cross-sections this far (mm) back from its tip, clear of the cut face
// (BodyParts3D cuts some vessels obliquely).
const SECTION_NEAR = 10;
const SECTION_FAR = 16;
// Over this length (mm, at most a third of the bridge) the bridge turns from
// the joined vessel's direction into Z-Anatomy's course.
const BLEND = 25;
// A free end keeps this share of the radius it starts with: Z-Anatomy's
// internal jugular narrows a little towards the jugular foramen.
const FREE_END_RADIUS = 0.8;
const SIDES = 12;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => scale(a, 1 / (len(a) || 1));
const mix = (a, b, t) => add(a, scale(sub(b, a), t));
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function points(positions) {
  const out = [];
  for (let i = 0; i < positions.length; i += 3) out.push([positions[i], positions[i + 1], positions[i + 2]]);
  return out;
}

/**
 * The upper (`dir` +1) or lower (-1) cut end of a vessel: the centre of the
 * tip `point`, the vessel's direction `axis` out through it, its `radius`, and
 * `inside`, two points on its centreline behind the tip. Each is measured on
 * cross-sections of the mesh (where its edges cross a horizontal plane), so a
 * coarse mesh measures as well as a fine one.
 */
function cutEnd({ positions, indices }, dir) {
  const pts = points(positions);
  const height = (p) => p[2] * dir;
  const tip = pts.reduce((a, b) => (height(b) > height(a) ? b : a));
  const section = (depth) => {
    const h = height(tip) - depth;
    const out = [];
    for (let t = 0; t < indices.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const [a, b] = [pts[indices[t + e]], pts[indices[t + ((e + 1) % 3)]]];
        if ((height(a) - h) * (height(b) - h) >= 0) continue;
        const q = mix(a, b, (h - height(a)) / (height(b) - height(a)));
        if (len(sub(q, tip)) < 30) out.push(q);
      }
    return out;
  };
  const centre = (ps) => scale(ps.reduce(add, [0, 0, 0]), 1 / ps.length);
  const ring = section(SECTION_NEAR);
  const c1 = centre(ring);
  const c2 = centre(section(SECTION_FAR));
  const axis = norm(sub(c1, c2));
  const radius = ring.reduce((sum, p) => sum + len(sub(sub(p, c1), scale(axis, dot(sub(p, c1), axis)))), 0) / ring.length;
  return { point: add(c1, scale(axis, dot(sub(tip, c1), axis))), axis, radius, inside: [c2, c1] };
}

/** The point of `line` nearest to `p`, as an index. */
const nearest = (line, p) => line.reduce((best, q, i) => (len(sub(q, p)) < len(sub(line[best], p)) ? i : best), 0);

/**
 * The bridge's centreline (`line`, [x, y, z, r] points in mm), the part each
 * point belongs to (`who`), and its length between the pinned ends (`total`).
 * `stop(from)` gives where a bridge without an `end` stops.
 */
function bridgeLine(curve, owner, start, end, stop) {
  const i0 = nearest(curve, start.point);
  const i1 = end ? nearest(curve, end.point) : stop(i0);
  if (i1 - i0 < 2) throw new Error(`Nothing to bridge between ${start.point} and ${end?.point ?? 'the curve\'s end'}`);
  let sec = curve.slice(i0, i1 + 1);
  let who = owner.slice(i0, i1 + 1);
  const arc = [0];
  for (let i = 1; i < sec.length; i++) arc.push(arc[i - 1] + len(sub(sec[i], sec[i - 1])));
  const total = arc.at(-1);
  // Pin both ends; the offset between them fades along the curve.
  const o0 = sub(start.point, sec[0]);
  const o1 = end ? sub(end.point, sec.at(-1)) : [0, 0, 0];
  const r0 = start.radius;
  const r1 = end ? end.radius : start.radius * FREE_END_RADIUS;
  const blend = Math.min(BLEND, total / 3);
  sec = sec.map((p, i) => {
    const t = arc[i] / total;
    let q = add(p.slice(0, 3), mix(o0, o1, t));
    // Turn out of (and into) the joined vessels' own directions.
    if (start.axis) q = mix(add(start.point, scale(start.axis, arc[i])), q, smooth(arc[i] / blend));
    if (end) q = mix(add(end.point, scale(end.axis, total - arc[i])), q, smooth((total - arc[i]) / blend));
    return [...q, r0 + (r1 - r0) * t];
  });
  // Start (and end) inside the joined vessels, a little thinner, so no seam shows.
  const into = (e, r) => e.inside.map((p) => [...p, r * 0.9]);
  const line = [...(start.inside ? into(start, r0) : []), ...sec, ...(end ? into(end, r1).reverse() : [])];
  who = [...(start.inside ? start.inside.map(() => who[0]) : []), ...who, ...(end ? end.inside.map(() => who.at(-1)) : [])];
  return { line, who, total };
}

/**
 * Adds the bridges to the circulatory parts (BodyParts3D millimetres, after
 * mergeByName), in place.
 * @param {{name: string, positions: number[], indices: number[]}[]} parts
 * @param {string} dir data-sources/z-anatomy/circulatory
 * @param {string} landmarks data-sources/z-anatomy/nervous/landmarks.json
 * @param {Map<string, {name: string, positions: number[], indices: number[]}>} bp3dBones BodyParts3D bones by English name
 * @param {import('./placement.mjs').Body} body the skin and bones as shown
 */
export function bridgeNeckVessels(parts, dir, landmarks, bp3dBones, body) {
  const warp = buildWarp(JSON.parse(readFileSync(landmarks, 'utf8')), bp3dBones);
  const byName = new Map(parts.map((p) => [p.name, p]));
  const part = (name) => {
    if (!byName.has(name)) throw new Error(`No circulatory part "${name}" to bridge`);
    return byName.get(name);
  };
  const report = [];
  for (const bridge of BRIDGES) {
    const curve = [];
    const owner = [];
    for (const [file, name] of bridge.curves) {
      const line = JSON.parse(readFileSync(join(dir, `${file}.json`), 'utf8')).lines[0];
      const mm = line.map(([x, y, z, r]) => [...warp.blended([x * 1000, y * 1000, z * 1000]), r * 1000]);
      // Curves run on from each other; the shared point is kept once.
      for (const p of curve.length && len(sub(mm[0], curve.at(-1))) < 0.5 ? mm.slice(1) : mm) {
        curve.push(p);
        owner.push(name);
      }
    }
    const startPart = part(bridge.start.part);
    let start;
    if (bridge.start.side) {
      // A point inside the vessel the bridge branches off, beside the curve's start.
      const pts = points(startPart.positions);
      const d = (p) => len(sub(p, curve[0]));
      const closest = Math.min(...pts.map(d));
      const around = pts.filter((p) => d(p) < closest + 6);
      start = { point: scale(around.reduce(add, [0, 0, 0]), 1 / around.length), radius: null };
    } else start = cutEnd(startPart, bridge.start.tip);
    const end = bridge.end && cutEnd(part(bridge.end.part), bridge.end.tip);
    // A branch is as thick as the vessel it leads to.
    start.radius ??= end.radius;
    if (len(sub(curve[0], start.point)) > len(sub(curve.at(-1), start.point))) {
      curve.reverse();
      owner.reverse();
    }
    // Where the curve reaches a `stopAt` bone: the first point whose tube
    // would touch it.
    const stop = (from) => {
      const bones = body.bones.filter((b) => bridge.stopAt.test(b.name));
      const reach = start.radius * FREE_END_RADIUS;
      const i = curve.findIndex((p, k) => k > from && bones.some((b) => b.solid.contains(p) || b.solid.closest(p).distance < reach));
      return i < 0 ? curve.length - 1 : i;
    };
    const { line, who, total } = bridgeLine(curve, owner, start, end, stop);
    // One tube per part, meeting where the bridge passes from one to the next.
    for (let i = 0; i < line.length; ) {
      let j = i;
      while (j + 1 < line.length && who[j + 1] === who[i]) j++;
      const piece = line.slice(i, Math.min(j + 2, line.length));
      if (piece.length > 1) {
        const into = part(who[i]);
        const positions = [];
        const indices = [];
        tube(piece, positions, indices, { radius: (r) => r, sides: SIDES });
        const base = into.positions.length / 3;
        into.positions = into.positions.concat(positions);
        into.indices = into.indices.concat(indices.map((k) => k + base));
      }
      i = j + 1;
    }
    report.push(`${bridge.curves.at(-1)[1]} ${total.toFixed(0)} mm`);
  }
  console.log(`  bridged the neck vessels BodyParts3D models in pieces: ${report.join(', ')}`);
}
