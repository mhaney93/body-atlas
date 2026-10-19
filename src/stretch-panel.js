// "Stretch it" in the info panel of a selected muscle: the stretches that
// lengthen it (src/stretches.json), each of which poses the model on a loop
// (Viewer.showPose) on the muscle's own side, with the muscles it stretches
// lit; or, for a muscle that can't be stretched, why not.
import { canonical } from './layers.js';
import * as THREE from 'three';
import { CUES, variantCues } from './cues.js';
import { variantOps } from './pose.js';
import { sideOf } from './search.js';
import { STRETCHING, stretchedSides, targetsOf, variantRef, variantsOf } from './stretching.js';

/** The stretching entry of a Muscular mesh (a tendon uses its muscle's). */
export function stretchEntry(mesh) {
  const name = mesh.userData.of ?? mesh.userData.name ?? mesh.name;
  const key = canonical(name);
  return { key, entry: STRETCHING.muscles[key] };
}

/**
 * The meshes of a loaded Muscular `group` that a variant done on `side`
 * lengthens (stretchedSides): its targets on the sides it stretches them,
 * and midline ones.
 */
export function stretchedMeshes(group, stretch, variant, side) {
  const keys = new Set(targetsOf(stretch, variant));
  const sides = new Map();
  const meshes = [];
  group?.traverse((o) => {
    if (!o.isMesh || o.userData.haze) return;
    const name = o.userData.of ?? o.userData.name ?? o.name;
    const key = canonical(name);
    if (!keys.has(key)) return;
    if (!sides.has(key)) sides.set(key, stretchedSides(key, stretch, variant, side));
    const own = sideOf(name);
    if (!own ? sides.get(key).length : sides.get(key).includes(own)) meshes.push(o);
  });
  return meshes;
}

/**
 * The rest-pose centre of the muscles `keys` in a loaded Muscular `group`, on
 * `side` (null: both sides together), or null if none is there: where a cue
 * arrow (src/cues.js) starts.
 */
export function cueCenters(group) {
  return (keys, side) => {
    const want = new Set(keys);
    const box = new THREE.Box3();
    const part = new THREE.Box3();
    group?.traverse((o) => {
      if (!o.isMesh || o.userData.haze || o.userData.of) return;
      const name = o.userData.name ?? o.name;
      if (!want.has(canonical(name)) || (side && sideOf(name) !== side)) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      o.updateWorldMatrix(true, false);
      box.union(part.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld));
    });
    return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
  };
}

/** The pose and arrows a variant is shown with on `side`: its joint turns, and cues for the moves no bone shows. */
export function demo(viewer, layer, stretch, variant, side) {
  const rig = viewer.poser.rig;
  const cues = rig ? variantCues(stretch, variant, side, rig, cueCenters(viewer.layers.get(layer.id)?.group)) : [];
  return { ops: variantOps(stretch, variant, side), cues };
}

/** Whether a variant can be shown: it turns a joint or has a cue arrow (every move does; this guards against data that doesn't). */
export function moves(stretch, variant) {
  const codes = [...(variant.setup ?? []), ...variant.moves];
  return variantOps(stretch, variant, 'left').some((op) => op.angle && !op.setup) || codes.some((code) => CUES[code.split(':')[0]]);
}

/**
 * Lends a layer to a demo (the eyeballs' Sense organs to an eye muscle's
 * "Stretch it"): `borrow()` switches it on if it is off, resolving `ready`
 * once it has loaded, and its `restore()` switches it back off, unless the
 * user has taken it over meanwhile (`keep()`: they selected one of its parts
 * or toggled it), in which case it stays as they have it.
 * @param {{ isOn: () => boolean, setOn: (on: boolean) => Promise<unknown>, load: () => Promise<unknown> }} layer
 */
export function layerLoan({ isOn, setOn, load }) {
  let loan = null;
  return {
    borrow() {
      if (isOn()) return { ready: load(), restore() {} };
      const mine = { kept: false };
      loan = mine;
      return {
        ready: setOn(true),
        restore() {
          if (loan !== mine) return;
          loan = null;
          if (!mine.kept && isOn()) setOn(false);
        },
      };
    },
    keep() {
      if (loan) loan.kept = true;
    },
  };
}

/**
 * @param {import('./viewer.js').Viewer} viewer
 * @param {HTMLElement} el the panel's section
 * @param {{ color: string }} layer the Muscular layer
 * @param {{ openMode?: (muscleKey: string, side?: 'left' | 'right') => void, showEyes?: () => { ready: Promise<unknown>, restore: () => void } }} [host]
 *   `openMode` opens Stretching mode at the muscle's first stretch, on the muscle's side (none for a midline muscle);
 *   `showEyes` shows the eyeballs' layer (Sense organs; a layerLoan's `borrow`), resolving `ready` once it has loaded
 */
export function stretchPanel(viewer, el, layer, { openMode, showEyes } = {}) {
  let playing = null;

  function stop() {
    if (!playing) return;
    playing.eyes?.restore();
    playing = null;
    viewer.stopPose();
    viewer.emphasize([]);
    for (const b of el.querySelectorAll('button[data-ref]')) b.textContent = b.dataset.label;
    el.querySelector('.stretch-how')?.replaceChildren();
  }

  function play(stretch, variant, side, button) {
    const ref = variantRef(stretch, variant);
    const again = playing?.ref === ref;
    stop();
    if (again) return;
    playing = { ref };
    const { ops, cues } = demo(viewer, layer, stretch, variant, side);
    viewer.showPose(ops, cues);
    // The eyes turn about their eyeballs, which the rig finds once the Sense organs load: show them and start again.
    if (showEyes && ops.some((op) => op.seg.endsWith('-eye'))) {
      playing.eyes = showEyes();
      playing.eyes.ready
        .then(() => {
          if (playing?.ref === ref) viewer.showPose(ops, cues);
        })
        .catch((err) => console.error(err));
    }
    viewer.emphasize(stretchedMeshes(viewer.layers.get(layer.id)?.group, stretch, variant, side));
    button.textContent = button.dataset.label.replace('▶', '■ Stop:');
    const how = el.querySelector('.stretch-how');
    const line = (label, text) => {
      const p = document.createElement('p');
      const b = document.createElement('span');
      b.className = 'label';
      b.textContent = `${label}: `;
      p.append(b, text);
      return p;
    };
    how.replaceChildren(line('How', stretch.how), line('Hold', stretch.hold));
    if (stretch.cue) how.append(line('Cue', stretch.cue));
  }

  return {
    stop,
    /** Ends any pose and empties the section. */
    hide() {
      stop();
      el.hidden = true;
      el.replaceChildren();
    },
    /** Fills the section for a selected mesh of `selectedLayer` (hidden for other layers). */
    show(selectedLayer, mesh) {
      stop();
      el.replaceChildren();
      const { key, entry } = selectedLayer.id === layer.id ? stretchEntry(mesh) : {};
      el.hidden = !entry;
      if (!entry) return;
      el.style.setProperty('--layer-color', layer.color);
      const heading = document.createElement('p');
      heading.className = 'kicker';
      heading.textContent = entry.lengthenOnly ? 'Lengthen it' : 'Stretch it';
      el.append(heading);
      if (entry.cannot) {
        const p = document.createElement('p');
        p.textContent = `Can’t be stretched: ${entry.cannot}`;
        el.append(p);
        return;
      }
      if (entry.note) {
        const p = document.createElement('p');
        p.className = 'stretch-note';
        p.textContent = entry.note;
        el.append(p);
      }
      const own = sideOf(mesh.userData.of ?? mesh.userData.name ?? mesh.name);
      const side = own ?? 'left';
      const list = document.createElement('ul');
      list.className = 'stretch-list';
      for (const { stretch, variant } of entry.stretches.flatMap((ref) => variantsOf(ref))) {
        const item = document.createElement('li');
        const name = stretch.variants.length > 1 ? `${stretch.name} · ${variant.label}` : stretch.name;
        if (moves(stretch, variant)) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'tour-button';
          button.dataset.ref = variantRef(stretch, variant);
          button.dataset.label = `▶ ${name}`;
          button.textContent = button.dataset.label;
          button.addEventListener('click', () => play(stretch, variant, side, button));
          item.append(button);
        } else {
          item.textContent = `${name}: ${stretch.how}`;
        }
        list.append(item);
      }
      const how = document.createElement('div');
      how.className = 'stretch-how';
      const note = document.createElement('p');
      note.className = 'stretch-note';
      note.textContent =
        'The bones, muscles, joints and nerves move into the stretch; other systems hide while it plays, and the glass skin stays where you start.';
      el.append(list, how, note);
      if (openMode) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'link-button';
        link.textContent = 'How to stretch it, in Stretching mode ›';
        link.title = 'Step through every stretch, starting with this muscle’s';
        link.addEventListener('click', () => openMode(key, own ?? undefined));
        el.append(link);
      }
    },
  };
}
