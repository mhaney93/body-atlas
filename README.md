# Body Atlas

Free interactive 3D atlas of the human body with per-system highlighting.

**Live site:** https://body-atlas-hd.vercel.app

The page shows a see-through glass model of an adult male body that you can rotate, zoom and pan with a mouse or with touch. Turning on a body system in the filter panel lights up its parts in color. Clicking or tapping a part shows its name and a short description. Zoom in very close and parts near the camera are cut away, so you can see into bone to buried parts; parts smaller than about 1.5 cm stay whole.

It ships the **Skeletal**, **Nervous**, **Circulatory**, **Joints & connective tissue**, **Digestive**, **Muscular** and **Respiratory** systems. Every bone, brain region, named nerve, artery, vein, ligament, joint capsule, cartilage pad, fascia, digestive organ, skeletal muscle and airway part in the model is a separate, clickable part with its own name and description. A system's model downloads when its filter is first switched on, except Skeletal, which loads in the background at startup.

It is a static site with no backend, so it costs nothing to host. Vercel builds every push: pull requests get preview deployments, and `main` deploys to production at https://body-atlas-hd.vercel.app.

## Development

```sh
npm install
npm run dev       # local dev server
npm run build     # production build into dist/
npm run preview   # serve dist/ locally
```

## Project layout

| Path | What it is |
| --- | --- |
| `src/viewer.js` | three.js scene: glass shell, layer loading, hover/selection, orbit controls |
| `src/layers.js` | List of body-system layers and part-info lookup |
| `src/data/skeletal.json` | Skeletal layer: name, highlight color, asset, summary, and a description for every part |
| `src/data/nervous.json` | Nervous layer, including per-part colors for the brain regions and its decorative effect |
| `src/effects.js` | Decorative effects a layer can offer, such as the skin haze (not anatomy) |
| `src/data/circulatory.json` | Circulatory layer: as above, plus artery/vein/heart sub-groups, blood-flow direction, and the capillary-glow effect |
| `src/data/joints.json` | Joints & connective tissue layer: as above, plus sub-groups you can show or hide and parts shared with the Skeletal layer |
| `src/data/digestive.json` | Digestive layer: as above, plus its two decorative hazes and the "Follow the food" tour |
| `src/tour.js` | A layer's guided tour: a glowing pulse that travels its parts in order, with a caption per stage |
| `src/data/muscular.json` | Muscular layer: every muscle's description, action and depth, the tendon sub-group, the exercise presets for the movement view, and the fiber-haze effect |
| `src/data/respiratory.json` | Respiratory layer: airway, bronchial tree, lung lobe and diaphragm descriptions in five sub-groups, and the air-sac haze |
| `src/layer-controls.js` | Optional per-layer controls built from layer data: the peel-away depth slider and the movement picker |
| `src/main.js`, `index.html`, `src/style.css` | UI: filter panel, info panel, loading indicator, credit |
| `public/models/*.glb` | Generated, compressed models (committed) |
| `scripts/fetch-bodyparts3d.mjs` | Downloads and checksums the BodyParts3D source meshes into `.cache/` |
| `scripts/build-models.mjs` | Converts the OBJ meshes to meshopt-compressed GLB files |
| `scripts/extract-z-anatomy.py`, `data-sources/z-anatomy/` | Blender script and its output: parts BodyParts3D lacks (the coccyx, the auditory ossicles in `ossicles/`, the nervous system in `nervous/`, most ligaments, joint capsules, menisci and fasciae in `connective-tissue.obj.gz`, and the lung lobes, nasal cavity, sinuses and pharynx in `respiratory.obj.gz`), taken from Z-Anatomy |
| `scripts/muscular-model.mjs` | Builds the muscles: BodyParts3D's plus the ones it lacks from Z-Anatomy (fitted onto the BodyParts3D skeleton), with each muscle's tendons split off as parts of their own |
| `scripts/export-z-anatomy.py`, `data-sources/z-anatomy/muscular/` | Blender script that exports chosen Z-Anatomy objects as OBJ files, and the muscles it exported (listed in `objects.txt`) |
| `scripts/nervous-model.mjs` | Fits the Z-Anatomy nervous system onto the BodyParts3D skeleton, keeps nerves under the skin and out of solid bone, and turns nerve curves into tubes |
| `scripts/check-nerves.mjs`, `scripts/nerve-passages.mjs` | Checks the built nerves against the skin and bones; the list of real foramina and canals a nerve may pass through |

### Adding a body system

Each system is a data-driven layer, so adding another system (Muscular, say) does not touch the viewer:

1. In `scripts/build-models.mjs`, add an entry to `ASSETS` that lists its BodyParts3D element files (or a `load` function for parts from another source, as the Nervous entry does). Then rebuild the models (see below).
2. Add `src/data/<system>.json` with the same shape as `skeletal.json`: `id`, `name`, `color`, `asset`, `summary`, plus `parts` keyed by the part's name with any "left"/"right" removed.
3. Import it and append it to `LAYERS` in `src/layers.js`.

A layer can also list more GLB files in `extraAssets`. They load together with `asset` and act as one layer. Skeletal and Nervous use this to keep the ossicles and the inner-ear nerves, which have a different license, in files of their own.

A part that has no entry in `parts` still shows its name when clicked. A part entry can also set its own `color` (the Nervous layer colors each brain region this way).

A layer can list decorative `effects` (see `nervous.json` and `src/effects.js`). Each one appears as a checkbox under the layer's toggle with its `label` and a `note`, which must say it is an illustrative effect and not modeled anatomy.

Optional layer fields, all generic (see `circulatory.json` for an example):

- `groups`: sub-groups with their own `label`, `color`, optional `opacity`, and optional `flow` text. The build tags each mesh with a group (`groups` in its `ASSETS` entry, stored as the `group` node extra), and the filter panel shows them as a colour key.
- `preload: true`: download the model in the background at startup so the first toggle is instant. Leave it off for heavy models so phones only fetch them on demand.
- `flowLabel`, plus `flow` on a group or a part: an extra line in the info panel (e.g. "Blood flow: Away from the heart").
- `effects`: optional toggles shown under the layer's button. `type: "haze"` lays a decorative glow over the skin (and over any layer with `hazeSurface: true`). `type: "part-haze"` scatters glowing specks over the layer's own parts named in `parts` (mesh names), in a `style` from `src/effects.js` (`villi`, `bacteria`, or `alveoli`, which fills the inside of closed parts instead of their surface). The UI badges every effect as "Illustrative", so describe it in `note` as a visual effect, never as modeled anatomy.
- `tour`: a "play" button under the layer's toggle that sends a glowing pulse through the layer's parts in order. It has a `label`, a `note`, a `total` shown at the end, and `stages`, each with a `name`, the `parts` (mesh names) it passes through, a `time` caption and how many `seconds` the animation spends there. The pulse follows a part's centreline where the build stored one (`centerlines` in its `ASSETS` entry) and otherwise passes through the part's centre.
- In `scripts/build-models.mjs`, an `ASSETS` entry can also `merge` several elements into one part, `split` an element at a height into two parts, and `rename` parts (the Digestive entry does all three).
- A part whose left and right sides differ can be keyed by its full lowercase name (e.g. `"left ventricle"`), which wins over the side-less key.
- `"group": "<id>"` on a part puts it in a sub-group when the build didn't tag one (`joints.json` does this).
- `groupToggles: true`: each colour-key entry becomes a checkbox that shows or hides its sub-group; a group with `visible: false` starts hidden. A see-through group (`opacity` below 1) only takes a click when no solid part is behind it.
- `depthLevels`: names of a layer's depth layers, outermost first (e.g. `["Superficial", "Intermediate", "Deep"]`). A "Peel away" slider then hides parts layer by layer; each part sets `depth` (1 = outermost). `peelReveals: "<layer id>"` offers a link to switch that layer on underneath (Muscular offers Skeletal).
- `movements`: a "Show me the muscles for…" picker (label from `movementPrompt`). Each entry is `{ id, name, note?, prime: [part keys], synergist: [part keys] }`; choosing one lights the prime movers brightest (gently pulsing unless the viewer prefers reduced motion), the synergists dimmer, and fades the rest of the layer to a ghost that clicks pass through. The selected part's info panel says its role.
- A mesh can belong to another part through the `of` node extra (a muscle's tendon names its muscle). It then takes that part's region, `flow`, `depth` and movement role, and its sub-group's `description` stands in for its own.
- An effect with `surface: "layer"` is built over the layer's own model instead of the skin; `type: "fiber-haze"` (Muscular) draws faint glowing streaks along each part.
- `shared`: a list of `{ layer, match, group? }`. It also shows another layer's meshes whose name (lowercase, "left"/"right" removed) matches the `match` regular expression as parts of this layer, reusing the other layer's model and geometry instead of shipping a copy; that layer's model loads with this one. The info panel uses this layer's `parts` entry if there is one, otherwise the other layer's. The Joints layer shares the intervertebral discs and costal cartilages this way.

## Anatomy model: source, license and attribution

The 3D anatomy comes from **[BodyParts3D](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/)**, © The Database Center for Life Science (DBCLS). BodyParts3D is a set of 3D models built from scans of a single adult Japanese male, with one mesh per anatomical structure.

- **License:** [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/), per the [official license page](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html) (updated 2025-02-27). The OBJ files still carry a header from an older release that names CC BY-SA 2.1 Japan; the database's current license page supersedes that header.
- **Required credit:** "BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International". The site shows this in its footer, with links to the source and the license.
- **Changes made:** the meshes were converted from OBJ to glTF, rescaled to metres, re-oriented to Y-up, simplified, and compressed with meshopt. A few parts were renamed (see `NAME_OVERRIDES` in `scripts/build-models.mjs`). In the circulatory model, elements that share a name (e.g. the segments of one vein) were merged into one part, and same-named vessels on both sides of the body were split into left and right. In the respiratory model, the pieces of each segmental bronchial tree were merged into one part. In the digestive model, the pieces of the liver, pharynx, bile ducts, jejunum and ileum were merged into one part each, and the cecum and sigmoid colon were cut off the ascending and descending colon at an approximate boundary. In the muscular model, one-sided muscles were mirrored to the other side, each muscle's tendons were split off into a separate part, and a few parts were renamed (see `scripts/muscular-model.mjs`).
- **Source files used:** `isa_BP3D_4.0_obj_99.zip` (polygon reduction rate 99%, IS-A tree) and the element lists `isa_element_parts.txt` and `partof_element_parts.txt`, which say which elements are arteries, veins or parts of the heart, BodyParts3D version 4.0.

The **coccyx**, which BodyParts3D lacks, comes from **[Z-Anatomy](https://www.z-anatomy.com)** ([source repository](https://github.com/Z-Anatomy/Models-of-human-anatomy)), "Z-Anatomy - The libre 3D atlas of anatomy", licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Z-Anatomy is itself derived from BodyParts3D and shares its scale. `scripts/extract-z-anatomy.py` extracts the mesh from Z-Anatomy's Blender template into `data-sources/z-anatomy/coccyx.obj`. The build then moves it so that it sits under the BodyParts3D sacrum.

The six **auditory ossicles** (malleus, incus and stapes of each ear) also come from Z-Anatomy, which adapted them from **[“Anatomy of the Inner Ear”](https://sketchfab.com/3d-models/anatomy-of-the-inner-ear-f80bda64666c4b8aaac8f63b7b82a0a0)** by Annie Campbell, University of Dundee School of Medicine ([AnatomyTOOL record](https://anatomytool.org/node/60505)). That model is itself a derivative of “3D Ear” by W. Robert J. Funnell, PhD, Sam Daniel, MD, CM and Daren Nicolson, MD, CM at McGill University. It is licensed [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), which allows **non-commercial use only**. `scripts/extract-z-anatomy.py` extracts the six meshes into `data-sources/z-anatomy/ossicles/`, and the build moves each one into place by matching the centre of its temporal bone, then simplifies it.

So that the restriction stays with those files only, the ossicles ship separately: **`public/models/skeletal-ossicles.glb` and `data-sources/z-anatomy/ossicles/` are distributed under CC BY-NC-SA 4.0 and may not be used commercially.** Body Atlas is a free, non-commercial site. The footer credits Dundee, McGill and Z-Anatomy, notes the changes and states that the ossicle model is non-commercial.

The whole **nervous system** also comes from Z-Anatomy, because BodyParts3D has no spinal cord or peripheral nerves. The extract script exports the brain regions (each lobe is Z-Anatomy's gyri and sulci for it merged into one mesh), the spinal cord, ganglia and optic pathway as meshes, and the nerves, which Z-Anatomy draws as curves, as sampled polylines. `scripts/nervous-model.mjs` then fits it onto the BodyParts3D skeleton, bone by bone, and turns each nerve into a thickened tube so it reads as a glowing thread.

Z-Anatomy lists these models as used for reference or included and adapted, so parts of its brain and cranial nerves may derive from them: "Brainder" and "White matter" from the University of Washington; and "Cranial Nerves and Foramina" by the University of Dundee, CAHID (CC BY 4.0).

Most **ligaments, joint capsules, menisci, joint discs and fasciae** come from Z-Anatomy too, because BodyParts3D has only a few of them (the interosseous membranes, the wrist's flexor retinaculum, the iliotibial tract, the long plantar ligament and the ligaments and membranes of the larynx and hyoid, which are taken from BodyParts3D). `scripts/extract-z-anatomy.py` writes them to `data-sources/z-anatomy/connective-tissue.obj.gz`, already moved onto the BodyParts3D skeleton: Z-Anatomy's bones were reshaped from BodyParts3D's and sit up to about 2 cm away from them, so the script registers each Z-Anatomy bone onto its BodyParts3D twin (long bones piece by piece) and moves every vertex of a ligament or fascia with the bones nearest to it. It also decimates the largest sheets, and the build simplifies them further.

The **lung lobes, nasal cavity, paranasal sinuses** (frontal, sphenoidal and the anterior, middle and posterior ethmoidal cells) and the **nasopharynx, oropharynx and laryngopharynx** come from Z-Anatomy too, because BodyParts3D has the trachea, bronchial tree and laryngeal cartilages but not these. `scripts/extract-z-anatomy.py` writes them to `data-sources/z-anatomy/respiratory.obj.gz`, moved onto the BodyParts3D skeleton the same way as the connective tissue.

The two **parotid glands** come from Z-Anatomy as well, because BodyParts3D has the other salivary glands but not these. `scripts/extract-z-anatomy.py` extracts them into `data-sources/z-anatomy/parotid-gland-left.obj` and `parotid-gland-right.obj`, and the build moves each one so that the submandibular gland next to it lines up with the BodyParts3D one.

The **muscles** come from BodyParts3D: every element its IS-A tree files as a muscle, a head or a part of one, plus the muscle sets, trapezius parts and free-standing tendons listed in `scripts/muscular-model.mjs`. Paired muscles BodyParts3D models on one side only are mirrored to the other. The muscles BodyParts3D lacks (latissimus dorsi, rectus abdominis, the internal oblique and transversus abdominis, quadratus lumborum, the muscles of facial expression and of chewing, multifidus, and a few in the foot) come from Z-Anatomy: `scripts/export-z-anatomy.py` exports them to `data-sources/z-anatomy/muscular/`, and the build fits them onto the BodyParts3D skeleton with the same bone-by-bone warp as the nervous system. The build then splits each muscle's tendons off as separate parts: stretches of the mesh much thinner than the muscle's belly that reach a bone. That split is an approximation from the shape alone; muscles that end in skin, fascia or other muscles (such as the face's) are left whole. Each muscle's depth for the peel-away slider and its role in each exercise are this project's own simplified grouping.

Because of those ShareAlike parts, **`public/models/skeletal.glb`, `public/models/nervous.glb`, `public/models/joints.glb`, `public/models/digestive.glb`, `public/models/muscular.glb`, `public/models/respiratory.glb` and `data-sources/z-anatomy/` (apart from `ossicles/` and the inner-ear nerve entries in `nervous/nerves.json`) are distributed under CC BY-SA 4.0**. `public/models/skin.glb` and `public/models/circulatory.glb` are under CC BY 4.0. The site credits both sources in its footer, notes that the Z-Anatomy parts were modified, and states that the skeletal, nervous, joints, digestive, muscular and respiratory models are CC BY-SA 4.0.

The **inner-ear nerves** (the cochlear, vestibular and vestibulocochlear (VIII) nerves and the chorda tympani of each side) also come from Z-Anatomy, which may have adapted them from **[“Anatomy of the Inner Ear”](https://sketchfab.com/3d-models/anatomy-of-the-inner-ear-f80bda64666c4b8aaac8f63b7b82a0a0)** by Annie Campbell, University of Dundee School of Medicine. That model is itself a derivative of “3D Ear” by W. Robert J. Funnell, PhD, Sam Daniel, MD, CM and Daren Nicolson, MD, CM at McGill University. It is licensed [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), which allows **non-commercial use only**. So that the restriction stays with those parts only, they ship separately: **`public/models/nervous-inner-ear.glb` and the inner-ear nerve entries in `data-sources/z-anatomy/nervous/nerves.json` (Cochlear nerve, Vestibular nerve, Vestibulocochlear nerve (VIII) and Chorda tympani, both sides) are distributed under CC BY-NC-SA 4.0 and may not be used commercially.** Body Atlas is a free, non-commercial site. The footer credits Dundee, McGill and Z-Anatomy, notes the changes and states that the inner-ear nerve model is non-commercial.

The part descriptions in `src/data/` are original text written for this project.

### Rebuilding the models

```sh
npm run fetch-data     # downloads ~140 MB into .cache/ (gitignored) and checks its SHA-256
npm run build-models   # writes public/models/skin.glb, skeletal.glb, skeletal-ossicles.glb, nervous.glb, nervous-inner-ear.glb, circulatory.glb, joints.glb, digestive.glb, muscular.glb and respiratory.glb
npm run check-nerves   # fails if a nerve lies outside the skin, or runs through solid bone away from a real foramen or canal
```

The generated GLB files come to about 18.9 MB in total (circulatory.glb is about 4.7 MB, muscular.glb about 4.2 MB, joints.glb about 1.4 MB, digestive.glb about 1.3 MB, respiratory.glb about 1.1 MB); each system's file downloads only when its filter is first turned on. They are committed, so a normal build does not need the source data.

`data-sources/z-anatomy/` is committed too. To regenerate it, run `npm run fetch-data` (the registration needs the BodyParts3D meshes), download `Z-Anatomy.zip` from the Z-Anatomy repository, unzip it, and run its `Startup.blend` through Blender 4.x or later (it needs about 9 GB of memory and a few minutes):

```sh
blender -b --factory-startup --disable-autoexec Z-Anatomy/Startup.blend \
  --python scripts/extract-z-anatomy.py -- data-sources/z-anatomy .cache/bodyparts3d/obj
```

The Z-Anatomy muscles in `data-sources/z-anatomy/muscular/` come from a lighter export that loads only the objects listed in `objects.txt` (a few GB of memory):

```sh
blender -b --factory-startup --disable-autoexec --python scripts/export-z-anatomy.py -- \
  Z-Anatomy/Startup.blend data-sources/z-anatomy "names:muscular=data-sources/z-anatomy/muscular/objects.txt"
```

### Skeletal coverage

The Skeletal layer covers all 206 bones of the standard adult count, including the 6 auditory ossicles. It also includes the 4 sesamoid bones under the big toes, the costal cartilages and the intervertebral discs. The sternum is shown as its three parts: manubrium, body and xiphoid process.

The ossicles sit inside the temporal bone, in the middle ear. Only the malleus can be seen through the ear canal. The incus and stapes sit deeper inside the temporal bone. To see them, zoom toward the ear until the bone in front is cut away.

### Nervous coverage

The Nervous layer shows the brain split into regions (the frontal, parietal, temporal and occipital lobes, insula and limbic lobe of each hemisphere, plus the cerebellum and brainstem, each in its own color), the optic chiasm and tracts, the spinal cord and cauda equina, the spinal nerve roots and ganglia, the sympathetic trunks, and every named nerve in Z-Anatomy's peripheral nervous system: the 12 pairs of cranial nerves and their main branches, the brachial, lumbar and sacral plexuses and the nerves of the arms, trunk and legs.

Deeper brain structures (thalamus, basal ganglia and so on) and the many small unnamed nerve twigs are not shown. Nerves are drawn thicker than life so they stay visible.

The optional **nerve-ending haze** is a decorative effect, not anatomy: twinkling specks just under the skin, denser at the fingertips, lips, face and soles to suggest where sensory endings are most concentrated. The page labels it as an illustrative effect.

### Circulatory coverage

The Circulatory layer shows every artery and vein that BodyParts3D models as its own named element: 438 artery parts and 224 vein parts after merging same-named segments, from the aorta down to the digital arteries of the fingers and toes. Each part's info panel says whether it carries blood toward or away from the heart (and, for the pulmonary vessels, that their oxygen levels are the reverse of the rest of the body's). Arteries are red and veins blue.

The heart is split into its four chambers (the blood-filled cavities), the walls of the atria and ventricles, and the valve apparatus: the cusps of the aortic and pulmonary valves, the leaflets of the mitral and tricuspid valves, and the papillary muscles. The walls and chambers are see-through so the valves show inside.

Capillaries are far too small and numerous to model, so they are not shown. The optional **Capillary glow** toggle lays a soft, pulsing glow over the skin as a hint of the capillary beds. It is a decorative visual effect, not modeled anatomy, and the filter panel labels it "Illustrative".

### Muscular coverage

The Muscular layer shows every skeletal muscle in the model: about 245 named muscles and muscle parts, most of them on both sides (the deltoid, trapezius and pectoralis major in their parts, the biceps, triceps and gastrocnemius by head), from the muscles of the face, eye, tongue, throat and larynx to those of the fingers and toes. Each one's info panel gives its name, a short description and its action (the movement it makes). Cardiac muscle and the smooth muscle of the organs belong to other systems and are not part of this layer.

- **Tendons** are paler parts of their own, showing where each muscle attaches to bone; clicking one shows which muscle it belongs to. The colour key's checkboxes show or hide the muscles and the tendons. Ligaments are in the Joints & connective tissue layer.
- **Peel away** hides the superficial muscles, then the intermediate ones, then the deep ones, down to bone, and offers to switch the Skeletal layer on underneath.
- **Show me the muscles for…** picks an exercise (squat, lunge, deadlift, glute bridge, calf raise, push-up, bench press, overhead press, pull-up, bent-over row, bicep curl, triceps dip, plank or crunch) and lights up the muscles that do the work: prime movers brightest, synergists dimmer. The lists follow common exercise-science descriptions and are simplified.
- The optional **Muscle-fiber haze** is a decorative effect, not anatomy: faint glowing streaks drift along each muscle's long axis, not its real fibre directions. The page labels it as an illustrative effect.

### Joints & connective tissue coverage

The layer has four groups, each in its own color with its own checkbox in the filter panel. Fascia starts hidden, because it wraps the limbs and would hide the rest:

- **Ligaments**: the ligaments of the spine, ribs, pelvis and every limb joint down to the fingers and toes, the interosseous membranes, and the ligaments and membranes of the jaw and larynx. Several small ligaments are one part each, as in the source model (for example "Dorsal intercarpal ligaments").
- **Cartilage & discs**: the knee menisci, the hip and shoulder labra, the discs of the jaw, sternoclavicular, acromioclavicular and distal radio-ulnar joints, the pubic and sacrococcygeal discs, plus the intervertebral discs and costal cartilages. Those last two are shared with the Skeletal layer: they are the same meshes, shown in this layer's color when it is on.
- **Capsules** (see-through): the fibrous capsules of the main joints, the hip's zona orbicularis and capsular folds, and the knee's infrapatellar fat pad.
- **Fascia** (see-through): the deep fasciae, intermuscular septa, retinacula and the palmar and plantar aponeuroses.

Not shown:

- **Articular (hyaline) cartilage**, the thin layer that caps the bone ends inside joints. Neither BodyParts3D nor Z-Anatomy models it.
- **Tendons and tendon sheaths**, which belong with the muscles, and **bursae**.
- **Ligaments of the eye** (suspensory ligament of the lens, check ligaments) and of the ossicles.
- The **triradiate cartilage** of the hip socket, a growth cartilage that has fused in an adult.

### Digestive coverage

The Digestive layer follows the tract from mouth to anus, plus the organs that feed into it:

- **Mouth**: lips, upper and lower gums, tongue, and 28 teeth (each incisor, canine, premolar and first and second molar is its own part; BodyParts3D has no wisdom teeth).
- **Salivary glands**: the parotid, submandibular and sublingual glands of each side.
- **Pharynx** (shown as its constrictor muscles, merged into one part) and **esophagus**.
- **Stomach**.
- **Small intestine**: duodenum, jejunum, ileum and the ileocecal junction.
- **Large intestine**: cecum, appendix, ascending, transverse, descending and sigmoid colon, rectum and the external anal sphincter. BodyParts3D models the cecum as part of the ascending colon and the sigmoid colon as part of the descending colon, so the boundaries between them are approximate.
- **Accessory organs**: liver, gallbladder, bile ducts and pancreas.

The layer has two optional decorative effects, each badged "Illustrative" in the filter panel. They are visual effects, not modeled anatomy:

- **Villi haze**: a fine, swaying fuzz over the small intestine, a hint of the millions of tiny villi that line it.
- **Gut bacteria haze**: drifting specks around the colon, a hint of its gut bacteria.

**Follow the food** sends a glowing pulse through the tract in order (mouth, pharynx, esophagus, stomach, small intestine, large intestine, rectum and anus), lighting up each stage and showing the typical time food spends there, from seconds in the mouth to one to three days in all. The animation is shortened to about half a minute.

### Respiratory coverage

The Respiratory layer follows the air from the nose to the lungs, in five colour-coded groups:

- **Nose, sinuses & pharynx**: the nasal cavity, the major alar, lateral nasal and septal cartilages of the nose, the frontal and sphenoidal sinuses and the anterior, middle and posterior ethmoidal cells of each side, and the nasopharynx, oropharynx and laryngopharynx. The maxillary sinuses are not modeled by either source.
- **Larynx**: the thyroid and cricoid cartilages, the epiglottis, the arytenoid, corniculate and cuneiform cartilages of each side and the conus elasticus. The vocal ligaments and the other laryngeal ligaments are in the Joints layer.
- **Trachea & bronchial tree**: the trachea, both main bronchi and the segmental bronchial trees, ten per lung as BodyParts3D models them, each one clickable.
- **Lung lobes** (see-through so the airways show inside): the superior, middle and inferior lobes of the right lung and the superior and inferior lobes of the left.
- **Diaphragm**, the main muscle of breathing.

The optional **Air-sac haze** is a decorative effect, not anatomy: softly glowing specks inside the lung lobes that brighten and dim on a slow breathing rhythm, a hint of the hundreds of millions of alveoli too small to model. The filter panel labels it "Illustrative".
