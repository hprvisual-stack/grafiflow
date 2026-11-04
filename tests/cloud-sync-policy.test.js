import test from 'node:test';
import assert from 'node:assert/strict';
import { conflictCopyId, hasMeaningfulDraft, shouldQueueLocalRecord, shouldSyncDraft } from '../dist/cloud-sync-policy.js';

const blankDraft = (suffix = 'default') => ({
  quoteId: null,
  quoteName: '',
  clientQuote: {
    businessName: 'Minha gráfica',
    businessPhone: '11999990000',
    businessEmail: 'contato@minhagrafica.com',
    businessDocument: '',
    businessAddress: '',
    validity: '7 dias',
    paymentTerms: '50% de entrada e saldo na entrega',
  },
  materials: [{
    id: `mat-${suffix}`,
    name: 'Material principal',
    nameIsDefault: true,
    supplier: '',
    calculationMode: 'roll',
    widthCm: 320,
    widthIsDefault: true,
    heightCm: 0,
    price: 0,
    basis: 'linear',
    volumePricing: [],
    rotate: true,
    laminationMaterialId: null,
  }],
  pieces: [{ id: `piece-${suffix}`, description: 'Peça nova', widthCm: 0, heightCm: 0, quantity: 1 }],
  globalBleed: 0,
  globalGap: 2,
  optimize: true,
  installation: { type: 'lona', basis: 'm2', quantity: 0, unitPrice: 0, travel: 0, autoQuantity: true, supplies: [] },
  salePrice: 0,
  otherCosts: 0,
  targetMargin: 35,
});

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

test('rascunho vazio com IDs padrão novos e dados comerciais pré-preenchidos não é enviado', () => {
  const firstVisit = blankDraft('first');
  const nextVisit = blankDraft('next');
  assert.notEqual(firstVisit.materials[0].id, nextVisit.materials[0].id);
  assert.notEqual(firstVisit.pieces[0].id, nextVisit.pieces[0].id);
  assert.equal(hasMeaningfulDraft(firstVisit), false);
  assert.equal(shouldSyncDraft({ value: firstVisit, cloudIntent: true }), false);
});

test('conteúdo preenchido ou limpeza explícita do rascunho pode ser sincronizada', () => {
  const editedDraft = blankDraft();
  editedDraft.pieces[0].widthCm = 80;
  assert.equal(shouldSyncDraft({ value: editedDraft }), true);
  assert.equal(shouldSyncDraft({ value: blankDraft(), clearIntent: true }), true);
});
