// Poses the models into stretches. Layers whose data sets `posable` load
// as PoseMeshes: skinned meshes bound to one shared skeleton (one bone per rig
// segment, src/rig.js), which render and pick exactly like plain meshes while
// the skeleton rests. Bones ("posable": "bones") follow their own segment;
// soft parts ("posable": "soft") get their real skin weights the first time a
// pose moves a segment they could follow. A pose plays on a loop (into the
// stretch, hold, back out) with arrows at each moving joint; the glass skin
// stays where it is, a ghost of the starting position.
import * as THREE from 'three';
import { buildRig, candidateSegments, indexBones, segmentOfBone, SEGMENTS, SEGMENT_INDEX, skinWeights } from './rig.js';
import { opAxis, opStart, opTurn, poseMatrices } from './pose.js';

const LOOP = { into: 1.6, hold: 2.4, out: 1.2, rest: 0.8 }; // seconds
const ARROW_COLOR = '#9fd8ff';

/**
 * A skinned mesh that behaves as a plain mesh while unposed: bounds, picking
 * and vertex positions come from its geometry, so the idle site pays nothing
 * for being posable. While posed, picking follows the skeleton and its bounds
 * are a sphere that holds it all the way through the pose.
 */
export class PoseMesh extends THREE.SkinnedMesh {
  constructor(geometry, material) {
    super(geometry, material);
    this.posed = false;
    /** Whether skinWeights has given this mesh its real weights. */
    this.weighted = false;
  }

  computeBoundingBox() {
    if (this.posed) return super.computeBoundingBox();
    if (!this.geometry.boundingBox) this.geometry.computeBoundingBox();
    this.boundingBox = (this.boundingBox ?? new THREE.Box3()).copy(this.geometry.boundingBox);
  }

  computeBoundingSphere() {
    if (this.posed) return super.computeBoundingSphere();
    if (!this.geometry.boundingSphere) this.geometry.computeBoundingSphere();
    this.boundingSphere = (this.boundingSphere ?? new THREE.Sphere()).copy(this.geometry.boundingSphere);
  }

  raycast(raycaster, intersects) {
    if (this.posed) return super.raycast(raycaster, intersects);
    return THREE.Mesh.prototype.raycast.call(this, raycaster, intersects);
  }

  getVertexPosition(index, target) {
    if (this.posed) return super.getVertexPosition(index, target);
    return THREE.Mesh.prototype.getVertexPosition.call(this, index, target);
  }
}

/** World-space positions of a mesh's vertices, flat. */
function worldPositions(mesh) {
  mesh.updateWorldMatrix(true, false);
  const pos = mesh.geometry.getAttribute('position');
  const out = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  return out;
}

const ease = (t) => t * t * (3 - 2 * t);

/** The fraction of the way into the stretch at `t` seconds into the loop. */
export function loopFraction(t) {
  const total = LOOP.into + LOOP.hold + LOOP.out + LOOP.rest;
  t %= total;
  if (t < LOOP.into) return ease(t / LOOP.into);
  if ((t -= LOOP.into) < LOOP.hold) return 1;
  if ((t -= LOOP.hold) < LOOP.out) return 1 - ease(t / LOOP.out);
  return 0;
}

export class Poser {
  /**
   * @param {THREE.Scene} scene
   * @param {{ region: (layer: object, mesh: THREE.Mesh) => string | undefined, side: (mesh: THREE.Mesh) => string | null }} parts
   *   where a soft part lies (its region) and which side it is on
   */
  constructor(scene, parts) {
    this.scene = scene;
    this.parts = parts;
    this.rig = null;
    this.skeleton = null;
    this.index = null;
    /** Every PoseMesh, with the layer it belongs to. */
    this.meshes = [];
    this.ops = null;
    this.fraction = 0;
    this.arrows = new THREE.Group();
    this.arrows.renderOrder = 30;
    scene.add(this.arrows);
    this.ready = new Promise((resolve) => (this.resolveReady = resolve));
  }

  get active() {
    return this.ops !== null;
  }

  /**
   * Builds the rig and skeleton from a loaded "bones" layer. Call once, before
   * adopting meshes; soft layers wait for it.
   */
  setBones(group) {
    group.updateMatrixWorld(true);
    const byName = new Map();
    group.traverse((o) => o.isMesh && byName.set(o.userData.name ?? o.name, worldPositions(o)));
    this.rig = buildRig((name) => byName.get(name));
    this.index = indexBones(byName);
    const bones = SEGMENTS.map((def) => {
      const bone = new THREE.Bone();
      bone.name = def.id;
      return bone;
    });
    SEGMENTS.forEach((def, i) => {
      const seg = this.rig.segments.get(def.id);
      const parent = def.parent ? bones[SEGMENT_INDEX.get(def.parent)] : null;
      bone(bones[i], seg.pivot, parent ? this.rig.segments.get(def.parent).pivot : null);
      (parent ?? this.scene).add(bones[i]);
    });
    bones[0].updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(bones);
    this.resolveReady();

    function bone(b, pivot, parentPivot) {
      b.position.copy(parentPivot ? pivot.clone().sub(parentPivot) : pivot);
    }
  }

  /**
   * Swaps a freshly loaded layer's meshes for PoseMeshes bound to the
   * skeleton, before anything else holds them. A bones layer's meshes follow
   * their own segment; a soft layer's rest on the root until they are weighted.
   */
  adopt(layer, group) {
    group.updateMatrixWorld(true);
    const swaps = [];
    group.traverse((o) => o.isMesh && swaps.push(o));
    for (const mesh of swaps) {
      const geometry = mesh.geometry.getAttribute('skinIndex') ? mesh.geometry.clone() : mesh.geometry;
      const n = geometry.getAttribute('position').count;
      const indices = new Uint8Array(n * 4);
      const weights = new Uint8Array(n * 4);
      let seg = 0;
      if (layer.posable === 'bones') seg = SEGMENT_INDEX.get(segmentOfBone(mesh.userData.name ?? mesh.name)) ?? 0;
      for (let i = 0; i < n; i++) (indices[i * 4] = seg), (weights[i * 4] = 255);
      geometry.setAttribute('skinIndex', new THREE.BufferAttribute(indices, 4));
      geometry.setAttribute('skinWeight', new THREE.BufferAttribute(weights, 4, true));
      const posed = new PoseMesh(geometry, mesh.material);
      posed.name = mesh.name;
      posed.userData = mesh.userData;
      posed.position.copy(mesh.position);
      posed.quaternion.copy(mesh.quaternion);
      posed.scale.copy(mesh.scale);
      posed.weighted = layer.posable === 'bones';
      const parent = mesh.parent;
      parent.children[parent.children.indexOf(mesh)] = posed;
      posed.parent = parent;
      mesh.parent = null;
      posed.updateMatrixWorld(true);
      posed.bind(this.skeleton, posed.matrixWorld);
      this.meshes.push({ layer, mesh: posed });
    }
  }

  /**
   * Starts showing a pose: `ops` from variantOps (src/pose.js), looping into
   * the stretch and back unless `still` (reduced motion: hold the full stretch).
   */
  start(ops, { still = false } = {}) {
    this.stop();
    this.ops = ops;
    this.still = still;
    this.clock = 0;
    const moving = this.#movingSegments(ops);
    this.#weigh(moving);
    const full = poseMatrices(this.rig, ops, 1);
    for (const { mesh } of this.meshes) {
      mesh.posed = true;
      mesh.boundingSphere = this.#poseSphere(mesh, moving);
      mesh.boundingBox = null;
    }
    this.#drawArrows(ops, full);
    this.#apply(still ? 1 : 0);
  }

  /** Returns everything to rest. */
  stop() {
    if (!this.active) return;
    this.ops = null;
    this.#apply(0);
    for (const { mesh } of this.meshes) {
      mesh.posed = false;
      mesh.boundingSphere = null;
      mesh.boundingBox = null;
    }
    this.arrows.clear();
  }

  /** Advances the loop; call every frame. */
  update(dt) {
    if (!this.active || this.still) return;
    this.clock += dt;
    this.#apply(loopFraction(this.clock));
  }

  /** Puts every bone where the ops put its segment, `fraction` of the way. */
  #apply(fraction) {
    this.fraction = fraction;
    const matrices = poseMatrices(this.rig, this.ops ?? [], fraction);
    const world = new Map();
    for (const [i, def] of SEGMENTS.entries()) {
      const seg = this.rig.segments.get(def.id);
      // A bone's world matrix is its segment's pose applied at the bone's rest position (the pivot).
      const m = matrices.get(def.id).clone().multiply(new THREE.Matrix4().makeTranslation(seg.pivot.x, seg.pivot.y, seg.pivot.z));
      world.set(def.id, m);
      const local = def.parent ? world.get(def.parent).clone().invert().multiply(m) : m;
      const bone = this.skeleton.bones[i];
      local.decompose(bone.position, bone.quaternion, bone.scale);
    }
    this.skeleton.bones[0].updateMatrixWorld(true);
    this.arrows.visible = this.ops !== null;
  }

  /** The ops' segments and every segment below them. */
  #movingSegments(ops) {
    const moving = new Set(ops.filter((op) => op.angle).map((op) => op.seg));
    for (const def of SEGMENTS) if (def.parent && moving.has(def.parent)) moving.add(def.id);
    return moving;
  }

  /** Gives real skin weights to soft meshes that could follow a moving segment (once each). */
  #weigh(moving) {
    for (const { layer, mesh } of this.meshes) {
      if (mesh.weighted) continue;
      const region = this.parts.region(layer, mesh);
      const allowed = candidateSegments(region, this.parts.side(mesh));
      // A mesh also follows its candidates' parents across a joint.
      const reach = new Set([...allowed].flatMap((i) => [SEGMENTS[i].id, SEGMENTS[i].parent].filter(Boolean)));
      if (![...reach].some((id) => moving.has(id))) continue;
      const { indices, weights } = skinWeights(this.rig, this.index, worldPositions(mesh), allowed);
      const skinIndex = mesh.geometry.getAttribute('skinIndex');
      const skinWeight = mesh.geometry.getAttribute('skinWeight');
      skinIndex.array.set(indices);
      for (let i = 0; i < weights.length; i++) skinWeight.array[i] = Math.round(weights[i] * 255);
      skinIndex.needsUpdate = true;
      skinWeight.needsUpdate = true;
      mesh.weighted = true;
    }
  }

  /**
   * A local-space sphere that holds the mesh at every fraction of the pose:
   * its rest sphere, grown to cover any turn of its moving segments about
   * their pivots.
   */
  #poseSphere(mesh, moving) {
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    const local = mesh.geometry.boundingSphere;
    const world = local.clone().applyMatrix4(mesh.matrixWorld);
    const segs = new Set();
    const idx = mesh.geometry.getAttribute('skinIndex').array;
    const wts = mesh.geometry.getAttribute('skinWeight').array;
    for (let i = 0; i < idx.length; i++) if (wts[i]) segs.add(SEGMENTS[idx[i]].id);
    for (const id of segs) {
      if (!moving.has(id)) continue;
      // Walk up to the highest moving segment: the mesh stays within the chain's reach of its pivot.
      let s = this.rig.segments.get(id);
      let r = world.center.distanceTo(s.pivot) + world.radius;
      while (s.parent && moving.has(s.parent)) {
        const p = this.rig.segments.get(s.parent);
        r += s.pivot.distanceTo(p.pivot);
        s = p;
      }
      const sphere = new THREE.Sphere(s.pivot.clone(), r + 0.01);
      world.union(sphere);
    }
    const inv = mesh.matrixWorld.clone().invert();
    const scale = mesh.matrixWorld.getMaxScaleOnAxis();
    return new THREE.Sphere(world.center.clone().applyMatrix4(inv), world.radius / scale);
  }

  /**
   * One curved arrow per move and side (not per setup move), at its joint,
   * sweeping as far as the pose turns it there, from where the turn starts.
   */
  #drawArrows(ops, full) {
    this.arrows.clear();
    const material = new THREE.MeshBasicMaterial({ color: ARROW_COLOR, transparent: true, opacity: 0.9, depthTest: false });
    const seen = new Set();
    for (const op of ops) {
      const key = `${op.code} ${op.side}`;
      // A joint shared over several segments (the spine's) turns by its whole angle, drawn once.
      const sweep = opTurn(op, this.rig) / (op.share ?? 1);
      if (op.setup || op.plane === 'glide' || sweep < 1 || seen.has(key)) continue;
      seen.add(key);
      const seg = this.rig.segments.get(op.seg);
      const parent = seg.parent ? full.get(seg.parent) : new THREE.Matrix4();
      const rot = new THREE.Matrix4().extractRotation(parent);
      const axis = opAxis(op, this.rig).applyMatrix4(rot).normalize();
      const angle = THREE.MathUtils.degToRad(Math.min(sweep, 300));
      let center;
      let start;
      let radius;
      if (op.plane === 'axial') {
        // Around the segment's own length, partway along it.
        center = seg.pivot.clone().addScaledVector(seg.dir, seg.length * 0.45).applyMatrix4(parent);
        radius = THREE.MathUtils.clamp(seg.length * 0.18, 0.012, 0.05);
        start = new THREE.Vector3(1, 0, 0).cross(axis);
        if (start.lengthSq() < 1e-4) start = new THREE.Vector3(0, 0, 1).cross(axis);
      } else {
        center = seg.pivot.clone().applyMatrix4(parent);
        radius = THREE.MathUtils.clamp(seg.length * 0.45, 0.02, 0.16);
        start = seg.dir.clone().applyMatrix4(rot);
      }
      start.addScaledVector(axis, -start.dot(axis)).normalize().applyAxisAngle(axis, THREE.MathUtils.degToRad(opStart(op, this.rig)));
      const arrow = arcArrow(center, axis, start, angle, radius, material);
      arrow.userData = { code: op.code, side: op.side, seg: op.seg, sweep: Math.min(sweep, 300) };
      this.arrows.add(arrow);
    }
  }
}

/** A tube along an arc of `angle` about `axis` through `center`, from `start`, with a cone at its end. */
function arcArrow(center, axis, start, angle, radius, material) {
  const pts = [];
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const d = start.clone().applyAxisAngle(axis, (angle * i) / steps);
    pts.push(center.clone().addScaledVector(d, radius));
  }
  const thickness = Math.max(0.0015, radius * 0.05);
  const group = new THREE.Group();
  const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), steps * 2, thickness, 6), material);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(thickness * 3, thickness * 8, 10), material);
  const end = pts[pts.length - 1];
  const tangent = start.clone().applyAxisAngle(axis, angle).cross(axis).negate().normalize();
  tip.position.copy(end);
  tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
  for (const m of [tube, tip]) {
    m.renderOrder = 30;
    m.raycast = () => {};
  }
  group.add(tube, tip);
  return group;
}

