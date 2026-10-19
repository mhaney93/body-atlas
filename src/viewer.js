import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { EFFECTS } from './effects.js';
import { KeyboardNav } from './keyboard-nav.js';
import { partGroupId, partInfo, sharedEntry } from './layers.js';
import { Poser } from './pose-view.js';
import { sideOf } from './search.js';
import { frameView } from './search-select.js';

const BODY_HEIGHT = 1.72; // metres, roughly; the models stand on y = 0
const CLICK_SLOP_PX = 6;
// Close-up cutaway: once zoomed in closer than CUT_START, layer geometry in a
// bubble around the camera is hidden (and unclickable), so zooming further
// pushes through outer bone to buried parts such as the ear ossicles.
const CUT_START = 0.25; // orbit distance (m) where the bubble starts to grow
const CUT_FULL = 0.15; // orbit distance (m) where it reaches CUT_RADIUS
const CUT_RADIUS = 0.03; // metres
const UNCUT_SIZE = 0.015; // parts smaller than this (bounding-box diagonal, m) are never cut
const cutUniform = { value: 0 };
// Keyboard movement speed is this many orbit distances per second (within
// these limits), so it is brisk from afar and fine-grained close up.
const KEY_SPEED = 0.5;
const KEY_SPEED_MIN = 0.05; // m/s
const KEY_SPEED_MAX = 2; // m/s
const FOCUS_MIN_DISTANCE = 0.1; // m; nearest focusOn() puts the camera to a part's centre
const FLIGHT_SECONDS = 0.8; // camera move onto a part picked in the search

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

/**
 * Decorative "haze": a soft, mottled glow laid over a surface, pulsing gently
 * like a heartbeat. It is an illustrative effect, not modeled anatomy, and the
 * UI must label it as such. `time` is a shared { value: seconds } uniform.
 */
function hazeMaterial(hex, time) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(hex) }, uTime: time },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vPos;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        vPos = position;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vPos;
      float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float noise(vec3 x) {
        vec3 i = floor(x);
        vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
          mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
          f.z);
      }
      void main() {
        // Fine branching mottling: sharpened noise ridges at two scales.
        float coarse = noise(vPos * 45.0);
        float fine = 1.0 - abs(2.0 * noise(vPos * 160.0) - 1.0);
        float mottle = 0.35 + 0.65 * coarse * pow(fine, 3.0);
        float facing = abs(dot(normalize(vNormal), normalize(vView)));
        float beat = 0.8 + 0.2 * pow(0.5 + 0.5 * sin(uTime * 6.2832 * 1.1), 6.0);
        gl_FragColor = vec4(uColor * mottle * (0.12 + 0.38 * facing) * beat, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    blending: THREE.AdditiveBlending,
  });
}

/** Makes a material discard fragments closer to the camera than the cutaway radius. */
function withCutaway(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCut = cutUniform;
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      'uniform float uCut;\nvoid main() {\n  if (length(vViewPosition) < uCut) discard;',
    );
  };
  return material;
}

/** Emissive intensity of an emphasised part's "prime" material, which pulses (see setEmphasis). */
const PRIME_GLOW = 0.85;

/**
 * Materials for one highlight colour: `base`, `hover` and `selected`, plus
 * the emphasis roles (see setEmphasis): `prime` (brightest), `synergist`
 * (lit, dimmer) and `dim` (a faint ghost for parts outside the emphasis).
 * `opacity` < 1 makes them see-through; `onTop` draws a part shared from
 * another layer (see `shared` in the layer data) over that layer's own copy
 * of the same mesh.
 */
function layerMaterials(hex, opacity = 1, cutaway = false, onTop = false) {
  const color = new THREE.Color(hex);
  const make = (emissive, intensity, alpha = opacity, tint = color) => {
    const material = new THREE.MeshStandardMaterial({
      color: tint,
      emissive,
      emissiveIntensity: intensity,
      roughness: 0.55,
      metalness: 0.0,
      ...(alpha < 1 && { transparent: true, opacity: alpha, depthWrite: false }),
      ...(onTop && { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }),
    });
    return cutaway ? withCutaway(material) : material;
  };
  return {
    base: make(color, 0.45),
    hover: make(new THREE.Color('#ffffff').lerp(color, 0.4), 0.7),
    selected: make(new THREE.Color('#ffffff'), 0.9),
    prime: make(new THREE.Color('#ffffff').lerp(color, 0.55), PRIME_GLOW),
    synergist: make(color, 0.3, opacity, color.clone().multiplyScalar(0.7)),
    dim: make(color, 0.1, Math.min(opacity, 0.08)),
  };
}

export class Viewer {
  /**
   * @param {HTMLElement} container
   * @param {{
   *   onSelect?: (sel: {layer: object, mesh: THREE.Mesh} | null) => void,
   *   partColor?: (layer: object, meshName: string) => string | undefined,
   *   onFadedChange?: (count: number) => void,
   *   poseBones?: object,
   * }} [options] `partColor` can give a part its own highlight color instead of the layer's;
   *   `onFadedChange` hears how many parts are faded (see focusOn) whenever that set changes;
   *   `poseBones` is the layer whose bones the stretching poses are built on (`posable: "bones"`).
   */
  constructor(container, { onSelect, partColor, onFadedChange, poseBones } = {}) {
    this.container = container;
    this.onSelect = onSelect ?? (() => {});
    this.onFadedChange = onFadedChange ?? (() => {});
    this.partColor = partColor ?? (() => undefined);
    this.loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    /** @type {Map<string, {layer: object, group: THREE.Group | null, promise: Promise<THREE.Group>}>} */
    this.layers = new Map();
    /** @type {Map<string, boolean>} latest requested visibility per layer id */
    this.wanted = new Map();
    /** @type {Map<string, boolean>} visibility per "<layer id>/<group id>" set by setGroupVisible */
    this.groupShown = new Map();
    /** @type {Map<string, {object: THREE.Object3D, update: Function}>} decorative effects by id */
    this.effects = new Map();
    this.shell = null;
    this.hovered = null;
    this.selected = null;
    /** @type {THREE.Mesh[]} */
    this.shellMeshes = [];
    /** @type {Map<string, {material: THREE.ShaderMaterial, overlays: THREE.Mesh[]}>} haze effects by id */
    this.hazes = new Map();
    /**
     * Per-layer part filters (see setPeeled and setEmphasis), applied when the
     * layer loads and whenever they change.
     * @type {Map<string, {hide?: (mesh: THREE.Mesh) => boolean, role?: (mesh: THREE.Mesh) => string | null}>}
     */
    this.display = new Map();
    /** @type {Set<THREE.MeshStandardMaterial>} every `prime` material, pulsed while an emphasis is shown */
    this.primeMaterials = new Set();
    this.time = { value: 0 };
    /** Meshes drawn in their hover style while nothing else styles them (e.g. a tour's current stage). */
    this.emphasized = new Set();
    /** Called every frame with (seconds since the last frame); see onFrame(). */
    this.frameCallbacks = new Set();
    /** Parts faded out because they stand in front of the part focusOn() framed. */
    this.faded = new Set();
    /** The part focusOn() last framed, while it stays selected. */
    this.focused = null;
    /** Stops the camera flight focusOn() started, if one is running. */
    this.flight = null;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor('#0b0f14');
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;
    this.poseBones = poseBones;
    // Stretching poses (src/pose-view.js): the posable layers' parts follow one skeleton.
    this.poser = new Poser(scene, {
      // A part shared from another layer (the Sense organs' eye muscles) is where that layer says.
      region: (layer, mesh) =>
        partInfo(layer, mesh.userData.name ?? mesh.name, mesh.userData.group, this.layers.get(mesh.userData.sourceId)?.layer, mesh.userData.of).region,
      side: (mesh) => sideOf(mesh.userData.name ?? mesh.name),
    });

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
    controls.minDistance = 0.01;
    controls.maxDistance = 6;
    controls.zoomToCursor = true;
    controls.addEventListener('change', () => this.#clampTarget());
    this.controls = controls;
    this.home = { position: camera.position.clone(), target: controls.target.clone() };

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.#bindPointer(renderer.domElement);
    this.keys = new KeyboardNav(window);

    new ResizeObserver(() => this.#resize()).observe(container);
    this.#resize();
    const timer = new THREE.Timer();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = reducedMotion;
    renderer.setAnimationLoop(() => {
      timer.update();
      this.time.value = timer.getElapsed();
      const dt = Math.min(timer.getDelta(), 0.1);
      for (const fn of this.frameCallbacks) fn(dt);
      this.poser.update(dt);
      if (this.keys.moving) {
        this.flight?.();
        this.#moveByKeys(dt);
      }
      controls.update();
      const distance = camera.position.distanceTo(controls.target);
      cutUniform.value = CUT_RADIUS * THREE.MathUtils.smoothstep(CUT_START - distance, 0, CUT_START - CUT_FULL);
      for (const fx of this.effects.values()) if (fx.object.visible) fx.update(this.time.value, camera, renderer);
      if (!reducedMotion.matches) {
        const glow = PRIME_GLOW + 0.25 * Math.sin(this.time.value * 3);
        for (const m of this.primeMaterials) m.emissiveIntensity = glow;
      }
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
        this.shellMeshes.push(o);
      }
    });
    this.scene.add(gltf.scene);
    this.shell = gltf.scene;
    this.#applyHazes();
  }

  /**
   * Starts downloading a layer's asset (hidden) and returns a promise for it.
   * A layer with `shared` entries also loads those layers and shows their
   * matching meshes as its own too, reusing their geometry.
   */
  preloadLayer(layer) {
    let entry = this.layers.get(layer.id);
    if (entry) return entry.promise;
    // Materials are shared per colour: a part's own colour, else its sub-group's
    // (e.g. arteries and veins, tagged via the `group` node extra), else the layer's.
    const byColor = new Map();
    const materialsFor = (color, opacity, cutaway, onTop) => {
      const key = `${color}/${opacity ?? 1}/${cutaway}/${onTop}`;
      if (!byColor.has(key)) {
        byColor.set(key, layerMaterials(color, opacity, cutaway, onTop));
        this.primeMaterials.add(byColor.get(key).prime);
      }
      return byColor.get(key);
    };
    entry = { layer, group: null, promise: null };
    // A layer may ship extra files (e.g. parts under a different license).
    const urls = [layer.asset, ...(layer.extraAssets ?? [])];
    const sources = (layer.shared ?? []).map((s) => s.source).filter(Boolean);
    entry.promise = Promise.all([
      Promise.all(urls.map((url) => this.loader.loadAsync(url))),
      ...sources.map((source) => this.preloadLayer(source)),
      // A soft posable layer needs the bones its parts follow.
      layer.posable === 'soft' && this.poseBones ? this.preloadLayer(this.poseBones) : null,
    ]).then(([gltfs, ...sourceGroups]) => {
      const group = new THREE.Group();
      group.add(...gltfs.map((gltf) => gltf.scene));
      sources.forEach((source, i) => group.add(...this.#sharedCopies(layer, source.id, sourceGroups[i])));
      if (layer.posable === 'bones') this.poser.setBones(group);
      // Shared parts pose with the layer that shows them (the Joints layer's copies of the discs).
      if (layer.posable && this.poser.skeleton) this.poser.adopt(layer, group);
      group.visible = false;
      group.updateMatrixWorld(true);
      const box = new THREE.Box3();
      group.traverse((o) => {
        if (o.isMesh) {
          // Small parts stay whole in the cutaway so they don't vanish as you close in on them.
          o.userData.uncut = box.setFromObject(o).getSize(new THREE.Vector3()).length() < UNCUT_SIZE;
          const name = o.userData.name ?? o.name;
          o.userData.group ??= partGroupId(layer, name);
          const g = layer.groups?.[o.userData.group];
          const color = this.partColor(layer, name) ?? g?.color ?? layer.color;
          o.userData.materials = materialsFor(color, g?.opacity, !o.userData.uncut, o.userData.sourceId !== undefined);
          o.material = o.userData.materials.base;
          o.userData.layerId = layer.id;
        }
      });
      this.scene.add(group);
      entry.group = group;
      if (layer.hazeSurface) this.#applyHazes();
      this.#applyDisplay(layer.id);
      return group;
    });
    entry.promise.catch(() => this.layers.delete(layer.id));
    this.layers.set(layer.id, entry);
    return entry.promise;
  }

  /** Meshes of `sourceGroup` (layer `sourceId`) that `layer` shares, as new meshes on the same geometry. */
  #sharedCopies(layer, sourceId, sourceGroup) {
    const copies = [];
    sourceGroup.updateMatrixWorld(true);
    sourceGroup.traverse((o) => {
      const entry = o.isMesh && sharedEntry(layer, sourceId, o.userData.name ?? o.name);
      if (!entry) return;
      const copy = new THREE.Mesh(o.geometry);
      copy.name = o.name;
      copy.userData = { name: o.userData.name, sourceId, group: entry.group };
      o.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
      copies.push(copy);
    });
    return copies;
  }

  /** Shows or hides one of a layer's sub-groups (see `groups` in the layer data). */
  setGroupVisible(layer, groupId, visible) {
    this.groupShown.set(`${layer.id}/${groupId}`, visible);
    this.#applyDisplay(layer.id);
  }

  async setLayerVisible(layer, visible) {
    this.wanted.set(layer.id, visible);
    const group = visible ? await this.preloadLayer(layer) : this.layers.get(layer.id)?.group;
    if (!group) return;
    // The layer may have been toggled again while it was downloading.
    group.visible = this.#layerShown(layer);
    if (!group.visible) {
      if ([...this.faded].some((m) => m.userData.layerId === layer.id)) {
        this.#setFaded([...this.faded].filter((m) => m.userData.layerId !== layer.id));
      }
      if (this.hovered?.userData.layerId === layer.id) this.#setHovered(null);
      if (this.selected?.userData.layerId === layer.id) this.select(null);
    }
  }

  /**
   * Shows or hides a decorative effect, e.g. { id, type: 'skin-haze', color, ... }
   * (see effects.js). It is built the first time it is shown: from the shell,
   * for an effect with `parts`, from those meshes of `layer`, or if the effect
   * sets `surface: "layer"`, from `layer`'s whole model (call again once the
   * layer has loaded).
   */
  setEffectVisible(effect, visible, layer) {
    let fx = this.effects.get(effect.id);
    if (!fx) {
      const source = effect.parts
        ? this.#partMeshes(layer, effect.parts)
        : effect.surface === 'layer'
          ? this.layers.get(layer?.id)?.group
          : this.shell;
      if (!visible || !source) return;
      fx = EFFECTS[effect.type](source, effect, { cut: cutUniform });
      // An effect laid over a layer's parts would stay behind while they move in a pose.
      fx.onLayer = source !== this.shell;
      this.scene.add(fx.object);
      this.effects.set(effect.id, fx);
    }
    fx.wanted = visible;
    fx.object.visible = visible && !(fx.onLayer && this.poser.active);
  }

  /**
   * Plays a stretch pose: `ops` from variantOps (src/pose.js), looping into
   * the stretch and back (held still for reduced motion). Only the posable
   * layers move, so the others, and effects laid over layers, hide until
   * stopPose(); the glass skin stays put as a ghost of the starting position.
   * `cues` (src/cues.js) are arrows for the moves the bones can't show.
   */
  showPose(ops, cues = []) {
    this.poser.start(ops, { still: this.reducedMotion.matches, cues });
    this.#applyPoseHiding();
  }

  /** Ends a pose (showPose): everything returns to rest and reappears. */
  stopPose() {
    this.poser.stop();
    this.#applyPoseHiding();
  }

  /** Whether a layer is drawn: toggled on, and posable or no pose playing. */
  #layerShown(layer) {
    return !!this.wanted.get(layer.id) && (!this.poser.active || !!layer.posable);
  }

  #applyPoseHiding() {
    for (const { layer, group } of this.layers.values()) {
      if (!group) continue;
      group.visible = this.#layerShown(layer);
      if (!group.visible && this.hovered?.userData.layerId === layer.id) this.#setHovered(null);
    }
    for (const fx of this.effects.values()) fx.object.visible = !!fx.wanted && !(fx.onLayer && this.poser.active);
  }

  /** The meshes of a loaded layer with these names, or null if the layer hasn't loaded. */
  #partMeshes(layer, names) {
    const group = layer && this.layers.get(layer.id)?.group;
    if (!group) return null;
    const meshes = [];
    group.traverse((o) => o.isMesh && names.includes(o.userData.name ?? o.name) && meshes.push(o));
    return meshes;
  }

  /** Runs `fn(dt)` every frame until the returned function is called. */
  onFrame(fn) {
    this.frameCallbacks.add(fn);
    return () => this.frameCallbacks.delete(fn);
  }

  /** Highlights these meshes in their hover style, replacing any previous emphasis. */
  emphasize(meshes = []) {
    const prev = this.emphasized;
    this.emphasized = new Set(meshes);
    for (const mesh of new Set([...prev, ...meshes])) this.#restyle(mesh);
  }

  /**
   * Peels parts of a layer away: hides every mesh for which `hide(mesh)` is
   * true (null shows them all). Emphasised parts (see setEmphasis) stay.
   */
  setPeeled(layerId, hide) {
    this.display.set(layerId, { ...this.display.get(layerId), hide });
    this.#applyDisplay(layerId);
  }

  /**
   * Picks out some parts of a layer: `role(mesh)` returns 'prime' (lit
   * brightest, gently pulsing), 'synergist' (lit, dimmer) or null (faded to
   * a ghost). Null instead of a function clears the emphasis.
   */
  setEmphasis(layerId, role) {
    this.display.set(layerId, { ...this.display.get(layerId), role });
    this.#applyDisplay(layerId);
  }

  /** Applies a layer's sub-group visibility (setGroupVisible), peeling and emphasis to its meshes. */
  #applyDisplay(layerId) {
    const { layer, group } = this.layers.get(layerId) ?? {};
    if (!group) return;
    const { hide, role } = this.display.get(layerId) ?? {};
    group.traverse((o) => {
      if (!o.isMesh || o.userData.haze) return;
      o.userData.role = role ? (role(o) ?? 'dim') : null;
      const groupOn = this.isGroupVisible(layer, o.userData.group);
      o.visible = groupOn && (!hide?.(o) || o.userData.role === 'prime' || o.userData.role === 'synergist');
      if (!o.visible) {
        if (o === this.hovered) this.#setHovered(null);
        if (o === this.selected) this.select(null);
      }
      this.#restyle(o);
    });
  }

  /** Whether a layer's sub-group is shown (setGroupVisible, else the group's `visible`, else true). */
  isGroupVisible(layer, groupId) {
    return this.groupShown.get(`${layer.id}/${groupId}`) ?? layer.groups?.[groupId]?.visible ?? true;
  }

  /** The loaded mesh of a layer with this (original) name, its own before one shared from another layer. */
  findMesh(layerId, meshName) {
    let found = null;
    this.layers.get(layerId)?.group?.traverse((o) => {
      if (!o.isMesh || o.userData.haze || (o.userData.name ?? o.name) !== meshName) return;
      if (!found || (found.userData.sourceId && !o.userData.sourceId)) found = o;
    });
    return found;
  }

  /**
   * Every clickable part of a loaded layer (its own meshes and the ones it
   * shares from another layer) as { meshName, center }, `center` being the
   * middle of its bounding box in world space; [] before the layer loads.
   */
  partCenters(layerId) {
    const parts = [];
    const box = new THREE.Box3();
    this.layers.get(layerId)?.group?.traverse((o) => {
      if (!o.isMesh || o.userData.haze) return;
      const { x, y, z } = box.setFromObject(o).getCenter(new THREE.Vector3());
      parts.push({ meshName: o.userData.name ?? o.name, center: { x, y, z } });
    });
    return parts;
  }

  /**
   * Selects a part and flies the camera to frame it (see frameView), fading
   * every visible part in front of it from there, so a buried part shows.
   * The fade lasts until the selection changes or clearFaded() is called.
   */
  focusOn(mesh) {
    this.focused = null;
    this.select(mesh);
    this.focused = mesh;
    const sphere = new THREE.Box3().setFromObject(mesh).getBoundingSphere(new THREE.Sphere());
    const view = frameView({
      center: sphere.center,
      radius: sphere.radius,
      camera: this.camera.position,
      fov: this.camera.fov,
      aspect: this.camera.aspect,
      // Close enough for a small part to fill some of the view; what is in front is faded anyway.
      minDistance: FOCUS_MIN_DISTANCE,
      // On portrait screens the info sheet covers the bottom of the view.
      raise: this.camera.aspect < 0.8 ? 0.2 : 0,
      maxDistance: this.controls.maxDistance,
    });
    const position = new THREE.Vector3().copy(view.position);
    this.#setFaded(this.#occluders(mesh, position));
    this.#fly(position, new THREE.Vector3().copy(view.target));
  }

  /**
   * Flies the camera to frame a world-space box (see frameView), as focusOn
   * frames a part, without selecting or fading anything.
   */
  frameBox(box) {
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const view = frameView({
      center: sphere.center,
      radius: sphere.radius,
      camera: this.camera.position,
      fov: this.camera.fov,
      aspect: this.camera.aspect,
      minDistance: FOCUS_MIN_DISTANCE,
      raise: this.camera.aspect < 0.8 ? 0.2 : 0,
      maxDistance: this.controls.maxDistance,
    });
    this.#fly(new THREE.Vector3().copy(view.position), new THREE.Vector3().copy(view.target));
  }

  /** Shows the parts focusOn() faded again. */
  clearFaded() {
    this.#setFaded([]);
  }

  #setFaded(meshes) {
    const prev = this.faded;
    this.faded = new Set(meshes);
    for (const mesh of new Set([...prev, ...this.faded])) this.#restyle(mesh);
    this.onFadedChange(this.faded.size);
  }

  /** Visible layer meshes between `from` and points across `mesh`'s bounding box. */
  #occluders(mesh, from) {
    const targets = [];
    for (const { group } of this.layers.values()) if (group?.visible) targets.push(group);
    const box = new THREE.Box3().setFromObject(mesh);
    const center = box.getCenter(new THREE.Vector3());
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.3);
    const points = [center];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) points.push(center.clone().add(half.clone().multiply(new THREE.Vector3(x, y, z))));
    const found = new Set();
    for (const point of points) {
      const dir = point.clone().sub(from);
      const length = dir.length();
      this.raycaster.set(from, dir.normalize());
      const hits = this.raycaster.intersectObjects(targets, true).filter((h) => h.object.isMesh && h.object.visible);
      // In front of the part where the ray meets it, else in front of the sample point.
      const limit = hits.find((h) => h.object === mesh)?.distance ?? length;
      for (const h of hits) if (h.distance < limit - 1e-4 && h.object !== mesh) found.add(h.object);
    }
    return found;
  }

  /** Moves the camera and orbit target to these over FLIGHT_SECONDS (at once if the viewer prefers reduced motion). */
  #fly(position, target) {
    this.flight?.();
    const { camera, controls } = this;
    if (this.reducedMotion.matches) {
      camera.position.copy(position);
      controls.target.copy(target);
      controls.update();
      return;
    }
    const from = { position: camera.position.clone(), target: controls.target.clone() };
    let t = 0;
    const stop = this.onFrame((dt) => {
      t = Math.min(1, t + dt / FLIGHT_SECONDS);
      const k = t * t * (3 - 2 * t);
      camera.position.lerpVectors(from.position, position, k);
      controls.target.lerpVectors(from.target, target, k);
      if (t === 1) this.flight();
    });
    this.flight = () => {
      stop();
      this.flight = null;
    };
  }

  /** Selects a mesh (or clears the selection with null). */
  select(mesh) {
    if (mesh === this.selected) return;
    if (mesh !== this.focused) {
      this.focused = null;
      this.#setFaded([]);
    }
    const prev = this.selected;
    this.selected = mesh;
    if (prev) this.#restyle(prev);
    if (mesh) this.#restyle(mesh);
    const entry = mesh && this.layers.get(mesh.userData.layerId);
    this.onSelect(mesh ? { layer: entry.layer, mesh } : null);
  }

  /**
   * Shows (with a CSS colour) or hides (with null) a decorative haze overlay
   * on the skin and on any loaded layer whose data sets `hazeSurface: true`.
   * Several hazes may be shown at once, keyed by id.
   */
  setHaze(id, color) {
    const prev = this.hazes.get(id);
    if (prev) {
      for (const m of prev.overlays) m.removeFromParent();
      prev.material.dispose();
      this.hazes.delete(id);
    }
    if (color) this.hazes.set(id, { material: hazeMaterial(color, this.time), overlays: [] });
    this.#applyHazes();
  }

  /** (Re)builds every haze's overlay meshes over the current haze surfaces. */
  #applyHazes() {
    const surfaces = [...this.shellMeshes];
    for (const { layer, group } of this.layers.values()) {
      if (layer.hazeSurface) group?.traverse((o) => o.isMesh && !o.userData.haze && surfaces.push(o));
    }
    for (const haze of this.hazes.values()) {
      for (const m of haze.overlays) m.removeFromParent();
      haze.overlays = surfaces.map((surface) => {
        const overlay = new THREE.Mesh(surface.geometry, haze.material);
        overlay.userData.haze = true;
        overlay.renderOrder = 11; // over the glass shell
        overlay.raycast = () => {};
        surface.add(overlay); // follows its surface's visibility
        return overlay;
      });
    }
  }

  resetView() {
    this.camera.position.copy(this.home.position);
    this.controls.target.copy(this.home.target);
    this.controls.update();
  }

  #restyle(mesh) {
    const { materials, role } = mesh.userData;
    mesh.material =
      mesh === this.selected
        ? materials.selected
        : mesh === this.hovered || this.emphasized.has(mesh)
          ? materials.hover
          : this.faded.has(mesh)
            ? materials.dim
            : (materials[role] ?? materials.base);
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
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    let hits = this.#hits();
    // While a layer has an emphasis (setEmphasis), its faded parts let clicks
    // through to any part behind them that is lit.
    if (hits.some((h) => h.object.userData.role !== 'dim')) hits = hits.filter((h) => h.object.userData.role !== 'dim');
    // A part shared from another layer wins over that layer's own copy of it.
    const twin = hits[0] && hits.find((h) => h.distance - hits[0].distance < 1e-5 && h.object.userData.sourceId);
    if (twin) hits.unshift(twin);
    // A see-through part (e.g. the heart wall) yields only to an opaque part
    // inside it (e.g. a valve), i.e. one hit before the ray leaves it.
    const [nearest] = hits;
    if (!nearest || nearest.object.material.opacity >= 1) return nearest?.object ?? null;
    const exit = this.#exitDistance(nearest.object);
    const solid = hits.find((h) => h.distance < exit && h.object.material.opacity >= 1);
    return (solid || nearest).object;
  }

  /** Visible layer mesh hits along this.raycaster, nearest first, skipping anything cut away near the camera. */
  #hits() {
    const targets = [];
    for (const { group } of this.layers.values()) if (group?.visible) targets.push(group);
    return this.raycaster
      .intersectObjects(targets, true)
      // three.js also hits hidden meshes, such as peeled-away parts; parts faded by focusOn let clicks through.
      .filter(
        (h) =>
          h.object.isMesh &&
          h.object.visible &&
          !this.faded.has(h.object) &&
          (h.distance >= cutUniform.value || h.object.userData.uncut),
      );
  }

  /** First visible layer mesh hit by this.raycaster, skipping anything cut away near the camera. */
  #firstHit() {
    return this.#hits()[0];
  }

  /** Distance along the current pick ray to the last surface of `mesh`, back faces included. */
  #exitDistance(mesh) {
    const { material } = mesh;
    const { side } = material;
    const hits = [];
    material.side = THREE.DoubleSide;
    mesh.raycast(this.raycaster, hits);
    material.side = side;
    return Math.max(...hits.map((h) => h.distance));
  }

  #bindPointer(el) {
    let down = null;
    let pending = null;
    const active = new Set();
    el.addEventListener('pointerdown', (e) => {
      this.flight?.(); // the user takes over the camera
      active.add(e.pointerId);
      down = active.size === 1 ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null;
      if (active.size === 2) this.#reachTarget();
    });
    el.addEventListener(
      'wheel',
      () => {
        this.flight?.();
        this.#reachTarget();
      },
      { capture: true, passive: true },
    );
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

  /**
   * Close up, zooming stalls once the camera reaches minDistance from the orbit
   * target. If the target sits short of the part in view, slide it along the
   * view axis onto that part (the view itself doesn't move) so zooming can
   * carry on into the cutaway.
   */
  #reachTarget() {
    const { camera, controls } = this;
    const distance = camera.position.distanceTo(controls.target);
    if (distance >= CUT_START) return;
    this.raycaster.set(camera.position, camera.getWorldDirection(new THREE.Vector3()));
    const hit = this.#firstHit();
    if (hit && hit.distance > distance) controls.target.copy(this.raycaster.ray.at(hit.distance, new THREE.Vector3()));
  }

  /**
   * Moves the camera and its orbit target together for the held keys: W/S
   * along the view direction, A/D sideways, Q/E straight down/up. The target
   * stays inside the same bounds as panning; once it is held there, W/S carry
   * on by moving the camera toward or away from it, but no closer than where
   * the cutaway starts (scroll zoom still goes further).
   */
  #moveByKeys(dt) {
    const { camera, controls } = this;
    const { forward, right, up } = this.keys.direction();
    const distance = camera.position.distanceTo(controls.target);
    const step = THREE.MathUtils.clamp(distance * KEY_SPEED, KEY_SPEED_MIN, KEY_SPEED_MAX) * dt;
    const ahead = camera.getWorldDirection(new THREE.Vector3());
    const side = new THREE.Vector3().crossVectors(ahead, camera.up).normalize();
    const slide = side.multiplyScalar(right * step).addScaledVector(camera.up, up * step);
    this.#translate(slide);
    if (!forward) return;
    // The part of the forward/back move the bounds hold back becomes a dolly.
    const moved = this.#translate(ahead.clone().multiplyScalar(forward * step));
    const held = forward * step - moved.dot(ahead);
    const nearest = Math.min(distance, CUT_START);
    const wanted = THREE.MathUtils.clamp(distance - held, nearest, controls.maxDistance);
    camera.position.addScaledVector(ahead, distance - wanted);
  }

  /** Moves the camera and orbit target by `offset` within the target bounds; returns how far they moved. */
  #translate(offset) {
    const before = this.controls.target.clone();
    this.camera.position.add(offset);
    this.controls.target.add(offset);
    this.#clampTarget();
    return this.controls.target.clone().sub(before);
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
