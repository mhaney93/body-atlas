// Arrows for moves a pose can't show: the ribs in breathing, the pelvic
// floor, the tongue, the face and the eyes, the palm and the foot's arch have
// no bone of their own to turn (UNPOSED in src/pose.js). Each such move gets
// straight arrows at the muscles that make it, pointing the way it goes;
// src/pose-view.js carries them along with whatever the pose moves and draws
// them with the joint arrows. Pure, so the tests can check every move has one.
import * as THREE from 'three';
import { UNPOSED, vector } from './pose.js';
import { isSided, parseMove } from './stretching.js';

const EYE = ['superior rectus', 'inferior rectus', 'medial rectus', 'lateral rectus'];
/** In front of the eyeball (m), where a gaze arrow starts. */
const IN_FRONT_OF_EYE = 0.015;

const cue = (at, toward, seg, extra = {}) => ({ at, toward, seg, ...extra });
const eye = (toward) => [cue(EYE, toward, 'head', { ahead: IN_FRONT_OF_EYE })];

/**
 * For each move the rig can't pose, its arrows: at the muscles `at` (one
 * arrow per side, or one over both for a `midline` one), riding on segment
 * `seg`, pointing `toward` the sum of these directions. Directions are the
 * rig's (up, down, anterior, posterior; lateral and medial of the arrow's
 * side; radial, ulnar of its hand), plus `toward` and `away`: the side the
 * move is written for and the other one, so both eyes look the same way.
 */
export const CUES = {
  'ribs.inh': [cue(['diaphragm'], ['down'], 'thorax', { midline: true })],
  'ribs.exh': [cue(['diaphragm'], ['up'], 'thorax', { midline: true })],
  'ribs.elev': [cue(['external intercostal muscle'], ['lateral', 'up'], 'thorax')],
  'ribs.dep': [cue(['external intercostal muscle'], ['medial', 'down'], 'thorax')],
  'pelvic-floor.drop': [cue(['pubococcygeus', 'iliococcygeus'], ['down'], 'pelvis')],
  'tongue.out': [cue(['genioglossus'], ['anterior', 'up'], 'mandible', { midline: true })],
  'tongue.back': [cue(['genioglossus'], ['posterior'], 'mandible', { midline: true })],
  'face.browsup': [cue(['frontalis'], ['up'], 'head')],
  'face.browsdown': [cue(['corrugator supercilii'], ['down', 'medial'], 'head')],
  'face.eyeswide': [cue(['palpebral part of orbicularis oculi'], ['up'], 'head')],
  'face.flare': [cue(['nasalis'], ['lateral'], 'head')],
  'face.lipswide': [cue(['risorius'], ['lateral'], 'head')],
  'face.lowerlipdown': [cue(['depressor labii inferioris'], ['down'], 'mandible')],
  'face.pout': [cue(['mentalis'], ['anterior', 'up'], 'mandible')],
  'face.pucker': [cue(['orbicularis oris'], ['anterior', 'medial'], 'head')],
  'face.puff': [cue(['buccinator'], ['lateral'], 'head')],
  'face.smile': [cue(['zygomaticus major'], ['lateral', 'up'], 'head')],
  'face.sniff': [cue(['levator labii superioris alaeque nasi'], ['up'], 'head')],
  'eye.up': eye(['up']),
  'eye.down': eye(['down']),
  'eye.in': eye(['away']),
  'eye.out': eye(['toward']),
  'eye.upin': eye(['up', 'away']),
  'eye.upout': eye(['up', 'toward']),
  'eye.downin': eye(['down', 'away']),
  'eye.downout': eye(['down', 'toward']),
  'eye.lidclose': [cue(['levator palpebrae superioris'], ['down'], 'head')],
  'palm.flat': [cue(['opponens pollicis'], ['radial'], 'hand'), cue(['opponens digiti minimi of hand'], ['ulnar'], 'hand')],
  'arch.drop': [cue(['flexor digitorum brevis'], ['down'], 'foot')],
};

/** Segments that come in a left and a right. */
const SIDED = new Set(['hand', 'foot']);

/**
 * The arrows a variant needs for its moves the rig can't pose, done on
 * `side`: { center, seg, dir, length } with the centre and direction in the
 * rest pose (Poser carries them with the pose). `centerOf(keys, side)` gives
 * the rest-pose centre of those muscles on that side (side null: both), or
 * null when they aren't loaded; such arrows are left out.
 */
export function variantCues(stretch, variant, side, rig, centerOf) {
  const sides = isSided(stretch, variant) ? [side] : ['left', 'right'];
  // A one-time move ("look to the left") is written for the left side.
  const written = isSided(stretch, variant) ? side : 'left';
  const out = [];
  for (const code of [...(variant.setup ?? []), ...variant.moves]) {
    const { joint, dir } = parseMove(code);
    if (!UNPOSED.has(joint)) continue;
    for (const spec of CUES[`${joint}.${dir}`] ?? []) {
      for (const s of spec.midline ? [null] : sides) {
        const center = centerOf(spec.at, s);
        if (!center) continue;
        const own = s ?? written;
        const seg = SIDED.has(spec.seg) ? `${own}-${spec.seg}` : spec.seg;
        const d = new THREE.Vector3();
        for (const name of spec.toward) {
          const named = { toward: 'lateral', away: 'medial' }[name];
          d.add(named ? vector(named, seg, written, rig) : vector(name, seg, own, rig));
        }
        d.normalize();
        if (spec.ahead) center.addScaledVector(vector('anterior', seg, own, rig), spec.ahead);
        out.push({ code, center, seg, dir: d, length: spec.seg === 'head' || spec.seg === 'mandible' ? 0.025 : 0.05 });
      }
    }
  }
  return out;
}
