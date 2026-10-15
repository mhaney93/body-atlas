// Body systems shown in the filter panel. Each layer is pure data: adding a
// system means adding a JSON file shaped like data/skeletal.json (and its
// GLB, built by scripts/build-models.mjs) and listing it here.
import skeletal from './data/skeletal.json';
import nervous from './data/nervous.json';
import circulatory from './data/circulatory.json';
import joints from './data/joints.json';
import digestive from './data/digestive.json';

export const SHELL_ASSET = 'models/skin.glb';

export const LAYERS = [skeletal, nervous, circulatory, joints, digestive];

/** Canonical form of a mesh name used to match part info, e.g. "Navicular bone of left foot" → "navicular bone of foot". */
function canonical(meshName) {
  return meshName
    .toLowerCase()
    .replace(/^(left|right) /, '')
    .replace(/ of (left|right) /, ' of ');
}

/** The part entry for a mesh name, if the layer has one. */
function partEntry(layer, meshName) {
  return layer.parts[meshName.toLowerCase()] ?? layer.parts[canonical(meshName)];
}

/** The sub-group id a layer's part entry names (`"group": "<id>"`), if any. */
export function partGroupId(layer, meshName) {
  return partEntry(layer, meshName)?.group;
}

/**
 * The entry of `layer.shared` that claims a mesh of the layer `sourceId`, if
 * any. `shared` lets a layer also show parts that live in another layer's
 * model (e.g. the intervertebral discs, which are in the skeletal model)
 * without shipping the mesh twice: `{ layer: "<id>", match: "<regex on the
 * canonical name>", group? }`.
 */
export function sharedEntry(layer, sourceId, meshName) {
  const name = canonical(meshName);
  return layer.shared?.find((s) => s.layer === sourceId && new RegExp(s.match).test(name));
}

/**
 * Returns { name, region?, description?, color?, group?, flow? } for a mesh in the
 * given layer. Parts whose left and right sides differ (e.g. the heart's
 * chambers) are keyed by their full lowercase name, which wins over the
 * side-less one. `group` is the layer's sub-group (see `groups` in the layer
 * data) that the model assigns the mesh to, else the one its part entry names.
 * A part shared from another layer (`source`, see sharedEntry) falls back to
 * that layer's part info.
 */
export function partInfo(layer, meshName, groupId, source) {
  const part = partEntry(layer, meshName) ?? (source && partEntry(source, meshName));
  const group = layer.groups?.[groupId ?? part?.group];
  return {
    name: meshName,
    region: part?.region,
    description: part?.description,
    color: part?.color,
    group,
    flow: part?.flow ?? group?.flow,
  };
}
