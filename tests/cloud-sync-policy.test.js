import test from 'node:test';
import assert from 'node:assert/strict';
import { conflictCopyId, shouldQueueLocalRecord } from '../dist/cloud-sync-policy.js';

test('só enfileira registros locais ainda não confirmados ou marcados como alterados', () => {
  assert.equal(shouldQueueLocalRecord(null), false);
  assert.equal(shouldQueueLocalRecord({ _cloudVersionAt: null }), true);
  assert.equal(shouldQueueLocalRecord({ _cloudVersionAt: '2026-11-03T10:00:00Z' }), false);
  assert.equal(shouldQueueLocalRecord({ _cloudVersionAt: '2026-11-03T10:00:00Z', _cloudDirty: true }), true);
});

test('IDs de cópia de conflito são repetíveis e distinguem conteúdo diferente', () => {
  const item = {
    recordType: 'draft',
    recordId: 'draft',
    payload: { value: { quoteName: 'Fachada', pieces: [{ widthCm: 100, heightCm: 50 }] } },
  };
  assert.equal(conflictCopyId(item), conflictCopyId(structuredClone(item)));
  assert.equal(conflictCopyId(item), conflictCopyId({
    ...item,
    payload: { value: { pieces: [{ heightCm: 50, widthCm: 100 }], quoteName: 'Fachada', updatedAt: 'later' } },
  }));
  assert.notEqual(conflictCopyId(item), conflictCopyId({ ...item, payload: { value: { quoteName: 'Outra fachada' } } }));
});
