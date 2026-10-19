// Places where a part of a body system really lies inside a bone, as
// [layer, part, bone, opening, depth] (part and bone match mesh names).
// BodyParts3D's simplified bones are solid: they close most foramina, canals
// and air sinuses, so a nerve in a canal, a tooth in its socket or a sinus in
// its bone shows inside the bone there, and that is right. `depth` bounds the
// region: the most mm under the shown bone's surface that the opening runs,
// so a part cutting deeper through the solid bone is still wrong.
// nervous-model.mjs and settle.mjs leave these pairs no deeper than that and
// push every other part out of solid bone; check-placement.mjs allows only
// these pairs inside, and only that deep. The Skeletal layer is the bones
// themselves (its discs, costal cartilages and ossicles meet or sit in bone
// by design), so it has no entries.
export const PASSAGES = [
  ['nervous', /^(spinal cord|cauda equina)$/i, /vertebra$|^sacrum$/i, 'vertebral canal and sacral canal', 15],
  // Only the roots pass the sacral foramina. The plexus branches (sciatic,
  // pudendal, gluteal and the rest) leave the pelvis through the greater
  // sciatic foramen, which is not an opening in bone.
  ['nervous', /(anterior|posterior) root of|spinal ganglia/i, /^sacrum$|^coccyx$/i, 'sacral foramina and sacral canal', 5],
  ['nervous', /(anterior|posterior) root of spinal nerve|spinal ganglia/i, /vertebra$/i, 'intervertebral foramina', 5],
  ['nervous', /inferior alveolar|mental nerve/i, /^mandible$/i, 'mandibular canal and mental foramen', 8],
  ['nervous', /facial nerve|vestibul|cochlear|chorda tympani|petrosal|tympanic|glossopharyngeal|vagus|accessory|abducens/i, /temporal bone$/i, 'internal acoustic meatus, facial canal, petrotympanic fissure, jugular foramen and Dorello\'s canal', 8],
  ['nervous', /hypoglossal|vagus|accessory|glossopharyngeal/i, /^occipital bone$/i, 'hypoglossal canal and jugular foramen', 6],
  ['nervous', /optic nerve|oculomotor|trochlear|abducens|ophthalmic|maxillary nerve|mandibular nerve|trigeminal|nasociliary|frontal nerve|lacrimal|meningeal|pterygo|palatine|nasal|petrosal/i, /^sphenoid bone$/i, 'optic canal, superior orbital fissure, foramen rotundum, ovale and spinosum, and pterygoid canal', 5],
  ['nervous', /olfactory|ethmoidal|nasociliary|nasal/i, /^ethmoid bone$/i, 'cribriform plate and ethmoidal foramina', 3],
  ['nervous', /ophthalmic|frontal nerve|supra-?orbital|supratrochlear/i, /^frontal bone$/i, 'supraorbital foramen and notch', 3],
  ['nervous', /maxillary nerve|infra-?orbital|zygomatic|superior alveolar|palatine|nasal/i, /maxilla$|palatine bone$|zygomatic bone$/i, 'infraorbital canal, superior alveolar canals, palatine canals and zygomatic foramina', 5],
  ['nervous', /obturator/i, /hip bone$/i, 'obturator canal', 5],
  ['nervous', /suprascapular/i, /scapula$/i, 'suprascapular and spinoglenoid notches', 4],
  // Muscles, tendons, ligaments, capsules and fasciae attach to bone. Where
  // they meet it the simplified meshes overlap a little, which does not show.
  ['muscular', /./, /./, 'attachment at the bone surface', 3],
  ['joints', /./, /./, 'attachment at the bone surface', 3],
  ['digestive', /pharynx/i, /./, 'attachment at the bone surface', 3],
  ['reproductive', /^corpora cavernosa/i, /hip bone$/i, 'the crura of the penis attach along the ischiopubic rami', 3],
  ['senses', /check ligament|trochlea of/i, /./, 'attachment at the bone surface', 3],
  // BodyParts3D's ear sinks 3.7 mm into the temporal bone at its root.
  ['senses', /auricle$/i, /temporal bone$/i, 'the auricular ligaments and cartilage of the outer ear attach on the temporal bone around the ear canal', 4],
  // The inner ear is hollowed out of the temporal bone, and the middle ear and
  // the start of the auditory tube are air spaces in it.
  ['senses', /cochlea|vestibule|tympanic membrane|auditory tube/i, /temporal bone$/i, 'bony labyrinth, middle ear and bony part of the auditory tube', 9],
  ['digestive', /incisor|canine|premolar|molar/i, /^mandible$|maxilla$/i, 'dental alveoli (tooth sockets)', 9],
  ['digestive', /gum$/i, /^mandible$|maxilla$|palatine bone$|^vomer$/i, 'gums over the alveolar processes', 3],
  // The paranasal sinuses are air spaces hollowed out of these bones, and
  // the conchae and septum jut into the nasal cavity's air space.
  ['respiratory', /^frontal sinus$/i, /^frontal bone$/i, 'frontal sinus', 7],
  ['respiratory', /^sphenoidal sinus$/i, /^sphenoid bone$/i, 'sphenoidal sinus', 7],
  ['respiratory', /ethmoidal cells$/i, /^ethmoid bone$/i, 'ethmoidal labyrinth', 7],
  ['respiratory', /^(nasal cavity|nasopharynx)$/i, /^ethmoid bone$|^sphenoid bone$|maxilla$|palatine bone$|nasal bone$|^vomer$|inferior nasal concha$/i, 'nasal conchae, septum and walls of the nasal cavity', 5],
];

/**
 * [layer, part, bone, why, depth]: parts left deeper in bone than PASSAGES
 * allows, which the build's settle step (settle.mjs) could not lift further,
 * each bounded by how deep it runs now so it cannot grow. Only
 * check-placement.mjs reads this list; the build still aims for PASSAGES.
 * Coarse muscle and ligament meshes bridge the grooves between their
 * attachment points, and parts squeezed between a bone and the skin (or
 * between two bones) have no room to move out. Every entry names its parts
 * and bones, so a part not listed here gets only its PASSAGES allowance.
 */
export const RESIDUALS = [
  // Muscles attaching where the bone is grooved or the space is tight.
  ['muscular', /rotator|interspinales|longissimus thoracis|spinalis thoracis|semispinalis|splenius capitis|serratus posterior superior|rhomboid minor|trapezius|levatores costarum/i, /vertebra$|^axis$/i, 'the deep back muscles packed onto the spinous and transverse processes', 5],
  ['muscular', /psoas major|^diaphragm$/i, /vertebra$|^intervertebral disk/i, 'psoas and the diaphragm\'s crura on the sides of the lumbar spine', 4.5],
  ['muscular', /intercostal|subscapularis|transversus (abdominis|thoracis)|pectoralis major|rectus abdominis|external oblique|levatores costarum|iliocostalis thoracis|longissimus thoracis|serratus posterior inferior|scalenus posterior|^diaphragm$/i, /rib$|costal cartilage$/i, 'the chest and abdominal wall muscles attaching along the ribs and costal cartilages', 5],
  ['muscular', /sternocleidomastoid|pectoralis major/i, /^manubrium$/i, 'attaching on the manubrium, between the bone and the skin', 4.5],
  ['muscular', /trapezius/i, /scapula$|clavicle$/i, 'trapezius inserting along the spine of the scapula and the clavicle, between the bone and the skin', 5.5],
  ['muscular', /deltoid|teres (major|minor)|pectoralis major|iliocostalis lumborum/i, /scapula$|clavicle$/i, 'attaching on the scapula and clavicle', 4],
  ['muscular', /depressor (anguli oris|labii inferioris)|mentalis|orbicularis oris|masseter/i, /^mandible$/i, 'the muscles of the mouth and masseter on the mandible, between the bone and the skin', 5.5],
  ['muscular', /lateral pterygoid|temporalis/i, /temporal bone$|^frontal bone$/i, 'attaching in the infratemporal and temporal fossae', 3.5],
  ['muscular', /quadratus lumborum|sartorius|rectus femoris/i, /hip bone$/i, 'attaching at the iliac crest and the anterior iliac spines', 5],
  ['muscular', /gluteus maximus/i, /^sacrum$/i, 'attaching on the back of the sacrum, between the bone and the skin', 4],
  ['muscular', /extensor hallucis brevis|biceps femoris|fibularis longus/i, /calcaneus$|fibula$/i, 'attaching on the calcaneus and the head of the fibula', 3.5],
  // Ligaments, capsules and fasciae in the narrow gaps between bones.
  ['joints', /interspinous|supraspinous|intertransverse/i, /vertebra$|^axis$/i, 'ligaments filling the narrow gaps between the spinous and transverse processes', 5.5],
  ['joints', /sacrococcygeal symphysis/i, /^sacrum$/i, 'the joint between the sacrum and coccyx', 5],
  ['joints', /iliopsoas fascia/i, /femur$|^sacrum$/i, 'the fitted sheet of fascia over iliopsoas', 4.5],
  ['joints', /fascia lata/i, /^coccyx$/i, 'the fascia lata attaching at the coccyx', 4],
  ['joints', /radiocarpal joint|ulnocapitate/i, /ulna$|radius$|capitate$/i, 'the wrist capsule and ligaments wrapped tightly around the joint', 5],
  ['joints', /sternoclavicular|coraco-acromial|head of rib/i, /clavicle$|scapula$|rib$/i, 'small joint discs and ligaments wrapped tightly around their joints', 4],
  ['respiratory', /lobe of (left|right) lung$/i, /rib$|vertebra$|^intervertebral disk/i, 'pressed against the ribs and spine', 3.5],
  ['muscular', /adductor magnus/i, /femur$/i, 'BodyParts3D\'s adductor magnus sinks 14.5 mm into the femur at the adductor tubercle in the source data', 14],
  ['muscular', /gluteus (medius|minimus)|transversus abdominis|external oblique/i, /hip bone$/i, 'broad muscles attaching along the iliac crest, between the bone and the skin', 7.5],
  ['muscular', /triceps brachii/i, /ulna$/i, 'the triceps tendon inserting on the olecranon', 7],
  ['muscular', /longissimus capitis/i, /temporal bone$/i, 'inserting on the mastoid process', 6.5],
  ['joints', /iliopsoas fascia/i, /hip bone$/i, 'the fitted sheet of fascia lining the iliac fossa', 11],
  ['digestive', /gum$/i, /^mandible$|maxilla$/i, 'gums wrapped tightly around the alveolar processes', 6],
  ['digestive', /parotid gland/i, /^mandible$|temporal bone$/i, 'the parotid gland wraps the ramus of the mandible', 4],
  ['reproductive', /^corpora cavernosa/i, /hip bone$/i, 'the crura of the penis wrapped along the ischiopubic rami, where BodyParts3D sinks them 4.8 mm into the bone in the source data', 5],
  ['digestive', /colon|cecum|esophagus/i, /hip bone$|^intervertebral disk/i, 'pressed against the pelvis and spine', 2.5],
  ['circulatory', /basilic vein/i, /humerus$/i, 'BodyParts3D\'s basilic vein dips into the humerus above the elbow in the source data', 5.5],
  ['circulatory', /subclavian|axillary|suprascapular/i, /clavicle$/i, 'squeezed between the clavicle and the first rib', 4.5],
  ['circulatory', /iliac|lumbar|renal|gluteal|azygos|hemiazygos|vena cava|intercostal/i, /vertebra$|^intervertebral disk|^sacrum$|rib$|costal cartilage$/i, 'vessels lying on the vertebral bodies, sacrum and ribs', 4.5],
  ['circulatory', /sulcus|temporal branch|anterior temporal artery/i, /parietal bone$|temporal bone$/i, 'cerebral arteries on the brain surface, pressed against the inside of the skull', 2.5],
  ['circulatory', /ophthalmic artery/i, /^frontal bone$|^sphenoid bone$/i, 'running from the optic canal along the roof of the orbit', 2.5],
  ['circulatory', /suprascapular|dorsal scapular/i, /scapula$/i, 'lying on the scapula under its muscles', 2],
];

/**
 * [layer, part, why, depth]: parts whose own surface is the skin's, so they
 * may lie up to `depth` mm outside the skin shell, which was simplified from
 * the same surface separately. Every other part keeps SKIN_TOLERANCE.
 */
export const ON_SKIN = [
  ['senses', /auricle$/i, 'the outer ear is skin over cartilage, and the shell\'s ears are the same BodyParts3D mesh simplified on its own', 1],
];

/**
 * [layer, part, why, depth]: what the build could not move back under the
 * skin, bounded by how far it sticks out now. The build does not read it.
 */
export const SKIN_RESIDUALS = [
  // Edges and a vertex across the sharp fold where the shell's outer ear
  // meets the head, between vertices that are under the skin.
  ['muscular', /temporoparietalis$/i, 'running over the temple into the fold where the outer ear joins the scalp', 1],
  ['lymphatic', /pre-auricular nodes$/i, 'in front of the ear, in the fold where the outer ear joins the head', 1],
];

/** The SKIN_RESIDUALS entry for `part` of `layer`, as { why, depth }, if there is one. */
export function skinResidual(layer, part) {
  const found = SKIN_RESIDUALS.find(([l, p]) => l === layer && p.test(part));
  return found && { why: found[2], depth: found[3] };
}

/** The ON_SKIN entry for `part` of `layer`, as { why, depth }, if there is one. */
export function onSkin(layer, part) {
  const found = ON_SKIN.find(([l, p]) => l === layer && p.test(part));
  return found && { why: found[2], depth: found[3] };
}

/** The deepest RESIDUALS entry for `part` of `layer` in `bone`, as { why, depth }, if there is one. */
export function residual(layer, part, bone) {
  const found = RESIDUALS.filter(([l, p, b]) => l === layer && p.test(part) && b.test(bone)).sort((x, y) => y[4] - x[4])[0];
  return found && { why: found[3], depth: found[4] };
}

/** The real opening `part` of `layer` passes through in `bone`, as { opening, depth }, if there is one. */
export function passage(layer, part, bone) {
  const found = PASSAGES.find(([l, p, b]) => l === layer && p.test(part) && b.test(bone));
  return found && { opening: found[3], depth: found[4] };
}
