// Places where a nerve really passes through or runs inside a bone, as
// [nerve, bone, opening, depth]. BodyParts3D's simplified bones close most
// foramina and canals, so these nerves show inside the bone there, and that
// is right. `depth` bounds the region: the most mm under the shown bone's
// surface that the opening runs, so a nerve cutting deeper through the solid
// bone is still wrong. nervous-model.mjs leaves these pairs where they are and
// pushes every other nerve out of solid bone; check-nerves.mjs allows only
// these pairs inside, and only that deep.
export const PASSAGES = [
  [/^(spinal cord|cauda equina)$/i, /vertebra$|^sacrum$/i, 'vertebral canal and sacral canal', 15],
  // Only the roots pass the sacral foramina. The plexus branches (sciatic,
  // pudendal, gluteal and the rest) leave the pelvis through the greater
  // sciatic foramen, which is not an opening in bone.
  [/(anterior|posterior) root of|spinal ganglia/i, /^sacrum$|^coccyx$/i, 'sacral foramina and sacral canal', 5],
  [/(anterior|posterior) root of spinal nerve|spinal ganglia/i, /vertebra$/i, 'intervertebral foramina', 5],
  [/inferior alveolar|mental nerve/i, /^mandible$/i, 'mandibular canal and mental foramen', 8],
  [/facial nerve|vestibul|cochlear|chorda tympani|petrosal|tympanic|glossopharyngeal|vagus|accessory|abducens/i, /temporal bone$/i, 'internal acoustic meatus, facial canal, petrotympanic fissure, jugular foramen and Dorello\'s canal', 8],
  [/hypoglossal|vagus|accessory|glossopharyngeal/i, /^occipital bone$/i, 'hypoglossal canal and jugular foramen', 6],
  [/optic nerve|oculomotor|trochlear|abducens|ophthalmic|maxillary nerve|mandibular nerve|trigeminal|nasociliary|frontal nerve|lacrimal|meningeal|pterygo|palatine|nasal|petrosal/i, /^sphenoid bone$/i, 'optic canal, superior orbital fissure, foramen rotundum, ovale and spinosum, and pterygoid canal', 5],
  [/olfactory|ethmoidal|nasociliary|nasal/i, /^ethmoid bone$/i, 'cribriform plate and ethmoidal foramina', 3],
  [/ophthalmic|frontal nerve|supra-?orbital|supratrochlear/i, /^frontal bone$/i, 'supraorbital foramen and notch', 3],
  [/maxillary nerve|infra-?orbital|zygomatic|superior alveolar|palatine|nasal/i, /maxilla$|palatine bone$|zygomatic bone$/i, 'infraorbital canal, superior alveolar canals, palatine canals and zygomatic foramina', 5],
  [/obturator/i, /hip bone$/i, 'obturator canal', 5],
  [/suprascapular/i, /scapula$/i, 'suprascapular and spinoglenoid notches', 4],
];

/** The real opening `nerve` passes through in `bone`, as { opening, depth }, if there is one. */
export function passage(nerve, bone) {
  const found = PASSAGES.find(([n, b]) => n.test(nerve) && b.test(bone));
  return found && { opening: found[2], depth: found[3] };
}
