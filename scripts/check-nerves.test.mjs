import assert from 'node:assert/strict';
import { test } from 'node:test';
import { throughBone } from './check-nerves.mjs';

const hit = (nerve, bone, depth) => ({ nerve, bone, depth });

test('sacral plexus branches may not pass through the sacrum, only their roots', () => {
  for (const nerve of ['Left sciatic nerve', 'Left pudendal nerve', 'Right superior gluteal nerve', 'Right posterior femoral cutaneous nerve', 'Left nerve to piriformis muscle', 'Left nerve to quadratus femoris muscle'])
    assert.ok(throughBone(hit(nerve, 'Sacrum', 2)), nerve);
  assert.ok(!throughBone(hit('Left posterior root of posterior femoral cutaneous nerve', 'Sacrum', 2)));
  assert.ok(!throughBone(hit('Right anterior root of spinal nerve', 'Sacrum', 2)));
});

test('the inferior alveolar nerve passes only through the mandible', () => {
  assert.ok(!throughBone(hit('Left inferior alveolar nerve', 'Mandible', 6)));
  assert.ok(throughBone(hit('Left inferior alveolar nerve', 'Left maxilla', 2)));
  assert.ok(!throughBone(hit('Left maxillary nerve', 'Left maxilla', 2)));
});

test('an allowed passage is flagged deeper than its opening runs', () => {
  assert.ok(!throughBone(hit('Cauda equina', 'Sacrum', 12)));
  assert.ok(throughBone(hit('Cauda equina', 'Sacrum', 30)));
  assert.ok(!throughBone(hit('Left anterior root of spinal nerve', 'Sixth thoracic vertebra', 1.5)));
  assert.ok(throughBone(hit('Left anterior root of spinal nerve', 'Sixth thoracic vertebra', 10)));
});

test('other nerves are flagged only beyond grazing contact', () => {
  assert.ok(!throughBone(hit('Left vagus nerve (X)', 'Fifth thoracic vertebra', 1)));
  assert.ok(throughBone(hit('Left vagus nerve (X)', 'Fifth thoracic vertebra', 3)));
});
