// Body systems shown in the filter panel. Each layer is pure data: adding a
// system means adding a JSON file shaped like data/skeletal.json (and its
// GLB, built by scripts/build-models.mjs) and listing it here.
import skeletal from './data/skeletal.json';
import nervous from './data/nervous.json';
import circulatory from './data/circulatory.json';

export const SHELL_ASSET = 'models/skin.glb';

export const LAYERS = [skeletal, nervous, circulatory];

/** Canonical form of a mesh name used to match part info, e.g. "Navicular bone of left foot" → "navicular bone of foot". */
function canonical(meshName) {
  return meshName
    .toLowerCase()
    .replace(/^(left|right) /, '')
    .replace(/ of (left|right) /, ' of ');
}

/**
 * Returns { name, region?, description?, color?, group?, flow? } for a mesh in the
 * given layer. Parts whose left and right sides differ (e.g. the heart's
 * chambers) are keyed by their full lowercase name, which wins over the
 * side-less one. `group` is the layer's sub-group (see `groups` in the layer
 * data) that the model assigns the mesh to.
 */
export function partInfo(layer, meshName, groupId) {
  const part = layer.parts[meshName.toLowerCase()] ?? layer.parts[canonical(meshName)];
  const group = layer.groups?.[groupId];
  return {
    name: meshName,
    region: part?.region,
    description: part?.description,
    color: part?.color,
    group,
    flow: part?.flow ?? group?.flow,
  };
}
