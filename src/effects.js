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
  // Soft specks filling the inside of the parts, glowing with a slow breath (e.g. alveoli in the lungs).
  alveoli: { offset: [0.002, 0.015], inside: true, size: 0.003, sway: 0.0006, drift: 0, pulse: 0.5, secondColor: '#ffffff' },
};

/** Triangles ({ tri } in world space) bucketed in a uniform grid, to find those near a short segment quickly. */
function triangleGrid(tris, size) {
  const cells = new Map();
  const box = new THREE.Box3();
  const each = (min, max, fn) => {
    for (let x = Math.floor(min.x / size); x <= Math.floor(max.x / size); x++)
      for (let y = Math.floor(min.y / size); y <= Math.floor(max.y / size); y++)
        for (let z = Math.floor(min.z / size); z <= Math.floor(max.z / size); z++) fn(`${x},${y},${z}`);
  };
  tris.forEach(({ tri }, i) => {
    box.setFromPoints([tri.a, tri.b, tri.c]);
    each(box.min, box.max, (key) => (cells.get(key) ?? cells.set(key, []).get(key)).push(i));
  });
  return {
    /** Indices of the triangles in the cells the segment start–end passes near. */
    near(start, end) {
      const found = new Set();
      box.makeEmpty().expandByPoint(start).expandByPoint(end);
      each(box.min, box.max, (key) => cells.get(key)?.forEach((i) => found.add(i)));
      return found;
    },
  };
}

/**
 * A glowing cloud of specks scattered over the surface of some of a layer's
 * parts (`parts` in the effect's data, matched by mesh name), e.g. villi on
 * the small intestine. Points are sampled by area. A style with `inside`
 * pushes them into the parts instead (the meshes must be closed).
 * @param {THREE.Mesh[]} meshes the parts to cover
 * @param {{ color: string, style?: 'villi' | 'bacteria' | 'alveoli', count?: number }} options
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
    const first = tris.length;
    const centre = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    let outward = 0;
    for (let i = 0; i + 2 < n; i += 3) {
      const tri = new THREE.Triangle(vertex(i, a).clone(), vertex(i + 1, b).clone(), vertex(i + 2, c).clone());
      const area = tri.getArea();
      if (!area) continue;
      tris.push({ tri, total: (total += area), side: 1 });
      outward += Math.sign(tri.getNormal(a).dot(tri.getMidpoint(b).sub(centre)));
    }
    // An inside haze needs inward normals: flip a mesh whose winding mostly faces out.
    if (look.inside && outward > 0) for (let i = first; i < tris.length; i++) tris[i].side = -1;
  }

  const n = tris.length ? count : 0;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const seeds = new Float32Array(n * 4);
  const p = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const grid = look.inside && triangleGrid(tris, look.offset[1] * 2);
  const ray = new THREE.Ray();
  const hit = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const r = random() * total;
    let lo = 0;
    let hi = tris.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tris[mid].total < r) lo = mid + 1;
      else hi = mid;
    }
    const { tri, side } = tris[lo];
    let u = random();
    let v = random();
    if (u + v > 1) [u, v] = [1 - u, 1 - v];
    tri.getNormal(normal).multiplyScalar(side);
    p.copy(tri.a)
      .addScaledVector(new THREE.Vector3().subVectors(tri.b, tri.a), u)
      .addScaledVector(new THREE.Vector3().subVectors(tri.c, tri.a), v);
    let depth = look.offset[0] + random() * (look.offset[1] - look.offset[0]);
    if (grid) {
      // Stay within the middle of thin parts (e.g. the lungs' sharp lower edges).
      ray.set(p.clone().addScaledVector(normal, 1e-5), normal);
      for (const j of grid.near(ray.origin, ray.at(depth * 2, new THREE.Vector3()))) {
        const { a: ta, b: tb, c: tc } = tris[j].tri;
        if (ray.intersectTriangle(ta, tb, tc, false, hit)) depth = Math.min(depth, hit.distanceTo(ray.origin) / 2);
      }
    }
    p.addScaledVector(normal, depth);
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
      uPulse: { value: look.pulse ?? 0 },
      uColor: { value: new THREE.Color(color) },
      uColor2: { value: new THREE.Color(look.secondColor) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime, uScale, uSize, uSway, uDrift, uPulse;
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
        // uPulse fades every speck together on a slow ~5 s cycle, like breathing.
        float breath = 1.0 - uPulse * (0.5 - 0.5 * sin(uTime * 1.25));
        vGlow = (0.6 + 0.4 * sin(uTime * 1.6 + phase * 3.0)) * breath;
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

/** The longest axis of a mesh's vertices in world space (principal component). */
function principalAxis(mesh) {
  const pos = mesh.geometry.getAttribute('position');
  const v = new THREE.Vector3();
  const mean = new THREE.Vector3();
  const pts = [];
  const step = Math.max(1, Math.floor(pos.count / 1500));
  for (let i = 0; i < pos.count; i += step) {
    pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).clone());
    mean.add(pts.at(-1));
  }
  mean.divideScalar(pts.length);
  const c = [0, 0, 0, 0, 0, 0]; // xx xy xz yy yz zz
  for (const p of pts) {
    const [x, y, z] = [p.x - mean.x, p.y - mean.y, p.z - mean.z];
    c[0] += x * x;
    c[1] += x * y;
    c[2] += x * z;
    c[3] += y * y;
    c[4] += y * z;
    c[5] += z * z;
  }
  // Power iteration for the covariance matrix's dominant eigenvector.
  const dir = new THREE.Vector3(0.3, 1, 0.2).normalize();
  for (let k = 0; k < 32; k++) {
    dir
      .set(
        c[0] * dir.x + c[1] * dir.y + c[2] * dir.z,
        c[1] * dir.x + c[3] * dir.y + c[4] * dir.z,
        c[2] * dir.x + c[4] * dir.y + c[5] * dir.z,
      )
      .normalize();
  }
  return dir;
}

/**
 * Faint glowing streaks drawn over every part of a layer, running along each
 * part's long axis, with slow pulses travelling along them: a hint of muscle
 * fibres. The streaks are a pattern, not the fibres' real directions.
 * @param {THREE.Object3D} model the layer's loaded model
 * @param {{ color: string, spacing?: number }} options `spacing`: streak spacing in metres
 * @param {{ cut: { value: number } }} context the viewer's close-zoom cutaway radius
 */
export function fiberHaze(model, { color, spacing = 0.004 }, { cut }) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uTime: { value: 0 },
      uAxis: { value: new THREE.Vector3(0, 1, 0) },
      uFreq: { value: (Math.PI * 2) / spacing },
      uCut: cut,
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vec4 mv = viewMatrix * world;
        vPos = world.xyz;
        vNormal = normalize(normalMatrix * normal);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uTime;
      uniform vec3 uAxis;
      uniform float uFreq;
      uniform float uCut;
      varying vec3 vPos;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        if (length(vView) < uCut) discard;
        vec3 b1 = normalize(cross(uAxis, abs(uAxis.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
        vec3 b2 = cross(uAxis, b1);
        float along = dot(vPos, uAxis);
        float across = dot(vPos, b1) + 0.7 * dot(vPos, b2);
        // Streaks across the axis, wavering a little along it; faded out where
        // they would be finer than a pixel so they never shimmer.
        float phase = across * uFreq + 0.8 * sin(along * 90.0 + across * 260.0);
        float streak = smoothstep(0.3, 1.0, sin(phase)) * (1.0 - smoothstep(1.0, 3.0, fwidth(phase)));
        float pulse = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(along * 40.0 - uTime * 2.0 + across * 150.0), 3.0);
        float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.0);
        gl_FragColor = vec4(uColor * (streak * pulse * 0.55 + rim * 0.12 + 0.03), 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const group = new THREE.Group();
  const overlays = [];
  model.updateWorldMatrix(true, true);
  model.traverse((mesh) => {
    if (!mesh.isMesh || mesh.userData.haze) return;
    const overlay = new THREE.Mesh(mesh.geometry, material.clone());
    overlay.material.uniforms.uAxis.value = principalAxis(mesh);
    // Shared uniforms: one clock, one colour, the viewer's cutaway radius.
    for (const key of ['uColor', 'uTime', 'uFreq']) overlay.material.uniforms[key] = material.uniforms[key];
    // Small parts the viewer never cuts away (userData.uncut) keep their streaks too.
    overlay.material.uniforms.uCut = mesh.userData.uncut ? { value: 0 } : cut;
    overlay.matrixAutoUpdate = false;
    overlay.matrix.copy(mesh.matrixWorld);
    overlay.renderOrder = 5; // after the opaque parts it lies on
    overlay.raycast = () => {}; // never picked: it is not a part
    group.add(overlay);
    overlays.push({ overlay, mesh });
  });
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const shown = (o) => {
    for (; o; o = o.parent) if (!o.visible) return false;
    return true;
  };

  return {
    object: group,
    /** Per-frame update: drift the pulses (unless reduced motion) and follow each part's visibility and fading. */
    update(time) {
      if (!reducedMotion.matches) material.uniforms.uTime.value = time;
      for (const { overlay, mesh } of overlays) overlay.visible = shown(mesh) && !mesh.material.transparent;
    },
  };
}

/**
 * Effect builders by `type`. Each takes the surface to decorate (the skin
 * shell; for an effect with `parts`, those meshes of its layer; for
 * `surface: 'layer'`, the layer's whole model), the effect's data and
 * { cut } (the viewer's cutaway radius), and returns
 * { object, update(time, camera, renderer) }.
 */
export const EFFECTS = { 'skin-haze': skinHaze, 'part-haze': partHaze, 'fiber-haze': fiberHaze };
