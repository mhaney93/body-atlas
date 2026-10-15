// Optional controls a layer can opt into through its data file, shown under
// its toggle while it is on (see README "Adding a body system"):
//
//   depthLevels: ["Superficial", ...]  a slider that peels parts away layer by
//                                      layer; parts carry `depth` 1..n (1 = outermost)
//   peelReveals: "skeletal"            once peeling, offer to switch that layer on
//   movements: [{ id, name, note?, prime: [part keys], synergist: [part keys] }]
//                                      a picker that lights up the parts doing a movement
//   movementPrompt: "Show me the muscles for…"
//
// Part keys are part names as keyed in `parts` (no "left"/"right"); a mesh
// that belongs to a part (e.g. a muscle's tendon) follows that part.
import { canonical, partInfo } from './layers.js';

/** "gluteus maximus" → "Gluteus maximus" */
const displayName = (key) => key.charAt(0).toUpperCase() + key.slice(1);

const meshName = (mesh) => mesh.userData.name ?? mesh.name;

/**
 * Builds the controls for one layer, or returns null if it has none.
 * @param {object} layer layer data
 * @param {import('./viewer.js').Viewer} viewer
 * @param {{ layerName: (id: string) => string | undefined, isLayerOn: (id: string) => boolean, showLayer: (id: string) => void }} host
 * @returns {{ element: HTMLElement, refresh: () => void, describe: (mesh: object) => string | null } | null}
 */
export function buildLayerControls(layer, viewer, host) {
  const { depthLevels, movements } = layer;
  if (!depthLevels?.length && !movements?.length) return null;

  const root = document.createElement('div');
  root.className = 'layer-controls';
  root.style.setProperty('--layer-color', layer.color);
  const uid = (name) => `${layer.id}-${name}`;
  let refreshPeel = () => {};
  let movement = null;

  if (depthLevels?.length) {
    const depthOf = (mesh) =>
      (mesh.userData.depth ??= partInfo(layer, meshName(mesh), mesh.userData.group, undefined, mesh.userData.of).depth ?? 0);
    const wrap = document.createElement('div');
    wrap.className = 'control';
    wrap.innerHTML = `
      <label class="control-label" for="${uid('peel')}">Peel away <output></output></label>
      <input id="${uid('peel')}" type="range" min="0" max="${depthLevels.length}" step="1" value="0" />
      <p class="control-note" hidden></p>`;
    const input = wrap.querySelector('input');
    const out = wrap.querySelector('output');
    const note = wrap.querySelector('.control-note');
    refreshPeel = () => {
      const level = Number(input.value);
      out.textContent =
        level === 0
          ? 'Nothing'
          : level === depthLevels.length
            ? 'All layers'
            : depthLevels.slice(0, level).join(' + ');
      input.setAttribute('aria-valuetext', `Peeled away: ${out.textContent}`);
      const reveals = layer.peelReveals;
      const offer = level > 0 && reveals && !host.isLayerOn(reveals);
      note.hidden = !offer;
      if (offer) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'link-button';
        button.textContent = `Show ${host.layerName(reveals) ?? reveals} underneath`;
        button.addEventListener('click', () => host.showLayer(reveals));
        note.replaceChildren(button);
      }
    };
    input.addEventListener('input', () => {
      const level = Number(input.value);
      viewer.setPeeled(layer.id, level ? (mesh) => depthOf(mesh) > 0 && depthOf(mesh) <= level : null);
      refreshPeel();
    });
    refreshPeel();
    root.append(wrap);
  }

  if (movements?.length) {
    const wrap = document.createElement('div');
    wrap.className = 'control';
    wrap.innerHTML = `
      <label class="control-label" for="${uid('movement')}"></label>
      <select id="${uid('movement')}"><option value="">Choose a movement</option></select>
      <div class="movement" hidden>
        <p class="movement-legend">
          <span class="key prime" aria-hidden="true"></span> Prime movers
          <span class="key synergist" aria-hidden="true"></span> Synergists
        </p>
        <p class="control-note movement-note"></p>
        <p class="control-note"><strong>Prime movers:</strong> <span class="movement-prime"></span></p>
        <p class="control-note"><strong>Synergists:</strong> <span class="movement-synergist"></span></p>
      </div>`;
    wrap.querySelector('label').textContent = layer.movementPrompt ?? 'Show me the muscles for…';
    const select = wrap.querySelector('select');
    for (const m of movements) select.add(new Option(m.name, m.id));
    const details = wrap.querySelector('.movement');
    select.addEventListener('change', () => {
      const m = movements.find((x) => x.id === select.value);
      movement = m && { ...m, primeKeys: new Set(m.prime), synergistKeys: new Set(m.synergist) };
      viewer.setEmphasis(layer.id, movement ? (mesh) => roleOf(mesh) : null);
      details.hidden = !m;
      if (!m) return;
      details.querySelector('.movement-note').textContent = m.note ?? '';
      details.querySelector('.movement-prime').textContent = m.prime.map(displayName).join(', ');
      details.querySelector('.movement-synergist').textContent = m.synergist.map(displayName).join(', ');
    });
    root.append(wrap);
  }

  /** A mesh's role in the chosen movement, by its own part key or that of the part it belongs to. */
  function roleOf(mesh) {
    const key = canonical(mesh.userData.of ?? meshName(mesh));
    if (movement?.primeKeys.has(key)) return 'prime';
    if (movement?.synergistKeys.has(key)) return 'synergist';
    return null;
  }

  return {
    element: root,
    refresh: () => refreshPeel(),
    describe(mesh) {
      const role = movement && roleOf(mesh);
      return role ? `${role === 'prime' ? 'Prime mover' : 'Synergist'} in: ${movement.name}` : null;
    },
  };
}
