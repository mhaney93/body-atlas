import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const BODY_HEIGHT = 1.72; // metres, roughly; the models stand on y = 0
const CLICK_SLOP_PX = 6;

/** Fresnel "glass" shading: nearly clear face-on, glowing at grazing angles. */
function glassMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color('#9fd8ff') } },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float f = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.2);
        gl_FragColor = vec4(uColor * (0.035 + 0.75 * f), 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

function layerMaterials(hex) {
  const color = new THREE.Color(hex);
  const make = (emissive, intensity) =>
    new THREE.MeshStandardMaterial({
      color,
      emissive,
      emissiveIntensity: intensity,
      roughness: 0.55,
      metalness: 0.0,
    });
  return {
    base: make(color, 0.45),
    hover: make(new THREE.Color('#ffffff').lerp(color, 0.4), 0.7),
    selected: make(new THREE.Color('#ffffff'), 0.9),
  };
}

export class Viewer {
  /**
   * @param {HTMLElement} container
   * @param {{ onSelect?: (sel: {layer: object, mesh: THREE.Mesh} | null) => void }} [options]
   */
  constructor(container, { onSelect } = {}) {
    this.container = container;
    this.onSelect = onSelect ?? (() => {});
    this.loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    /** @type {Map<string, {layer: object, group: THREE.Group | null, promise: Promise<THREE.Group>, materials: object}>} */
    this.layers = new Map();
    /** @type {Map<string, boolean>} latest requested visibility per layer id */
    this.wanted = new Map();
    this.hovered = null;
    this.selected = null;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor('#0b0f14');
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 50);
    camera.position.set(0.8, 1.1, 3.6);
    this.camera = camera;

    scene.add(new THREE.HemisphereLight('#cfe6ff', '#1a1410', 1.4));
    const key = new THREE.DirectionalLight('#ffffff', 1.6);
    key.position.set(2, 3, 3);
    const rim = new THREE.DirectionalLight('#8ab8ff', 1.2);
    rim.position.set(-2, 1.5, -3);
    scene.add(key, rim);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, BODY_HEIGHT * 0.53, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.25;
    controls.maxDistance = 6;
    controls.zoomToCursor = true;
    controls.addEventListener('change', () => this.#clampTarget());
    this.controls = controls;
    this.home = { position: camera.position.clone(), target: controls.target.clone() };

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.#bindPointer(renderer.domElement);

    new ResizeObserver(() => this.#resize()).observe(container);
    this.#resize();
    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });
  }

  /** Loads the glass skin. `onProgress` receives 0..1 while downloading. */
  async loadShell(url, onProgress) {
    const gltf = await this.loader.loadAsync(url, (e) => {
      if (e.lengthComputable && e.total) onProgress?.(e.loaded / e.total);
    });
    const material = glassMaterial();
    gltf.scene.traverse((o) => {
      if (o.isMesh) {
        o.material = material;
        o.renderOrder = 10; // after opaque layers so they show through
        o.raycast = () => {}; // the shell never blocks picking
      }
    });
    this.scene.add(gltf.scene);
  }

  /** Starts downloading a layer's asset (hidden) and returns a promise for it. */
  preloadLayer(layer) {
    let entry = this.layers.get(layer.id);
    if (entry) return entry.promise;
    const materials = layerMaterials(layer.color);
    entry = { layer, group: null, materials, promise: null };
    // A layer may ship extra files (e.g. parts under a different license).
    const urls = [layer.asset, ...(layer.extraAssets ?? [])];
    entry.promise = Promise.all(urls.map((url) => this.loader.loadAsync(url))).then((gltfs) => {
      const group = new THREE.Group();
      group.add(...gltfs.map((gltf) => gltf.scene));
      group.visible = false;
      group.traverse((o) => {
        if (o.isMesh) {
          o.material = materials.base;
          o.userData.layerId = layer.id;
        }
      });
      this.scene.add(group);
      entry.group = group;
      return group;
    });
    entry.promise.catch(() => this.layers.delete(layer.id));
    this.layers.set(layer.id, entry);
    return entry.promise;
  }

  async setLayerVisible(layer, visible) {
    this.wanted.set(layer.id, visible);
    const group = visible ? await this.preloadLayer(layer) : this.layers.get(layer.id)?.group;
    if (!group) return;
    // The layer may have been toggled again while it was downloading.
    group.visible = this.wanted.get(layer.id);
    if (!group.visible) {
      if (this.hovered?.userData.layerId === layer.id) this.#setHovered(null);
      if (this.selected?.userData.layerId === layer.id) this.select(null);
    }
  }

  /** Selects a mesh (or clears the selection with null). */
  select(mesh) {
    if (mesh === this.selected) return;
    const prev = this.selected;
    this.selected = mesh;
    if (prev) this.#restyle(prev);
    if (mesh) this.#restyle(mesh);
    const entry = mesh && this.layers.get(mesh.userData.layerId);
    this.onSelect(mesh ? { layer: entry.layer, mesh } : null);
  }

  resetView() {
    this.camera.position.copy(this.home.position);
    this.controls.target.copy(this.home.target);
    this.controls.update();
  }

  #restyle(mesh) {
    const { materials } = this.layers.get(mesh.userData.layerId);
    mesh.material =
      mesh === this.selected ? materials.selected : mesh === this.hovered ? materials.hover : materials.base;
  }

  #setHovered(mesh) {
    if (mesh === this.hovered) return;
    const prev = this.hovered;
    this.hovered = mesh;
    if (prev) this.#restyle(prev);
    if (mesh) this.#restyle(mesh);
    this.renderer.domElement.style.cursor = mesh ? 'pointer' : '';
  }

  #pick(clientX, clientY) {
    const targets = [];
    for (const { group } of this.layers.values()) if (group?.visible) targets.push(group);
    if (!targets.length) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(targets, true).find((h) => h.object.isMesh);
    return hit?.object ?? null;
  }

  #bindPointer(el) {
    let down = null;
    let pending = null;
    const active = new Set();
    el.addEventListener('pointerdown', (e) => {
      active.add(e.pointerId);
      down = active.size === 1 ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null;
    });
    el.addEventListener('pointerup', (e) => {
      active.delete(e.pointerId);
      if (!down || down.id !== e.pointerId) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved <= CLICK_SLOP_PX) this.select(this.#pick(e.clientX, e.clientY));
    });
    el.addEventListener('pointercancel', (e) => {
      active.delete(e.pointerId);
      down = null;
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || down) return;
      pending = e;
      requestAnimationFrame(() => {
        if (!pending) return;
        this.#setHovered(this.#pick(pending.clientX, pending.clientY));
        pending = null;
      });
    });
    el.addEventListener('pointerleave', () => this.#setHovered(null));
  }

  #clampTarget() {
    const t = this.controls.target;
    const before = t.clone();
    t.x = THREE.MathUtils.clamp(t.x, -0.6, 0.6);
    t.y = THREE.MathUtils.clamp(t.y, 0, BODY_HEIGHT + 0.1);
    t.z = THREE.MathUtils.clamp(t.z, -0.4, 0.4);
    // Move the camera with the clamped target so panning stops at the edge.
    this.camera.position.add(t.clone().sub(before));
  }

  #resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the whole body in frame on narrow (portrait) screens, nudged up
    // so the bottom sheet doesn't cover the feet.
    const portrait = w / h < 0.8;
    this.camera.fov = portrait ? 46 : 35;
    if (portrait) this.camera.setViewOffset(w, h, 0, h * 0.07, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }
}
