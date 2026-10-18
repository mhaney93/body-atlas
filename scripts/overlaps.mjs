// Where parts of different body systems may run into each other.
//
// Soft parts touch, and their simplified meshes overlap a little where they
// do. Some parts really lie inside a part of another system (the bronchi and
// pulmonary vessels branch inside the lungs, the hepatic vessels run inside
// the liver): those pairs are NESTED, each named and bounded by how deep the
// inner part runs. Every other overlap deeper than ORGAN_LIMIT is clipping:
// the build moves one part out of the other (YIELDS, applied by settle.mjs
// and nervous-model.mjs) and check-placement.mjs fails on any that is left,
// apart from the KNOWN ones it lists with their reasons. Overlaps between
// ORGAN_TOLERANCE and ORGAN_LIMIT are listed by the check as contact.
// Overlaps within one system (a vessel branching off another, a tooth in its
// gum) are that system's own modelling and are not checked.

// mm of overlap that is contact rather than clipping, and the most an
// overlap may run before the check fails.
export const ORGAN_TOLERANCE = 3;
export const ORGAN_LIMIT = 6;

/** [layer, part, layer, part, why, depth]: the first part lies inside the second, up to `depth` mm. */
export const NESTED = [
  ['circulatory', /segmental|lingular|lobar|pulmonary|bronchial|basal|subsuperior/i, 'respiratory', /lobe of (left|right) lung$/i, 'pulmonary and bronchial vessels branch inside the lung', 40],
  ['circulatory', /hepatic|portal|vena cava/i, 'digestive', /^liver$/i, 'the hepatic artery, portal vein and hepatic veins branch inside the liver, and the vena cava runs in its groove', 35],
  ['muscular', /glossus|genio/i, 'digestive', /^tongue$/i, 'the extrinsic tongue muscles run into the tongue', 20],
  ['muscular', /orbicularis oris|buccinator|mentalis|depressor (labii|anguli)|levator (labii|anguli)|zygomaticus|risorius/i, 'digestive', /^lips$|gum$/i, 'the muscles of the mouth insert into the lips and lie on the gums', 15],
  ['muscular', /pharyngeal constrictor|palatopharyngeus|stylopharyngeus|salpingopharyngeus/i, 'digestive', /^pharynx$/i, 'the pharynx is its constrictor muscles', 30],
  ['muscular', /pharyngeal constrictor|palatopharyngeus|stylopharyngeus|salpingopharyngeus|cricothyroid|arytenoid|vocalis/i, 'respiratory', /pharynx$|cartilage$|conus elasticus/i, 'the pharyngeal and laryngeal muscles wrap the airway and attach to its cartilages', 6],
  ['muscular', /^diaphragm$/i, 'respiratory', /^diaphragm$/i, 'the same muscle shown in both layers', 30],
  ['nervous', /lingual|hypoglossal|glossopharyngeal/i, 'digestive', /^tongue$/i, 'the nerves of the tongue run into it', 12],
  ['nervous', /inferior alveolar|mental nerve|superior alveolar/i, 'digestive', /gum$|incisor|canine|premolar|molar/i, 'the alveolar nerves run beneath the gums into the teeth', 8],
  ['circulatory', /./, 'nervous', /lobe|insula|cerebellum|brainstem|optic chiasm|optic tract/i, 'the cerebral vessels run in the sulci on the brain surface', 6],
  ['circulatory', /gastric|gastro-?epiploic|gastro-?omental/i, 'digestive', /^stomach$/i, 'the gastric vessels run along the curvatures of the stomach, in its wall', 10],
  ['circulatory', /bronchial artery/i, 'respiratory', /trachea|bronch/i, 'the bronchial arteries run along the airways', 8],
  ['nervous', /suprascapular/i, 'muscular', /supraspinatus|infraspinatus/i, 'the suprascapular nerve runs beneath and into supraspinatus and infraspinatus', 10],
  ['nervous', /sciatic|posterior femoral cutaneous|gluteal|pudendal/i, 'joints', /piriformis fascia/i, 'these nerves leave the pelvis just beneath piriformis, through its fascia', 8],
  ['joints', /fascia|septum|aponeurosis|retinaculum|tract/i, 'muscular', /./, 'fascia wraps and divides the muscles', 10],
  ['circulatory', /splenic (artery|vein)/i, 'lymphatic', /^spleen$/i, 'the splenic vessels branch into the spleen at its hilum', 15],
  ['urinary', /^urethra$/i, 'reproductive', /^prostate$|corpus spongiosum|^glans penis$/i, 'the urethra runs through the prostate and down the corpus spongiosum to the glans', 12],
  ['circulatory', /renal|segmental artery/i, 'urinary', /kidney$|ureter$/i, 'the renal vessels branch into the kidney at its hilum, beside the start of the ureter', 20],
  ['circulatory', /suprarenal (artery|vein)/i, 'endocrine', /adrenal gland$/i, 'the suprarenal arteries and veins run into the adrenal glands', 8],
];

/**
 * [layer, part, layer, part, why, depth]: overlaps deeper than ORGAN_LIMIT
 * that are clipping, but that the build does not fix (yet), each bounded by
 * how deep it runs now so it cannot grow. Most are BodyParts3D organs that
 * already overlap in the source data, or organs pressed into a Z-Anatomy
 * fascia sheet, which is open and so cannot be yielded to.
 */
export const KNOWN = [
  ['digestive', /colon|ileum|jejunum|stomach|liver/i, 'joints', /transversalis fascia|diaphragmatic fascia/i, 'the organs bulge through the fitted sheet of fascia that lines the abdomen', 14],
  ['circulatory', /epigastric/i, 'digestive', /transverse colon/i, 'BodyParts3D\'s transverse colon reaches into the abdominal wall where these vessels run', 13],
  ['digestive', /ileum|stomach/i, 'muscular', /transversus abdominis|rectus abdominis/i, 'left after moving the gut out of the abdominal wall, where it is pressed between wall and other organs', 8],
  ['circulatory', /left hepatic vein|left gastric vein/i, 'digestive', /^stomach$|^liver$/i, 'BodyParts3D\'s stomach and liver overlap each other in the source data', 14],
  ['circulatory', /splenic artery|inferior mesenteric vein|testicular vein/i, 'digestive', /stomach|pancreas|duodenum/i, 'vessels running behind the stomach, pancreas and duodenum, which overlap them in BodyParts3D', 7.5],
  ['circulatory', /inferior gluteal vein/i, 'digestive', /^rectum$/i, 'BodyParts3D\'s rectum overlaps the pelvic veins beside it', 10],
  ['circulatory', /aorta/i, 'respiratory', /lobe of left lung$/i, 'the aorta lies in a groove of the left lung, which the fitted lung does not have', 9],
  ['circulatory', /aorta/i, 'digestive', /^esophagus$/i, 'the aorta and esophagus run side by side and overlap in BodyParts3D', 7],
  ['circulatory', /femoral vein/i, 'muscular', /adductor longus/i, 'the femoral vessels lie on adductor longus and overlap it in BodyParts3D', 9],
  ['circulatory', /brachiocephalic vein/i, 'muscular', /sternothyroid/i, 'the vein lies just behind the muscle and overlaps it in BodyParts3D', 6.5],
  // Moving the kidney out of psoas crumples its simplified mesh at the hilum.
  ['urinary', /kidney$/i, 'muscular', /psoas major/i, 'BodyParts3D\'s kidneys overlap psoas major, on which they lie, in the source data', 10.5],
  ['urinary', /kidney$/i, 'joints', /iliopsoas fascia/i, 'the kidneys pressed into the fitted sheet of fascia over psoas', 11.5],
  ['endocrine', /^left adrenal gland$/i, 'urinary', /^left kidney$/i, 'Z-Anatomy\'s fitted left kidney reaches into BodyParts3D\'s left adrenal gland, which sits on its upper pole', 8],
  // lymphatic-model.mjs moves the lymph nodes out of bone and skin only; the
  // build does not yet move them out of the organs and vessels they drain.
  // Lymph node clusters are drawn 6 mm across.
  ['lymphatic', /gastro-omental nodes|gastric nodes|subpyloric nodes|splenic nodes/i, 'digestive', /^liver$|^stomach$/i, 'the gastric node chains along the stomach\'s curvatures, pressed into the stomach and liver', 13],
  ['lymphatic', /superior mesenteric nodes|juxta-intestinal mesenteric nodes|middle colic nodes/i, 'digestive', /transverse colon|^jejunum$|^duodenum$/i, 'the mesenteric nodes, pressed into the gut they drain', 12],
  ['lymphatic', /precaval nodes|lateral caval nodes|pre-aortic nodes|lateral aortic nodes|pancreatic nodes/i, 'digestive', /^pancreas$/i, 'the nodes around the aorta and vena cava, pressed into the pancreas in front of them', 9],
  ['lymphatic', /pararectal nodes|postvesical nodes/i, 'digestive', /^rectum$/i, 'the nodes beside the rectum, pressed into it', 7.5],
  ['lymphatic', /lateral aortic nodes|ileocolic nodes/i, 'circulatory', /inferior vena cava/i, 'nodes pressed into the vena cava they lie on', 8.5],
];

/**
 * [layer, part, layer, part, why]: the build moves the first part's vertices
 * out of the second part. Only parts built before it can be yielded to (see
 * ASSETS in build-models.mjs); nerves yield in nervous-model.mjs.
 */
export const YIELDS = [
  // The digestive organs lie inside the abdominal wall, and the lungs above
  // the diaphragm and inside the chest wall; BodyParts3D's organs and the
  // fitted Z-Anatomy muscles overlap by up to 15 mm.
  ['digestive', /colon|cecum|appendix|ileum|jejunum|duodenum|stomach|rectum/i, 'muscular', /iliacus|psoas|quadratus lumborum|transversus abdominis|oblique|rectus abdominis|pyramidalis|diaphragm/i, 'the abdominal organs lie inside the abdominal wall'],
  ['respiratory', /lobe of (left|right) lung$/i, 'muscular', /diaphragm|transversus (abdominis|thoracis)|intercostal|subcostal/i, 'the lungs lie above the diaphragm and inside the chest wall'],
  // Nerves run beside the gut and the great vessels, not through them.
  ['nervous', /nerve|trunk|plexus|ganglia|ganglion/i, 'digestive', /colon|cecum|appendix|ileum|jejunum|duodenum|stomach|esophagus|rectum|liver/i, 'nerves run beside the gut, not through it'],
  ['nervous', /nerve|trunk|plexus|ganglia|ganglion/i, 'urinary', /kidney$|ureter$|bladder$|^urethra$/i, 'nerves run behind and beside the kidneys, ureters and bladder, not through them'],
  ['nervous', /nerve|trunk|plexus|ganglia|ganglion/i, 'circulatory', /aorta|vena cava|pulmonary trunk|^(left|right) pulmonary artery$/i, 'nerves run beside the great vessels, not through them'],
  // BodyParts3D's spleen reaches into its left adrenal gland by up to 11 mm.
  ['endocrine', /^left adrenal gland$/i, 'lymphatic', /^spleen$/i, 'the left adrenal gland lies in front of the kidney, beside the spleen, not in it'],
];

const matches = ([la, pa, lb, pb], a, b) => la === a.layer && pa.test(a.part) && lb === b.layer && pb.test(b.part);

/** The NESTED entry that allows `a` and `b` (either way round) to overlap, if any. */
export function nested(a, b) {
  const found = NESTED.find((rule) => matches(rule, a, b) || matches(rule, b, a));
  return found && { why: found[4], depth: found[5] };
}

/** The KNOWN entry for `a` and `b` (either way round), if any. */
export function known(a, b) {
  const found = KNOWN.find((rule) => matches(rule, a, b) || matches(rule, b, a));
  return found && { why: found[4], depth: found[5] };
}

/** How check-placement.mjs counts an overlap { a, b, depth }: { nested?, known?, fail }. */
export function classify({ a, b, depth }) {
  const allowed = nested(a, b);
  if (allowed) return { nested: allowed, fail: depth > allowed.depth };
  const left = depth > ORGAN_LIMIT ? known(a, b) : undefined;
  return { known: left, fail: depth > (left?.depth ?? ORGAN_LIMIT) };
}

/** The parts { layer, name } in `others` that `part` of `layer` must be moved out of. */
export function yieldsTo(layer, part, others) {
  return others.filter((o) => YIELDS.some((rule) => matches(rule, { layer, part }, { layer: o.layer, part: o.name })));
}
