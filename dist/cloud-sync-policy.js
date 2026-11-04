function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const metadata = new Set(['_syncUpdatedAt', '_cloudVersionAt', '_cloudDirty', 'updatedAt']);
  return Object.fromEntries(Object.keys(value).filter((key) => !metadata.has(key)).sort().map((key) => [key, stableValue(value[key])]));
}

function number(value, fallback = 0) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value, fallback = 0) {
  return Math.max(0, number(value, fallback));
}

export function hasMeaningfulDraft(draftRecord) {
  const draft = draftRecord?.value && typeof draftRecord.value === 'object' ? draftRecord.value : draftRecord;
  if (!draft || typeof draft !== 'object') return false;
  if (draft.quoteId || String(draft.quoteName || '').trim()) return true;

  const client = draft.clientQuote || {};
  if (['clientName', 'clientContact', 'clientEmail', 'clientDocument', 'clientAddress', 'customerId', 'notes'].some((key) => String(client[key] || '').trim())) return true;
  if (client.validity && client.validity !== '7 dias') return true;
  if (client.paymentTerms && client.paymentTerms !== '50% de entrada e saldo na entrega') return true;

  if (Array.isArray(draft.materials) && draft.materials.some((material) => {
    const name = String(material?.name || '').trim();
    const tiers = Array.isArray(material?.volumePricing)
      && material.volumePricing.some((tier) => positive(tier?.minQuantity) > 0 && positive(tier?.unitPrice) > 0);
    return (name && name !== 'Material principal' && !/^Material \d+$/.test(name))
      || String(material?.supplier || '').trim()
      || positive(material?.price) > 0
      || positive(material?.heightCm) > 0
      || material?.widthIsDefault === false
      || (material?.calculationMode && material.calculationMode !== 'roll')
      || (material?.basis && material.basis !== 'linear')
      || material?.rotate === false
      || Boolean(material?.laminationMaterialId)
      || tiers;
  })) return true;

  if (Array.isArray(draft.pieces) && draft.pieces.some((piece) => positive(piece?.widthCm) > 0 || positive(piece?.heightCm) > 0 || positive(piece?.quantity, 1) !== 1 || (piece?.description && piece.description !== 'Peça nova'))) return true;
  if (positive(draft.globalBleed) > 0 || positive(draft.globalGap, 2) !== 2 || draft.optimize === false) return true;
  if (positive(draft.salePrice) > 0 || positive(draft.otherCosts) > 0 || number(draft.targetMargin, 35) !== 35) return true;

  const installation = draft.installation || {};
  if ((installation.type && installation.type !== 'lona')
    || (installation.basis && installation.basis !== 'm2')
    || positive(installation.quantity) > 0
    || positive(installation.unitPrice) > 0
    || positive(installation.travel) > 0
    || installation.autoQuantity === false
    || (Array.isArray(installation.supplies) && installation.supplies.length > 0)) return true;
  return false;
}

export function shouldSyncDraft(draftRecord) {
  return draftRecord?.clearIntent === true || hasMeaningfulDraft(draftRecord);
}

export function shouldQueueLocalRecord(record) {
  return Boolean(record) && (!record._cloudVersionAt || record._cloudDirty === true);
}

export function conflictCopyId(item) {
  const signature = JSON.stringify(stableValue({
    recordType: item?.recordType || '',
    recordId: item?.recordId || '',
    deleted: item?.deleted === true,
    payload: item?.payload ?? null,
  }));
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < signature.length; index += 1) {
    const code = signature.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ (code + index), 3266489917);
  }
  return `conflict-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}
