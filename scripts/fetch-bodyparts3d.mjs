// Downloads the BodyParts3D 4.0 IS-A polygon meshes (CC BY 4.0, DBCLS)
// into .cache/bodyparts3d/ and extracts the OBJ files. The IS-A archive is a
// superset of the PART-OF one (it also has e.g. the foot sesamoid bones).
// Safe to re-run: a cached archive with the expected checksum is reused.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';

const URL = 'https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/isa_BP3D_4.0_obj_99.zip';
const SHA256 = '40665852c49f218326590e204db91064a1ecfc3c6f8cbd7bbbcaac62c7cd409e';
const CACHE = join(import.meta.dirname, '..', '.cache', 'bodyparts3d');
const ZIP = join(CACHE, 'isa_BP3D_4.0_obj_99.zip');
const OBJ_DIR = join(CACHE, 'obj');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(CACHE, { recursive: true });

let zip = existsSync(ZIP) ? readFileSync(ZIP) : null;
if (!zip || sha256(zip) !== SHA256) {
  console.log(`Downloading ${URL} (~140 MB, the server can be slow)...`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  zip = Buffer.from(await res.arrayBuffer());
  writeFileSync(ZIP, zip);
}
const actual = sha256(zip);
if (actual !== SHA256) {
  throw new Error(`Checksum mismatch for ${ZIP}: expected ${SHA256}, got ${actual}`);
}

mkdirSync(OBJ_DIR, { recursive: true });
const files = unzipSync(new Uint8Array(zip), { filter: (f) => f.name.endsWith('.obj') });
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(OBJ_DIR, name.split('/').pop()), data);
}
console.log(`Extracted ${Object.keys(files).length} OBJ files to ${OBJ_DIR}`);
