export const UNOWNED_LEGACY_OWNER_MARKER = '__unowned__';

export function legacyOwnerFromStorage(storedMarker, currentOwner) {
  if (storedMarker !== null) return storedMarker === UNOWNED_LEGACY_OWNER_MARKER ? '' : storedMarker;
  return currentOwner || '';
}

export function localDatabaseNameForOwner(ownerId, legacyOwnerId, baseName = 'nesto-local-v1') {
  if (!ownerId || ownerId === legacyOwnerId) return baseName;
  const safeOwnerId = String(ownerId).replace(/[^a-z0-9-]/gi, '_').slice(0, 120);
  return `${baseName}-user-${safeOwnerId}`;
}
