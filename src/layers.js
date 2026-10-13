// Body systems shown in the filter panel. Each layer is pure data: adding a
// system means adding a JSON file shaped like data/skeletal.json (and its
// GLB, built by scripts/build-models.mjs) and listing it here.
import skeletal from './data/skeletal.json';
import nervous from './data/nervous.json';

export const SHELL_ASSET = 'models/skin.glb';

export const LAYERS = [skeletal, nervous];

/** Canonical form of a mesh name used to match part info, e.g. "Navicular bone of left foot" → "navicular bone of foot". */
function canonical(meshName) {
  return meshName
    .toLowerCase()
    .replace(/^(left|right) /, '')
    .replace(/ of (left|right) /, ' of ');
}

/** Returns { name, region?, description?, color? } for a mesh in the given layer. */
export function partInfo(layer, meshName) {
  const part = layer.parts[canonical(meshName)];
  return { name: meshName, region: part?.region, description: part?.description, color: part?.color };
}
