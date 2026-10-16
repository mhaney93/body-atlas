// Checks the built Nervous models against the skin and the skeleton:
// - no nerve geometry may lie outside the skin shell;
// - no nerve may pass through solid bone, except where a real nerve passes
//   through an opening in that bone (nerve-passages.mjs), and then no deeper
//   than that opening runs.
// Every nerve triangle edge is sampled, so a straight tube segment that cuts
// a corner is caught even when both of its ends are fine.
//
//   node scripts/check-nerves.mjs [--all] [--models <dir>]
// --all also lists allowed passages and contact under the tolerances;
// --models checks GLB files in another directory (default public/models).
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { join } from 'node:path';
import { passage } from './nerve-passages.mjs';
import { Envelope, Solid } from './solid.mjs';

const arg = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const MODELS = process.argv.includes('--models') ? arg('--models') : join(import.meta.dirname, '..', 'public', 'models');

// mm a nerve may stick out of the skin, or sink into solid bone, before it
// counts: about one tube radius of grazing contact, which is not visible.
const SKIN_TOLERANCE = 0.3;
const BONE_TOLERANCE = 1.5;
// Samples along each nerve edge are at most this far apart (mm).
const STEP = 1.5;

export async function load(file) {
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(join(MODELS, file));
  return doc
    .getRoot()
    .listNodes()
    .filter((node) => node.getMesh())
    .map((node) => {
      const m = node.getWorldMatrix();
      const prim = node.getMesh().listPrimitives()[0];
      const attr = prim.getAttribute('POSITION');
      const positions = new Float64Array(attr.getCount() * 3);
      const v = [];
      for (let i = 0; i < attr.getCount(); i++) {
        attr.getElement(i, v);
        // World position in mm.
        for (let k = 0; k < 3; k++) positions[i * 3 + k] = 1000 * (m[k] * v[0] + m[4 + k] * v[1] + m[8 + k] * v[2] + m[12 + k]);
      }
      return { name: node.getExtras().name ?? node.getName(), positions, indices: prim.getIndices().getArray() };
    });
}

/** Points along every edge of a mesh, at most STEP apart. */
export function samples({ positions, indices }) {
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

/** Whether a bone hit from measure() is a nerve in solid bone rather than in a real opening. */
export function throughBone({ nerve, bone, depth }) {
  return depth > (passage(nerve, bone)?.depth ?? BONE_TOLERANCE);
}

const fmt = (p) => p.map((v) => v.toFixed(0)).join(', ');

/** Measures every nerve; returns { skin: [...], bone: [...] } offender lists. */
export async function measure() {
  const [skinMesh] = await load('skin.glb');
  const skin = new Envelope(skinMesh.positions, skinMesh.indices, 10, 2.5);
  const bones = (await load('skeletal.glb')).map((b) => ({ name: b.name, solid: new Solid(b.positions, b.indices, 4) }));
  const nerves = [...(await load('nervous.glb')), ...(await load('nervous-inner-ear.glb'))];

  const skinHits = [];
  const boneHits = new Map();
  for (const nerve of nerves) {
    let worst = { distance: 0, count: 0 };
    for (const p of samples(nerve)) {
      const distance = skin.outside(p);
      if (distance > 0) {
        worst.count++;
        if (distance > worst.distance) worst = { ...worst, distance, at: p };
      }
      for (const bone of bones) {
        if (!bone.solid.nearBox(p) || !bone.solid.contains(p)) continue;
        const { distance } = bone.solid.closest(p);
        const key = `${nerve.name}\t${bone.name}`;
        const hit = boneHits.get(key) ?? { nerve: nerve.name, bone: bone.name, depth: 0, count: 0 };
        hit.count++;
        if (distance > hit.depth) [hit.depth, hit.at] = [distance, p];
        boneHits.set(key, hit);
      }
    }
    if (worst.count) skinHits.push({ nerve: nerve.name, ...worst });
  }
  return {
    nerves: nerves.length,
    skin: skinHits.sort((a, b) => b.distance - a.distance),
    bone: [...boneHits.values()].sort((a, b) => b.depth - a.depth),
  };
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const all = process.argv.includes('--all');
  const { nerves, skin, bone } = await measure();
  const skinBad = skin.filter((h) => h.distance > SKIN_TOLERANCE);
  console.log(`Checked ${nerves} nerve parts.`);
  console.log(`\nOutside the skin (> ${SKIN_TOLERANCE} mm): ${skinBad.length}`);
  for (const h of all ? skin : skinBad)
    console.log(`  ${h.distance.toFixed(1).padStart(5)} mm  ${h.nerve}  (${h.count} samples, worst at ${fmt(h.at)})`);

  const boneBad = bone.filter(throughBone);
  console.log(`\nThrough solid bone (> ${BONE_TOLERANCE} mm deep, or deeper than an allowed passage runs): ${boneBad.length}`);
  for (const h of all ? bone : boneBad) {
    const allowed = passage(h.nerve, h.bone);
    console.log(
      `  ${h.depth.toFixed(1).padStart(5)} mm  ${h.nerve} in ${h.bone}  (${h.count} samples, deepest at ${fmt(h.at)})` +
        (allowed ? `  [${throughBone(h) ? 'deeper than' : 'allowed'}: ${allowed.opening}, ${allowed.depth} mm]` : ''),
    );
  }
  if (skinBad.length || boneBad.length) {
    console.error('\nFAIL: nerve placement check');
    process.exitCode = 1;
  } else console.log('\nOK: nerve placement check');
}
