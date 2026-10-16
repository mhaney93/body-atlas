// Checks every body system's built model against the skin, the skeleton and
// the other systems (layers come from src/data/, so a new one is checked
// without being listed here):
// 1. no part may lie outside the skin shell;
// 2. no part may pass through solid bone, except where it really lies in an
//    opening of that bone (passages.mjs), and then no deeper than that
//    opening runs;
// 3. parts of different systems may touch, but not run deep into each other,
//    except where one really lies inside the other (overlaps.mjs).
// What the build could not fix is listed as known (RESIDUALS in passages.mjs,
// KNOWN in overlaps.mjs), each with its reason and bounded by its depth now.
// For rules 1 and 2 every triangle edge is sampled, so a straight edge that
// cuts a corner is caught even when both of its ends are fine. Rule 3 tests
// each vertex against the closed parts of the other systems.
//
//   node scripts/check-placement.mjs [--all] [--layer <id>]
// --all also lists allowed passages, nested parts and contact under the
// tolerances; --layer checks only that layer's parts (all three rules).
import { join } from 'node:path';
import { classify, ORGAN_LIMIT, ORGAN_TOLERANCE } from './overlaps.mjs';
import { passage, residual } from './passages.mjs';
import { allowedDepth, Body, BONE_TOLERANCE, layerAssets, readModel, REFERENCE_LAYER, SKIN_ASSET, SKIN_TOLERANCE } from './placement.mjs';
import { Solid } from './solid.mjs';

const arg = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined);
const MODELS = join(import.meta.dirname, '..', 'public', 'models');

// Samples along each edge are at most this far apart (mm).
const STEP = 1.5;

/** Points along every edge of a mesh, at most STEP apart. */
function samples({ positions, indices }) {
  const seen = new Set();
  const out = [];
  const at = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  for (let t = 0; t < indices.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const [a, b] = [indices[t + e], indices[t + ((e + 1) % 3)]].sort((x, y) => x - y);
      const key = a * 4294967296 + b;
      if (seen.has(key)) continue;
      seen.add(key);
      const [p, q] = [at(a), at(b)];
      const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) / STEP));
      for (let s = 0; s < n; s++) out.push(p.map((v, k) => v + ((q[k] - v) * s) / n));
      out.push(q);
    }
  return out;
}

/** Whether a bone hit from measure() is a part in solid bone rather than in a real opening. */
export function throughBone({ layer, part, bone, depth }) {
  return depth > Math.max(allowedDepth(layer, part, bone), residual(layer, part, bone)?.depth ?? 0);
}

/**
 * Whether a mesh is closed (every edge shared by two triangles, matching
 * vertices by position), so that it has an inside other parts can be in.
 */
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
 * The parts of every layer but the reference one, for rule 3: a muscle and
 * its tendons (the `of` node extra) are one part, so together they are closed.
 */
function organUnits(layers) {
  const units = new Map();
  for (const { layer, meshes } of layers) {
    if (layer === REFERENCE_LAYER) continue;
    for (const m of meshes) {
      const name = m.extras.of ?? m.name;
      const key = `${layer}\t${name}`;
      if (!units.has(key)) units.set(key, { layer, name, meshes: [] });
      units.get(key).meshes.push(m);
    }
  }
  return [...units.values()].map((u) => {
    const positions = [];
    const indices = [];
    for (const m of u.meshes) {
      const base = positions.length / 3;
      positions.push(...m.positions);
      for (const i of m.indices) indices.push(i + base);
    }
    const unit = { layer: u.layer, name: u.name, positions, indices };
    return { ...unit, solid: closed(unit) ? new Solid(positions, indices, 4) : null };
  });
}

/**
 * Measures every layer (or `only` that one; `organs: false` skips rule 3);
 * returns { parts, skin: [...], bone: [...], organ: [...] } hit lists.
 */
export async function measure({ only, organs = true } = {}) {
  const layers = [];
  for (const { id, files } of layerAssets())
    if (organs || !only || id === only) for (const file of files) layers.push({ layer: id, meshes: await readModel(join(MODELS, file)) });
  const [skinMesh] = await readModel(join(MODELS, SKIN_ASSET));
  const reference = layerAssets().find((l) => l.id === REFERENCE_LAYER);
  const body = new Body(skinMesh, await readModel(join(MODELS, reference.files[0])));

  const skin = [];
  const bone = new Map();
  let parts = 0;
  for (const { layer, meshes } of layers) {
    if (only && layer !== only) continue;
    for (const mesh of meshes) {
      parts++;
      let worst = { distance: 0, count: 0 };
      for (const p of samples(mesh)) {
        const distance = body.outside(p);
        if (distance > 0) {
          worst.count++;
          if (distance > worst.distance) worst = { ...worst, distance, at: p };
        }
        if (layer === REFERENCE_LAYER) continue;
        for (const hit of body.bonesAt(p)) {
          const key = `${layer}\t${mesh.name}\t${hit.bone}`;
          const h = bone.get(key) ?? { layer, part: mesh.name, bone: hit.bone, depth: 0, count: 0 };
          h.count++;
          if (hit.depth > h.depth) [h.depth, h.at] = [hit.depth, p];
          bone.set(key, h);
        }
      }
      if (worst.count) skin.push({ layer, part: mesh.name, ...worst });
    }
  }

  // Rule 3: each vertex of a part against the closed parts of other layers
  // whose bounding box holds it (a coarse grid finds those).
  const units = organs ? organUnits(layers) : [];
  const GRID = 40;
  const cellOf = (p) => p.map((v) => Math.floor(v / GRID)).join(',');
  const grid = new Map();
  units.forEach((u, i) => {
    if (!u.solid) return;
    const lo = u.solid.min.map((v) => Math.floor(v / GRID));
    const hi = u.solid.max.map((v) => Math.floor(v / GRID));
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++) {
          const key = `${x},${y},${z}`;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(i);
        }
  });
  const organ = new Map();
  units.forEach((a, ai) => {
    for (let i = 0; i < a.positions.length; i += 3) {
      const p = [a.positions[i], a.positions[i + 1], a.positions[i + 2]];
      for (const bi of grid.get(cellOf(p)) ?? []) {
        const b = units[bi];
        if (b.layer === a.layer || (only && a.layer !== only && b.layer !== only)) continue;
        if (!b.solid.nearBox(p) || !b.solid.contains(p)) continue;
        const { distance } = b.solid.closest(p);
        // Keyed by the pair, so A in B and B in A make one entry.
        const [x, y] = ai < bi ? [a, b] : [b, a];
        const key = `${x.layer}\t${x.name}\t${y.layer}\t${y.name}`;
        const h = organ.get(key) ?? { a: { layer: x.layer, part: x.name }, b: { layer: y.layer, part: y.name }, depth: 0, count: 0 };
        h.count++;
        if (distance > h.depth) [h.depth, h.at, h.inside] = [distance, p, a === x ? 'a' : 'b'];
        organ.set(key, h);
      }
    }
  });

  return {
    parts,
    skin: skin.sort((a, b) => b.distance - a.distance),
    bone: [...bone.values()].sort((a, b) => b.depth - a.depth),
    organ: [...organ.values()].map((h) => ({ ...h, verdict: classify(h) })).sort((a, b) => b.depth - a.depth),
  };
}

const fmt = (p) => p.map((v) => v.toFixed(0)).join(', ');

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const all = process.argv.includes('--all');
  const { parts, skin, bone, organ } = await measure({ only: arg('--layer') });
  console.log(`Checked ${parts} parts.`);

  const skinBad = skin.filter((h) => h.distance > SKIN_TOLERANCE);
  console.log(`\n1. Outside the skin (> ${SKIN_TOLERANCE} mm): ${skinBad.length}`);
  for (const h of all ? skin : skinBad)
    console.log(`  ${h.distance.toFixed(1).padStart(5)} mm  ${h.layer}: ${h.part}  (${h.count} samples, worst at ${fmt(h.at)})`);

  const boneBad = bone.filter(throughBone);
  console.log(`\n2. Through solid bone (> ${BONE_TOLERANCE} mm deep, or deeper than an allowed opening runs): ${boneBad.length}`);
  const boneLine = (h) => {
    const allowed = passage(h.layer, h.part, h.bone);
    return (
      `  ${h.depth.toFixed(1).padStart(5)} mm  ${h.layer}: ${h.part} in ${h.bone}  (${h.count} samples, deepest at ${fmt(h.at)})` +
      (allowed ? `  [${h.depth > allowed.depth ? 'deeper than' : 'allowed'}: ${allowed.opening}, ${allowed.depth} mm]` : '')
    );
  };
  for (const h of all ? bone : boneBad) console.log(boneLine(h));
  const boneKnown = bone.filter((h) => !throughBone(h) && h.depth > allowedDepth(h.layer, h.part, h.bone));
  console.log(`\n   Known residuals (RESIDUALS in passages.mjs, not failures): ${boneKnown.length}`);
  for (const h of boneKnown) console.log(`${boneLine(h)}  [known: ${residual(h.layer, h.part, h.bone).why}, ${residual(h.layer, h.part, h.bone).depth} mm]`);

  const organBad = organ.filter((h) => h.verdict.fail);
  const organKnown = organ.filter((h) => !h.verdict.fail && h.verdict.known);
  const contact = organ.filter((h) => !h.verdict.fail && !h.verdict.nested && !h.verdict.known && h.depth > ORGAN_TOLERANCE);
  console.log(`\n3. Into another system's part (> ${ORGAN_LIMIT} mm, or deeper than a nested part runs): ${organBad.length}`);
  const line = (h) =>
    `  ${h.depth.toFixed(1).padStart(5)} mm  ${h.a.layer}: ${h.a.part} / ${h.b.layer}: ${h.b.part}  (${h.count} vertices, deepest at ${fmt(h.at)})` +
    (h.verdict.nested ? `  [${h.verdict.fail ? 'deeper than' : 'nested'}: ${h.verdict.nested.why}, ${h.verdict.nested.depth} mm]` : '');
  for (const h of organBad) console.log(line(h));
  console.log(`\n   Known clipping (KNOWN in overlaps.mjs, not failures): ${organKnown.length}`);
  for (const h of organKnown) console.log(`${line(h)}  [known: ${h.verdict.known.why}, ${h.verdict.known.depth} mm]`);
  console.log(`\n   Contact between ${ORGAN_TOLERANCE} and ${ORGAN_LIMIT} mm (not failures): ${contact.length}`);
  for (const h of contact) console.log(line(h));
  if (all) {
    console.log('\n   Nested parts and contact under the tolerance:');
    for (const h of organ.filter((h) => !h.verdict.fail && (h.verdict.nested || h.depth <= ORGAN_TOLERANCE))) console.log(line(h));
  }

  if (skinBad.length || boneBad.length || organBad.length) {
    console.error('\nFAIL: placement check');
    process.exitCode = 1;
  } else console.log('\nOK: placement check');
}
