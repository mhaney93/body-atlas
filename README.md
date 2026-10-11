# Body Atlas

Free interactive 3D atlas of the human body with per-system highlighting.

**Live site:** https://body-atlas-hd.vercel.app

The page shows a see-through glass model of an adult male body that you can rotate, zoom and pan with a mouse or with touch. Turning on a body system in the filter panel lights up its parts in color. Clicking or tapping a part shows its name and a short description.

This first version ships the **Skeletal** system. Every bone in the model is a separate, clickable part with its own name and description.

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
| `src/main.js`, `index.html`, `src/style.css` | UI: filter panel, info panel, loading indicator, credit |
| `public/models/*.glb` | Generated, compressed models (committed) |
| `scripts/fetch-bodyparts3d.mjs` | Downloads and checksums the BodyParts3D source meshes into `.cache/` |
| `scripts/build-models.mjs` | Converts the OBJ meshes to meshopt-compressed GLB files |
| `scripts/extract-z-anatomy.py`, `data-sources/z-anatomy/` | Blender script and its output: bones BodyParts3D lacks (the coccyx), taken from Z-Anatomy |

### Adding a body system

Each system is a data-driven layer, so adding Circulatory, Nervous or another system does not touch the viewer:

1. In `scripts/build-models.mjs`, add an entry to `ASSETS` that lists its BodyParts3D element files. Then rebuild the models (see below).
2. Add `src/data/<system>.json` with the same shape as `skeletal.json`: `id`, `name`, `color`, `asset`, `summary`, plus `parts` keyed by the part's name with any "left"/"right" removed.
3. Import it and append it to `LAYERS` in `src/layers.js`.

A part that has no entry in `parts` still shows its name when clicked.

## Anatomy model: source, license and attribution

The 3D anatomy comes from **[BodyParts3D](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/)**, © The Database Center for Life Science (DBCLS). BodyParts3D is a set of 3D models built from scans of a single adult Japanese male, with one mesh per anatomical structure.

- **License:** [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/), per the [official license page](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html) (updated 2025-02-27). The OBJ files still carry a header from an older release that names CC BY-SA 2.1 Japan; the database's current license page supersedes that header.
- **Required credit:** "BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International". The site shows this in its footer, with links to the source and the license.
- **Changes made:** the meshes were converted from OBJ to glTF, rescaled to metres, re-oriented to Y-up, simplified, and compressed with meshopt. Two parts were renamed (see `NAME_OVERRIDES` in `scripts/build-models.mjs`).
- **Source files used:** `isa_BP3D_4.0_obj_99.zip` (polygon reduction rate 99%, IS-A tree), BodyParts3D version 4.0.

The **coccyx**, which BodyParts3D lacks, comes from **[Z-Anatomy](https://www.z-anatomy.com)** ([source repository](https://github.com/Z-Anatomy/Models-of-human-anatomy)), "Z-Anatomy - The libre 3D atlas of anatomy", licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Z-Anatomy is itself derived from BodyParts3D and shares its scale. `scripts/extract-z-anatomy.py` extracts the mesh from Z-Anatomy's Blender template into `data-sources/z-anatomy/coccyx.obj`. The build then moves it so that it sits under the BodyParts3D sacrum.

Because of that ShareAlike part, **`public/models/skeletal.glb` and `data-sources/z-anatomy/` are distributed under CC BY-SA 4.0**. `public/models/skin.glb` is under CC BY 4.0. The site credits both sources in its footer, notes that the coccyx was modified, and states that the skeletal model is CC BY-SA 4.0.

The bone descriptions in `src/data/` are original text written for this project.

### Rebuilding the models

```sh
npm run fetch-data     # downloads ~140 MB into .cache/ (gitignored) and checks its SHA-256
npm run build-models   # writes public/models/skin.glb and skeletal.glb
```

The generated GLB files come to about 4 MB in total. They are committed, so a normal build does not need the source data.

`data-sources/z-anatomy/coccyx.obj` is committed too. To regenerate it, download `Z-Anatomy.zip` from the Z-Anatomy repository, unzip it, and run its `Startup.blend` through Blender 4.x:

```sh
blender -b --factory-startup --disable-autoexec Z-Anatomy/Startup.blend \
  --python scripts/extract-z-anatomy.py -- data-sources/z-anatomy
```

### Skeletal coverage

The Skeletal layer covers all 206 bones of the standard adult count **except the 6 auditory ossicles**. It also includes the 4 sesamoid bones under the big toes, the costal cartilages and the intervertebral discs. The sternum is shown as its three parts: manubrium, body and xiphoid process.

Not shown:

- **Auditory ossicles**: malleus, incus and stapes in each ear (6 bones). BodyParts3D doesn't have them. Z-Anatomy does, but it lists the University of Dundee's "Anatomy of the Inner Ear" model, which includes the ossicles and is licensed CC BY-NC-SA 4.0 (non-commercial), among the models it adapted. Their license is therefore unclear, so they are left out.
