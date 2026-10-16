import assert from 'node:assert/strict';
import { test } from 'node:test';
import { throughBone } from './check-placement.mjs';
import { classify, ORGAN_LIMIT } from './overlaps.mjs';
import { layerAssets } from './placement.mjs';

const hit = (layer, part, bone, depth) => ({ layer, part, bone, depth });
const nerve = (part, bone, depth) => hit('nervous', part, bone, depth);

test('every layer in src/data is checked, with all of its models', () => {
  const layers = Object.fromEntries(layerAssets().map((l) => [l.id, l.files]));
  for (const id of ['skeletal', 'nervous', 'circulatory', 'joints', 'digestive', 'muscular', 'respiratory']) assert.ok(layers[id], id);
  assert.deepEqual(layers.nervous, ['nervous.glb', 'nervous-inner-ear.glb']);
  assert.deepEqual(layers.skeletal, ['skeletal.glb', 'skeletal-ossicles.glb']);
});

test('sacral plexus branches may not pass through the sacrum, only their roots', () => {
  for (const part of ['Left sciatic nerve', 'Left pudendal nerve', 'Right superior gluteal nerve', 'Right posterior femoral cutaneous nerve', 'Left nerve to piriformis muscle', 'Left nerve to quadratus femoris muscle'])
    assert.ok(throughBone(nerve(part, 'Sacrum', 2)), part);
  assert.ok(!throughBone(nerve('Left posterior root of posterior femoral cutaneous nerve', 'Sacrum', 2)));
  assert.ok(!throughBone(nerve('Right anterior root of spinal nerve', 'Sacrum', 2)));
});

test('the inferior alveolar nerve passes only through the mandible', () => {
  assert.ok(!throughBone(nerve('Left inferior alveolar nerve', 'Mandible', 6)));
  assert.ok(throughBone(nerve('Left inferior alveolar nerve', 'Left maxilla', 2)));
  assert.ok(!throughBone(nerve('Left maxillary nerve', 'Left maxilla', 2)));
});

test('an allowed passage is flagged deeper than its opening runs', () => {
  assert.ok(!throughBone(nerve('Cauda equina', 'Sacrum', 12)));
  assert.ok(throughBone(nerve('Cauda equina', 'Sacrum', 30)));
  assert.ok(!throughBone(nerve('Left anterior root of spinal nerve', 'Sixth thoracic vertebra', 1.5)));
  assert.ok(throughBone(nerve('Left anterior root of spinal nerve', 'Sixth thoracic vertebra', 10)));
});

test('other parts are flagged only beyond grazing contact', () => {
  assert.ok(!throughBone(nerve('Left vagus nerve (X)', 'Fifth thoracic vertebra', 1)));
  assert.ok(throughBone(nerve('Left vagus nerve (X)', 'Fifth thoracic vertebra', 3)));
  assert.ok(!throughBone(hit('circulatory', 'Right popliteal artery', 'Right tibia', 1)));
  assert.ok(throughBone(hit('circulatory', 'Right popliteal artery', 'Right tibia', 3)));
});

test('passages are per layer: a nerve canal does not let a vessel or a muscle through', () => {
  assert.ok(throughBone(hit('circulatory', 'Inferior alveolar artery', 'Mandible', 6)));
  assert.ok(throughBone(hit('muscular', 'Left inferior alveolar nerve', 'Mandible', 6)));
});

test('muscles and ligaments may sink into bone only as far as an attachment', () => {
  assert.ok(!throughBone(hit('muscular', 'Right biceps brachii', 'Right radius', 2.5)));
  assert.ok(throughBone(hit('muscular', 'Right biceps brachii', 'Right radius', 6)));
  assert.ok(!throughBone(hit('joints', 'Left posterior cruciate ligament', 'Left tibia', 2.5)));
  assert.ok(throughBone(hit('joints', 'Left posterior cruciate ligament', 'Left tibia', 6)));
});

test('known residuals are bounded by their depth now and by their bone', () => {
  assert.ok(!throughBone(hit('muscular', 'Tendons of right adductor magnus', 'Right femur', 13)));
  assert.ok(throughBone(hit('muscular', 'Tendons of right adductor magnus', 'Right femur', 15)));
  assert.ok(throughBone(hit('muscular', 'Tendons of right adductor magnus', 'Right tibia', 7)));
  assert.ok(throughBone(hit('circulatory', 'Left basilic vein', 'Left humerus', 6)));
});

test('known clipping between systems is bounded too', () => {
  const colon = { layer: 'digestive', part: 'Transverse colon' };
  const artery = { layer: 'circulatory', part: 'Left inferior epigastric artery' };
  assert.ok(classify({ a: artery, b: colon, depth: 12 }).known);
  assert.ok(!classify({ a: artery, b: colon, depth: 12 }).fail);
  assert.ok(classify({ a: artery, b: colon, depth: 20 }).fail);
});

test('teeth sit in their sockets and sinuses in their bones, nowhere else', () => {
  assert.ok(!throughBone(hit('digestive', 'Left lower first molar', 'Mandible', 7)));
  assert.ok(throughBone(hit('digestive', 'Left lower first molar', 'Left temporal bone', 3)));
  assert.ok(!throughBone(hit('respiratory', 'Frontal sinus', 'Frontal bone', 5)));
  assert.ok(throughBone(hit('respiratory', 'Frontal sinus', 'Sphenoid bone', 5)));
  assert.ok(throughBone(hit('respiratory', 'Superior lobe of right lung', 'Manubrium', 3)));
});

test('overlaps between systems fail only when deep, unless one part really lies in the other', () => {
  const pair = (a, b, depth) => classify({ a, b, depth });
  const colon = { layer: 'digestive', part: 'Descending colon' };
  const iliacus = { layer: 'muscular', part: 'Left iliacus' };
  assert.ok(!pair(colon, iliacus, ORGAN_LIMIT - 1).fail);
  assert.ok(pair(colon, iliacus, ORGAN_LIMIT + 1).fail);
  const lung = { layer: 'respiratory', part: 'Superior lobe of right lung' };
  const vessel = { layer: 'circulatory', part: 'Right posterior segmental vein' };
  assert.ok(pair(vessel, lung, 30).nested);
  assert.ok(!pair(lung, vessel, 30).fail, 'either order');
});
