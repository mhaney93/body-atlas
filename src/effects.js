// Decorative, illustrative effects a layer can offer next to its anatomy.
// They are not modeled anatomy: the UI labels each one as an effect.
import * as THREE from 'three';

/** Small seeded PRNG so the effect looks the same on every visit. */
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A twinkling haze of glowing specks just under the skin, denser around
 * `hotspots` ({ at: [x, y, z] in metres, radius, weight }). Points are
 * sampled over the shell's surface by area times density.
 * @param {THREE.Object3D} shell the loaded skin model
 * @param {{ color: string, count?: number, size?: number, depth?: number, hotspots?: object[] }} options
 */
export function skinHaze(shell, { color, count = 6000, size = 0.006, depth = 0.003, hotspots = [] }) {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const tris = [];
  const centre = new THREE.Box3().setFromObject(shell).getCenter(new THREE.Vector3());
  let outward = 0;
  shell.updateWorldMatrix(true, true);
  shell.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.getAttribute('position');
    const index = o.geometry.getIndex();
    const vertex = (i, v) => v.fromBufferAttribute(pos, index ? index.getX(i) : i).applyMatrix4(o.matrixWorld);
    const n = index ? index.count : pos.count;
    for (let i = 0; i + 2 < n; i += 3) {
      vertex(i, a);
      vertex(i + 1, b);
      vertex(i + 2, c);
      const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      const area = normal.length() / 2;
      if (!area) continue;
      normal.normalize();
      const mid = new THREE.Vector3().add(a).add(b).add(c).divideScalar(3);
      outward += Math.sign(normal.dot(new THREE.Vector3().subVectors(mid, centre)));
      let density = 1;
      for (const h of hotspots) {
        density += h.weight * Math.exp(-mid.distanceToSquared(new THREE.Vector3(...h.at)) / h.radius ** 2);
      }
      tris.push({ a: a.clone(), b: b.clone(), c: c.clone(), normal, weight: area * density });
    }
  });
  // Mostly-inward winding means the normals point into the body already.
  const inward = outward >= 0 ? -1 : 1;

  const cumulative = new Float64Array(tris.length);
  let total = 0;
  tris.forEach((t, i) => (cumulative[i] = total += t.weight));

  const random = mulberry32(20261011);
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const r = random() * total;
    let lo = 0;
    let hi = tris.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const t = tris[lo];
    let u = random();
    let v = random();
    if (u + v > 1) [u, v] = [1 - u, 1 - v];
    p.copy(t.a)
      .addScaledVector(new THREE.Vector3().subVectors(t.b, t.a), u)
      .addScaledVector(new THREE.Vector3().subVectors(t.c, t.a), v)
      .addScaledVector(t.normal, inward * depth * (0.5 + random()));
    p.toArray(positions, i * 3);
    seeds[i] = random();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uTime: { value: 0 },
      uSize: { value: size },
      uScale: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      uniform float uSize;
      uniform float uScale;
      varying float vGlow;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        vGlow = 0.55 + 0.45 * sin(uTime * (0.6 + 1.4 * aSeed) + aSeed * 40.0);
        gl_PointSize = min(uSize * uScale / -mv.z, 48.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vGlow;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = exp(-dot(c, c) * 16.0) * vGlow;
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 11; // after the glass shell
  points.raycast = () => {}; // never picked: it is not a part
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  return {
    object: points,
    /** Per-frame update: twinkle (unless reduced motion) and keep point size in pixels per metre. */
    update(time, camera, renderer) {
      if (!reducedMotion.matches) material.uniforms.uTime.value = time;
      const height = renderer.domElement.height;
      material.uniforms.uScale.value = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    },
  };
}

// Looks for partHaze(); `style` in the effect's data picks one.
const PART_HAZE_STYLES = {
  // A fine, dense, gently swaying fuzz hugging the surface (e.g. villi).
  villi: { offset: [0.0004, 0.0025], size: 0.0021, sway: 0.0012, drift: 0, secondColor: '#ff6fc4' },
  // Sparser specks floating a little off the surface and drifting about (e.g. gut bacteria).
  bacteria: { offset: [0.001, 0.008], size: 0.0026, sway: 0, drift: 0.003, secondColor: '#c79bff' },
};

/**
 * A glowing cloud of specks scattered over the surface of some of a layer's
 * parts (`parts` in the effect's data, matched by mesh name), e.g. villi on
 * the small intestine. Points are sampled by area.
 * @param {THREE.Mesh[]} meshes the parts to cover
 * @param {{ color: string, style?: 'villi' | 'bacteria', count?: number }} options
 */
export function partHaze(meshes, { color, style = 'villi', count = 5000 }) {
  const look = PART_HAZE_STYLES[style] ?? PART_HAZE_STYLES.villi;
  const random = mulberry32(count);
  const tris = [];
  let total = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const pos = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const vertex = (i, v) => v.fromBufferAttribute(pos, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
    const n = index ? index.count : pos.count;
    for (let i = 0; i + 2 < n; i += 3) {
      const tri = new THREE.Triangle(vertex(i, a).clone(), vertex(i + 1, b).clone(), vertex(i + 2, c).clone());
      const area = tri.getArea();
      if (!area) continue;
      tris.push({ tri, total: (total += area) });
    }
  }

  const n = tris.length ? count : 0;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const seeds = new Float32Array(n * 4);
  const p = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const r = random() * total;
    let lo = 0;
    let hi = tris.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tris[mid].total < r) lo = mid + 1;
      else hi = mid;
    }
    const { tri } = tris[lo];
    let u = random();
    let v = random();
    if (u + v > 1) [u, v] = [1 - u, 1 - v];
    tri.getNormal(normal);
    p.copy(tri.a)
      .addScaledVector(new THREE.Vector3().subVectors(tri.b, tri.a), u)
      .addScaledVector(new THREE.Vector3().subVectors(tri.c, tri.a), v)
      .addScaledVector(normal, look.offset[0] + random() * (look.offset[1] - look.offset[0]));
    p.toArray(positions, i * 3);
    normal.toArray(normals, i * 3);
    seeds.set([random(), 0.55 + random() * 0.9, random(), random()], i * 4);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aNormal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: 1 },
      uSize: { value: look.size },
      uSway: { value: look.sway },
      uDrift: { value: look.drift },
      uColor: { value: new THREE.Color(color) },
      uColor2: { value: new THREE.Color(look.secondColor) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime, uScale, uSize, uSway, uDrift;
      attribute vec3 aNormal;
      attribute vec4 aSeed;
      varying float vGlow;
      varying float vMix;
      void main() {
        float phase = aSeed.x * 6.2832;
        vec3 p = position + aNormal * uSway * sin(uTime * 2.2 + phase);
        float t = uTime * 0.5 + phase;
        p += uDrift * vec3(sin(t * 1.3), cos(t * 1.7), sin(t * 1.1 + 1.0));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = clamp(uSize * aSeed.y * uScale / -mv.z, 1.0, 24.0);
        gl_Position = projectionMatrix * mv;
        vGlow = 0.6 + 0.4 * sin(uTime * 1.6 + phase * 3.0);
        vMix = aSeed.z;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor, uColor2;
      varying float vGlow;
      varying float vMix;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.05, d);
        vec3 color = mix(uColor, uColor2, step(0.7, vMix));
        gl_FragColor = vec4(color, a * vGlow);
      }`,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 5; // after opaque parts, before the glass shell
  points.raycast = () => {}; // never picked: it is not a part
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  return {
    object: points,
    /** Per-frame update: sway and drift (unless reduced motion) and keep point size in pixels per metre. */
    update(time, camera, renderer) {
      if (!reducedMotion.matches) material.uniforms.uTime.value = time;
      const height = renderer.domElement.height;
      material.uniforms.uScale.value = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    },
  };
}

/**
 * Effect builders by `type`. Each takes the surface to decorate (the skin
 * shell, or for an effect with `parts`, those meshes of its layer) and the
 * effect's data, and returns { object, update(time, camera, renderer) }.
 */
export const EFFECTS = { 'skin-haze': skinHaze, 'part-haze': partHaze };
