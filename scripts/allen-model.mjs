// Small brain nuclei that neither BodyParts3D nor Z-Anatomy models (the
// substantia nigra, subthalamic and red nuclei, deep cerebellar nuclei,
// nucleus accumbens, claustrum and inferior olive), taken from the Allen
// Human Reference Atlas 3D, 2020 (CC BY 4.0; fetched into .cache/allen/ by
// scripts/fetch-allen.mjs).
//
// The atlas is a 0.5 mm label volume of a population-average brain (MNI ICBM
// 2009b), so each nucleus is surfaced from its labels and then mapped onto
// this body's brain:
// 1. a 12-parameter affine fitted to the centres of structures both the atlas
//    and the shown brain have (thalamus, basal ganglia, ventricles, ...);
// 2. a local refinement: each of those shared structures is fitted onto the
//    shown one (affine ICP), and a smooth thin-plate-spline warp through the
//    moves of their surfaces carries the nuclei between them along;
// 3. each nucleus is then moved as a whole, if needed, so it lies inside the
//    part that holds it (e.g. the substantia nigra in the brainstem) and out
//    of its neighbours, and locally where it is squeezed between them;
// 4. once the build has simplified the layer, placeNuclei repeats step 3
//    against the simplified parts, whose surfaces move by up to ~2 mm.
// The result is the atlas position mapped onto this body, good to a few
// millimetres, and the site labels these parts as approximate.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';
import { Envelope, Solid } from './solid.mjs';

/**
 * The nuclei, each surfaced per hemisphere, with the shown part each must
 * lie inside (`within`, if any). The deep cerebellar nuclei are one label in
 * the atlas, so they are one part per side. The claustrum is a sheet about
 * 1 mm thick, which needs a lighter blur and a lower threshold to stay whole.
 */
export const NUCLEI = [
  { name: 'substantia nigra', acronyms: ['SN'], within: 'Brainstem' },
  { name: 'red nucleus', acronyms: ['RN'], within: 'Brainstem' },
  { name: 'subthalamic nucleus', acronyms: ['STH'] },
  { name: 'deep cerebellar nuclei', acronyms: ['CbDN'], within: 'Cerebellum' },
  { name: 'inferior olive', acronyms: ['IO'], within: 'Brainstem' },
  { name: 'nucleus accumbens', acronyms: ['NAC'] },
  { name: 'claustrum', acronyms: ['Cla'], surface: { sigma: 0.7, iso: 0.35 } },
];

// Shown parts a nucleus must stay out of (other than its `within`): the deep
// structures, the insula and limbic lobe (whose meshes are closed), the
// brainstem, cerebellum and the nuclei placed before it.
export const NEIGHBOURS =
  /thalamus|mammillary|caudate|putamen|pallidus|hippocampus|amygdala|corpus callosum|internal capsule|fornix|commissure|septum pellucidum|ventricle|aqueduct|interventricular|choroid|insula|limbic lobe|brainstem|cerebellum|substantia nigra|red nucleus|subthalamic|deep cerebellar|inferior olive|accumbens|claustrum/i;

// Structures both the atlas and the shown brain have: atlas acronyms (with
// their sub-structures), the shown part (paired ones per side), and whether
// its centre is a landmark for the affine. The shown insula and cerebellum
// are cortex surfaces and the atlas brainstem is cut off lower down, so their
// centres differ from the atlas's; only their surfaces are fitted.
const SHARED = [
  { acronyms: ['THM'], name: 'thalamus' },
  { acronyms: ['CaH', 'CaB', 'CaT'], name: 'caudate nucleus' },
  { acronyms: ['Pu'], name: 'putamen' },
  { acronyms: ['GPe', 'GPi'], name: 'globus pallidus' },
  { acronyms: ['HiH', 'HiB', 'HiT'], name: 'hippocampus' },
  { acronyms: ['AMY'], name: 'amygdala' },
  { acronyms: ['aLV', 'bLV', 'xLV', 'pLV', 'iLV'], name: 'lateral ventricle' },
  { acronyms: ['3V'], name: 'Third ventricle' },
  { acronyms: ['4V'], name: 'Fourth ventricle' },
  { acronyms: ['HTH'], name: 'Hypothalamus' },
  { acronyms: ['LIG', 'SIG'], name: 'insula', landmark: false },
  { mask: 'brainstem', name: 'Brainstem', landmark: false },
  { mask: 'cerebellum', name: 'Cerebellum', landmark: false },
];

// How far (mm) a nucleus is kept inside its part and clear of its neighbours,
// so the simplification after the fit does not bring it back into contact.
const CLEARANCE = 0.6;
// A local push fades out over this many mm around the vertex it moves.
const TAPER = 3;
// mm a nucleus surface may move when it is simplified, before the build's own
// simplification (which, relative to the size of a part, keeps a thin sheet
// such as the claustrum nearly whole).
const SIMPLIFY_ERROR = 0.1;

const SIDES = ['Left', 'Right'];
/** "Left" + "putamen" → "Left putamen"; a capitalised (midline) name stays as it is. */
const sided = (side, name) => (/^[A-Z]/.test(name) ? name : `${side} ${name}`);
const midline = (name) => /^[A-Z]/.test(name);

// --- The atlas volume -------------------------------------------------------

/** Reads the label volume (NIfTI-1, qform) and its ontology. */
export function readAtlas(dir) {
  const buf = gunzipSync(readFileSync(join(dir, 'annotation_full.nii.gz')));
  const dims = [1, 2, 3].map((i) => buf.readInt16LE(40 + 2 * i));
  const datatype = buf.readInt16LE(70);
  if (datatype !== 768) throw new Error(`Allen annotation: expected uint32 labels, got NIfTI datatype ${datatype}`);
  const pixdim = [0, 1, 2, 3].map((i) => buf.readFloatLE(76 + 4 * i));
  const offset = buf.readFloatLE(108);
  // qform: quaternion rotation, voxel size and qfac for k (the sform is unset).
  const [b, c, d] = [256, 260, 264].map((o) => buf.readFloatLE(o));
  const a = Math.sqrt(Math.max(0, 1 - b * b - c * c - d * d));
  const shift = [268, 272, 276].map((o) => buf.readFloatLE(o));
  const qfac = pixdim[0] < 0 ? -1 : 1;
  const R = [
    [a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
    [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
    [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - c * c - b * b],
  ];
  const scale = [pixdim[1], pixdim[2], pixdim[3] * qfac];
  // Voxel index → MNI mm, as a 3x4 affine.
  const toMni = R.map((row, k) => [row[0] * scale[0], row[1] * scale[1], row[2] * scale[2], shift[k]]);
  const labels = new Uint32Array(buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + 4 * dims[0] * dims[1] * dims[2]));

  const rows = readFileSync(join(dir, 'voxel_count.csv'), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const cells = line.match(/("[^"]*"|[^,]*)(,|$)/g).map((s) => s.replace(/,$/, '').replace(/^"|"$/g, ''));
      return { id: Number(cells[0]), acronym: cells[2], name: cells[3], path: cells[6].split('/').filter(Boolean).map(Number) };
    });
  const byAcronym = new Map(rows.map((r) => [r.acronym, r]));
  /** Label ids of the structures named and everything under them. */
  const labelSet = (acronyms) => {
    const ids = new Set(
      acronyms.map((acr) => {
        const row = byAcronym.get(acr);
        if (!row) throw new Error(`Allen ontology has no structure "${acr}"`);
        return row.id;
      }),
    );
    return new Set(rows.filter((r) => r.path.some((id) => ids.has(id))).map((r) => r.id));
  };
  return { dims, toMni, labels, labelSet };
}

/** Whether a voxel lies in the left hemisphere (MNI x < 0); 0 = left, 1 = right. */
function sideOf(atlas, i, j, k) {
  const m = atlas.toMni[0];
  return m[0] * i + m[1] * j + m[2] * k + m[3] < 0 ? 0 : 1;
}

/**
 * Masks (voxel index lists per side, and both) for the brainstem and the
 * cerebellum. The atlas files the white matter of both under one "white
 * matter of hindbrain"; each of its voxels goes to whichever is nearer.
 */
function brainstemAndCerebellum(atlas) {
  const { labels } = atlas;
  const stem = atlas.labelSet(['M', 'Pn', 'Mo']);
  const cb = atlas.labelSet(['CB']);
  const wm = atlas.labelSet(['HWM']);
  const owner = new Uint8Array(labels.length); // 1 stem, 2 cerebellum
  const [nx, ny] = atlas.dims;
  const queue = [];
  for (let v = 0; v < labels.length; v++) {
    if (stem.has(labels[v])) (owner[v] = 1), queue.push(v);
    else if (cb.has(labels[v])) (owner[v] = 2), queue.push(v);
  }
  for (let h = 0; h < queue.length; h++) {
    const v = queue[h];
    for (const n of [v - 1, v + 1, v - nx, v + nx, v - nx * ny, v + nx * ny]) {
      if (n >= 0 && n < labels.length && !owner[n] && wm.has(labels[n])) {
        owner[n] = owner[v];
        queue.push(n);
      }
    }
  }
  return { brainstem: (v) => owner[v] === 1, cerebellum: (v) => owner[v] === 2 };
}

/** Voxel indices (flat) matching `test`, split by side. */
function voxels(atlas, test) {
  const [nx, ny, nz] = atlas.dims;
  const out = [[], []];
  for (let k = 0, v = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, v++) if (atlas.labels[v] && test(v)) out[sideOf(atlas, i, j, k)].push(v);
  return out;
}

// --- Surfacing ---------------------------------------------------------------

/** Separable Gaussian blur of a grid in place. */
function blur(field, dims, sigma) {
  const r = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const total = kernel.reduce((s, x) => s + x, 0);
  const stride = [1, dims[0], dims[0] * dims[1]];
  const tmp = new Float32Array(field.length);
  for (let axis = 0; axis < 3; axis++) {
    const s = stride[axis];
    const len = dims[axis];
    for (let v = 0; v < field.length; v++) {
      const c = Math.floor(v / s) % len;
      let sum = 0;
      for (let d = -r; d <= r; d++) if (c + d >= 0 && c + d < len) sum += field[v + d * s] * kernel[d + r];
      tmp[v] = sum / total;
    }
    field.set(tmp);
  }
}

/**
 * Surface nets: a closed triangle mesh of the region where `field` exceeds
 * `iso`, one vertex per boundary cell placed at the mean of its edge
 * crossings. Positions are grid coordinates; faces wind outward.
 */
function surfaceNets(field, dims, iso) {
  const [nx, ny, nz] = dims;
  const at = (x, y, z) => field[x + nx * (y + ny * z)];
  const cellIndex = new Int32Array(nx * ny * nz).fill(-1);
  const positions = [];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let z = 0; z < nz - 1; z++)
    for (let y = 0; y < ny - 1; y++)
      for (let x = 0; x < nx - 1; x++) {
        const vals = corners.map(([a, b, c]) => at(x + a, y + b, z + c));
        const inside = vals.map((v) => v > iso);
        if (inside.every(Boolean) || !inside.some(Boolean)) continue;
        const sum = [0, 0, 0];
        let n = 0;
        for (const [p, q] of edges) {
          if (inside[p] === inside[q]) continue;
          const t = (iso - vals[p]) / (vals[q] - vals[p]);
          for (let k = 0; k < 3; k++) sum[k] += corners[p][k] + t * (corners[q][k] - corners[p][k]);
          n++;
        }
        cellIndex[x + nx * (y + ny * z)] = positions.length / 3;
        positions.push(x + sum[0] / n, y + sum[1] / n, z + sum[2] / n);
      }
  const indices = [];
  const cell = (x, y, z) => cellIndex[x + nx * (y + ny * z)];
  const quad = (a, b, c, d, out) => (out ? indices.push(a, b, c, a, c, d) : indices.push(a, d, c, a, c, b));
  for (let z = 1; z < nz - 1; z++)
    for (let y = 1; y < ny - 1; y++)
      for (let x = 1; x < nx - 1; x++) {
        const here = at(x, y, z) > iso;
        // Each grid edge leaving (x, y, z) that crosses the surface is a quad
        // of the four cells around it, facing from inside to outside.
        if (x < nx - 1 && here !== at(x + 1, y, z) > iso)
          quad(cell(x, y - 1, z - 1), cell(x, y, z - 1), cell(x, y, z), cell(x, y - 1, z), here);
        if (y < ny - 1 && here !== at(x, y + 1, z) > iso)
          quad(cell(x - 1, y, z - 1), cell(x - 1, y, z), cell(x, y, z), cell(x, y, z - 1), here);
        if (z < nz - 1 && here !== at(x, y, z + 1) > iso)
          quad(cell(x - 1, y - 1, z), cell(x, y - 1, z), cell(x, y, z), cell(x - 1, y, z), here);
      }
  return { positions, indices };
}

/**
 * Surfaces a set of voxels (flat indices) as a mesh in MNI mm. The mask is
 * blurred by `sigma` voxels first, so the surface is smooth rather than
 * stepped; thin sheets (the claustrum) need a lower `iso` to stay whole.
 */
function surface(atlas, voxelList, { sigma = 1, iso = 0.5 } = {}) {
  const [nx, ny] = atlas.dims;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const ijk = (v) => [v % nx, Math.floor(v / nx) % ny, Math.floor(v / (nx * ny))];
  for (const v of voxelList) {
    const p = ijk(v);
    for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], p[k])), (hi[k] = Math.max(hi[k], p[k]));
  }
  const pad = Math.ceil(sigma * 3) + 2;
  const origin = lo.map((v) => v - pad);
  const dims = hi.map((v, k) => v - lo[k] + 1 + 2 * pad);
  const field = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (const v of voxelList) {
    const p = ijk(v).map((c, k) => c - origin[k]);
    field[p[0] + dims[0] * (p[1] + dims[1] * p[2])] = 1;
  }
  blur(field, dims, sigma);
  const mesh = surfaceNets(field, dims, iso);
  const m = atlas.toMni;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const g = [0, 1, 2].map((k) => mesh.positions[i + k] + origin[k]);
    for (let k = 0; k < 3; k++) mesh.positions[i + k] = m[k][0] * g[0] + m[k][1] * g[1] + m[k][2] * g[2] + m[k][3];
  }
  return mesh;
}

/** Simplifies a mesh to SIMPLIFY_ERROR mm and drops the vertices it no longer uses. Needs MeshoptSimplifier.ready. */
function simplified({ positions, indices }) {
  const [kept] = MeshoptSimplifier.simplify(new Uint32Array(indices), new Float32Array(positions), 3, 0, SIMPLIFY_ERROR, ['ErrorAbsolute']);
  const remap = new Map();
  const out = { positions: [], indices: [] };
  for (const i of kept) {
    if (!remap.has(i)) {
      remap.set(i, remap.size);
      out.positions.push(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
    }
    out.indices.push(remap.get(i));
  }
  return out;
}

// --- Geometry ----------------------------------------------------------------

/** Volume centroid of a closed mesh (signed tetrahedra), else its vertex mean. */
function centroidOf({ positions: p, indices }) {
  let vol = 0;
  const c = [0, 0, 0];
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, d] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    const v =
      (p[a] * (p[b + 1] * p[d + 2] - p[b + 2] * p[d + 1]) -
        p[a + 1] * (p[b] * p[d + 2] - p[b + 2] * p[d]) +
        p[a + 2] * (p[b] * p[d + 1] - p[b + 1] * p[d])) /
      6;
    vol += v;
    for (let k = 0; k < 3; k++) c[k] += (v * (p[a + k] + p[b + k] + p[d + k])) / 4;
  }
  if (Math.abs(vol) > 1) return c.map((x) => x / vol);
  const n = p.length / 3;
  return [0, 1, 2].map((k) => {
    let s = 0;
    for (let i = k; i < p.length; i += 3) s += p[i];
    return s / n;
  });
}

/** Mean of voxel centres in MNI mm. */
function voxelCentroid(atlas, list) {
  const [nx, ny] = atlas.dims;
  const s = [0, 0, 0];
  for (const v of list) {
    const g = [v % nx, Math.floor(v / nx) % ny, Math.floor(v / (nx * ny))];
    for (let k = 0; k < 3; k++) s[k] += atlas.toMni[k][0] * g[0] + atlas.toMni[k][1] * g[1] + atlas.toMni[k][2] * g[2] + atlas.toMni[k][3];
  }
  return s.map((x) => x / list.length);
}

/** Solves the square system M x = b (Gaussian elimination, partial pivoting); b may hold several columns. */
function solve(M, B) {
  const n = M.length;
  const cols = B[0].length;
  const A = M.map((row, i) => [...row, ...B[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const pivot = A[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / pivot;
      if (f) for (let k = c; k < n + cols; k++) A[r][k] -= f * A[c][k];
    }
  }
  const X = Array.from({ length: n }, () => new Array(cols).fill(0));
  for (let r = n - 1; r >= 0; r--)
    for (let j = 0; j < cols; j++) {
      let s = A[r][n + j];
      for (let k = r + 1; k < n; k++) s -= A[r][k] * X[k][j];
      X[r][j] = s / A[r][r];
    }
  return X;
}

/** Least-squares affine (3x4 rows) taking each src point to its dst point. */
function fitAffine(src, dst) {
  const XtX = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
  const XtY = [0, 1, 2, 3].map(() => [0, 0, 0]);
  src.forEach((s, n) => {
    const x = [...s, 1];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) XtX[i][j] += x[i] * x[j];
      for (let d = 0; d < 3; d++) XtY[i][d] += x[i] * dst[n][d];
    }
  });
  const X = solve(XtX, XtY);
  return [0, 1, 2].map((d) => [X[0][d], X[1][d], X[2][d], X[3][d]]);
}

const applyAffine = (A, p) => A.map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + r[3]);
const determinant = (A) =>
  A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
  A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
  A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);

const points = (positions) => Array.from({ length: positions.length / 3 }, (_, i) => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]]);
const every = (list, n) => list.filter((_, i) => i % Math.max(1, Math.floor(list.length / n)) === 0);

/**
 * Affine ICP of `src` points onto the outer surface of a filled part, with
 * correspondences both ways (each source point to the nearest surface point,
 * each surface triangle to the nearest source point) so the fit can neither shrink nor drift onto one
 * end of the target. Returns the affine.
 */
function icpAffine(src, env, iterations = 30) {
  const { solid, outer } = env;
  const tgt = every(
    [...outer.keys()].filter((t) => outer[t]).map((t) => [0, 1, 2].map((k) => (solid.tris[t * 9 + k] + solid.tris[t * 9 + 3 + k] + solid.tris[t * 9 + 6 + k]) / 3)),
    400,
  );
  let A = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
  for (let it = 0; it < iterations; it++) {
    const moved = src.map((p) => applyAffine(A, p));
    const from = [];
    const to = [];
    moved.forEach((m, i) => {
      from.push(src[i]);
      to.push(solid.closest(m, outer).point);
    });
    for (const t of tgt) {
      let best = 0;
      let bestD = Infinity;
      moved.forEach((m, i) => {
        const d = (m[0] - t[0]) ** 2 + (m[1] - t[1]) ** 2 + (m[2] - t[2]) ** 2;
        if (d < bestD) [best, bestD] = [i, d];
      });
      from.push(src[best]);
      to.push(t);
    }
    A = fitAffine(from, to);
  }
  return A;
}

/**
 * A smooth warp through displacement samples: a regularised thin-plate
 * spline (kernel -|r|, the biharmonic one in 3D) plus an affine part, fitted per axis.
 */
function thinPlate(centres, moves, smoothing) {
  const n = centres.length;
  const M = Array.from({ length: n + 4 }, () => new Array(n + 4).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i][j] = -Math.hypot(centres[i][0] - centres[j][0], centres[i][1] - centres[j][1], centres[i][2] - centres[j][2]);
    M[i][i] = smoothing;
    const row = [1, ...centres[i]];
    for (let k = 0; k < 4; k++) M[i][n + k] = M[n + k][i] = row[k];
  }
  const B = [...moves, [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const W = solve(M, B);
  return (p) => {
    const d = [W[n][0], W[n][1], W[n][2]];
    for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) d[k] += W[n + 1 + a][k] * p[a];
    for (let i = 0; i < n; i++) {
      const r = -Math.hypot(p[0] - centres[i][0], p[1] - centres[i][1], p[2] - centres[i][2]);
      for (let k = 0; k < 3; k++) d[k] += W[i][k] * r;
    }
    return [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
  };
}

// --- Placement ----------------------------------------------------------------

/**
 * A shown part as a filled solid: its surface closed up and flood-filled from
 * outside, so a cortex with folds and a hollow core (the cerebellum) still
 * counts as solid inside. `outer` flags the triangles on its outside.
 */
function filled(mesh) {
  return (mesh.filled ??= new Envelope(mesh.positions, mesh.indices, 4, 1, 1));
}

/** Whether a mesh is closed: every edge shared by two triangles, matching vertices by position. */
function closed({ positions, indices }) {
  const ids = new Map();
  const id = (i) => {
    const key = `${positions[i * 3].toFixed(2)},${positions[i * 3 + 1].toFixed(2)},${positions[i * 3 + 2].toFixed(2)}`;
    if (!ids.has(key)) ids.set(key, ids.size);
    return ids.get(key);
  };
  const edges = new Map();
  for (let t = 0; t < indices.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const [a, b] = [id(indices[t + e]), id(indices[t + ((e + 1) % 3)])].sort((x, y) => x - y);
      edges.set(a * 4294967296 + b, (edges.get(a * 4294967296 + b) ?? 0) + 1);
    }
  return [...edges.values()].every((n) => n !== 1);
}

/**
 * A shown part as something a point is inside or outside of, and a way out
 * through its surface. A closed mesh uses its exact inside (ray parity); the
 * filled solid (above) is only for a part that is open or hollow (the
 * brainstem, the cerebellum), as it also counts the mouths of narrow folds
 * as inside, by an amount that depends on how its voxels fall.
 */
export function shapeOf(mesh) {
  if (!mesh.shape) {
    if (closed(mesh)) {
      const solid = new Solid(mesh.positions, mesh.indices, 4);
      mesh.shape = { solid, encloses: (p) => solid.contains(p), closest: (p) => solid.closest(p) };
    } else {
      const env = filled(mesh);
      mesh.shape = { solid: env.solid, encloses: (p) => env.encloses(p), closest: (p) => env.solid.closest(p, env.outer) };
    }
  }
  return mesh.shape;
}

/** The move (or null) that takes `p` out of `shape` or, with `into`, into it, to `clearance` beyond the surface. */
function push(shape, p, into, clearance) {
  if (shape.encloses(p) === into) return null;
  const { point, distance } = shape.closest(p);
  if (!point) return null;
  const d = [point[0] - p[0], point[1] - p[1], point[2] - p[2]];
  // Out of a part: through its nearest outer surface. Into one: to it, and on.
  const s = (distance + clearance) / (distance || 1);
  return [d[0] * s, d[1] * s, d[2] * s];
}

/**
 * Moves a nucleus into its `within` part and out of `blockers`: first as a
 * whole, by the mean of what its vertices need, then vertex by vertex, each
 * move fading out over TAPER mm around it. Returns the deepest violation
 * left (mm) and the whole-nucleus shift.
 */
function place(positions, within, blockers) {
  const n = positions.length / 3;
  const at = (i) => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];
  // The part that holds it keeps its full clearance: squeezing is only between neighbours.
  const needs = (clearance = CLEARANCE, inward = Math.max(clearance, CLEARANCE)) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = at(i);
      let best = null;
      const consider = (m) => m && (!best || Math.hypot(...m) > Math.hypot(...best)) && (best = m);
      if (within) consider(push(within, p, true, inward));
      for (const b of blockers) if (b.solid.nearBox(p)) consider(push(b, p, false, clearance));
      if (best) out.push([i, best]);
    }
    return out;
  };
  const shift = [0, 0, 0];
  for (let round = 0; round < 12; round++) {
    const need = needs();
    if (!need.length) break;
    const mean = [0, 1, 2].map((k) => need.reduce((s, [, m]) => s + m[k], 0) / n);
    if (Math.hypot(...mean) < 0.05) break;
    for (let i = 0; i < positions.length; i++) positions[i] += mean[i % 3];
    for (let k = 0; k < 3; k++) shift[k] += mean[k];
  }
  // Vertices bucketed by position, so a move only visits those it reaches.
  const cell = TAPER + 2;
  let grid;
  const near = (p) => {
    const c = p.map((x) => Math.floor(x / cell));
    const out = [];
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) out.push(...(grid.get(`${c[0] + x},${c[1] + y},${c[2] + z}`) ?? []));
    return out;
  };
  // The taper shrinks round by round, so where a nucleus is squeezed between
  // two parts its two sides can move apart from each other (it thins there).
  // The last rounds aim only just past each surface, so a nucleus squeezed
  // into a gap narrower than twice the clearance (the claustrum between the
  // putamen and the insula) still ends up clear of both sides.
  for (let round = 0; round < 16; round++) {
    const need = needs(round < 12 ? CLEARANCE : 0.1);
    if (!need.length) break;
    const taper = TAPER * Math.max(0, 1 - round / 8);
    grid = new Map();
    for (let i = 0; i < n; i++) {
      const k = at(i).map((x) => Math.floor(x / cell)).join();
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
    const moves = new Float64Array(positions.length);
    const size = new Float64Array(n);
    for (const [v, m] of need) {
      const p = at(v);
      const length = Math.hypot(...m);
      const reach = taper + Math.min(length, 2);
      for (const i of near(p)) {
        const d = Math.hypot(positions[3 * i] - p[0], positions[3 * i + 1] - p[1], positions[3 * i + 2] - p[2]);
        const w = i === v ? 1 : Math.max(0, 1 - d / reach);
        // The strongest move reaching a vertex wins, so moves never add up.
        if (w * length > size[i]) {
          size[i] = w * length;
          for (let k = 0; k < 3; k++) moves[3 * i + k] = m[k] * w;
        }
      }
    }
    for (let i = 0; i < positions.length; i++) positions[i] += moves[i];
  }
  const left = needs(0, 0).reduce((worst, [, m]) => Math.max(worst, Math.hypot(...m)), 0);
  return { left, shift };
}

// --- The fit -----------------------------------------------------------------

/**
 * The atlas nuclei mapped onto the shown brain. Await MeshoptSimplifier.ready first.
 * @param {string} dir directory holding annotation_full.nii.gz and voxel_count.csv
 * @param {Map<string, {positions: ArrayLike<number>, indices: ArrayLike<number>}>} shown
 *   the shown brain's parts by name (mm, any frame; "Left …" is the body's left)
 * @returns {object[]} parts `{ id, name, positions, indices, source: 'allen' }` in the frame of `shown`
 */
export function loadAllen(dir, shown, { log = () => {} } = {}) {
  const atlas = readAtlas(dir);
  const masks = brainstemAndCerebellum(atlas);
  const shared = SHARED.flatMap((s) => {
    const set = s.acronyms && atlas.labelSet(s.acronyms);
    const sides = voxels(atlas, masks[s.mask] ?? ((v) => set.has(atlas.labels[v])));
    const lists = midline(s.name) ? [[...sides[0], ...sides[1]]] : sides;
    return lists.map((list, side) => {
      const name = sided(SIDES[side], s.name);
      if (!shown.has(name) || !list.length) throw new Error(`Allen fit: no ${list.length ? 'shown part' : 'atlas voxels'} for ${name}`);
      return { ...s, name, list, target: shown.get(name) };
    });
  });

  // 1. Global affine from the shared structures' centres.
  const landmarks = shared.filter((s) => s.landmark !== false);
  const src = landmarks.map((s) => voxelCentroid(atlas, s.list));
  const dst = landmarks.map((s) => centroidOf(s.target));
  const global = fitAffine(src, dst);
  const rms = Math.sqrt(src.reduce((sum, p, i) => sum + applyAffine(global, p).reduce((s, x, k) => s + (x - dst[i][k]) ** 2, 0), 0) / src.length);

  // 2. Local refinement: each shared structure fitted onto the shown one, and
  // a smooth warp through the moves of their surfaces.
  const centres = [];
  const moves = [];
  let before = 0;
  let after = 0;
  for (const s of shared) {
    const pts = every(points(surface(atlas, s.list).positions), 300).map((p) => applyAffine(global, p));
    const env = filled(s.target);
    const A = icpAffine(pts, env);
    const gap = (ps) => ps.reduce((sum, p) => sum + env.solid.closest(p, env.outer).distance, 0) / ps.length;
    before += gap(pts) / shared.length;
    after += gap(pts.map((p) => applyAffine(A, p))) / shared.length;
    for (const p of every(pts, 40)) {
      centres.push(p);
      moves.push(applyAffine(A, p).map((x, k) => x - p[k]));
    }
  }
  const warp = thinPlate(centres, moves, 20);
  log(
    `  Allen atlas: affine from ${src.length} landmarks (${rms.toFixed(1)} mm RMS); ` +
      `${shared.length} shared surfaces ${before.toFixed(1)} → ${after.toFixed(1)} mm apart after the local fit`,
  );

  // 3. Surface, map and place each nucleus.
  const flip = determinant(global) * determinant(atlas.toMni) < 0;
  const parts = [];
  const placed = new Map(shown);
  for (const nucleus of NUCLEI) {
    const set = atlas.labelSet(nucleus.acronyms);
    voxels(atlas, (v) => set.has(atlas.labels[v])).forEach((list, side) => {
      const name = sided(SIDES[side], nucleus.name);
      const mesh = surface(atlas, list, nucleus.surface);
      const mapped = [];
      for (const p of points(mesh.positions)) mapped.push(...warp(applyAffine(global, p)));
      const { positions, indices } = simplified({ positions: mapped, indices: mesh.indices });
      // A map that mirrors (left ↔ right) turns the faces inside out.
      if (flip) for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2], indices[t + 1]];
      const { shift } = placeAmong(name, positions, nucleus.within, placed);
      log(`    ${name}: moved ${Math.hypot(...shift).toFixed(1)} mm as a whole to sit clear of its neighbours`);
      const part = { id: `allen:${nucleus.acronyms.join('+')}:${SIDES[side][0]}`, name, positions, indices, source: 'allen' };
      placed.set(name, part);
      parts.push(part);
    });
  }
  return parts;
}

/** Places a nucleus (positions changed in place) among the parts in `parts` (a Map by name); throws if it cannot. */
function placeAmong(name, positions, within, parts) {
  const box = boundsOf(positions, 5);
  const blockers = [...parts]
    .filter(([other, m]) => other !== name && other !== within && NEIGHBOURS.test(other) && overlaps(box, boundsOf(m.positions)))
    .map(([, m]) => shapeOf(m));
  const result = place(positions, within && shapeOf(parts.get(within)), blockers);
  if (result.left > 0.5) throw new Error(`Allen fit: ${name} still ${result.left.toFixed(1)} mm into a neighbour or out of its part`);
  return result;
}

/**
 * Step 4: places the nuclei again among the layer's simplified parts
 * (`{ name, positions, indices }`, mm; positions changed in place).
 * @returns {Map<string, number>} the largest move (mm) of each nucleus that moved
 */
export function placeNuclei(parts) {
  const byName = new Map(parts.map((p) => [p.name, p]));
  const moved = new Map();
  for (const nucleus of NUCLEI)
    for (const side of SIDES) {
      const part = byName.get(sided(side, nucleus.name));
      if (!part) continue;
      const before = [...part.positions];
      delete part.shape; // it is about to move
      delete part.filled;
      placeAmong(part.name, part.positions, nucleus.within, byName);
      delete part.shape;
      delete part.filled;
      let most = 0;
      for (let i = 0; i < before.length; i += 3)
        most = Math.max(most, Math.hypot(part.positions[i] - before[i], part.positions[i + 1] - before[i + 1], part.positions[i + 2] - before[i + 2]));
      if (most > 0) moved.set(part.name, most);
    }
  return moved;
}

function boundsOf(positions, pad = 0) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k] - pad);
      max[k] = Math.max(max[k], positions[i + k] + pad);
    }
  return { min, max };
}

const overlaps = (a, b) => [0, 1, 2].every((k) => a.min[k] <= b.max[k] && b.min[k] <= a.max[k]);
