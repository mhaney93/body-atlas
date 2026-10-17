// Downloads the Allen Human Reference Atlas 3D, 2020 (CC BY 4.0, © 2019
// Allen Institute for Brain Science) into .cache/allen/: the 0.5 mm label
// volume on MNI ICBM 2009b and its structure list, which
// scripts/allen-model.mjs surfaces into the small brain nuclei.
// Safe to re-run: a cached file with the expected checksum is reused.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://download.alleninstitute.org/informatics-archive/allen_human_reference_atlas_3d_2020/version_1/';
const FILES = {
  'annotation_full.nii.gz': '2b05581e39c44f2623d9b0a69f64e3df0823c20d054abef92973812313335dc3',
  'examples/voxel_count/voxel_count.csv': '7348be087e6c2b6cb1fde1d604761cdd2d70e0e33ded6e1f322db334959d162f',
};
const CACHE = join(import.meta.dirname, '..', '.cache', 'allen');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(CACHE, { recursive: true });
for (const [file, sha] of Object.entries(FILES)) {
  const path = join(CACHE, file.split('/').pop());
  let data = existsSync(path) ? readFileSync(path) : null;
  if (!data || sha256(data) !== sha) {
    console.log(`Downloading ${BASE + file}...`);
    const res = await fetch(BASE + file);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    data = Buffer.from(await res.arrayBuffer());
    writeFileSync(path, data);
  }
  const actual = sha256(data);
  if (actual !== sha) throw new Error(`Checksum mismatch for ${path}: expected ${sha}, got ${actual}`);
}
console.log(`Allen Human Reference Atlas files are in ${CACHE}`);
