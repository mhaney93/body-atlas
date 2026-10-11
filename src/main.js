import { LAYERS, SHELL_ASSET, partInfo } from './layers.js';
import { Viewer } from './viewer.js';

const $ = (id) => document.getElementById(id);
// Asset paths in layer data are relative to the site root.
const asset = (path) => import.meta.env.BASE_URL + path;
const layers = LAYERS.map((layer) => ({ ...layer, asset: asset(layer.asset) }));

const info = $('info');
const viewer = new Viewer($('stage'), {
  onSelect(selection) {
    if (!selection) {
      info.hidden = true;
      return;
    }
    const { layer, mesh } = selection;
    // three.js sanitises node names (spaces → underscores); the original lives in extras.
    const part = partInfo(layer, mesh.userData.name ?? mesh.name);
    $('info-kicker').textContent = part.region ? `${layer.name} · ${part.region}` : layer.name;
    $('info-kicker').style.color = layer.color;
    $('info-name').textContent = part.name;
    $('info-description').textContent = part.description ?? '';
    info.hidden = false;
  },
});

$('info-close').addEventListener('click', () => viewer.select(null));
$('reset-view').addEventListener('click', () => viewer.resetView());

const active = new Set();

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
    button.classList.add('busy');
    button.querySelector('.state').textContent = '';
    try {
      await viewer.setLayerVisible(layer, active.has(layer.id));
    } catch (err) {
      console.error(err);
      active.delete(layer.id);
      button.setAttribute('aria-pressed', 'false');
      renderSummary();
      button.querySelector('.state').textContent = 'Failed to load';
    } finally {
      button.classList.remove('busy');
    }
  });
  li.append(button);
  $('layer-list').append(li);
}

try {
  await viewer.loadShell(asset(SHELL_ASSET), (p) => {
    $('loading-text').textContent = `Loading body… ${Math.round(p * 100)}%`;
  });
  $('loading').hidden = true;
  // Fetch the system layers in the background so toggles respond instantly.
  for (const layer of layers) viewer.preloadLayer(layer).catch(() => {});
} catch (err) {
  console.error(err);
  $('loading').classList.add('error');
  $('loading-text').textContent = 'Could not load the 3D model. Please check your connection and reload.';
}
