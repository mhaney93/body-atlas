# Body Atlas

Free interactive 3D atlas of the human body with per-system highlighting.

**Live site:** https://body-atlas-hd.vercel.app

The page shows a see-through glass model of an adult male body that you can rotate, zoom and pan with a mouse or with touch. Turning on a body system in the filter panel lights up its parts in color. Clicking or tapping a part shows its name and a short description.

It ships the **Skeletal** and **Nervous** systems. Every bone, brain region and named nerve in the model is a separate, clickable part with its own name and description.

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
| `src/main.js`, `index.html`, `src/style.css` | UI: filter panel, info panel, loading indicator, credit |
| `public/models/*.glb` | Generated, compressed models (committed) |
| `scripts/fetch-bodyparts3d.mjs` | Downloads and checksums the BodyParts3D source meshes into `.cache/` |
| `scripts/build-models.mjs` | Converts the OBJ meshes to meshopt-compressed GLB files |
| `scripts/extract-z-anatomy.py`, `data-sources/z-anatomy/` | Blender script and its output: parts BodyParts3D lacks (the coccyx, the auditory ossicles in `ossicles/` and the nervous system in `nervous/`), taken from Z-Anatomy |
| `scripts/nervous-model.mjs` | Fits the Z-Anatomy nervous system onto the BodyParts3D skeleton and turns nerve curves into tubes |

### Adding a body system

Each system is a data-driven layer, so adding Circulatory or another system does not touch the viewer:

1. In `scripts/build-models.mjs`, add an entry to `ASSETS` that lists its BodyParts3D element files (or a `load` function for parts from another source, as the Nervous entry does). Then rebuild the models (see below).
2. Add `src/data/<system>.json` with the same shape as `skeletal.json`: `id`, `name`, `color`, `asset`, `summary`, plus `parts` keyed by the part's name with any "left"/"right" removed.
3. Import it and append it to `LAYERS` in `src/layers.js`.

A layer can also list more GLB files in `extraAssets`. They load together with `asset` and act as one layer. Skeletal and Nervous use this to keep the ossicles and the inner-ear nerves, which have a different license, in files of their own.

A part that has no entry in `parts` still shows its name when clicked. A part entry can also set its own `color` (the Nervous layer colors each brain region this way).

A layer can list decorative `effects` (see `nervous.json` and `src/effects.js`). Each one appears as a checkbox under the layer's toggle with its `label` and a `note`, which must say it is an illustrative effect and not modeled anatomy.

## Anatomy model: source, license and attribution

The 3D anatomy comes from **[BodyParts3D](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/)**, © The Database Center for Life Science (DBCLS). BodyParts3D is a set of 3D models built from scans of a single adult Japanese male, with one mesh per anatomical structure.

- **License:** [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/), per the [official license page](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html) (updated 2025-02-27). The OBJ files still carry a header from an older release that names CC BY-SA 2.1 Japan; the database's current license page supersedes that header.
- **Required credit:** "BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International". The site shows this in its footer, with links to the source and the license.
- **Changes made:** the meshes were converted from OBJ to glTF, rescaled to metres, re-oriented to Y-up, simplified, and compressed with meshopt. Two parts were renamed (see `NAME_OVERRIDES` in `scripts/build-models.mjs`).
- **Source files used:** `isa_BP3D_4.0_obj_99.zip` (polygon reduction rate 99%, IS-A tree), BodyParts3D version 4.0.

The **coccyx**, which BodyParts3D lacks, comes from **[Z-Anatomy](https://www.z-anatomy.com)** ([source repository](https://github.com/Z-Anatomy/Models-of-human-anatomy)), "Z-Anatomy - The libre 3D atlas of anatomy", licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Z-Anatomy is itself derived from BodyParts3D and shares its scale. `scripts/extract-z-anatomy.py` extracts the mesh from Z-Anatomy's Blender template into `data-sources/z-anatomy/coccyx.obj`. The build then moves it so that it sits under the BodyParts3D sacrum.

The six **auditory ossicles** (malleus, incus and stapes of each ear) also come from Z-Anatomy, which adapted them from **[“Anatomy of the Inner Ear”](https://sketchfab.com/3d-models/anatomy-of-the-inner-ear-f80bda64666c4b8aaac8f63b7b82a0a0)** by Annie Campbell, University of Dundee School of Medicine ([AnatomyTOOL record](https://anatomytool.org/node/60505)). That model is itself a derivative of “3D Ear” by W. Robert J. Funnell, PhD, Sam Daniel, MD, CM and Daren Nicolson, MD, CM at McGill University. It is licensed [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), which allows **non-commercial use only**. `scripts/extract-z-anatomy.py` extracts the six meshes into `data-sources/z-anatomy/ossicles/`, and the build moves each one into place by matching the centre of its temporal bone, then simplifies it.

So that the restriction stays with those files only, the ossicles ship separately: **`public/models/skeletal-ossicles.glb` and `data-sources/z-anatomy/ossicles/` are distributed under CC BY-NC-SA 4.0 and may not be used commercially.** Body Atlas is a free, non-commercial site. The footer credits Dundee, McGill and Z-Anatomy, notes the changes and states that the ossicle model is non-commercial.

The whole **nervous system** also comes from Z-Anatomy, because BodyParts3D has no spinal cord or peripheral nerves. The extract script exports the brain regions (each lobe is Z-Anatomy's gyri and sulci for it merged into one mesh), the spinal cord, ganglia and optic pathway as meshes, and the nerves, which Z-Anatomy draws as curves, as sampled polylines. `scripts/nervous-model.mjs` then fits it onto the BodyParts3D skeleton, bone by bone, and turns each nerve into a thickened tube so it reads as a glowing thread.

Z-Anatomy lists these models as used for reference or included and adapted, so parts of its brain and cranial nerves may derive from them: "Brainder" and "White matter" from the University of Washington; and "Cranial Nerves and Foramina" by the University of Dundee, CAHID (CC BY 4.0).

Because of that ShareAlike part, **`public/models/skeletal.glb`, `public/models/nervous.glb` and `data-sources/z-anatomy/` (apart from `ossicles/` and the inner-ear nerve entries in `nervous/nerves.json`) are distributed under CC BY-SA 4.0**. `public/models/skin.glb` is under CC BY 4.0. The site credits both sources in its footer, notes that the Z-Anatomy parts were modified, and states that the skeletal and nervous models are CC BY-SA 4.0.

The **inner-ear nerves** (the cochlear, vestibular and vestibulocochlear (VIII) nerves and the chorda tympani of each side) also come from Z-Anatomy, which may have adapted them from **[“Anatomy of the Inner Ear”](https://sketchfab.com/3d-models/anatomy-of-the-inner-ear-f80bda64666c4b8aaac8f63b7b82a0a0)** by Annie Campbell, University of Dundee School of Medicine. That model is itself a derivative of “3D Ear” by W. Robert J. Funnell, PhD, Sam Daniel, MD, CM and Daren Nicolson, MD, CM at McGill University. It is licensed [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), which allows **non-commercial use only**. So that the restriction stays with those parts only, they ship separately: **`public/models/nervous-inner-ear.glb` and the inner-ear nerve entries in `data-sources/z-anatomy/nervous/nerves.json` (Cochlear nerve, Vestibular nerve, Vestibulocochlear nerve (VIII) and Chorda tympani, both sides) are distributed under CC BY-NC-SA 4.0 and may not be used commercially.** Body Atlas is a free, non-commercial site. The footer credits Dundee, McGill and Z-Anatomy, notes the changes and states that the inner-ear nerve model is non-commercial.

The part descriptions in `src/data/` are original text written for this project.

### Rebuilding the models

```sh
npm run fetch-data     # downloads ~140 MB into .cache/ (gitignored) and checks its SHA-256
npm run build-models   # writes public/models/skin.glb, skeletal.glb, skeletal-ossicles.glb, nervous.glb and nervous-inner-ear.glb
```

The generated GLB files come to about 6 MB in total; each system's file downloads only when its filter is first turned on. They are committed, so a normal build does not need the source data.

`data-sources/z-anatomy/` is committed too. To regenerate it, download `Z-Anatomy.zip` from the Z-Anatomy repository, unzip it, and run its `Startup.blend` through Blender 4.x:

```sh
blender -b --factory-startup --disable-autoexec Z-Anatomy/Startup.blend \
  --python scripts/extract-z-anatomy.py -- data-sources/z-anatomy
```

### Skeletal coverage

The Skeletal layer covers all 206 bones of the standard adult count, including the 6 auditory ossicles. It also includes the 4 sesamoid bones under the big toes, the costal cartilages and the intervertebral discs. The sternum is shown as its three parts: manubrium, body and xiphoid process.

The ossicles sit inside the temporal bone, in the middle ear. Only the malleus can be seen through the ear canal. The incus and stapes sit deeper inside the temporal bone; to click them, zoom into the middle ear.

### Nervous coverage

The Nervous layer shows the brain split into regions (the frontal, parietal, temporal and occipital lobes, insula and limbic lobe of each hemisphere, plus the cerebellum and brainstem, each in its own color), the optic chiasm and tracts, the spinal cord and cauda equina, the spinal nerve roots and ganglia, the sympathetic trunks, and every named nerve in Z-Anatomy's peripheral nervous system: the 12 pairs of cranial nerves and their main branches, the brachial, lumbar and sacral plexuses and the nerves of the arms, trunk and legs.

Deeper brain structures (thalamus, basal ganglia and so on) and the many small unnamed nerve twigs are not shown. Nerves are drawn thicker than life so they stay visible.

The optional **nerve-ending haze** is a decorative effect, not anatomy: twinkling specks just under the skin, denser at the fingertips, lips, face and soles to suggest where sensory endings are most concentrated. The page labels it as an illustrative effect.
