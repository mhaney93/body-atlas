// Shared by the model build (settle.mjs) and the placement check
// (check-placement.mjs): where every body system's parts may lie relative to
// the skin, the bones and each other, and how to read the built models.
//
// The skin (skin.glb) and the Skeletal layer are the reference everything
// else is placed against: BodyParts3D scanned them from one body, and the
// other layers were either scanned with them (and then simplified) or fitted
// onto them from Z-Anatomy.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { passage } from './passages.mjs';
import { Envelope, Solid } from './solid.mjs';

const ROOT = join(import.meta.dirname, '..');

export const SKIN_ASSET = 'skin.glb';
export const REFERENCE_LAYER = 'skeletal';

// mm a part may stick out of the skin, or sink into solid bone away from a
// real opening (passages.mjs), before it counts: grazing contact, which does
// not show.
export const SKIN_TOLERANCE = 0.3;
export const BONE_TOLERANCE = 1.5;
// Layers held closer: lymph nodes sit in fat and along vessels, never on bone.
const LAYER_BONE_TOLERANCE = { lymphatic: 1 };

/**
 * Every body-system layer in src/data/ with the GLB files it shows (its
 * `asset` and `extraAssets`), so a new layer is placed and checked without
 * being listed anywhere else.
 */
export function layerAssets(dataDir = join(ROOT, 'src', 'data')) {
  return readdirSync(dataDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dataDir, f), 'utf8')))
    .filter((layer) => layer.asset)
    .map((layer) => ({ id: layer.id, files: [layer.asset, ...(layer.extraAssets ?? [])].map((a) => a.replace(/^models\//, '')) }));
}

/** The id of the layer that shows `file`, if any. */
export function layerOf(file, layers = layerAssets()) {
  return layers.find((l) => l.files.includes(file))?.id;
}

const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

/** The meshes of a built GLB as { name, extras, positions (world mm), indices }. */
export async function readModel(path) {
  const doc = await io.read(path);
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
        for (let k = 0; k < 3; k++) positions[i * 3 + k] = 1000 * (m[k] * v[0] + m[4 + k] * v[1] + m[8 + k] * v[2] + m[12 + k]);
      }
      const extras = node.getExtras();
      return { name: extras.name ?? node.getName(), extras, positions, indices: prim.getIndices().getArray() };
    });
}

/**
 * The skin and bones that every other part is placed against. Positions are
 * in mm, in whatever frame the given meshes share.
 */
export class Body {
  /**
   * @param {{positions: ArrayLike<number>, indices: ArrayLike<number>}} skin
   * @param {{name: string, positions: ArrayLike<number>, indices: ArrayLike<number>}[]} bones
   */
  constructor(skin, bones) {
    this.skin = new Envelope(skin.positions, skin.indices, 10, 2.5);
    this.bones = bones.map((b) => ({ name: b.name, solid: new Solid(b.positions, b.indices, 4) }));
  }

  /** How far `p` lies outside the skin (0 if within it). */
  outside(p) {
    return this.skin.outside(p);
  }

  /** Every bone `p` lies inside, with its depth there and the nearest point on its surface. */
  bonesAt(p) {
    const out = [];
    for (const bone of this.bones) {
      if (!bone.solid.nearBox(p) || !bone.solid.contains(p)) continue;
      const { distance, point } = bone.solid.closest(p);
      out.push({ bone: bone.name, depth: distance, point });
    }
    return out;
  }
}

/** The most mm `part` of `layer` may lie inside `bone`: its real opening's depth, or grazing contact. */
export function allowedDepth(layer, part, bone) {
  return passage(layer, part, bone)?.depth ?? boneTolerance(layer);
}

/** The most mm a part of `layer` may graze a bone it has no opening into. */
export function boneTolerance(layer) {
  return LAYER_BONE_TOLERANCE[layer] ?? BONE_TOLERANCE;
}
