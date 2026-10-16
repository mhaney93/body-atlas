// Checks the built Lymphatic model against the skin and the skeleton, the way
// check-nerves.mjs checks the nerves: no lymph node, tonsil or lymphoid organ
// may lie outside the skin shell or inside solid bone. Lymph nodes sit in fat
// and along vessels, never inside bone, so there are no allowed passages.
//
//   node scripts/check-lymphatic.mjs [--all]
// --all also lists contact under the tolerances.
import { load, samples } from './check-nerves.mjs';
import { Envelope, Solid } from './solid.mjs';

// mm a part may stick out of the skin, or sink into bone, before it counts:
// grazing contact that is not visible.
export const SKIN_TOLERANCE = 0.3;
export const BONE_TOLERANCE = 1;

const fmt = (p) => p.map((v) => v.toFixed(0)).join(', ');

/** Measures every lymphatic part; returns { parts, skin: [...], bone: [...] } sorted worst first. */
export async function measure() {
  const [skinMesh] = await load('skin.glb');
  const skin = new Envelope(skinMesh.positions, skinMesh.indices, 10, 2.5);
  const bones = (await load('skeletal.glb')).map((b) => ({ name: b.name, solid: new Solid(b.positions, b.indices, 4) }));
  const parts = await load('lymphatic.glb');
  const skinHits = [];
  const boneHits = [];
  for (const part of parts) {
    let out = { distance: 0, count: 0 };
    const inBone = new Map();
    for (const p of samples(part)) {
      const distance = skin.outside(p);
      if (distance > 0) {
        out.count++;
        if (distance > out.distance) out = { ...out, distance, at: p };
      }
      for (const bone of bones) {
        if (!bone.solid.nearBox(p) || !bone.solid.contains(p)) continue;
        const { distance } = bone.solid.closest(p);
        const hit = inBone.get(bone.name) ?? { part: part.name, bone: bone.name, depth: 0, count: 0 };
        hit.count++;
        if (distance > hit.depth) [hit.depth, hit.at] = [distance, p];
        inBone.set(bone.name, hit);
      }
    }
    if (out.count) skinHits.push({ part: part.name, ...out });
    boneHits.push(...inBone.values());
  }
  return {
    parts: parts.length,
    skin: skinHits.sort((a, b) => b.distance - a.distance),
    bone: boneHits.sort((a, b) => b.depth - a.depth),
  };
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const all = process.argv.includes('--all');
  const { parts, skin, bone } = await measure();
  const skinBad = skin.filter((h) => h.distance > SKIN_TOLERANCE);
  const boneBad = bone.filter((h) => h.depth > BONE_TOLERANCE);
  console.log(`Checked ${parts} lymphatic parts.`);
  console.log(`\nOutside the skin (> ${SKIN_TOLERANCE} mm): ${skinBad.length}`);
  for (const h of all ? skin : skinBad)
    console.log(`  ${h.distance.toFixed(1).padStart(5)} mm  ${h.part}  (${h.count} samples, worst at ${fmt(h.at)})`);
  console.log(`\nInside solid bone (> ${BONE_TOLERANCE} mm deep): ${boneBad.length}`);
  for (const h of all ? bone : boneBad)
    console.log(`  ${h.depth.toFixed(1).padStart(5)} mm  ${h.part} in ${h.bone}  (${h.count} samples, deepest at ${fmt(h.at)})`);
  if (skinBad.length || boneBad.length) {
    console.error('\nFAIL: lymphatic placement check');
    process.exitCode = 1;
  } else console.log('\nOK: lymphatic placement check');
}
