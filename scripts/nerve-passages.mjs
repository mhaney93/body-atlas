// Places where a nerve really passes through or runs inside a bone, as
// [nerve, bone, opening]. BodyParts3D's simplified bones close most foramina
// and canals, so these nerves show inside the bone there, and that is right.
// nervous-model.mjs leaves these pairs where they are and pushes every other
// nerve out of solid bone; check-nerves.mjs allows only these pairs inside.
export const PASSAGES = [
  [/^(spinal cord|cauda equina)$/i, /vertebra$|^sacrum$/i, 'vertebral canal and sacral canal'],
  // The sacral plexus branches start as roots leaving the sacral foramina.
  [/(anterior|posterior) root of spinal nerve|spinal ganglia|sacral|coccygeal|pudendal|posterior femoral cutaneous|gluteal|piriformis|quadratus femoris|sciatic/i, /^sacrum$|^coccyx$/i, 'sacral foramina and sacral canal'],
  [/(anterior|posterior) root of spinal nerve|spinal ganglia/i, /vertebra$/i, 'intervertebral foramina'],
  [/inferior alveolar|mental nerve/i, /^mandible$/i, 'mandibular canal and mental foramen'],
  [/facial nerve|vestibul|cochlear|chorda tympani|petrosal|tympanic|glossopharyngeal|vagus|accessory|abducens/i, /temporal bone$/i, 'internal acoustic meatus, facial canal, petrotympanic fissure, jugular foramen and Dorello\'s canal'],
  [/hypoglossal|vagus|accessory|glossopharyngeal/i, /^occipital bone$/i, 'hypoglossal canal and jugular foramen'],
  [/optic nerve|oculomotor|trochlear|abducens|ophthalmic|maxillary nerve|mandibular nerve|trigeminal|nasociliary|frontal nerve|lacrimal|meningeal|pterygo|palatine|nasal|petrosal/i, /^sphenoid bone$/i, 'optic canal, superior orbital fissure, foramen rotundum, ovale and spinosum, and pterygoid canal'],
  [/olfactory|ethmoidal|nasociliary|nasal/i, /^ethmoid bone$/i, 'cribriform plate and ethmoidal foramina'],
  [/ophthalmic|frontal nerve|supra-?orbital|supratrochlear/i, /^frontal bone$/i, 'supraorbital foramen and notch'],
  [/maxillary nerve|infra-?orbital|zygomatic|alveolar|palatine|nasal/i, /maxilla$|palatine bone$|zygomatic bone$/i, 'infraorbital canal, alveolar canals, palatine canals and zygomatic foramina'],
  [/obturator/i, /hip bone$/i, 'obturator canal'],
  [/suprascapular/i, /scapula$/i, 'suprascapular and spinoglenoid notches'],
];

/** The opening `nerve` passes through in `bone`, if it is a real passage. */
export const passage = (nerve, bone) => PASSAGES.find(([n, b]) => n.test(nerve) && b.test(bone))?.[2];
