// Builds the parts of the Reproductive layer that BodyParts3D lacks, from the
// Z-Anatomy export in data-sources/z-anatomy/reproductive/ (written by
// scripts/export-z-anatomy.py): the two ejaculatory ducts, which Z-Anatomy
// draws as bevelled curves.
//
// The ducts run from the seminal vesicles through the prostate, so they are
// placed by those glands: Z-Anatomy's prostate and seminal glands are fitted
// rigidly (ICP) onto the BodyParts3D prostate and seminal vesicles, and the
// ducts move with that fit. Each becomes a tube, like the nerves.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply, icp, pointsOf, tube } from './nervous-model.mjs';

// Z-Anatomy object -> the BodyParts3D element it is fitted onto.
const GLANDS = {
  Prostate: 'FJ3139',
  'Seminal gland.l': 'FJ3137',
  'Seminal gland.r': 'FJ3143',
};
const DUCTS = { 'Ejaculatory duct.l': 'Left ejaculatory duct', 'Ejaculatory duct.r': 'Right ejaculatory duct' };

/**
 * Returns the ejaculatory ducts as parts shaped like build-models' parseObj
 * output ({ name, positions, indices } in BodyParts3D millimetres).
 * @param {string} dir data-sources/z-anatomy/reproductive
 * @param {string} objDir the BodyParts3D OBJ files
 * @param {(path: string) => object} parseObj
 */
export function loadEjaculatoryDucts(dir, objDir, parseObj) {
  const src = [];
  const dst = [];
  for (const [file, id] of Object.entries(GLANDS)) {
    src.push(...pointsOf(parseObj(join(dir, `${file}.obj`)).positions).map((p) => p.map((v) => v * 1000)));
    dst.push(...pointsOf(parseObj(join(objDir, `${id}.obj`)).positions));
  }
  const fit = icp(src, dst);
  console.log(`  fitted the Z-Anatomy prostate and seminal glands onto BodyParts3D; RMS ${fit.rms.toFixed(2)} mm`);
  return Object.entries(DUCTS).map(([file, name]) => {
    const positions = [];
    const indices = [];
    for (const line of JSON.parse(readFileSync(join(dir, `${file}.json`), 'utf8')).lines) {
      tube(
        line.map(([x, y, z, r]) => [...apply(fit, [x * 1000, y * 1000, z * 1000]), r * 1000]),
        positions,
        indices,
      );
    }
    return { name, positions, indices, source: 'z-anatomy', simplify: false };
  });
}
