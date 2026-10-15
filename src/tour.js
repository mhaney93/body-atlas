// A guided tour a layer can offer (`tour` in its data): a glowing pulse that
// travels through the layer's parts in order, stage by stage, with a caption
// naming each stage (e.g. "follow the food" through the digestive tract).
// Tube-shaped parts carry a centreline (glTF node extra, built by
// scripts/build-models.mjs) that the pulse follows; any other part is passed
// through at its centre.
import * as THREE from 'three';

const TRAIL = 28;

function glowTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,240,190,0.85)');
  g.addColorStop(1, 'rgba(255,170,90,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/** Splits a layer's tour into per-stage curves through the parts of `group`. */
function buildStages(tour, group) {
  const byName = new Map();
  group.traverse((o) => {
    if (o.isMesh) byName.set(o.userData.name ?? o.name, o);
  });
  const stages = [];
  let last = null;
  for (const stage of tour.stages) {
    const points = last ? [last.clone()] : [];
    const parts = []; // { name, mesh, from } where `from` indexes `points`
    for (const name of stage.parts) {
      const mesh = byName.get(name);
      if (!mesh) continue;
      let pts;
      if (mesh.userData.centerline?.length > 1) {
        pts = mesh.userData.centerline.map((p) => new THREE.Vector3(...p));
        // Enter at whichever end is nearer to where the pulse is now.
        const here = points.at(-1);
        if (here && here.distanceTo(pts.at(-1)) < here.distanceTo(pts[0])) pts.reverse();
      } else {
        pts = [new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3())];
      }
      parts.push({ name, mesh, from: points.length });
      points.push(...pts);
    }
    if (!parts.length) continue;
    if (points.length === 1) points.push(points[0].clone().add(new THREE.Vector3(0, -0.001, 0)));
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
    // Where along the curve (0..1) each part begins, by polyline length.
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + points[i].distanceTo(points[i - 1]));
    const total = cumulative.at(-1) || 1;
    for (const part of parts) part.start = cumulative[part.from] / total;
    stages.push({ ...stage, curve, parts, meshes: parts.map((p) => p.mesh) });
    last = points.at(-1);
  }
  return stages;
}

export class Tour {
  /**
   * @param {import('./viewer.js').Viewer} viewer
   * @param {object} tour layer.tour from the layer data
   * @param {THREE.Group} group the layer's loaded model
   * @param {{ onStage?: (stage: object, index: number, part: string) => void, onEnd?: () => void }} handlers
   */
  constructor(viewer, tour, group, { onStage, onEnd } = {}) {
    this.viewer = viewer;
    this.stages = buildStages(tour, group);
    this.onStage = onStage ?? (() => {});
    this.onEnd = onEnd ?? (() => {});
    this.running = false;

    const map = glowTexture();
    const common = { map, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending };
    this.head = new THREE.Sprite(new THREE.SpriteMaterial({ ...common, color: '#fff3c4' }));
    this.head.scale.setScalar(0.045);
    this.trailPositions = new Float32Array(TRAIL * 3);
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    this.trail = new THREE.Points(
      trailGeometry,
      new THREE.PointsMaterial({ ...common, color: '#ffb36b', size: 0.018, sizeAttenuation: true, opacity: 0.8 }),
    );
    this.object = new THREE.Group();
    this.object.add(this.trail, this.head);
    this.object.renderOrder = 20;
    this.head.renderOrder = this.trail.renderOrder = 20; // drawn over everything, incl. the glass
    this.object.traverse((o) => (o.raycast = () => {}));
    this.object.visible = false;
    viewer.scene.add(this.object);
  }

  start() {
    this.stop();
    if (!this.stages.length) return;
    this.running = true;
    this.stageIndex = -1;
    this.part = null;
    this.t = 0;
    this.history = [];
    this.object.visible = true;
    this.unsubscribe = this.viewer.onFrame((dt) => this.#tick(dt));
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.unsubscribe?.();
    this.object.visible = false;
    this.viewer.emphasize([]);
  }

  dispose() {
    this.stop();
    this.viewer.scene.remove(this.object);
  }

  #tick(dt) {
    this.t += dt;
    let elapsed = this.t;
    let index = 0;
    while (index < this.stages.length && elapsed > this.stages[index].seconds) {
      elapsed -= this.stages[index].seconds;
      index++;
    }
    if (index >= this.stages.length) {
      this.stop();
      this.onEnd();
      return;
    }
    const stage = this.stages[index];
    const u = Math.min(1, elapsed / stage.seconds);
    const part = stage.parts.findLast((p) => p.start <= u) ?? stage.parts[0];
    if (index !== this.stageIndex || part !== this.part) {
      if (index !== this.stageIndex) this.viewer.emphasize(stage.meshes);
      this.stageIndex = index;
      this.part = part;
      this.onStage(stage, index, part.name);
    }
    const pos = stage.curve.getPointAt(u);
    this.head.position.copy(pos);
    this.head.scale.setScalar(0.04 + 0.008 * Math.sin(this.t * 9));
    this.history.unshift(pos.clone());
    this.history.length = Math.min(this.history.length, TRAIL);
    for (let i = 0; i < TRAIL; i++) (this.history[i] ?? pos).toArray(this.trailPositions, i * 3);
    this.trail.geometry.attributes.position.needsUpdate = true;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** The floating caption that narrates a running tour; created on first use. */
function tourCaption() {
  let caption = document.getElementById('tour-caption');
  if (caption) return caption;
  caption = el('aside', 'panel tour-caption');
  caption.id = 'tour-caption';
  caption.setAttribute('aria-live', 'polite');
  caption.hidden = true;
  const close = el('button', 'close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Stop');
  caption.append(close, el('p', 'kicker'), el('h2', 'tour-stage'), el('p', 'tour-part'), el('p', 'tour-time'), el('p', 'tour-note'));
  document.body.append(caption);
  return caption;
}

/**
 * The play/stop button for a layer's tour, shown under its toggle, and the
 * caption it drives. Returns { element, stop }; call stop() when the layer is
 * hidden.
 */
export function tourControls(viewer, layer) {
  const { label, note, total } = layer.tour;
  const caption = tourCaption();
  const set = (selector, text) => (caption.querySelector(selector).textContent = text);
  const button = el('button', 'tour-button', `▶ ${label}`);
  button.type = 'button';
  button.style.setProperty('--layer-color', layer.color);
  let tour = null;

  const show = (stage, index, part) => {
    caption.style.setProperty('--layer-color', layer.color);
    set('.kicker', `${label} · ${index + 1} of ${tour.stages.length}`);
    set('.tour-stage', stage.name);
    set('.tour-part', stage.parts.length > 1 ? part : '');
    set('.tour-time', `Typical time here: ${stage.time}`);
    set('.tour-note', note);
    caption.hidden = false;
    document.body.classList.add('touring');
  };
  const finish = () => {
    set('.kicker', `${label} · done`);
    set('.tour-stage', total);
    set('.tour-part', '');
    set('.tour-time', '');
    button.textContent = '↻ Replay';
  };
  const stop = () => {
    tour?.stop();
    if (caption.dataset.owner !== layer.id) return;
    caption.hidden = true;
    document.body.classList.remove('touring');
    button.textContent = `▶ ${label}`;
  };

  caption.querySelector('.close').addEventListener('click', () => caption.dataset.owner === layer.id && stop());
  button.addEventListener('click', async () => {
    if (tour?.running) return stop();
    tour ??= new Tour(viewer, layer.tour, await viewer.preloadLayer(layer), { onStage: show, onEnd: finish });
    caption.dataset.owner = layer.id;
    viewer.select(null);
    tour.start();
    button.textContent = '■ Stop';
  });
  return { element: button, stop };
}
