// Builds the parts of the Endocrine layer that BodyParts3D lacks, from the
// Z-Anatomy export in data-sources/z-anatomy/endocrine/ (written by
// scripts/export-z-anatomy.py): the thyroid gland, the four parathyroid
// glands, and the pituitary gland split into its anterior and posterior lobes.
//
// Each set is placed by the BodyParts3D parts it sits on, the way
// reproductive-model.mjs places the ejaculatory ducts: the thyroid and
// parathyroids by fitting Z-Anatomy's thyroid and cricoid cartilages rigidly
// (ICP) onto BodyParts3D's, and the two pituitary lobes by fitting them
// together onto BodyParts3D's single pituitary mesh, which is then left out.
import { join } from 'node:path';
import { apply, icp, pointsOf } from './nervous-model.mjs';

// Each set: the Z-Anatomy objects fitted (Z-Anatomy object -> BodyParts3D
// element), and the parts that move with the fit (Z-Anatomy object -> name).
const SETS = [
  {
    label: 'thyroid and cricoid cartilages',
    fit: { 'Thyroid cartilage': 'FJ2808', 'Cricoid cartilage': 'FJ2440' },
    parts: {
      'Thyroid gland': 'Thyroid gland',
      'Superior parathyroid gland.l': 'Left superior parathyroid gland',
      'Superior parathyroid gland.r': 'Right superior parathyroid gland',
      'Inferior parathyroid gland.l': 'Left inferior parathyroid gland',
      'Inferior parathyroid gland.r': 'Right inferior parathyroid gland',
    },
  },
  {
    label: 'pituitary lobes',
    fit: { Adenohypophysis: 'FJ1796', Neurohypophysis: 'FJ1796' },
    parts: {
      Adenohypophysis: 'Anterior pituitary',
      Neurohypophysis: 'Posterior pituitary',
    },
  },
];

/**
 * Returns the parts as build-models' parseObj output ({ name, positions,
 * indices } in BodyParts3D millimetres).
 * @param {string} dir data-sources/z-anatomy/endocrine
 * @param {string} objDir the BodyParts3D OBJ files
 * @param {(path: string) => object} parseObj
 */
export function loadEndocrine(dir, objDir, parseObj) {
  return SETS.flatMap(({ label, fit, parts }) => {
    const src = [];
    const dst = [];
    for (const file of Object.keys(fit)) {
      src.push(...pointsOf(parseObj(join(dir, `${file}.obj`)).positions).map((p) => p.map((v) => v * 1000)));
    }
    for (const id of new Set(Object.values(fit))) dst.push(...pointsOf(parseObj(join(objDir, `${id}.obj`)).positions));
    const T = icp(src, dst);
    console.log(`  fitted the Z-Anatomy ${label} onto BodyParts3D; RMS ${T.rms.toFixed(2)} mm`);
    return Object.entries(parts).map(([file, name]) => {
      const obj = parseObj(join(dir, `${file}.obj`));
      const positions = pointsOf(obj.positions).flatMap((p) => apply(T, p.map((v) => v * 1000)));
      return { id: file, name, positions, indices: obj.indices, source: 'z-anatomy' };
    });
  });
}
