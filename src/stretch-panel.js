// "Stretch it" in the info panel of a selected muscle: the stretches that
// lengthen it (src/stretches.json), each of which poses the model on a loop
// (Viewer.showPose) on the muscle's own side, with the muscles it stretches
// lit; or, for a muscle that can't be stretched, why not.
import { canonical } from './layers.js';
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

/** Whether a variant turns any joint (some, such as the face's, are words only). */
export function moves(stretch, variant) {
  return variantOps(stretch, variant, 'left').some((op) => op.angle && !op.setup);
}

/**
 * @param {import('./viewer.js').Viewer} viewer
 * @param {HTMLElement} el the panel's section
 * @param {{ color: string }} layer the Muscular layer
 * @param {{ openMode?: (muscleKey: string, side?: 'left' | 'right') => void }} [host] `openMode` opens Stretching mode at
 *   the muscle's first stretch, on the muscle's side (none for a midline muscle)
 */
export function stretchPanel(viewer, el, layer, { openMode } = {}) {
  let playing = null;

  function stop() {
    if (!playing) return;
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
    viewer.showPose(variantOps(stretch, variant, side));
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
