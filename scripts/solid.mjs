// Point queries against a closed triangle mesh: is a point inside it, and how
// far is it from the surface. Used to keep every layer inside the skin, out
// of solid bone and out of the parts it yields to (nervous-model.mjs,
// settle.mjs) and to check the built models for it (check-placement.mjs).
// Units are whatever the mesh uses.

/** Closest point to `p` on triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p, t, o) {
  const ax = t[o], ay = t[o + 1], az = t[o + 2];
  const abx = t[o + 3] - ax, aby = t[o + 4] - ay, abz = t[o + 5] - az;
  const acx = t[o + 6] - ax, acy = t[o + 7] - ay, acz = t[o + 8] - az;
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return [ax, ay, az];
  const bpx = p[0] - t[o + 3], bpy = p[1] - t[o + 4], bpz = p[2] - t[o + 5];
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return [t[o + 3], t[o + 4], t[o + 5]];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [ax + abx * v, ay + aby * v, az + abz * v];
  }
  const cpx = p[0] - t[o + 6], cpy = p[1] - t[o + 7], cpz = p[2] - t[o + 8];
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return [t[o + 6], t[o + 7], t[o + 8]];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [ax + acx * w, ay + acy * w, az + acz * w];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const bx = t[o + 3], by = t[o + 4], bz = t[o + 5];
    return [bx + (t[o + 6] - bx) * w, by + (t[o + 7] - by) * w, bz + (t[o + 8] - bz) * w];
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return [ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w];
}

const AXES = [0, 1, 2];

export class Solid {
  /**
   * @param {ArrayLike<number>} positions xyz triplets
   * @param {ArrayLike<number>} indices triangle vertex indices
   * @param {number} cell grid cell size (mesh units)
   */
  constructor(positions, indices, cell) {
    const n = indices.length / 3;
    this.tris = new Float64Array(n * 9);
    for (let i = 0; i < indices.length; i++)
      for (let k = 0; k < 3; k++) this.tris[i * 3 + k] = positions[indices[i] * 3 + k];
    this.cell = cell;
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.tris.length; i += 3)
      for (let k = 0; k < 3; k++) {
        this.min[k] = Math.min(this.min[k], this.tris[i + k]);
        this.max[k] = Math.max(this.max[k], this.tris[i + k]);
      }
    // Per axis: triangles bucketed by their projection on the other two axes.
    this.columns = AXES.map((a) => this.#bucket(n, [(a + 1) % 3, (a + 2) % 3]));
    this.cells = this.#bucket(n, [0, 1, 2]);
  }

  #bucket(n, axes) {
    const map = new Map();
    for (let t = 0; t < n; t++) {
      const lo = axes.map((k) => Math.floor(Math.min(...[0, 1, 2].map((v) => this.tris[t * 9 + v * 3 + k])) / this.cell));
      const hi = axes.map((k) => Math.floor(Math.max(...[0, 1, 2].map((v) => this.tris[t * 9 + v * 3 + k])) / this.cell));
      const walk = (d, key) => {
        if (d === axes.length) {
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(t);
          return;
        }
        for (let c = lo[d]; c <= hi[d]; c++) walk(d + 1, d ? `${key},${c}` : `${c}`);
      };
      walk(0, '');
    }
    return map;
  }

  /** Whether `p` lies within the bounding box grown by `pad`. */
  nearBox(p, pad = 0) {
    return p.every((v, k) => v >= this.min[k] - pad && v <= this.max[k] + pad);
  }

  /** Surface crossings of the line through `p` along axis `a`, [ahead, behind], within `reach`. */
  #crossings(p, a, reach = Infinity) {
    const [u, v] = [(a + 1) % 3, (a + 2) % 3];
    // Nudge the ray off exact vertex/edge alignments.
    const pu = p[u] + this.cell * 1.3e-7;
    const pv = p[v] + this.cell * 2.9e-7;
    const list = this.columns[a].get(`${Math.floor(pu / this.cell)},${Math.floor(pv / this.cell)}`);
    if (!list) return [0, 0];
    const t = this.tris;
    let ahead = 0;
    let behind = 0;
    for (const i of list) {
      const o = i * 9;
      const x0 = t[o + u] - pu, y0 = t[o + v] - pv;
      const x1 = t[o + 3 + u] - pu, y1 = t[o + 3 + v] - pv;
      const x2 = t[o + 6 + u] - pu, y2 = t[o + 6 + v] - pv;
      const w0 = x1 * y2 - x2 * y1;
      const w1 = x2 * y0 - x0 * y2;
      const w2 = x0 * y1 - x1 * y0;
      if (!((w0 > 0 && w1 > 0 && w2 > 0) || (w0 < 0 && w1 < 0 && w2 < 0))) continue;
      const s = w0 + w1 + w2;
      const hit = (w0 * t[o + a] + w1 * t[o + 3 + a] + w2 * t[o + 6 + a]) / s;
      if (Math.abs(hit - p[a]) > reach) continue;
      if (hit > p[a]) ahead++;
      else behind++;
    }
    return [ahead, behind];
  }

  /** Inside test by ray parity, majority of three axis-aligned rays. */
  contains(p) {
    if (!this.nearBox(p)) return false;
    let votes = 0;
    for (const a of AXES) votes += this.#crossings(p, a)[0] & 1;
    return votes >= 2;
  }

  /** Whether rays from `p` along +x, -x, +y, -y, +z and -z hit the surface within `reach`. */
  rayHits(p, reach = Infinity) {
    return AXES.flatMap((a) => this.#crossings(p, a, reach).map((n) => n > 0));
  }

  /**
   * Closest point on the surface to `p`, its distance, and the triangle it
   * lies on (only triangles flagged in `filter`, if given). Gives up with a
   * null point once nothing lies within `limit`.
   */
  closest(p, filter, limit = Infinity) {
    const c = p.map((x) => Math.floor(x / this.cell));
    let best = null;
    let bestD = Infinity;
    let tri = -1;
    const seen = new Set();
    for (let r = 0; r < 4096; r++) {
      for (let x = c[0] - r; x <= c[0] + r; x++)
        for (let y = c[1] - r; y <= c[1] + r; y++)
          for (let z = c[2] - r; z <= c[2] + r; z++) {
            if (Math.max(Math.abs(x - c[0]), Math.abs(y - c[1]), Math.abs(z - c[2])) !== r) continue;
            for (const t of this.cells.get(`${x},${y},${z}`) ?? []) {
              if (seen.has(t) || (filter && !filter[t])) continue;
              seen.add(t);
              const q = closestOnTriangle(p, this.tris, t * 9);
              const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
              if (d < bestD) [best, bestD, tri] = [q, d, t];
            }
          }
      // Every triangle within r cells is seen, so a hit that close is final.
      if (best && bestD <= r * this.cell) break;
      if (r * this.cell >= limit) break;
    }
    if (bestD > limit) return { point: null, distance: Infinity, triangle: -1 };
    return { point: best, distance: bestD, triangle: tri };
  }
}

/**
 * The body envelope bounded by BodyParts3D's skin. The skin is a layer about
 * 2 mm thick whose outer surface turns inward at the body openings (mouth,
 * nostrils, ...) and becomes its inner surface, so neither ray parity nor a
 * plain flood fill can tell the body's inside from the outside. Instead the
 * surface is voxelised and thickened by `close` voxels, which seals those
 * openings, the outside is flood-filled from the grid's border, and each
 * triangle is labelled outer if the outside lies just off its front face.
 */
export class Envelope {
  constructor(positions, indices, cell, voxel, close = 2) {
    this.solid = new Solid(positions, indices, cell);
    this.voxel = voxel;
    const { tris, min, max } = this.solid;
    const pad = close + 3;
    this.origin = min.map((v) => v - pad * voxel);
    this.dims = max.map((v, k) => Math.ceil((v + pad * voxel - this.origin[k]) / voxel));
    const [nx, ny, nz] = this.dims;
    // 0 = not reached, 1 = surface (thickened), 2 = outside.
    let grid = new Uint8Array(nx * ny * nz);
    const n = tris.length / 9;
    const p = [0, 0, 0];
    for (let o = 0; o < tris.length; o += 9) {
      const e1 = [tris[o + 3] - tris[o], tris[o + 4] - tris[o + 1], tris[o + 5] - tris[o + 2]];
      const e2 = [tris[o + 6] - tris[o], tris[o + 7] - tris[o + 1], tris[o + 8] - tris[o + 2]];
      const steps = Math.ceil(Math.max(Math.hypot(...e1), Math.hypot(...e2)) / (voxel / 3)) + 1;
      for (let i = 0; i <= steps; i++)
        for (let j = 0; i + j <= steps; j++) {
          for (let k = 0; k < 3; k++) p[k] = tris[o + k] + (e1[k] * i + e2[k] * j) / steps;
          grid[this.#index(p)] = 1;
        }
    }
    // Thicken: a separable box dilation along each axis.
    const stride = [1, nx, nx * ny];
    for (let axis = 0; axis < 3; axis++) {
      const next = grid.slice();
      const s = stride[axis];
      const len = this.dims[axis];
      for (let v = 0; v < grid.length; v++) {
        if (!grid[v]) continue;
        const c = Math.floor(v / s) % len;
        for (let d = -close; d <= close; d++) if (c + d >= 0 && c + d < len) next[v + d * s] = 1;
      }
      grid = next;
    }
    const queue = new Int32Array(grid.length);
    let head = 0;
    let tail = 0;
    grid[0] = 2;
    queue[tail++] = 0;
    while (head < tail) {
      const v = queue[head++];
      const x = v % nx;
      const y = ((v - x) / nx) % ny;
      const z = (v - x - y * nx) / (nx * ny);
      if (x > 0 && !grid[v - 1]) (grid[v - 1] = 2), (queue[tail++] = v - 1);
      if (x < nx - 1 && !grid[v + 1]) (grid[v + 1] = 2), (queue[tail++] = v + 1);
      if (y > 0 && !grid[v - nx]) (grid[v - nx] = 2), (queue[tail++] = v - nx);
      if (y < ny - 1 && !grid[v + nx]) (grid[v + nx] = 2), (queue[tail++] = v + nx);
      if (z > 0 && !grid[v - nx * ny]) (grid[v - nx * ny] = 2), (queue[tail++] = v - nx * ny);
      if (z < nz - 1 && !grid[v + nx * ny]) (grid[v + nx * ny] = 2), (queue[tail++] = v + nx * ny);
    }
    this.grid = grid;
    this.outer = new Uint8Array(n);
    for (let t = 0; t < n; t++) {
      const o = t * 9;
      const c = [0, 1, 2].map((k) => (tris[o + k] + tris[o + 3 + k] + tris[o + 6 + k]) / 3);
      const e1 = [0, 1, 2].map((k) => tris[o + 3 + k] - tris[o + k]);
      const e2 = [0, 1, 2].map((k) => tris[o + 6 + k] - tris[o + k]);
      const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const len = Math.hypot(...nrm) || 1;
      for (let s = close + 1; s <= close + 3; s++)
        if (grid[this.#index(c.map((v, k) => v + (nrm[k] / len) * s * voxel))] === 2) this.outer[t] = 1;
    }
  }

  #index(p) {
    const [x, y, z] = p.map((v, k) => Math.min(this.dims[k] - 1, Math.max(0, Math.floor((v - this.origin[k]) / this.voxel))));
    return x + this.dims[0] * (y + this.dims[1] * z);
  }

  /** How far `p` lies outside the outer skin surface (0 if it is within it). */
  outside(p) {
    const cell = this.solid.nearBox(p) ? this.grid[this.#index(p)] : 2;
    if (cell === 0) return 0;
    const near = this.solid.closest(p);
    if (cell === 2) return near.distance;
    // Off the surface, the nearest triangle is on the side p is on: from the
    // body's inside every path out crosses the inner surface first.
    return !this.solid.contains(p) && this.outer[near.triangle] ? near.distance : 0;
  }

  /** Whether `p` lies within the outer surface: outside(p) === 0, without measuring how far out it is. */
  encloses(p) {
    if (!this.solid.nearBox(p)) return false;
    const cell = this.grid[this.#index(p)];
    return cell === 1 ? this.outside(p) === 0 : cell === 0;
  }

  /**
   * Depth of `p` beneath the outer skin surface (negative outside) and the
   * nearest point on it, or null if `p` lies deeper than `limit`.
   */
  depth(p, limit = Infinity) {
    const out = this.outside(p);
    if (out > 0) return { depth: -out, point: this.solid.closest(p).point };
    const near = this.solid.closest(p, this.outer, limit);
    return near.point && { depth: near.distance, point: near.point };
  }
}
