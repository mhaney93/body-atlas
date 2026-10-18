// "Stretch it" in the info panel of a selected muscle: the stretches that
// lengthen it (src/stretches.json), each of which poses the model on a loop
// (Viewer.showPose) on the muscle's own side, with the muscles it stretches
// lit; or, for a muscle that can't be stretched, why not.
import { canonical } from './layers.js';
import { variantOps } from './pose.js';
import { sideOf } from './search.js';
import { STRETCHING, isSided, movesFor, targetsOf, variantRef, variantsOf } from './stretching.js';

/** The stretching entry of a Muscular mesh (a tendon uses its muscle's). */
export function stretchEntry(mesh) {
  const name = mesh.userData.of ?? mesh.userData.name ?? mesh.name;
  const key = canonical(name);
  return { key, entry: STRETCHING.muscles[key] };
}

/** Whether a variant turns any joint (some, such as the face's, are words only). */
export function moves(stretch, variant) {
  return variantOps(stretch, variant, 'left').some((op) => op.angle && !op.setup);
}

/**
 * @param {import('./viewer.js').Viewer} viewer
 * @param {HTMLElement} el the panel's section
 * @param {{ color: string }} layer the Muscular layer
 */
export function stretchPanel(viewer, el, layer) {
  let playing = null;

  function stop() {
    if (!playing) return;
    playing = null;
    viewer.stopPose();
    viewer.emphasize([]);
    for (const b of el.querySelectorAll('button[data-ref]')) b.textContent = b.dataset.label;
    el.querySelector('.stretch-how')?.replaceChildren();
  }

  /**
   * The parts the variant stretches on the side shown and the midline; both
   * sides for a variant done with both at once that is the same for each
   * (the butterfly, not a head turn, which mirrors).
   */
  function targets(stretch, variant, side) {
    const keys = new Set(targetsOf(stretch, variant));
    const both = !isSided(stretch, variant) && movesFor(stretch, variant, 'right').every((code, i) => code === variant.moves[i]);
    const group = viewer.layers.get(layer.id)?.group;
    const meshes = [];
    group?.traverse((o) => {
      if (!o.isMesh || o.userData.haze) return;
      const name = o.userData.of ?? o.userData.name ?? o.name;
      const own = sideOf(name);
      if (keys.has(canonical(name)) && (!own || both || own === side)) meshes.push(o);
    });
    return meshes;
  }

  function play(stretch, variant, side, button) {
    const ref = variantRef(stretch, variant);
    const again = playing?.ref === ref;
    stop();
    if (again) return;
    playing = { ref };
    viewer.showPose(variantOps(stretch, variant, side));
    viewer.emphasize(targets(stretch, variant, side));
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
      const { entry } = selectedLayer.id === layer.id ? stretchEntry(mesh) : {};
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
      const side = sideOf(mesh.userData.of ?? mesh.userData.name ?? mesh.name) ?? 'left';
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
        'The bones and muscles move into the stretch; other systems hide while it plays, and the glass skin stays where you start.';
      el.append(list, how, note);
    },
  };
}
