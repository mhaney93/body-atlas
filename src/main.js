import { LAYERS, SHELL_ASSET, partInfo } from './layers.js';
import { Viewer } from './viewer.js';

const $ = (id) => document.getElementById(id);
// Asset paths in layer data are relative to the site root.
const asset = (path) => import.meta.env.BASE_URL + path;
const layers = LAYERS.map((layer) => ({
  ...layer,
  asset: asset(layer.asset),
  extraAssets: layer.extraAssets?.map(asset),
}));

const info = $('info');
const viewer = new Viewer($('stage'), {
  partColor: (layer, meshName) => partInfo(layer, meshName).color,
  onSelect(selection) {
    if (!selection) {
      info.hidden = true;
      return;
    }
    const { layer, mesh } = selection;
    // three.js sanitises node names (spaces → underscores); the original lives in extras.
    const part = partInfo(layer, mesh.userData.name ?? mesh.name, mesh.userData.group);
    $('info-kicker').textContent = part.region ? `${layer.name} · ${part.region}` : layer.name;
    $('info-kicker').style.color = part.color ?? layer.color;
    $('info-name').textContent = part.name;
    $('info-flow').hidden = !part.flow;
    $('info-flow').querySelector('.label').textContent = layer.flowLabel ? `${layer.flowLabel}: ` : '';
    $('info-flow').querySelector('.value').textContent = part.flow ?? '';
    $('info-flow').style.setProperty('--group-color', part.group?.color ?? layer.color);
    $('info-description').textContent = part.description ?? '';
    info.hidden = false;
  },
});

if (import.meta.env.DEV) window.viewer = viewer; // handy for debugging in the console

// The hint and, on phones, the bottom panels sit just above the credit line, whatever its height.
const credit = document.querySelector('.credit');
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--credit-height', `${credit.offsetHeight}px`);
}).observe(credit);

$('info-close').addEventListener('click', () => viewer.select(null));
$('reset-view').addEventListener('click', () => viewer.resetView());

const active = new Set();
/** Effect ids the user has switched on; an effect shows only while its layer is on too. */
const effectsOn = new Set();

function applyEffects(layer) {
  for (const effect of layer.effects ?? []) {
    const on = active.has(layer.id) && effectsOn.has(effect.id);
    if (effect.type === 'haze') viewer.setHaze(effect.id, on ? effect.color : null);
    else viewer.setEffectVisible(effect, on);
  }
}

/** Colour key and optional effect toggles shown under a layer's button while it is on. */
function layerExtras(layer) {
  const extras = document.createElement('div');
  extras.className = 'layer-extras';
  extras.hidden = true;
  const groups = Object.values(layer.groups ?? {}).filter((g) => g.legend !== false);
  if (groups.length) {
    const legend = document.createElement('ul');
    legend.className = 'legend';
    legend.setAttribute('aria-label', `${layer.name} colour key`);
    for (const g of groups) {
      const item = document.createElement('li');
      item.style.setProperty('--group-color', g.color);
      item.textContent = g.label;
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
  return extras;
}

function renderSummary() {
  const summary = $('layer-summary');
  const shown = layers.filter((l) => active.has(l.id));
  summary.hidden = shown.length === 0;
  summary.textContent = shown.map((l) => l.summary).join(' ');
  $('hint').textContent = shown.length
    ? 'Tap or click a part to learn about it · drag to rotate · pinch or scroll to zoom'
    : 'Drag to rotate · scroll or pinch to zoom · right-drag or two fingers to pan';
}

for (const layer of layers) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'layer-toggle';
  button.setAttribute('aria-pressed', 'false');
  button.style.setProperty('--layer-color', layer.color);
  button.innerHTML = '<span class="swatch" aria-hidden="true"></span><span class="label"></span><span class="state"></span>';
  button.querySelector('.label').textContent = layer.name;
  const extras = layerExtras(layer);
  const sync = () => {
    const on = active.has(layer.id);
    button.setAttribute('aria-pressed', String(on));
    extras.hidden = !on || !extras.childElementCount;
    applyEffects(layer);
    renderSummary();
  };
  button.addEventListener('click', async () => {
    active.has(layer.id) ? active.delete(layer.id) : active.add(layer.id);
    sync();
    button.classList.add('busy');
    button.querySelector('.state').textContent = '';
    try {
      await viewer.setLayerVisible(layer, active.has(layer.id));
    } catch (err) {
      console.error(err);
      active.delete(layer.id);
      sync();
      button.querySelector('.state').textContent = 'Failed to load';
    } finally {
      button.classList.remove('busy');
    }
  });
  li.append(button, extras);
  $('layer-list').append(li);
}

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
