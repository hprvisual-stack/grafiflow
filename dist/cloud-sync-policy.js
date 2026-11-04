function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const metadata = new Set(['_syncUpdatedAt', '_cloudVersionAt', '_cloudDirty', 'updatedAt']);
  return Object.fromEntries(Object.keys(value).filter((key) => !metadata.has(key)).sort().map((key) => [key, stableValue(value[key])]));
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
