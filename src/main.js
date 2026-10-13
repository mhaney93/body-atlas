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
    const part = partInfo(layer, mesh.userData.name ?? mesh.name);
    $('info-kicker').textContent = part.region ? `${layer.name} · ${part.region}` : layer.name;
    $('info-kicker').style.color = part.color ?? layer.color;
    $('info-name').textContent = part.name;
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
/** Effect ids the visitor switched on; shown only while their layer is on. */
const effectsOn = new Set();

function syncEffects() {
  for (const layer of layers) {
    for (const effect of layer.effects ?? []) {
      viewer.setEffectVisible(effect, active.has(layer.id) && effectsOn.has(effect.id));
    }
  }
  for (const row of document.querySelectorAll('.effect-toggle')) row.hidden = !active.has(row.dataset.layer);
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
  button.addEventListener('click', async () => {
    const on = !active.has(layer.id);
    on ? active.add(layer.id) : active.delete(layer.id);
    button.setAttribute('aria-pressed', String(on));
    renderSummary();
    syncEffects();
    button.classList.add('busy');
    button.querySelector('.state').textContent = '';
    try {
      await viewer.setLayerVisible(layer, active.has(layer.id));
    } catch (err) {
      console.error(err);
      active.delete(layer.id);
      button.setAttribute('aria-pressed', 'false');
      renderSummary();
      syncEffects();
      button.querySelector('.state').textContent = 'Failed to load';
    } finally {
      button.classList.remove('busy');
    }
  });
  li.append(button);
  // Decorative extras (e.g. a haze), always labelled as illustrative effects.
  for (const effect of layer.effects ?? []) {
    const row = document.createElement('label');
    row.className = 'effect-toggle';
    row.dataset.layer = layer.id;
    row.hidden = true;
    row.style.setProperty('--layer-color', effect.color ?? layer.color);
    row.innerHTML = '<input type="checkbox" /><span><span class="label"></span><small class="note"></small></span>';
    row.querySelector('.label').textContent = effect.label;
    row.querySelector('.note').textContent = effect.note;
    row.querySelector('input').addEventListener('change', (e) => {
      e.target.checked ? effectsOn.add(effect.id) : effectsOn.delete(effect.id);
      syncEffects();
    });
    li.append(row);
  }
  $('layer-list').append(li);
}

try {
  await viewer.loadShell(asset(SHELL_ASSET), (p) => {
    $('loading-text').textContent = `Loading body… ${Math.round(p * 100)}%`;
  });
  $('loading').hidden = true;
  syncEffects(); // effects are built from the shell, so apply any chosen while it loaded
} catch (err) {
  console.error(err);
  $('loading').classList.add('error');
  $('loading-text').textContent = 'Could not load the 3D model. Please check your connection and reload.';
}
