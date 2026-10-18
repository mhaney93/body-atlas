import { APPROXIMATE_LABEL, LAYERS, NOT_SHOWN_REASONS, SHELL_ASSET, partInfo } from './layers.js';
import { tourControls } from './tour.js';
import { guideControls } from './guide.js';
import { Stepper, stepperBar } from './stepper.js';
import { Viewer } from './viewer.js';
import { buildLayerControls } from './layer-controls.js';
import { notShownPanel } from './not-shown.js';
import { buildIndex } from './search.js';
import { searchBox } from './search-ui.js';
import { stretchPanel } from './stretch-panel.js';
import { fadeNoteKeeper, searchSelector } from './search-select.js';
import meshNames from './mesh-names.json';

const $ = (id) => document.getElementById(id);
// Asset paths in layer data are relative to the site root.
const asset = (path) => import.meta.env.BASE_URL + path;
const layers = LAYERS.map((layer) => ({
  ...layer,
  asset: asset(layer.asset),
  extraAssets: layer.extraAssets?.map(asset),
}));
// Point each shared-part entry at the layer object it borrows from.
for (const layer of layers) {
  layer.shared = layer.shared?.map((s) => ({ ...s, source: layers.find((l) => l.id === s.layer) }));
}

const info = $('info');
const viewer = new Viewer($('stage'), {
  poseBones: layers.find((l) => l.posable === 'bones'),
  partColor: (layer, meshName) => partInfo(layer, meshName).color,
  onFadedChange: (count) => fadeNotes.fadedChanged(count),
  onSelect(selection) {
    hideInfoNote();
    if (!selection) {
      info.hidden = true;
      stretch.hide();
      return;
    }
    const { layer, mesh } = selection;
    // three.js sanitises node names (spaces → underscores); the original lives in extras.
    const source = layers.find((l) => l.id === mesh.userData.sourceId);
    const part = partInfo(layer, mesh.userData.name ?? mesh.name, mesh.userData.group, source, mesh.userData.of);
    $('info-kicker').textContent = part.region ? `${layer.name} · ${part.region}` : layer.name;
    $('info-kicker').style.color = part.color ?? layer.color;
    $('info-name').textContent = part.name;
    $('info-flow').hidden = !part.flow;
    $('info-description').hidden = false;
    $('info-flow').querySelector('.label').textContent = layer.flowLabel ? `${layer.flowLabel}: ` : '';
    $('info-flow').querySelector('.value').textContent = part.flow ?? '';
    $('info-flow').style.setProperty('--group-color', part.group?.color ?? layer.color);
    $('info-description').textContent = part.description ?? '';
    $('info-approx').hidden = !part.approximate;
    $('info-approx').textContent = part.approximate ? APPROXIMATE_LABEL : '';
    showRole(layer, mesh);
    stretch.show(layer, mesh);
    info.hidden = false;
  },
});

if (import.meta.env.DEV) window.viewer = viewer; // handy for debugging in the console

// The hint and, on phones, the bottom panels sit just above the credit line, whatever its height.
const credit = document.querySelector('.credit');
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--credit-height', `${credit.offsetHeight}px`);
}).observe(credit);

/** "Stretch it" in a muscle's info panel (src/stretch-panel.js). */
const stretch = stretchPanel(viewer, $('info-stretch'), layers.find((l) => l.posable === 'soft'));

$('info-close').addEventListener('click', () => viewer.select(null));
$('reset-view').addEventListener('click', () => viewer.resetView());

const active = new Set();
/** Effect ids the user has switched on; an effect shows only while its layer is on too. */
const effectsOn = new Set();
/** Per-layer extra controls (layer-controls.js) by layer id. */
const controls = new Map();
/** Each layer's function that brings its toggle and extras in line with `active`. */
const syncs = new Map();
const toggles = new Map();
/** Sub-group show/hide checkboxes (layer `groupToggles`) by "<layer id>/<group id>". */
const groupBoxes = new Map();
const layerById = (id) => layers.find((l) => l.id === id);
/** Each layer's tour controls, by layer id, so the guide can stop a running tour. */
const tours = new Map();

/** Lets a layer's extras name another layer and switch it on. */
const layerHost = {
  layerName: (id) => layerById(id)?.name,
  showLayer: (id) => !active.has(id) && setLayer(layerById(id), true),
};

/** A line under the info panel's text with an optional action button. */
function infoNote(text, action, onAction) {
  fadeNotes.replaced();
  const note = $('info-note');
  note.querySelector('span').textContent = text;
  const button = note.querySelector('button');
  button.hidden = !action;
  button.textContent = action ?? '';
  button.onclick = onAction ?? null;
  note.hidden = false;
}

function hideInfoNote() {
  fadeNotes.replaced();
  $('info-note').hidden = true;
}

/** The note saying how many parts in front of a picked part are faded, kept up to date as that changes. */
const fadeNotes = fadeNoteKeeper({
  show: (note) => infoNote(note.text, note.action, () => viewer.clearFaded()),
  hide: hideInfoNote,
});

/** Fills the info panel with text that is not about a part on screen (nothing selected). */
function showInfoText({ kicker, color, name, description }) {
  viewer.select(null);
  $('info-kicker').textContent = kicker;
  $('info-kicker').style.color = color;
  $('info-name').textContent = name;
  $('info-flow').hidden = true;
  $('info-role').hidden = true;
  $('info-approx').hidden = true;
  $('info-description').textContent = description ?? '';
  $('info-description').hidden = !description;
  info.hidden = false;
}

/** The selected part's role in its layer's chosen movement, if any. */
function showRole(layer, mesh) {
  const role = controls.get(layer.id)?.describe(mesh);
  $('info-role').hidden = !role;
  $('info-role').textContent = role ?? '';
}

function applyEffects(layer) {
  for (const effect of layer.effects ?? []) {
    const on = active.has(layer.id) && effectsOn.has(effect.id);
    if (effect.type === 'haze') viewer.setHaze(effect.id, on ? effect.color : null);
    else viewer.setEffectVisible(effect, on, layer);
  }
}

/** Colour key and optional effect toggles shown under a layer's button while it is on. */
function layerExtras(layer) {
  const extras = document.createElement('div');
  extras.className = 'layer-extras';
  extras.hidden = true;
  const groups = Object.entries(layer.groups ?? {}).filter(([, g]) => g.legend !== false);
  if (groups.length) {
    const legend = document.createElement('ul');
    legend.className = 'legend';
    legend.setAttribute('aria-label', `${layer.name} colour key`);
    for (const [id, g] of groups) {
      const item = document.createElement('li');
      item.style.setProperty('--group-color', g.color);
      if (layer.groupToggles) {
        // Each key entry doubles as a show/hide checkbox for its sub-group.
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = g.visible ?? true;
        box.addEventListener('change', () => viewer.setGroupVisible(layer, id, box.checked));
        groupBoxes.set(`${layer.id}/${id}`, box);
        label.append(box, g.label);
        item.append(label);
      } else {
        item.textContent = g.label;
      }
      legend.append(item);
    }
    extras.append(legend);
  }
  for (const effect of layer.effects ?? []) {
    const label = document.createElement('label');
    label.className = 'effect';
    label.innerHTML =
      '<input type="checkbox" /><span class="effect-name"></span><span class="effect-badge">Illustrative</span><span class="effect-note"></span>';
    label.querySelector('.effect-name').textContent = effect.label;
    label.querySelector('.effect-note').textContent = effect.note;
    label.querySelector('input').addEventListener('change', (e) => {
      e.target.checked ? effectsOn.add(effect.id) : effectsOn.delete(effect.id);
      applyEffects(layer);
    });
    extras.append(label);
  }
  const extra = buildLayerControls(layer, viewer, {
    ...layerHost,
    isLayerOn: (id) => active.has(id),
    movementChanged: () => {
      const mesh = viewer.selected;
      if (mesh?.userData.layerId === layer.id) showRole(layer, mesh);
    },
  });
  if (extra) {
    controls.set(layer.id, extra);
    extras.append(extra.element);
  }
  return extras;
}

function renderSummary() {
  for (const c of controls.values()) c.refresh();
  const summary = $('layer-summary');
  const shown = layers.filter((l) => active.has(l.id));
  summary.hidden = shown.length === 0;
  summary.textContent = shown.map((l) => l.summary).join(' ');
  $('hint').textContent = shown.length
    ? 'Tap or click a part to learn about it · drag to rotate · pinch or scroll to zoom'
    : 'Drag to rotate · scroll or pinch to zoom · right-drag or two fingers to pan';
}

/**
 * The Guide (src/guide.js): steps through every part of one system, picking
 * each as a search result would (switching on whatever hides it, framing it
 * and opening its info), driven by the reusable stepper bar and ←/→/Esc.
 */
const guideStepper = new Stepper({
  onStep: (part) => pickResult({ kind: 'part', layerId: part.layerId, meshName: part.meshName }).catch((err) => console.error(err)),
}).listen(window);
document.body.append(
  stepperBar(guideStepper, {
    kicker: (s) => `Guide · ${layerById(s.current.layerId).name}`,
    title: (part) => part.meshName,
    color: (s) => layerById(s.current.layerId).color,
  }),
);

for (const layer of layers) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'layer-toggle';
  button.setAttribute('aria-pressed', 'false');
  button.style.setProperty('--layer-color', layer.color);
  button.innerHTML = '<span class="swatch" aria-hidden="true"></span><span class="label"></span><span class="state"></span>';
  button.querySelector('.label').textContent = layer.name;
  toggles.set(layer.id, button);
  const extras = layerExtras(layer);
  const guide = guideControls(viewer, layer, guideStepper, { onStart: () => tours.forEach((t) => t.stop()) });
  extras.append(guide.element);
  const tour = layer.tour && tourControls(viewer, layer);
  if (tour) {
    tours.set(layer.id, tour);
    tour.element.addEventListener('click', () => guideStepper.stop());
    extras.append(tour.element);
  }
  const notShown = notShownPanel(layer, layerHost);
  if (notShown) extras.append(notShown);
  const sync = () => {
    const on = active.has(layer.id);
    if (!on) {
      tour?.stop();
      guide.stop();
    }
    button.setAttribute('aria-pressed', String(on));
    extras.hidden = !on || !extras.childElementCount;
    applyEffects(layer);
    renderSummary();
  };
  syncs.set(layer.id, sync);
  button.addEventListener('click', () => setLayer(layer, !active.has(layer.id)));
  li.append(button, extras);
  $('layer-list').append(li);
}

/** Switches a layer on or off, loading its model the first time; resolves once it is shown. */
async function setLayer(layer, on) {
  const button = toggles.get(layer.id);
  const sync = syncs.get(layer.id);
  on ? active.add(layer.id) : active.delete(layer.id);
  sync();
  button.classList.add('busy');
  button.querySelector('.state').textContent = '';
  try {
    await viewer.setLayerVisible(layer, active.has(layer.id));
    applyEffects(layer); // effects built from the layer's own parts or model need it loaded
  } catch (err) {
    console.error(err);
    active.delete(layer.id);
    sync();
    button.querySelector('.state').textContent = 'Failed to load';
  } finally {
    button.classList.remove('busy');
  }
}

const pickResult = searchSelector({
  async showLayer(id) {
    const layer = layerById(id);
    if (!active.has(id)) await setLayer(layer, true);
    else await viewer.preloadLayer(layer).catch(() => {});
  },
  findMesh: (id, meshName) => (active.has(id) ? viewer.findMesh(id, meshName) : null),
  isGroupVisible: (id, groupId) => viewer.isGroupVisible(layerById(id), groupId),
  showGroup(id, groupId) {
    const box = groupBoxes.get(`${id}/${groupId}`);
    if (box) box.checked = true;
    viewer.setGroupVisible(layerById(id), groupId, true);
  },
  unpeel: (id, mesh) => controls.get(id)?.unpeel(mesh),
  focus(mesh) {
    viewer.focusOn(mesh);
    // Re-picking the selected part does not reselect it, so replace or hide the last note here.
    fadeNotes.focused(viewer.faded.size);
  },
  showNotShown(entry) {
    const layer = layerById(entry.layerId);
    const where = entry.shownIn ? null : entry.system && `Part of the ${entry.system} system, not on the site yet.`;
    showInfoText({
      kicker: `${layer.name} · Not shown`,
      color: layer.color,
      name: entry.name,
      description: [entry.note, where].filter(Boolean).join(' '),
    });
    const why = `Not shown: ${NOT_SHOWN_REASONS[entry.reason] ?? entry.reason}.`;
    const shownIn = entry.shownIn && layerById(entry.shownIn);
    if (shownIn && !active.has(shownIn.id)) {
      infoNote(why, `Shown in ${shownIn.name}: turn it on`, () => setLayer(shownIn, true));
    } else {
      infoNote(shownIn ? `${why} Shown in ${shownIn.name}, which is on.` : why);
    }
  },
  showMissing(entry) {
    const layer = layerById(entry.layerId);
    showInfoText({
      kicker: layer.name,
      color: layer.color,
      name: entry.meshName,
      description: active.has(layer.id)
        ? 'This part could not be found in the loaded model.'
        : `The ${layer.name} model could not be loaded. Please check your connection and try again.`,
    });
  },
});

searchBox($('search'), {
  index: () => buildIndex(layers, meshNames, partInfo),
  layer: layerById,
  reasons: NOT_SHOWN_REASONS,
  approximate: APPROXIMATE_LABEL,
  onPick: (entry) => pickResult(entry).catch((err) => console.error(err)),
});

try {
  await viewer.loadShell(asset(SHELL_ASSET), (p) => {
    $('loading-text').textContent = `Loading body… ${Math.round(p * 100)}%`;
  });
  $('loading').hidden = true;
  for (const layer of layers) applyEffects(layer); // effects are built from the shell, so apply any chosen while it loaded
  // Layers marked `preload` download in the background so their toggle
  // responds instantly; the rest wait until first switched on, so phones
  // never fetch heavy systems nobody looks at.
  for (const layer of layers) if (layer.preload) viewer.preloadLayer(layer).catch(() => {});
} catch (err) {
  console.error(err);
  $('loading').classList.add('error');
  $('loading-text').textContent = 'Could not load the 3D model. Please check your connection and reload.';
}
