// Downloads the BodyParts3D 4.0 IS-A polygon meshes (CC BY 4.0, DBCLS)
// into .cache/bodyparts3d/ and extracts the OBJ files. The IS-A archive is a
// superset of the PART-OF one (it also has e.g. the foot sesamoid bones).
// Also fetches the two element lists that map FMA concepts to element files,
// which scripts/build-models.mjs uses to pick e.g. every artery and vein.
// Safe to re-run: a cached file with the expected checksum is reused.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';

const BASE = 'https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/';
const FILES = {
  'isa_BP3D_4.0_obj_99.zip': '40665852c49f218326590e204db91064a1ecfc3c6f8cbd7bbbcaac62c7cd409e',
  'isa_element_parts.txt': 'a3de74423f943b0d724ae8f59b3a817f87c423a544f8db98113b1980817cbeaf',
  'partof_element_parts.txt': '3f5f6df1028eb122b30de77c711597b6bb8e5541658e5985859fd228adbf88ea',
};
const CACHE = join(import.meta.dirname, '..', '.cache', 'bodyparts3d');
const OBJ_DIR = join(CACHE, 'obj');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(CACHE, { recursive: true });

/** Returns the cached file, downloading it first if it is missing or stale. */
async function fetchFile(name, sha) {
  const path = join(CACHE, name);
  let data = existsSync(path) ? readFileSync(path) : null;
  if (!data || sha256(data) !== sha) {
    console.log(`Downloading ${BASE + name}${name.endsWith('.zip') ? ' (~140 MB, the server can be slow)' : ''}...`);
    const res = await fetch(BASE + name);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    data = Buffer.from(await res.arrayBuffer());
    writeFileSync(path, data);
  }
  const actual = sha256(data);
  if (actual !== sha) throw new Error(`Checksum mismatch for ${path}: expected ${sha}, got ${actual}`);
  return data;
}

const downloaded = {};
for (const [name, sha] of Object.entries(FILES)) downloaded[name] = await fetchFile(name, sha);
const zip = downloaded['isa_BP3D_4.0_obj_99.zip'];

mkdirSync(OBJ_DIR, { recursive: true });
const files = unzipSync(new Uint8Array(zip), { filter: (f) => f.name.endsWith('.obj') });
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(OBJ_DIR, name.split('/').pop()), data);
}
console.log(`Extracted ${Object.keys(files).length} OBJ files to ${OBJ_DIR}`);
