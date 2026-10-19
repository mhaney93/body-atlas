// Body systems shown in the filter panel. Each layer is pure data: adding a
// system means adding a JSON file shaped like data/skeletal.json (and its
// GLB, built by scripts/build-models.mjs) and listing it here.
import skeletal from './data/skeletal.json';
import nervous from './data/nervous.json';
import circulatory from './data/circulatory.json';
import joints from './data/joints.json';
import digestive from './data/digestive.json';
import muscular from './data/muscular.json';
import respiratory from './data/respiratory.json';
import lymphatic from './data/lymphatic.json';
import reproductive from './data/reproductive.json';
import urinary from './data/urinary.json';
import endocrine from './data/endocrine.json';
import senses from './data/senses.json';

export const SHELL_ASSET = 'models/skin.glb';

export const LAYERS = [skeletal, nervous, circulatory, joints, digestive, muscular, respiratory, lymphatic, reproductive, urinary, endocrine, senses];

/** Canonical form of a mesh name used to match part info, e.g. "Navicular bone of left foot" → "navicular bone of foot". */
export function canonical(meshName) {
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
 * The label on parts whose part entry sets `approximate: true`: parts placed
 * from a population-average atlas rather than modelled on this body, so their
 * position is good only to a few millimetres.
 */
export const APPROXIMATE_LABEL = 'Position approximate (population-average atlas)';

/**
 * Returns { name, region?, description?, color?, group?, flow?, depth?, of?, approximate? } for a
 * mesh in the given layer. Parts whose left and right sides differ (e.g. the
 * heart's chambers) are keyed by their full lowercase name, which wins over the
 * side-less one. `group` is the layer's sub-group (see `groups` in the layer
 * data) that the model assigns the mesh to, else the one its part entry names;
 * its `description` stands in for a part without one. `of` names the part a
 * mesh belongs to (e.g. a muscle's tendon, via the `of` node extra), whose
 * region, flow and depth it shares unless it has its own.
 */
export function partInfo(layer, meshName, groupId, of) {
  const part = partEntry(layer, meshName);
  const owner = of ? partEntry(layer, of) : undefined;
  const group = layer.groups?.[groupId ?? part?.group];
  return {
    name: meshName,
    region: part?.region ?? owner?.region,
    description: part?.description ?? group?.description,
    color: part?.color,
    group,
    flow: part?.flow ?? owner?.flow ?? group?.flow,
    depth: part?.depth ?? owner?.depth,
    of,
    approximate: part?.approximate === true,
  };
}

/**
 * Why a part is missing from a layer, for its `notShown` list (README "Adding
 * a body system"). Every layer lists what it leaves out, so the site hides
 * nothing silently; a layer that leaves nothing out says so in `nothingLeftOut`.
 */
export const NOT_SHOWN_REASONS = {
  'not-added': 'In a free model, not added yet',
  'no-model': 'Not in the free models we use',
  'too-small': 'Too small or too many to model',
  'other-system': 'Belongs to another system',
  license: 'License does not allow it here',
  'not-in-adult': 'Not in an adult body',
};
