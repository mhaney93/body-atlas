// Writes src/mesh-names.json: the name of every mesh in each layer's model
// files, read from the GLBs' glTF JSON. The part search (src/search.js) uses it
// to find parts, both sides of paired ones included, before a layer's model has
// downloaded. `npm run build-models` runs this (`npm run mesh-names`) after
// rebuilding the models, and scripts/search.test.mjs fails if the file is stale.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url);
export const MESH_NAMES_FILE = new URL('src/mesh-names.json', ROOT);
const DATA_DIR = new URL('src/data/', ROOT); // one file per layer (scripts/not-shown.test.mjs checks)

/** Original names (node extra `name`, else the node name) of the meshes in a .glb file. */
export function glbMeshNames(path) {
  const glb = readFileSync(path);
  const jsonLength = glb.readUInt32LE(12); // first chunk is always the JSON
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
  return (gltf.nodes ?? []).filter((n) => n.mesh !== undefined).map((n) => n.extras?.name ?? n.name);
}

/** { layerId: [mesh names] } for every layer, from its `asset` and `extraAssets`. */
export function collectMeshNames() {
  const out = {};
  const files = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort();
  for (const file of files) {
    const layer = JSON.parse(readFileSync(new URL(file, DATA_DIR), 'utf8'));
    const assets = [layer.asset, ...(layer.extraAssets ?? [])];
    out[layer.id] = assets.flatMap((asset) => glbMeshNames(new URL(`public/${asset}`, ROOT)));
  }
  return out;
}

export const serialize = (names) => `${JSON.stringify(names, null, 1)}\n`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const names = collectMeshNames();
  writeFileSync(MESH_NAMES_FILE, serialize(names));
  const total = Object.values(names).reduce((n, list) => n + list.length, 0);
  console.log(`src/mesh-names.json: ${total} meshes in ${Object.keys(names).length} layers`);
}
