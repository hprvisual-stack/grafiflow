const APP_VERSION = '1.2.0';
const DB_NAME = 'nesto-local-v1';
const DB_VERSION = 2;
const CLOUD_SESSION_KEY = 'grafiflow.auth.v1';
const CLOUD_WORKSPACE_KEY = 'grafiflow.workspace.v1';
const CLOUD_OWNER_KEY = 'grafiflow.local.owner.v1';
const MATERIAL_COLORS = ['#0a97e0', '#35bdc4', '#072d54', '#f5c51d', '#e52b7a', '#3d82b5', '#0f9f8a', '#6a78d4'];

const defaultMaterial = () => ({
  id: uid('mat'),
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
});

const defaultPiece = (materialId) => ({
  id: uid('piece'),
  description: 'Peça nova',
  descriptionIsDefault: true,
  materialId,
  widthCm: 0,
  heightCm: 0,
  quantity: 1,
});

const defaultClientQuote = () => ({
  businessName: '',
  businessPhone: '',
  businessEmail: '',
  clientName: '',
  clientContact: '',
  validity: '7 dias',
  validityIsDefault: true,
  deadline: '',
  paymentTerms: '50% de entrada e saldo na entrega',
  paymentTermsIsDefault: true,
  notes: '',
});

const state = {
  appVersion: APP_VERSION,
  quoteId: null,
  quoteName: '',
  clientQuote: defaultClientQuote(),
  materials: [defaultMaterial()],
  pieces: [],
  globalBleed: 0,
  globalGap: 2,
  optimize: true,
  installation: {
    type: 'lona',
    basis: 'm2',
    quantity: 0,
    unitPrice: 0,
    travel: 0,
    autoQuantity: true,
    supplies: [],
  },
  salePrice: 0,
  otherCosts: 0,
  targetMargin: 35,
};

let savedMaterials = [];
let savedMaterialVolumeTiers = [];
let savedQuotes = [];
let computed = emptyComputed();
let dbPromise;
let draftTimer;
let deferredInstallPrompt = null;
let cloudSession = null;
let cloudWorkspaceId = '';
let cloudWorkspaceName = '';
let cloudSyncTimer;
let cloudSyncRunning = false;
let suppressCloudQueue = false;
let authMode = 'login';

function uid(prefix) {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function emptyComputed() {
  return {
    materialResults: [],
    laminationResults: [],
    laminationLengthM: 0,
    laminationSheets: 0,
    totalLengthM: 0,
    totalSheets: 0,
    consumedAreaM2: 0,
    laminationAreaM2: 0,
    piecesAreaM2: 0,
    wasteAreaM2: 0,
    utilization: 0,
    baseMaterialCost: 0,
    laminationCost: 0,
    materialCost: 0,
    installationCost: 0,
    suppliesCost: 0,
    travelCost: 0,
    otherCosts: 0,
    totalCost: 0,
    salePrice: 0,
    profit: 0,
    margin: 0,
    markup: 0,
    suggestedPrice: 0,
    warnings: [],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function num(value, fallback = 0) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value, fallback = 0) {
  return Math.max(0, num(value, fallback));
}

function normalizeVolumePricing(tiers) {
  if (!Array.isArray(tiers)) return [];
  return tiers
    .map((tier) => ({
      minQuantity: positive(tier?.minQuantity),
      unitPrice: positive(tier?.unitPrice),
    }))
    .filter((tier) => tier.minQuantity > 0 && tier.unitPrice > 0)
    .sort((a, b) => a.minQuantity - b.minQuantity);
}

function materialPricingUnit(material) {
  if (material.calculationMode === 'area' || material.basis === 'm2') return 'm²';
  return material.basis === 'sheet' ? 'chapa' : 'm';
}

function resolveMaterialPricing(material, quantity) {
  const basePrice = positive(material.price);
  const eligibleTiers = normalizeVolumePricing(material.volumePricing).filter((tier) => tier.minQuantity <= positive(quantity) + 0.000001);
  const tier = eligibleTiers[eligibleTiers.length - 1] || null;
  return {
    unitPrice: tier ? tier.unitPrice : basePrice,
    tier,
  };
}

function formatNumber(value, decimals = 2) {
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Number.isFinite(value) ? value : 0);
}

function formatMoney(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value) {
  return `${formatNumber(value, 1)}%`;
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return '—';
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeXml(value) {
  return escapeHtml(value);
}

function materialColor(index) {
  return MATERIAL_COLORS[index % MATERIAL_COLORS.length];
}

function materialLabelColor(color) {
  const hex = color.replace('#', '');
  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.232 ? '#072d54' : '#ffffff';
}

function materialIndex(materialId) {
  return Math.max(0, state.materials.findIndex((material) => material.id === materialId));
}

function getMaterial(materialId) {
  return state.materials.find((material) => material.id === materialId) || state.materials[0];
}

function openDatabase() {
  if (dbPromise) return dbPromise;
  if (!('indexedDB' in window) || !window.indexedDB) return Promise.resolve(null);
  dbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('quotes')) db.createObjectStore('quotes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('materials')) db.createObjectStore('materials', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('syncQueue')) db.createObjectStore('syncQueue', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeGetAll(storeName) {
  const db = await openDatabase();
  if (!db) return [];
  const transaction = db.transaction(storeName, 'readonly');
  return idbRequest(transaction.objectStore(storeName).getAll());
}

async function storeGet(storeName, key) {
  const db = await openDatabase();
  if (!db) return undefined;
  const transaction = db.transaction(storeName, 'readonly');
  return idbRequest(transaction.objectStore(storeName).get(key));
}

async function storePut(storeName, value) {
  const db = await openDatabase();
  if (!db) return;
  let storedValue = value;
  if (!suppressCloudQueue && ['materials', 'quotes'].includes(storeName)) {
    storedValue = { ...value, _syncUpdatedAt: new Date().toISOString() };
  }
  const transaction = db.transaction(storeName, 'readwrite');
  await idbRequest(transaction.objectStore(storeName).put(storedValue));
  if (!suppressCloudQueue) await queueCloudMutation(storeName, storedValue).catch((error) => console.warn('Não foi possível registrar a sincronização pendente.', error));
}

async function storeDelete(storeName, key) {
  const db = await openDatabase();
  if (!db) return;
  const transaction = db.transaction(storeName, 'readwrite');
  await idbRequest(transaction.objectStore(storeName).delete(key));
  if (!suppressCloudQueue) await queueCloudMutation(storeName, null, { recordId: key, deleted: true }).catch((error) => console.warn('Não foi possível registrar a exclusão pendente.', error));
}

function cloudConfig() {
  const config = window.GRAFIFLOW_CONFIG || {};
  return { url: String(config.supabaseUrl || '').replace(/\/$/, ''), key: String(config.supabaseAnonKey || '') };
}

function cloudConfigured() {
  const config = cloudConfig();
  return Boolean(config.url && config.key);
}

function readCloudSession() {
  try {
    const saved = localStorage.getItem(CLOUD_SESSION_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

function saveCloudSession(session) {
  cloudSession = session;
  try {
    if (session) localStorage.setItem(CLOUD_SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(CLOUD_SESSION_KEY);
  } catch (error) {
    console.warn('A sessão não pôde ser mantida neste navegador.', error);
  }
  updateAccountStatus();
}

function recordIdentity(storeName, value) {
  if (storeName === 'settings' && value?.key === 'draft') return { type: 'draft', id: 'draft' };
  if (storeName === 'materials' && value?.id) return { type: 'material', id: String(value.id) };
  if (storeName === 'quotes' && value?.id) return { type: 'quote', id: String(value.id) };
  return null;
}

async function queueCloudMutation(storeName, value, { recordId = '', deleted = false } = {}) {
  if (suppressCloudQueue || !['settings', 'materials', 'quotes'].includes(storeName)) return;
  const identity = value ? recordIdentity(storeName, value) : storeName === 'settings' ? null : { type: storeName === 'materials' ? 'material' : 'quote', id: String(recordId) };
  if (!identity) return;
  const db = await openDatabase();
  if (!db) return;
  const queueId = `${identity.type}:${identity.id}`;
  const timestamp = value?.updatedAt || value?._syncUpdatedAt || new Date().toISOString();
  const existing = await storeGet('syncQueue', queueId);
  if (existing && new Date(existing.updatedAt).getTime() > new Date(timestamp).getTime()) return;
  const transaction = db.transaction('syncQueue', 'readwrite');
  await idbRequest(transaction.objectStore('syncQueue').put({
    id: queueId,
    recordType: identity.type,
    recordId: identity.id,
    payload: deleted ? null : clone(value),
    deleted,
    updatedAt: timestamp,
  }));
  scheduleCloudSync();
}

function hasMeaningfulDraft(draftRecord) {
  const draft = draftRecord?.value && typeof draftRecord.value === 'object' ? draftRecord.value : draftRecord;
  if (!draft || typeof draft !== 'object') return false;
  if (draft.quoteId || String(draft.quoteName || '').trim()) return true;

  const client = draft.clientQuote || {};
  if (['businessName', 'businessPhone', 'businessEmail', 'clientName', 'clientContact', 'notes'].some((key) => String(client[key] || '').trim())) return true;
  if (client.validity && client.validity !== '7 dias') return true;
  if (client.paymentTerms && client.paymentTerms !== '50% de entrada e saldo na entrega') return true;

  if (Array.isArray(draft.materials) && draft.materials.some((material) => {
    const name = String(material?.name || '').trim();
    return (name && name !== 'Material principal' && !/^Material \d+$/.test(name))
      || String(material?.supplier || '').trim()
      || positive(material?.price) > 0
      || positive(material?.heightCm) > 0
      || material?.widthIsDefault === false
      || (material?.calculationMode && material.calculationMode !== 'roll')
      || (material?.basis && material.basis !== 'linear')
      || material?.rotate === false
      || Boolean(material?.laminationMaterialId)
      || normalizeVolumePricing(material?.volumePricing).length > 0;
  })) return true;

  if (Array.isArray(draft.pieces) && draft.pieces.some((piece) => positive(piece?.widthCm) > 0 || positive(piece?.heightCm) > 0 || positive(piece?.quantity, 1) !== 1 || (piece?.description && piece.description !== 'Peça nova'))) return true;
  if (positive(draft.globalBleed) > 0 || positive(draft.globalGap, 2) !== 2 || draft.optimize === false) return true;
  if (positive(draft.salePrice) > 0 || positive(draft.otherCosts) > 0 || num(draft.targetMargin, 35) !== 35) return true;

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

function shouldSyncDraft(draftRecord) {
  return draftRecord?.cloudIntent === true || hasMeaningfulDraft(draftRecord);
}

async function deleteQueuedMutation(id) {
  const db = await openDatabase();
  if (db) await idbRequest(db.transaction('syncQueue', 'readwrite').objectStore('syncQueue').delete(id));
}

async function cloudFetch(path, { method = 'GET', body, token = cloudSession?.access_token } = {}) {
  const config = cloudConfig();
  if (!config.url || !config.key) throw new Error('A conexão com o Supabase ainda não foi configurada.');
  const response = await fetch(`${config.url}${path}`, {
    method,
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${token || config.key}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(path.startsWith('/rest/v1/rpc/') ? { 'Content-Profile': 'public', 'Accept-Profile': 'public' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let result = null;
  if (text) {
    try { result = JSON.parse(text); } catch { result = { message: text }; }
  }
  if (!response.ok) {
    const error = new Error(result?.msg || result?.message || result?.error_description || result?.error || `Supabase respondeu ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return result;
}

async function usableCloudSession() {
  if (!cloudSession?.access_token) throw new Error('Entre na sua conta GrafiFlow para sincronizar.');
  if (!navigator.onLine) return cloudSession;
  const expiresAt = Number(cloudSession.expires_at || 0) * 1000;
  if (expiresAt && expiresAt > Date.now() + 60_000) return cloudSession;
  if (!cloudSession.refresh_token) throw new Error('Sua sessão expirou. Entre novamente para sincronizar.');
  const refreshed = await cloudFetch('/auth/v1/token?grant_type=refresh_token', { method: 'POST', token: cloudConfig().key, body: { refresh_token: cloudSession.refresh_token } });
  const session = { ...refreshed, expires_at: Math.floor(Date.now() / 1000) + Number(refreshed.expires_in || 3600) };
  saveCloudSession(session);
  return session;
}

function scheduleCloudSync() {
  if (!cloudSession || !cloudWorkspaceId || !navigator.onLine || !cloudConfigured()) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => syncCloudNow().catch((error) => {
    console.warn('A sincronização será retomada quando houver conexão.', error);
    updateAccountStatus('Aguardando sincronização');
  }), 900);
}

async function getWorkspaceMembership() {
  const session = await usableCloudSession();
  const userId = encodeURIComponent(session.user?.id || '');
  const members = await cloudFetch(`/rest/v1/workspace_members?select=workspace_id,role&user_id=eq.${userId}&limit=1`, { token: session.access_token });
  const membership = Array.isArray(members) ? members[0] : null;
  if (!membership?.workspace_id) throw new Error('A conta foi criada, mas o espaço de trabalho ainda não ficou disponível.');
  cloudWorkspaceId = membership.workspace_id;
  try { localStorage.setItem(CLOUD_WORKSPACE_KEY, cloudWorkspaceId); } catch { /* armazenamento local opcional */ }
  const workspaces = await cloudFetch(`/rest/v1/workspaces?select=id,name&id=eq.${encodeURIComponent(cloudWorkspaceId)}&limit=1`, { token: session.access_token });
  cloudWorkspaceName = Array.isArray(workspaces) ? (workspaces[0]?.name || '') : '';
  updateAccountStatus();
  return cloudWorkspaceId;
}

async function queueLocalDataForFirstSync() {
  const [draft, materials, quotes] = await Promise.all([
    storeGet('settings', 'draft'), storeGetAll('materials'), storeGetAll('quotes'),
  ]);
  const queuedDraft = await storeGet('syncQueue', 'draft:draft');
  const queueIsNewer = queuedDraft && (!draft || (new Date(queuedDraft.updatedAt).getTime() > new Date(draft.updatedAt || 0).getTime()));
  const draftForSync = queueIsNewer ? queuedDraft.payload : draft;
  if (shouldSyncDraft(draftForSync)) {
    if (draftForSync && (!queuedDraft || !queueIsNewer)) await queueCloudMutation('settings', draftForSync);
  } else if (queuedDraft) {
    await deleteQueuedMutation(queuedDraft.id);
  }
  for (const material of materials) await queueCloudMutation('materials', material);
  for (const quote of quotes) await queueCloudMutation('quotes', quote);
}

async function localRecordTimestamp(recordType, recordId) {
  const queued = await storeGet('syncQueue', `${recordType}:${recordId}`);
  let value;
  if (recordType === 'draft') value = await storeGet('settings', 'draft');
  if (recordType === 'material') value = await storeGet('materials', recordId);
  if (recordType === 'quote') value = await storeGet('quotes', recordId);
  const queueIsNewer = queued && (!value || (new Date(queued.updatedAt).getTime() > new Date(value.updatedAt || 0).getTime()));
  if (recordType === 'draft' && !shouldSyncDraft(queueIsNewer ? queued.payload : value)) return 0;
  const valueTime = value?.updatedAt || value?._syncUpdatedAt || '';
  const queueTime = queued?.updatedAt || '';
  return Math.max(new Date(valueTime || 0).getTime() || 0, new Date(queueTime || 0).getTime() || 0);
}

async function applyCloudRecords(records) {
  suppressCloudQueue = true;
  let stateChanged = false;
  try {
    for (const record of records || []) {
      const cloudTime = new Date(record.updated_at || 0).getTime() || 0;
      if (await localRecordTimestamp(record.record_type, record.record_id) > cloudTime) continue;
      const storeName = record.record_type === 'draft' ? 'settings' : record.record_type === 'material' ? 'materials' : 'quotes';
      if (record.is_deleted) {
        await storeDelete(storeName, record.record_type === 'draft' ? 'draft' : record.record_id);
        if (record.record_type === 'draft') stateChanged = true;
        continue;
      }
      const payload = record.payload;
      if (record.record_type === 'draft') {
        if (payload?.value) {
          await storePut('settings', { key: 'draft', value: payload.value, updatedAt: record.updated_at, cloudIntent: payload.cloudIntent === true });
          stateChanged = true;
        }
      } else if (record.record_type === 'material' && payload?.id) {
        await storePut('materials', { ...payload, id: record.record_id, _syncUpdatedAt: record.updated_at });
      } else if (record.record_type === 'quote' && payload?.id) {
        await storePut('quotes', { ...payload, id: record.record_id, _syncUpdatedAt: record.updated_at });
      }
    }
  } finally {
    suppressCloudQueue = false;
  }
  await loadPersistence();
  if (!state.pieces.length) state.pieces.push(defaultPiece(state.materials[0]?.id));
  if (stateChanged || records?.length) renderAll({ persistDraft: false });
}

async function syncCloudNow() {
  if (!cloudSession || !cloudWorkspaceId || !navigator.onLine || !cloudConfigured() || cloudSyncRunning) return;
  cloudSyncRunning = true;
  let syncSucceeded = false;
  updateAccountStatus('Sincronizando…');
  try {
    const session = await usableCloudSession();
    const queuedItems = await storeGetAll('syncQueue');
    const queue = [];
    for (const item of queuedItems) {
      if (item.recordType === 'draft' && !shouldSyncDraft(item.payload)) {
        await deleteQueuedMutation(item.id);
      } else {
        queue.push(item);
      }
    }
    const changes = queue.map((item) => ({
      record_type: item.recordType,
      record_id: item.recordId,
      payload: item.deleted ? null : item.payload,
      is_deleted: item.deleted,
      updated_at: item.updatedAt,
    }));
    for (let index = 0; index < changes.length; index += 100) {
      await cloudFetch('/rest/v1/rpc/sync_grafiflow_records', {
        method: 'POST', token: session.access_token,
        body: { target_workspace_id: cloudWorkspaceId, changes: changes.slice(index, index + 100) },
      });
    }
    for (const item of queue) {
      const current = await storeGet('syncQueue', item.id);
      if (current?.updatedAt === item.updatedAt) {
        const db = await openDatabase();
        if (db) await idbRequest(db.transaction('syncQueue', 'readwrite').objectStore('syncQueue').delete(item.id));
      }
    }
    const records = [];
    let offset = 0;
    while (true) {
      const page = await cloudFetch(`/rest/v1/grafiflow_records?select=workspace_id,record_type,record_id,payload,is_deleted,updated_at&workspace_id=eq.${encodeURIComponent(cloudWorkspaceId)}&order=record_type.asc,record_id.asc&limit=500&offset=${offset}`, { token: session.access_token });
      if (!Array.isArray(page) || !page.length) break;
      records.push(...page);
      if (page.length < 500) break;
      offset += page.length;
    }
    await applyCloudRecords(records);
    syncSucceeded = true;
    updateAccountStatus('Sincronizado');
  } finally {
    cloudSyncRunning = false;
    updateAccountStatus();
    const pending = await storeGetAll('syncQueue').catch(() => []);
    if (syncSucceeded && pending.length) scheduleCloudSync();
  }
}

async function activateCloudSession(session) {
  saveCloudSession({ ...session, expires_at: session.expires_at || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600) });
  const ownerId = cloudSession?.user?.id || '';
  let localOwner = '';
  try { localOwner = localStorage.getItem(CLOUD_OWNER_KEY) || ''; } catch { /* armazenamento local opcional */ }
  if (localOwner && ownerId && localOwner !== ownerId) {
    cloudWorkspaceId = '';
    updateAccountStatus('Os dados locais deste dispositivo pertencem a outra conta. Exporte um backup antes de trocar de conta.');
    showToast('Para proteger seus dados, este dispositivo não sincronizou com a conta diferente.', 'error');
    return;
  }
  if (!localOwner && ownerId) {
    try { localStorage.setItem(CLOUD_OWNER_KEY, ownerId); } catch { /* armazenamento local opcional */ }
  }
  if (!navigator.onLine) {
    updateAccountStatus('Conta disponível offline');
    return;
  }
  try {
    await getWorkspaceMembership();
    await queueLocalDataForFirstSync();
    await syncCloudNow();
  } catch (error) {
    console.warn('Não foi possível iniciar a sincronização da conta.', error);
    updateAccountStatus(error.message || 'Sincronização indisponível');
    showToast(error.message || 'Não foi possível iniciar a sincronização.', 'error');
  }
}

async function restoreCloudAccount() {
  const saved = readCloudSession();
  if (!saved?.access_token) return;
  cloudWorkspaceId = (() => { try { return localStorage.getItem(CLOUD_WORKSPACE_KEY) || ''; } catch { return ''; } })();
  saveCloudSession(saved);
  let localOwner = '';
  try { localOwner = localStorage.getItem(CLOUD_OWNER_KEY) || ''; } catch { /* armazenamento local opcional */ }
  if (localOwner && saved.user?.id && localOwner !== saved.user.id) {
    cloudWorkspaceId = '';
    updateAccountStatus('Os dados locais deste dispositivo pertencem a outra conta. Exporte um backup antes de trocar de conta.');
    return;
  }
  if (!cloudConfigured() || !navigator.onLine) {
    updateAccountStatus(navigator.onLine ? 'Configure o Supabase para sincronizar' : 'Conta disponível offline');
    return;
  }
  try {
    const session = await usableCloudSession();
    const user = await cloudFetch('/auth/v1/user', { token: session.access_token });
    saveCloudSession({ ...session, user });
    if (!cloudWorkspaceId) await getWorkspaceMembership();
    await queueLocalDataForFirstSync();
    await syncCloudNow();
  } catch (error) {
    if (error.status === 401) {
      saveCloudSession(null);
      cloudWorkspaceId = '';
    }
    updateAccountStatus(error.message || 'Sincronização indisponível');
  }
}

function updateAccountStatus(message = '') {
  const button = document.getElementById('account-button');
  const status = document.getElementById('account-modal-status');
  const configured = cloudConfigured();
  const signedIn = Boolean(cloudSession?.user?.email || cloudSession?.user?.id);
  if (button) {
    button.textContent = signedIn ? 'Conta conectada' : 'Entrar e sincronizar';
    button.title = signedIn ? (cloudSession.user.email || cloudWorkspaceName || 'Conta GrafiFlow') : 'Entre para sincronizar seus dados entre dispositivos';
  }
  if (status) {
    status.textContent = message || (signedIn
      ? (cloudSyncRunning ? 'Sincronizando dados…' : !navigator.onLine ? 'Sem internet. Seus dados continuam salvos neste dispositivo.' : cloudWorkspaceName ? `Conectado a ${cloudWorkspaceName}.` : 'Conta conectada; aguardando sincronização.')
      : configured ? 'Entre ou crie uma conta para manter seus dados sincronizados entre dispositivos.' : 'A conta em nuvem será ativada quando a conexão com o Supabase estiver configurada. O modo offline segue funcionando.');
  }
  const signOut = document.getElementById('auth-signout');
  if (signOut) signOut.hidden = !signedIn;
  const syncNow = document.getElementById('auth-sync-now');
  if (syncNow) {
    syncNow.hidden = !signedIn;
    syncNow.disabled = !navigator.onLine || cloudSyncRunning || !cloudWorkspaceId;
  }
  const submit = document.getElementById('auth-submit');
  if (submit) submit.disabled = signedIn || !configured;
  const toggle = document.getElementById('auth-mode-toggle');
  if (toggle) toggle.hidden = signedIn;
  const form = document.getElementById('account-auth-form');
  if (form) form.hidden = signedIn;
}

function renderAuthMode() {
  const creating = authMode === 'signup';
  const nameField = document.getElementById('auth-name-field');
  const workspaceField = document.getElementById('auth-workspace-field');
  const password = document.getElementById('auth-password');
  const submit = document.getElementById('auth-submit');
  const toggle = document.getElementById('auth-mode-toggle');
  const title = document.getElementById('account-modal-title');
  if (nameField) nameField.hidden = !creating;
  if (workspaceField) workspaceField.hidden = !creating;
  if (password) password.autocomplete = creating ? 'new-password' : 'current-password';
  if (password) password.minLength = creating ? 8 : 1;
  if (submit) submit.textContent = creating ? 'Criar conta' : 'Entrar';
  if (toggle) toggle.textContent = creating ? 'Já tenho uma conta' : 'Criar conta';
  if (title) title.textContent = creating ? 'Criar conta GrafiFlow' : 'Entrar e sincronizar';
}

function openAccountModal() {
  authMode = 'login';
  renderAuthMode();
  updateAccountStatus();
  const modal = document.getElementById('account-modal');
  if (modal) modal.hidden = false;
}

async function submitCloudAuth(event) {
  event.preventDefault();
  if (!cloudConfigured()) {
    showToast('A sincronização será ativada após configurar o projeto Supabase.', 'error');
    return;
  }
  const email = document.getElementById('auth-email')?.value.trim();
  const password = document.getElementById('auth-password')?.value;
  const creating = authMode === 'signup';
  const body = creating ? {
    email, password,
    data: {
      full_name: document.getElementById('auth-full-name')?.value.trim() || '',
      workspace_name: document.getElementById('auth-workspace-name')?.value.trim() || '',
    },
  } : { email, password };
  const submit = document.getElementById('auth-submit');
  if (submit) { submit.disabled = true; submit.textContent = creating ? 'Criando…' : 'Entrando…'; }
  try {
    const response = creating
      ? await cloudFetch('/auth/v1/signup', { method: 'POST', token: cloudConfig().key, body })
      : await cloudFetch('/auth/v1/token?grant_type=password', { method: 'POST', token: cloudConfig().key, body });
    if (response?.access_token) {
      await activateCloudSession({ ...response, user: response.user });
      if (cloudSession?.access_token) {
        document.getElementById('account-modal').hidden = true;
        document.getElementById('account-auth-form')?.reset();
      }
      showToast('Conta GrafiFlow conectada.');
    } else if (creating) {
      showToast('Conta criada. Confirme o e-mail para depois entrar e sincronizar.');
      authMode = 'login';
      renderAuthMode();
    } else {
      throw new Error('O Supabase não retornou uma sessão. Verifique o e-mail e a senha.');
    }
  } catch (error) {
    showToast(error.message || 'Não foi possível conectar a conta.', 'error');
  } finally {
    if (submit) { submit.disabled = !cloudConfigured() || Boolean(cloudSession); renderAuthMode(); }
    updateAccountStatus();
  }
}

async function signOutCloudAccount() {
  try {
    if (cloudSession?.access_token && navigator.onLine && cloudConfigured()) {
      await cloudFetch('/auth/v1/logout', { method: 'POST', body: {}, token: cloudSession.access_token });
    }
  } catch (error) {
    console.warn('A sessão local será encerrada mesmo sem resposta do servidor.', error);
  }
  saveCloudSession(null);
  cloudWorkspaceId = '';
  cloudWorkspaceName = '';
  try { localStorage.removeItem(CLOUD_WORKSPACE_KEY); } catch { /* armazenamento local opcional */ }
  updateAccountStatus();
  showToast('Sessão encerrada. Os dados locais foram mantidos.');
}

async function loadPersistence() {
  try {
    const [draft, materials, quotes] = await Promise.all([
      storeGet('settings', 'draft'),
      storeGetAll('materials'),
      storeGetAll('quotes'),
    ]);
    if (draft?.value) hydrateState(draft.value, { inferDefaultText: !draft.value.quoteId });
    if (materials.length) savedMaterials = materials.map(normalizeMaterial);
    if (quotes.length) savedQuotes = quotes.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  } catch (error) {
    console.warn('Não foi possível abrir o armazenamento local.', error);
    showToast('O cálculo funciona, mas o armazenamento local não pôde ser aberto.', 'error');
  }
}

function hydrateState(source, { inferDefaultText = false } = {}) {
  if (!source || typeof source !== 'object') return;
  state.quoteId = source.quoteId || null;
  state.quoteName = source.quoteName || '';
  const clientDefaults = defaultClientQuote();
  const clientQuote = { ...clientDefaults, ...(source.clientQuote || {}) };
  state.clientQuote = {
    ...clientQuote,
    validityIsDefault: source.clientQuote?.validityIsDefault ?? (inferDefaultText && clientQuote.validity === clientDefaults.validity),
    paymentTermsIsDefault: source.clientQuote?.paymentTermsIsDefault ?? (inferDefaultText && clientQuote.paymentTerms === clientDefaults.paymentTerms),
  };
  state.materials = Array.isArray(source.materials) && source.materials.length ? source.materials.map((entry) => {
    const hasDefaultName = entry.name === 'Material principal' || /^Material \d+$/.test(String(entry.name || ''));
    const nameIsDefault = entry.nameIsDefault ?? (inferDefaultText && hasDefaultName);
    const material = normalizeMaterial(entry, { inferDefaultWidth: inferDefaultText && entry.nameIsDefault === true });
    return { ...material, nameIsDefault };
  }) : [defaultMaterial()];
  const materialIds = new Set(state.materials.map((material) => material.id));
  state.materials = state.materials.map((material) => material.laminationMaterialId && materialIds.has(material.laminationMaterialId) ? material : { ...material, laminationMaterialId: null });
  state.pieces = Array.isArray(source.pieces) ? source.pieces.map((piece) => ({
    id: piece.id || uid('piece'),
    description: String(piece.description ?? 'Peça'),
    descriptionIsDefault: piece.descriptionIsDefault ?? (inferDefaultText && piece.description === 'Peça nova'),
    materialId: materialIds.has(piece.materialId) ? piece.materialId : state.materials[0].id,
    widthCm: positive(piece.widthCm),
    heightCm: positive(piece.heightCm),
    quantity: Math.max(1, Math.floor(positive(piece.quantity, 1))),
  })) : [];
  state.globalBleed = positive(source.globalBleed);
  state.globalGap = positive(source.globalGap, 2);
  state.optimize = source.optimize !== false;
  state.installation = {
    type: source.installation?.type || 'lona',
    basis: source.installation?.basis || 'm2',
    quantity: positive(source.installation?.quantity),
    unitPrice: positive(source.installation?.unitPrice),
    travel: positive(source.installation?.travel),
    autoQuantity: source.installation?.autoQuantity !== false,
    supplies: Array.isArray(source.installation?.supplies) ? source.installation.supplies.map((entry) => {
      const supply = normalizeSupply(entry);
      return {
        ...supply,
        descriptionIsDefault: entry.descriptionIsDefault ?? (inferDefaultText && entry.description === 'Novo insumo'),
        unitIsDefault: entry.unitIsDefault ?? (inferDefaultText && entry.unit === 'un'),
      };
    }) : [],
  };
  state.salePrice = positive(source.salePrice);
  state.otherCosts = positive(source.otherCosts);
  state.targetMargin = Math.min(99.9, Math.max(0, num(source.targetMargin, 35)));
}

function normalizeMaterial(material, { inferDefaultWidth = false } = {}) {
  const calculationMode = ['area', 'sheet'].includes(material.calculationMode) ? material.calculationMode : 'roll';
  const widthCm = positive(material.widthCm, 320);
  return {
    id: material.id || uid('mat'),
    name: String(material.name ?? 'Material'),
    nameIsDefault: material.nameIsDefault === true,
    supplier: String(material.supplier || '').trim(),
    calculationMode,
    widthCm,
    widthIsDefault: material.widthIsDefault ?? (inferDefaultWidth && widthCm === 320 && material.nameIsDefault === true),
    heightCm: positive(material.heightCm),
    price: positive(material.price),
    basis: calculationMode === 'area' ? 'm2' : calculationMode === 'sheet' ? (material.basis === 'm2' ? 'm2' : 'sheet') : (material.basis === 'm2' ? 'm2' : 'linear'),
    volumePricing: normalizeVolumePricing(material.volumePricing),
    gapMm: positive(material.gapMm, 2),
    rotate: material.rotate !== false,
    laminationMaterialId: material.laminationMaterialId || null,
    _syncUpdatedAt: material._syncUpdatedAt || undefined,
  };
}

function normalizeSupply(supply) {
  return {
    id: supply.id || uid('supply'),
    description: String(supply.description ?? 'Insumo'),
    descriptionIsDefault: supply.descriptionIsDefault === true,
    quantity: positive(supply.quantity, 1),
    unit: String(supply.unit ?? 'un'),
    unitIsDefault: supply.unitIsDefault === true,
    unitPrice: positive(supply.unitPrice),
  };
}

function persistDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(async () => {
    try {
      await storePut('settings', { key: 'draft', value: clone(state), updatedAt: new Date().toISOString(), cloudIntent: true });
    } catch (error) {
      console.warn('Falha ao guardar rascunho local.', error);
    }
  }, 320);
}

function showToast(message, kind = 'success') {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  region.append(toast);
  setTimeout(() => toast.remove(), 3400);
}

function setValue(id, value) {
  const element = document.getElementById(id);
  if (element && document.activeElement !== element) element.value = value;
}

function setClearOnFocus(id, enabled) {
  const element = document.getElementById(id);
  if (!element) return;
  if (enabled) element.dataset.clearOnFocus = 'true';
  else delete element.dataset.clearOnFocus;
}

function setToggle(id, active) {
  const element = document.getElementById(id);
  if (!element) return;
  element.classList.toggle('on', active);
  element.setAttribute('aria-checked', String(active));
}

function renderStaticControls() {
  setValue('quote-name', state.quoteName);
  setValue('global-bleed', state.globalBleed);
  setValue('global-gap', state.globalGap);
  setValue('installation-type', state.installation.type);
  setValue('installation-basis', state.installation.basis);
  setValue('installation-quantity', state.installation.quantity);
  setValue('installation-unit-price', state.installation.unitPrice);
  setValue('installation-travel', state.installation.travel);
  setValue('sale-price', state.salePrice);
  setValue('other-costs', state.otherCosts);
  setValue('target-margin', state.targetMargin);
  setToggle('optimize-button', state.optimize);
  setToggle('auto-installation-button', state.installation.autoQuantity);
}

function isStandaloneApp() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function renderInstallButton() {
  const visible = Boolean(deferredInstallPrompt) && !isStandaloneApp();
  const topButton = document.getElementById('install-button');
  const helpButton = document.getElementById('help-install-button');
  if (topButton) topButton.hidden = !visible;
  if (helpButton) helpButton.hidden = !visible;
}

async function installApp() {
  if (!deferredInstallPrompt) {
    showToast('Use o menu do navegador para adicionar o GrafiFlow à tela inicial.', 'error');
    return;
  }
  const promptEvent = deferredInstallPrompt;
  deferredInstallPrompt = null;
  renderInstallButton();
  await promptEvent.prompt();
  await promptEvent.userChoice.catch(() => undefined);
}

function renderVolumePricingEditor(material) {
  const unit = materialPricingUnit(material) === 'chapa' ? 'chapas' : materialPricingUnit(material);
  const priceUnit = unit === 'chapas' ? 'chapa' : unit;
  const tiers = Array.isArray(material.volumePricing) ? material.volumePricing : [];
  return `
    <div class="volume-pricing-box full-width">
      <div class="volume-pricing-heading">
        <div><span class="section-kicker">PREÇO POR VOLUME</span><strong>Redução conforme a quantidade</strong><p>O preço base vale até a primeira faixa. Ao atingir uma faixa, o novo preço unitário vale para todo o material calculado.</p></div>
        <button class="secondary-button small-button" type="button" data-action="add-material-tier" data-id="${escapeHtml(material.id)}">+ Faixa</button>
      </div>
      <div class="volume-pricing-list">
        ${tiers.map((tier, tierIndex) => `
          <div class="volume-pricing-row">
            <label class="field"><span>A partir de <small>(${unit})</small></span><input data-material-id="${escapeHtml(material.id)}" data-material-field="tierMinQuantity" data-tier-index="${tierIndex}" type="number" min="0.01" step="0.01" value="${tier.minQuantity || ''}" placeholder="10" /></label>
            <label class="field"><span>Preço unitário <small>(R$/${priceUnit})</small></span><input data-material-id="${escapeHtml(material.id)}" data-material-field="tierUnitPrice" data-tier-index="${tierIndex}" type="number" min="0" step="0.01" value="${tier.unitPrice || ''}" placeholder="0,00" /></label>
            <button class="row-remove" type="button" data-action="remove-material-tier" data-id="${escapeHtml(material.id)}" data-tier-index="${tierIndex}" aria-label="Remover faixa">×</button>
          </div>
        `).join('')}
      </div>
      ${tiers.length ? `<p class="material-note volume-pricing-note">Ex.: a partir de 10 ${unit}, o preço passa para o valor informado. O sistema usa automaticamente a maior faixa alcançada.</p>` : ''}
    </div>
  `;
}

function renderMaterialEditors() {
  const container = document.getElementById('material-editor-list');
  if (!container) return;
  container.innerHTML = state.materials.map((material, index) => {
    const isSheet = material.calculationMode === 'sheet';
    const isArea = material.calculationMode === 'area';
    const priceUnit = isArea || material.basis === 'm2' ? 'R$/m²' : isSheet ? 'R$/chapa' : 'R$/m linear';
    return `
      <div class="material-editor" data-material-card="${escapeHtml(material.id)}">
        <div class="material-editor-top">
          <div class="material-name-display"><span class="material-color" style="background:${materialColor(index)}"></span><span class="material-title">${escapeHtml(material.name || 'Material')}</span></div>
          <div class="material-editor-actions">${state.materials.some((candidate) => candidate.laminationMaterialId === material.id) ? '<span class="info-badge lamination-badge">Usado na laminação</span>' : ''}${state.materials.length > 1 ? `<button class="remove-button" type="button" data-action="remove-material" data-id="${escapeHtml(material.id)}">Remover</button>` : ''}</div>
        </div>
        <div class="form-grid three-columns">
          <label class="field full-width"><span>Modo de cálculo</span><select data-material-id="${escapeHtml(material.id)}" data-material-field="calculationMode"><option value="roll" ${material.calculationMode === 'roll' ? 'selected' : ''}>Bobina — aproveitar por metro linear</option><option value="sheet" ${isSheet ? 'selected' : ''}>Chapa — aproveitar por chapa ou m²</option><option value="area" ${isArea ? 'selected' : ''}>Impressão terceirizada — cobrar por m²</option></select></label>
          <label class="field"><span>Descrição</span><input data-material-id="${escapeHtml(material.id)}" data-material-field="name" data-clear-on-focus="${material.nameIsDefault ? 'true' : 'false'}" type="text" value="${escapeHtml(material.name)}" /></label>
          <label class="field"><span>${isSheet ? 'Largura da chapa' : 'Largura'} <small>(cm)</small></span><input data-material-id="${escapeHtml(material.id)}" data-material-field="widthCm" data-clear-on-focus="${material.widthIsDefault ? 'true' : 'false'}" type="number" min="1" step="0.1" value="${isArea ? '' : material.widthCm || ''}" placeholder="${isArea ? 'Não necessária' : '320'}" ${isArea ? 'disabled' : ''} /></label>
          <label class="field" ${isSheet ? '' : 'hidden'}><span>Altura da chapa <small>(cm)</small></span><input data-material-id="${escapeHtml(material.id)}" data-material-field="heightCm" type="number" min="1" step="0.1" value="${material.heightCm || ''}" placeholder="244" ${isSheet ? '' : 'disabled'} /></label>
          <label class="field"><span>Preço base <small>(${priceUnit})</small></span><input data-material-id="${escapeHtml(material.id)}" data-material-field="price" type="number" min="0" step="0.01" value="${material.price || ''}" /></label>
          <label class="field"><span>Cobrança</span><select data-material-id="${escapeHtml(material.id)}" data-material-field="basis" ${isArea ? 'disabled' : ''}><option value="linear" ${material.basis === 'linear' ? 'selected' : ''} ${isSheet ? 'disabled' : ''}>Por metro linear</option><option value="m2" ${material.basis === 'm2' ? 'selected' : ''}>Por m²</option><option value="sheet" ${material.basis === 'sheet' ? 'selected' : ''} ${isSheet ? '' : 'disabled'}>Por chapa</option></select></label>
          <label class="field field-toggle"><span>Permitir giro das peças</span><button class="toggle-switch ${material.rotate ? 'on' : ''}" type="button" data-action="toggle-material-rotate" data-id="${escapeHtml(material.id)}" role="switch" aria-checked="${material.rotate}" ${isArea ? 'disabled' : ''}><span></span></button></label>
          <label class="field"><span>Material de laminação</span><select data-material-id="${escapeHtml(material.id)}" data-material-field="laminationMaterialId"><option value="" ${!material.laminationMaterialId ? 'selected' : ''}>Não será laminado</option>${state.materials.filter((candidate) => candidate.id !== material.id).map((candidate) => `<option value="${escapeHtml(candidate.id)}" ${candidate.id === material.laminationMaterialId ? 'selected' : ''}>${escapeHtml(candidate.name)}</option>`).join('')}</select></label>
        </div>
        ${renderVolumePricingEditor(material)}
        ${isArea ? '<p class="material-note area-mode-note">Use este modo quando a gráfica cobrar diretamente por m². A largura e o comprimento não entram no cálculo.</p>' : ''}
        ${isSheet ? '<p class="material-note area-mode-note">Informe as dimensões da chapa. O GrafiFlow calcula quantas chapas serão necessárias e permite cobrar por chapa ou pela área total comprada.</p>' : ''}
        ${material.laminationMaterialId ? '<p class="material-note">O encaixe da laminação será recalculado respeitando o formato e as dimensões do material selecionado.</p>' : ''}
      </div>
    `;
  }).join('');
}

function renderPieces() {
  const container = document.getElementById('pieces-list');
  const empty = document.getElementById('pieces-empty');
  if (!container || !empty) return;
  empty.hidden = state.pieces.length > 0;
  container.innerHTML = state.pieces.map((piece) => `
    <div class="piece-row" data-piece-card="${escapeHtml(piece.id)}">
      <label class="field"><span>Descrição</span><input data-piece-id="${escapeHtml(piece.id)}" data-piece-field="description" data-clear-on-focus="${piece.descriptionIsDefault ? 'true' : 'false'}" type="text" value="${escapeHtml(piece.description)}" /></label>
      <label class="field"><span>Material</span><select data-piece-id="${escapeHtml(piece.id)}" data-piece-field="materialId">${state.materials.map((material) => `<option value="${escapeHtml(material.id)}" ${piece.materialId === material.id ? 'selected' : ''}>${escapeHtml(material.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Largura <small>(cm)</small></span><input data-piece-id="${escapeHtml(piece.id)}" data-piece-field="widthCm" type="number" min="0" step="0.1" value="${piece.widthCm || ''}" /></label>
      <label class="field"><span>Altura <small>(cm)</small></span><input data-piece-id="${escapeHtml(piece.id)}" data-piece-field="heightCm" type="number" min="0" step="0.1" value="${piece.heightCm || ''}" /></label>
      <label class="field"><span>Qtd.</span><input data-piece-id="${escapeHtml(piece.id)}" data-piece-field="quantity" type="number" min="1" step="1" value="${piece.quantity || 1}" /></label>
      <button class="row-remove" type="button" data-action="remove-piece" data-id="${escapeHtml(piece.id)}" aria-label="Remover peça">×</button>
    </div>
  `).join('');
}

function renderSupplies() {
  const container = document.getElementById('supplies-list');
  if (!container) return;
  container.innerHTML = state.installation.supplies.map((supply) => `
    <div class="supply-row">
      <label class="field"><span>Descrição</span><input data-supply-id="${escapeHtml(supply.id)}" data-supply-field="description" data-clear-on-focus="${supply.descriptionIsDefault ? 'true' : 'false'}" type="text" value="${escapeHtml(supply.description)}" /></label>
      <label class="field"><span>Qtd.</span><input data-supply-id="${escapeHtml(supply.id)}" data-supply-field="quantity" type="number" min="0" step="0.01" value="${supply.quantity}" /></label>
      <label class="field"><span>Un.</span><input data-supply-id="${escapeHtml(supply.id)}" data-supply-field="unit" data-clear-on-focus="${supply.unitIsDefault ? 'true' : 'false'}" type="text" value="${escapeHtml(supply.unit)}" /></label>
      <label class="field"><span>Preço unitário</span><input data-supply-id="${escapeHtml(supply.id)}" data-supply-field="unitPrice" type="number" min="0" step="0.01" value="${supply.unitPrice || ''}" /></label>
      <button class="row-remove" type="button" data-action="remove-supply" data-id="${escapeHtml(supply.id)}" aria-label="Remover insumo">×</button>
    </div>
  `).join('');
}

function renderQuotes() {
  const container = document.getElementById('quotes-list');
  if (!container) return;
  if (!savedQuotes.length) {
    container.innerHTML = '<div class="empty-state"><strong>Nenhum orçamento salvo ainda</strong><p>Depois de preencher um cálculo, use “Salvar orçamento” para encontrá-lo aqui.</p></div>';
    return;
  }
  container.innerHTML = savedQuotes.map((quote) => `
    <article class="quote-card">
      <div><div class="quote-card-title">${escapeHtml(quote.name || 'Orçamento sem nome')}</div><div class="quote-card-meta">Atualizado em ${escapeHtml(formatDate(quote.updatedAt))} · ${quote.piecesCount || 0} peça(s) · ${quote.materialsCount || 0} material(is)</div></div>
      <div class="quote-card-figure"><div class="quote-card-price">${formatMoney(num(quote.salePrice))}</div><div class="quote-card-label">venda</div></div>
      <div class="quote-actions"><button class="secondary-button small-button" type="button" data-action="load-quote" data-id="${escapeHtml(quote.id)}">Abrir</button><button class="icon-button" type="button" data-action="delete-quote" data-id="${escapeHtml(quote.id)}" title="Excluir orçamento">×</button></div>
    </article>
  `).join('');
}

function renderSavedMaterialVolumePricing() {
  const container = document.getElementById('saved-material-volume-tiers');
  if (!container) return;
  const mode = document.getElementById('saved-material-calculation-mode')?.value || 'roll';
  const basis = document.getElementById('saved-material-basis')?.value;
  const unit = mode === 'area' || basis === 'm2' ? 'm²' : mode === 'sheet' && basis === 'sheet' ? 'chapas' : 'm';
  container.innerHTML = savedMaterialVolumeTiers.map((tier, tierIndex) => `
    <div class="volume-pricing-row">
      <label class="field"><span>A partir de <small>(${unit})</small></span><input data-saved-tier-index="${tierIndex}" data-saved-tier-field="minQuantity" type="number" min="0.01" step="0.01" value="${tier.minQuantity || ''}" placeholder="10" /></label>
      <label class="field"><span>Preço unitário <small>(R$/${unit === 'chapas' ? 'chapa' : unit})</small></span><input data-saved-tier-index="${tierIndex}" data-saved-tier-field="unitPrice" type="number" min="0" step="0.01" value="${tier.unitPrice || ''}" placeholder="0,00" /></label>
      <button class="row-remove" type="button" data-action="remove-saved-material-tier" data-tier-index="${tierIndex}" aria-label="Remover faixa">×</button>
    </div>
  `).join('');
}
function renderSavedMaterials() {
  const container = document.getElementById('saved-materials-list');
  if (!container) return;
  if (!savedMaterials.length) {
    container.innerHTML = '<div class="empty-state"><strong>Catálogo vazio</strong><p>Cadastre as mídias que você mais usa para reutilizar dimensões e preços nos cálculos.</p></div>';
    return;
  }
  container.innerHTML = savedMaterials.map((material) => {
    const measure = material.calculationMode === 'area'
      ? 'Área total'
      : material.calculationMode === 'sheet'
        ? `Chapa ${formatNumber(material.widthCm, 1)} × ${formatNumber(material.heightCm, 1)} cm`
        : `Bobina ${formatNumber(material.widthCm, 1)} cm`;
    const unit = materialPricingUnit(material);
    const charge = unit === 'chapa' ? 'R$/chapa' : `R$/${unit === 'm' ? 'metro linear' : unit}`;
    const useLabel = material.calculationMode === 'sheet' ? 'Usar chapa' : material.calculationMode === 'area' ? 'Usar material' : 'Usar bobina';
    return `
      <article class="saved-material-card">
        <div><div class="saved-material-card-title">${escapeHtml(material.name)}</div>${material.supplier ? `<div class="saved-material-card-supplier"><span>Fornecedor</span>${escapeHtml(material.supplier)}</div>` : ''}<div class="saved-material-card-meta">${measure} · ${charge} · ${formatMoney(material.price)}${material.volumePricing?.length ? ` · ${material.volumePricing.length} faixa(s) por volume` : ''}</div></div>
        <div class="saved-material-actions"><button class="secondary-button small-button" type="button" data-action="use-saved-material" data-id="${escapeHtml(material.id)}">${useLabel}</button><button class="icon-button" type="button" data-action="edit-saved-material" data-id="${escapeHtml(material.id)}" title="Editar">✎</button><button class="icon-button" type="button" data-action="delete-saved-material" data-id="${escapeHtml(material.id)}" title="Excluir">×</button></div>
      </article>
    `;
  }).join('');
}
function renderMaterialPicker() {
  const container = document.getElementById('material-picker-list');
  if (!container) return;
  if (!savedMaterials.length) {
    container.innerHTML = '<div class="empty-state"><strong>Nenhum material salvo ainda</strong><p>Cadastre uma mídia no catálogo para usá-la em qualquer orçamento.</p><button class="secondary-button small-button" id="picker-open-catalog" type="button">Ir para o catálogo</button></div>';
    return;
  }
  container.innerHTML = savedMaterials.map((material) => {
    const measure = material.calculationMode === 'area'
      ? 'Área total · cobrança por m²'
      : material.calculationMode === 'sheet'
        ? `${formatNumber(material.widthCm, 1)} × ${formatNumber(material.heightCm, 1)} cm · cobrança ${material.basis === 'm2' ? 'por m²' : 'por chapa'}`
        : `${formatNumber(material.widthCm, 1)} cm · cobrança ${material.basis === 'm2' ? 'por m²' : 'por metro linear'}`;
    const volume = material.volumePricing?.length ? ` · ${material.volumePricing.length} faixa(s) por volume` : '';
    const useLabel = material.calculationMode === 'sheet' ? 'Usar chapa' : material.calculationMode === 'area' ? 'Usar material' : 'Usar bobina';
    return `<article class="material-picker-card"><div class="material-picker-card-main"><strong>${escapeHtml(material.name)}</strong>${material.supplier ? `<span class="material-picker-supplier">Fornecedor: ${escapeHtml(material.supplier)}</span>` : ''}<span class="material-picker-meta">${measure} · ${formatMoney(material.price)}${volume}</span></div><button class="primary-button small-button" type="button" data-action="use-saved-material" data-id="${escapeHtml(material.id)}">${useLabel}</button></article>`;
  }).join('');
}
function openMaterialPicker() {
  renderMaterialPicker();
  const modal = document.getElementById('material-picker-modal');
  if (modal) modal.hidden = false;
}

function closeMaterialPicker() {
  const modal = document.getElementById('material-picker-modal');
  if (modal) modal.hidden = true;
}

function openMaterialCatalog() {
  closeMaterialPicker();
  switchView('materials-view');
  resetSavedMaterialForm();
  document.getElementById('saved-material-form-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderInstallationState() {
  const content = document.getElementById('installation-content');
  if (content) content.classList.toggle('installation-content-hidden', !installationExpanded);
  const quantity = computed.installationBasisQuantity || 0;
  if (state.installation.autoQuantity) {
    state.installation.quantity = state.installation.basis === 'fixed' ? 1 : quantity;
    setValue('installation-quantity', state.installation.quantity);
  }
  const quantityInput = document.getElementById('installation-quantity');
  if (quantityInput) quantityInput.disabled = state.installation.autoQuantity && state.installation.basis !== 'fixed';
}

function renderMetrics() {
  const resultState = document.getElementById('result-state');
  const validPieceCount = state.pieces.filter((piece) => positive(piece.widthCm) > 0 && positive(piece.heightCm) > 0 && positive(piece.quantity, 1) > 0).length;
  const areaModeOnly = computed.materialResults.length > 0 && computed.materialResults.every((result) => result.areaOnly);
  const allSheetOnly = computed.materialResults.length > 0 && computed.materialResults.every((result) => result.sheetOnly);
  const hasSheetMaterial = computed.materialResults.some((result) => result.sheetOnly);
  const allRolls = computed.materialResults.length > 0 && computed.materialResults.every((result) => result.calculationMode === 'roll');
  const areaAsMainMeasure = computed.materialResults.length > 0 && (hasSheetMaterial || (!areaModeOnly && !allRolls));
  if (resultState) {
    resultState.textContent = !validPieceCount ? 'Aguardando peças' : computed.warnings.length ? 'Revisar cálculo' : areaModeOnly ? 'Área calculada' : 'Aproveitamento calculado';
    resultState.style.color = computed.warnings.length ? '#f5c51d' : '#74d8c6';
  }
  const displayedMainMeasure = allSheetOnly ? computed.totalSheets : areaAsMainMeasure ? computed.consumedAreaM2 : areaModeOnly ? computed.piecesAreaM2 : computed.totalLengthM;
  setValue('total-length', formatNumber(displayedMainMeasure, allSheetOnly ? 0 : 2));
  const lengthElement = document.getElementById('total-length');
  if (lengthElement) lengthElement.textContent = formatNumber(displayedMainMeasure, allSheetOnly ? 0 : 2);
  const bigUnit = document.querySelector('.big-unit');
  if (bigUnit) bigUnit.innerHTML = allSheetOnly ? 'chapas<br /><small>necessárias</small>' : areaAsMainMeasure ? 'm²<br /><small>consumidos</small>' : areaModeOnly ? 'm²<br /><small>cobrados</small>' : 'm<br /><small>lineares</small>';
  const resultCaption = document.querySelector('.result-caption');
  if (resultCaption) resultCaption.textContent = allSheetOnly ? 'Chapas necessárias para produzir as peças' : areaAsMainMeasure ? 'Área total consumida pelos materiais' : areaModeOnly ? 'Área total para impressão terceirizada' : computed.laminationResults.length ? 'Comprimento necessário das bobinas base' : 'Comprimento necessário de bobina';
  const metrics = document.getElementById('metrics-grid');
  if (!metrics) return;
  const laminationMetric = computed.laminationAreaM2 > 0 ? `<div class="metric"><span class="metric-label">Área de laminação</span><strong class="metric-value">${formatNumber(computed.laminationAreaM2, 2)} m²</strong></div>` : '';
  const laminationLengthMetric = computed.laminationResults.some((result) => result.calculationMode === 'roll') ? `<div class="metric"><span class="metric-label">Comprimento da laminação</span><strong class="metric-value">${formatNumber(computed.laminationLengthM, 2)} m</strong></div>` : '';
  const laminationSheetsMetric = computed.laminationSheets > 0 ? `<div class="metric"><span class="metric-label">Chapas de laminação</span><strong class="metric-value">${computed.laminationSheets}</strong></div>` : '';
  metrics.innerHTML = `
    <div class="metric"><span class="metric-label">${areaModeOnly ? 'Área cobrada' : allSheetOnly ? 'Área total das chapas' : hasSheetMaterial ? 'Área consumida' : 'Área da base'}</span><strong class="metric-value">${formatNumber(computed.consumedAreaM2, 2)} m²</strong></div>
    <div class="metric"><span class="metric-label">Área das peças</span><strong class="metric-value">${formatNumber(computed.piecesAreaM2, 2)} m²</strong></div>
    <div class="metric"><span class="metric-label">Desperdício</span><strong class="metric-value">${formatNumber(computed.wasteAreaM2, 2)} m²</strong></div>
    <div class="metric"><span class="metric-label">Aproveitamento</span><strong class="metric-value">${formatPercent(computed.utilization)}</strong></div>
    ${laminationMetric}
    ${laminationLengthMetric}
    ${laminationSheetsMetric}
  `;
}
function renderCostBreakdown() {
  const container = document.getElementById('cost-breakdown');
  if (!container) return;
  const pricingSummary = (result) => {
    const unit = materialPricingUnit(result.material);
    const quantity = Number.isFinite(result.billingQuantity) ? result.billingQuantity : unit === 'm²' ? result.consumedAreaM2 : unit === 'chapa' ? result.sheetCount : result.usedLengthM;
    const unitPrice = Number.isFinite(result.unitPrice) ? result.unitPrice : result.material.price;
    const tier = result.volumeTier ? ` · faixa ${formatNumber(result.volumeTier.minQuantity, 2)}+` : '';
    const displayUnit = unit === 'chapa' ? (Math.abs(quantity - 1) < 0.000001 ? 'chapa' : 'chapas') : unit;
    const quantityDecimals = result.sheetOnly && unit === 'm²' ? 3 : 2;
    return `${formatNumber(quantity, quantityDecimals)} ${displayUnit} · ${formatMoney(unitPrice)}/${unit}${tier}`;
  };
  const materialLines = computed.materialResults.map((result) => `<div class="cost-line"><span>${escapeHtml(result.material.name)} <small>${pricingSummary(result)}</small></span><strong>${formatMoney(result.cost)}</strong></div>`).join('');
  const laminationLines = computed.laminationResults.map((result) => `<div class="cost-line lamination-line"><span>↳ Laminação: ${escapeHtml(result.material.name)} <small>${escapeHtml(result.baseMaterial.name)} · ${pricingSummary(result)}</small></span><strong>${formatMoney(result.cost)}</strong></div>`).join('');
  const suppliesLine = computed.suppliesCost > 0 ? `<div class="cost-line"><span>Insumos de instalação</span><strong>${formatMoney(computed.suppliesCost)}</strong></div>` : '';
  const installationLine = computed.installationLaborCost > 0 ? `<div class="cost-line"><span>Mão de obra de instalação</span><strong>${formatMoney(computed.installationLaborCost)}</strong></div>` : '';
  const travelLine = computed.travelCost > 0 ? `<div class="cost-line"><span>Deslocamento</span><strong>${formatMoney(computed.travelCost)}</strong></div>` : '';
  const otherLine = computed.otherCosts > 0 ? `<div class="cost-line"><span>Outros custos</span><strong>${formatMoney(computed.otherCosts)}</strong></div>` : '';
  container.innerHTML = `${materialLines || '<div class="cost-line"><span>Materiais</span><strong>R$ 0,00</strong></div>'}${laminationLines}${installationLine}${suppliesLine}${travelLine}${otherLine}<div class="cost-line total"><span>Custo total</span><strong>${formatMoney(computed.totalCost)}</strong></div>`;
}

function renderProfit() {
  const container = document.getElementById('profit-summary');
  if (!container) return;
  const valueClass = computed.profit >= 0 ? 'good' : 'bad';
  container.innerHTML = `
    <div class="profit-stat"><span class="profit-label">Custo total</span><strong class="profit-value">${formatMoney(computed.totalCost)}</strong></div>
    <div class="profit-stat"><span class="profit-label">Lucro estimado</span><strong class="profit-value ${valueClass}">${formatMoney(computed.profit)}</strong></div>
    <div class="profit-stat"><span class="profit-label">Margem real</span><strong class="profit-value ${valueClass}">${computed.salePrice > 0 ? formatPercent(computed.margin) : '—'}</strong></div>
    <div class="profit-stat"><span class="profit-label">Preço sugerido</span><strong class="profit-value">${formatMoney(computed.suggestedPrice)}</strong></div>
  `;
}

function renderClientQuoteForm() {
  const data = state.clientQuote || defaultClientQuote();
  setValue('client-business-name', data.businessName);
  setValue('client-business-phone', data.businessPhone);
  setValue('client-business-email', data.businessEmail);
  setValue('client-name', data.clientName);
  setValue('client-contact', data.clientContact);
  setValue('client-validity', data.validity);
  setClearOnFocus('client-validity', data.validityIsDefault);
  setValue('client-deadline', data.deadline);
  setValue('client-payment-terms', data.paymentTerms);
  setClearOnFocus('client-payment-terms', data.paymentTermsIsDefault);
  setValue('client-notes', data.notes);
}

function clientQuoteItemRows() {
  const pieces = state.pieces.filter((piece) => positive(piece.widthCm) > 0 && positive(piece.heightCm) > 0 && positive(piece.quantity, 1) > 0);
  if (!pieces.length) return '<div class="client-doc-item"><div><div class="client-doc-item-name">Serviço personalizado</div><div class="client-doc-item-meta">Detalhes conforme combinado</div></div></div>';
  return pieces.map((piece) => `<div class="client-doc-item"><div><div class="client-doc-item-name">${escapeHtml(piece.description || 'Peça personalizada')}</div><div class="client-doc-item-meta">${formatNumber(positive(piece.widthCm), 1)} × ${formatNumber(positive(piece.heightCm), 1)} cm</div></div><div class="client-doc-item-qty">${Math.max(1, Math.floor(positive(piece.quantity, 1)))} un.</div></div>`).join('');
}

function renderClientQuotePreview() {
  const container = document.getElementById('client-quote-preview');
  if (!container) return;
  const data = { ...defaultClientQuote(), ...(state.clientQuote || {}) };
  const businessName = String(data.businessName || '').trim() || 'Seu negócio';
  const clientName = String(data.clientName || '').trim();
  const greeting = clientName ? `Olá, ${clientName}. Segue o orçamento solicitado.` : 'Olá! Segue o orçamento solicitado.';
  const quoteTitle = state.quoteName.trim() || 'Serviço de comunicação visual';
  const total = computed.salePrice > 0 ? formatMoney(computed.salePrice) : 'Defina o preço de venda';
  const conditions = [
    String(data.validity || '').trim() ? `<div><span class="client-doc-condition-label">Validade</span><span class="client-doc-condition-value">${escapeHtml(data.validity)}</span></div>` : '',
    String(data.deadline || '').trim() ? `<div><span class="client-doc-condition-label">Prazo</span><span class="client-doc-condition-value">${escapeHtml(data.deadline)}</span></div>` : '',
    String(data.paymentTerms || '').trim() ? `<div><span class="client-doc-condition-label">Pagamento</span><span class="client-doc-condition-value">${escapeHtml(data.paymentTerms)}</span></div>` : '',
  ].filter(Boolean).join('');
  const contact = [String(data.businessPhone || '').trim(), String(data.businessEmail || '').trim()].filter(Boolean).join(' · ');
  const notesText = String(data.notes || '').trim();
  const notes = notesText ? `<p class="client-doc-notes"><strong>Observações:</strong><br />${escapeHtml(notesText)}</p>` : '';
  const quoteNumber = state.quoteId ? state.quoteId.slice(-6).toUpperCase() : 'RASCUNHO';
  container.innerHTML = `
    <article class="client-quote-document">
      <header class="client-doc-header">
        <div class="client-doc-brand"><span class="client-doc-brand-mark">${escapeHtml(businessName.charAt(0).toUpperCase())}</span><div><div class="client-doc-business">${escapeHtml(businessName)}</div>${contact ? `<div class="client-doc-contact">${escapeHtml(contact)}</div>` : ''}</div></div>
        <div><div class="client-doc-type">ORÇAMENTO</div><div class="client-doc-number">Nº ${escapeHtml(quoteNumber)} · ${escapeHtml(new Date().toLocaleDateString('pt-BR'))}</div></div>
      </header>
      <section class="client-doc-intro"><h3>${escapeHtml(quoteTitle)}</h3><p>${escapeHtml(greeting)}</p></section>
      <section><div class="client-doc-section-label">Descrição do serviço</div><div class="client-doc-items">${clientQuoteItemRows()}</div></section>
      <section class="client-doc-total"><span class="client-doc-total-label">Valor total</span><strong class="client-doc-total-value">${total}</strong></section>
      ${conditions ? `<section class="client-doc-conditions">${conditions}</section>` : ''}
      ${notes}
      <footer class="client-doc-footer">Orçamento preparado em ${escapeHtml(new Date().toLocaleDateString('pt-BR'))}. A execução será iniciada após a aprovação.</footer>
    </article>
  `;
}

function openClientQuoteModal() {
  renderClientQuoteForm();
  renderClientQuotePreview();
  const modal = document.getElementById('client-quote-modal');
  if (modal) modal.hidden = false;
}

function closeClientQuoteModal() {
  document.body.classList.remove('client-quote-printing');
  document.documentElement.classList.remove('client-quote-printing');
  const modal = document.getElementById('client-quote-modal');
  if (modal) modal.hidden = true;
}

function printClientQuote() {
  renderClientQuotePreview();
  const preview = document.querySelector('#client-quote-preview .client-quote-document');
  if (!preview) {
    showToast('Não foi possível preparar o orçamento para impressão.', 'error');
    return;
  }
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    showToast('O navegador bloqueou a janela de impressão. Permita pop-ups e tente novamente.', 'error');
    return;
  }
  const printStyles = `
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { color: #0b3d6b; font-family: Arial, Helvetica, sans-serif; }
    .client-quote-document { min-height: 240mm; display: flex; flex-direction: column; border-top: 8px solid #0a97e0; }
    .client-doc-header { display: flex; justify-content: space-between; align-items: start; gap: 24px; padding: 20px; color: #fff; background: #072d54; border-radius: 0 0 12px 12px; }
    .client-doc-brand { display: flex; align-items: center; gap: 10px; }
    .client-doc-brand-mark { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 8px; color: #072d54; background: #35bdc4; font-weight: 900; font-size: 18px; }
    .client-doc-business { color: #fff; font-weight: 850; font-size: 15px; }
    .client-doc-contact { color: #b7d3df; font-size: 11px; line-height: 1.5; margin-top: 3px; }
    .client-doc-type { color: #35bdc4; font-size: 11px; font-weight: 800; letter-spacing: .12em; text-align: right; }
    .client-doc-number { color: #fff; font-size: 12px; font-weight: 750; text-align: right; margin-top: 6px; }
    .client-doc-intro { margin: 25px 0 21px; padding: 14px 16px; background: #ecf5f9; border-left: 5px solid #35bdc4; border-radius: 0 10px 10px 0; }
    .client-doc-intro h3 { font-size: 17px; margin: 0 0 6px; }
    .client-doc-intro p { color: #60778b; font-size: 12px; line-height: 1.5; margin: 0; }
    .client-doc-section-label { color: #0361a1; font-size: 10px; font-weight: 850; letter-spacing: .11em; text-transform: uppercase; margin-bottom: 9px; }
    .client-doc-items { display: grid; gap: 0; border-top: 1px solid #d8e7f0; }
    .client-doc-item { display: flex; justify-content: space-between; gap: 12px; padding: 12px 10px; border-bottom: 1px solid #d8e7f0; font-size: 12px; break-inside: avoid; }
    .client-doc-item:nth-child(even) { background: #f8fbfd; }
    .client-doc-item-name { font-weight: 750; }
    .client-doc-item-meta { color: #60778b; font-size: 11px; margin-top: 3px; }
    .client-doc-item-qty { color: #60778b; white-space: nowrap; font-size: 11px; }
    .client-doc-total { display: flex; justify-content: space-between; align-items: end; gap: 16px; margin-top: auto; padding: 18px 20px; color: #fff; background: #072d54; border-radius: 12px; }
    .client-doc-total-label { color: #b7d3df; font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .client-doc-total-value { color: #35bdc4; font-size: 25px; font-weight: 900; letter-spacing: -.05em; }
    .client-doc-conditions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 13px; padding-top: 17px; }
    .client-doc-conditions > div { padding: 11px 12px; border: 1px solid #d8e7f0; border-top: 3px solid #0a97e0; border-radius: 8px; background: #f4f9fc; }
    .client-doc-condition-label { color: #60778b; display: block; font-size: 10px; font-weight: 800; margin-bottom: 3px; }
    .client-doc-condition-value { color: #0b3d6b; display: block; font-size: 11px; line-height: 1.4; }
    .client-doc-notes { color: #60778b; font-size: 11px; line-height: 1.5; white-space: pre-wrap; margin: 18px 0 0; padding: 11px 12px; border-left: 4px solid #35bdc4; border-radius: 0 8px 8px 0; background: #edfbfa; }
    .client-doc-footer { color: #8aa5b5; font-size: 10px; margin-top: 28px; }
    @media (max-width: 650px) {
      .client-doc-header { display: block; }
      .client-doc-type, .client-doc-number { text-align: left; margin-top: 12px; }
      .client-doc-conditions { grid-template-columns: 1fr; gap: 9px; }
    }
  `;
  printWindow.document.open();
  printWindow.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Orçamento para o cliente</title><style>${printStyles}</style></head><body>${preview.outerHTML}</body></html>`);
  printWindow.document.close();
  const startPrint = () => setTimeout(() => {
    printWindow.focus();
    printWindow.print();
  }, 160);
  if (printWindow.document.readyState === 'complete') startPrint();
  else printWindow.addEventListener('load', startPrint, { once: true });
}

function renderLayoutSvg(result, compact = false, layoutOverride = null, fixedHeight = null) {
  const layout = layoutOverride || result?.layout;
  if (!layout || !layout.items.length || !(positive(fixedHeight) || layout.usedLength > 0)) return '<div class="canvas-placeholder">Adicione medidas válidas para visualizar o encaixe.</div>';
  const width = result.rollWidth;
  const height = positive(fixedHeight) || layout.usedLength;
  const maxHeight = compact ? 520 : 820;
  const resultColorIndex = result.material?.id ? materialIndex(result.material.id) : null;
  const svgItems = layout.items.map((item) => {
    const color = materialColor(resultColorIndex ?? item.colorIndex);
    const labelColor = materialLabelColor(color);
    const actualX = item.x + item.pad;
    const actualY = item.y + item.pad;
    const label = `${item.description} · ${formatNumber(item.actualW / 10, 1)}×${formatNumber(item.actualH / 10, 1)}`;
    const fontSize = Math.max(9, Math.min(28, Math.min(item.actualW, item.actualH) * 0.13));
    const canShowLabel = item.actualW > 70 && item.actualH > 28;
    return `<g><rect x="${actualX}" y="${actualY}" width="${item.actualW}" height="${item.actualH}" rx="${Math.min(8, item.actualW / 8)}" fill="${color}" fill-opacity="0.92" stroke="#ffffff" stroke-width="2"/><rect x="${actualX + 3}" y="${actualY + 3}" width="${Math.max(0, item.actualW - 6)}" height="${Math.max(0, item.actualH - 6)}" rx="${Math.min(6, item.actualW / 10)}" fill="none" stroke="rgba(7,45,84,.16)" stroke-width="1"/>${canShowLabel ? `<text x="${actualX + item.actualW / 2}" y="${actualY + item.actualH / 2}" text-anchor="middle" dominant-baseline="middle" font-size="${fontSize}" font-weight="750" fill="${labelColor}">${escapeXml(label)}</text>` : ''}</g>`;
  }).join('');
  const rulerLabel = `${formatNumber(width / 10, 1)} cm × ${formatNumber(height / 10, 1)} cm`;
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(`Aproveitamento de ${rulerLabel}`)}" style="max-height:${maxHeight}px;max-width:100%;height:auto"><rect x="0" y="0" width="${width}" height="${height}" fill="#e8f2f7"/><path d="M0 0H${width}M0 ${height}H${width}" stroke="#b3cbd7" stroke-width="2" stroke-dasharray="10 8"/>${svgItems}<text x="${Math.min(width - 5, Math.max(5, width / 2))}" y="${Math.max(14, height - 8)}" text-anchor="middle" font-size="${Math.max(10, Math.min(18, width * 0.03))}" font-weight="700" fill="#587487">${escapeXml(rulerLabel)}</text></svg>`;
}

function renderMaterialLayouts(result, compact = false) {
  if (!result.sheetOnly) return renderLayoutSvg(result, compact);
  return `<div class="sheet-layout-list">${result.layouts.map((layout, index) => `<div class="sheet-layout-item"><strong>Chapa ${index + 1} de ${result.sheetCount}</strong>${renderLayoutSvg(result, compact, layout, result.sheetHeight)}</div>`).join('')}</div>`;
}

function renderMaterialResultBlock(result, compact = false) {
  const title = result.areaOnly
    ? `Base — ${escapeHtml(result.material.name)} · ${formatNumber(result.consumedAreaM2, 2)} m² cobrados`
    : result.sheetOnly
      ? `Base — ${escapeHtml(result.material.name)} · chapa de ${formatNumber(result.rollWidth / 10, 1)} × ${formatNumber(result.sheetHeight / 10, 1)} cm · ${result.sheetCount} ${result.sheetCount === 1 ? 'chapa' : 'chapas'}`
      : `Base — ${escapeHtml(result.material.name)} · bobina de ${formatNumber(result.rollWidth / 10, 1)} cm · ${formatNumber(result.usedLengthM, 2)} m lineares`;
  const content = result.areaOnly
    ? `<div class="area-only-result"><strong>Cálculo por área</strong><span>A largura de impressão será definida pela gráfica.</span><b>${formatNumber(result.consumedAreaM2, 2)} m²</b></div>`
    : renderMaterialLayouts(result, compact);
  const baseBlock = `<div class="layout-block"><div class="layout-block-title">${title}</div>${content}</div>`;
  const laminate = result.laminationResult;
  if (!laminate) return baseBlock;
  const laminateTitle = laminate.areaOnly
    ? `Laminação — ${escapeHtml(laminate.material.name)} · ${formatNumber(laminate.consumedAreaM2, 2)} m² cobrados`
    : laminate.sheetOnly
      ? `Laminação — ${escapeHtml(laminate.material.name)} · chapa de ${formatNumber(laminate.rollWidth / 10, 1)} × ${formatNumber(laminate.sheetHeight / 10, 1)} cm · ${laminate.sheetCount} ${laminate.sheetCount === 1 ? 'chapa' : 'chapas'}`
      : `Laminação — ${escapeHtml(laminate.material.name)} · bobina de ${formatNumber(laminate.rollWidth / 10, 1)} cm · ${formatNumber(laminate.usedLengthM, 2)} m lineares`;
  const laminateContent = laminate.areaOnly
    ? `<div class="area-only-result"><strong>Cálculo por área</strong><span>A largura não entra no cálculo deste material.</span><b>${formatNumber(laminate.consumedAreaM2, 2)} m²</b></div>`
    : renderMaterialLayouts(laminate, compact);
  return `${baseBlock}<div class="layout-block"><div class="layout-block-title">${laminateTitle}</div>${laminateContent}</div>`;
}
function renderLayout() {
  const container = document.getElementById('layout-canvas');
  const legend = document.getElementById('layout-legend');
  if (!container || !legend) return;
  if (!computed.materialResults.length) {
    container.innerHTML = '<div class="canvas-placeholder">Adicione peças para visualizar o encaixe.</div>';
    legend.innerHTML = '';
    return;
  }
  container.innerHTML = computed.materialResults.map((result) => renderMaterialResultBlock(result, true)).join('');
  const seen = new Map();
  const addMaterialToLegend = (result) => {
    if (!result?.material || result.areaOnly) return;
    const hasPlacedItems = result.layout?.items?.length || result.layouts?.some((layout) => layout.items.length);
    if (hasPlacedItems) seen.set(result.material.id, result.material);
  };
  computed.materialResults.forEach((result) => {
    addMaterialToLegend(result);
    addMaterialToLegend(result.laminationResult);
  });
  legend.innerHTML = [...seen.values()].map((material) => `<span class="legend-item"><i class="legend-swatch" style="background:${materialColor(materialIndex(material.id))}"></i>${escapeHtml(material.name)}</span>`).join('');
}

function renderResults() {
  renderMetrics();
  renderCostBreakdown();
  renderProfit();
  renderLayout();
  renderInstallationState();
  renderClientQuotePreview();
}

function calculateAndRender({ persistDraft = true } = {}) {
  computed = calculateQuote();
  renderResults();
  if (persistDraft) persistDraftSoon();
}

function buildItemsForMaterial(material) {
  const padding = positive(state.globalBleed) + positive(state.globalGap) / 2;
  const items = [];
  let order = 0;
  state.pieces.forEach((piece) => {
    if (piece.materialId !== material.id) return;
    const originalW = positive(piece.widthCm) * 10;
    const originalH = positive(piece.heightCm) * 10;
    const quantity = Math.max(0, Math.floor(positive(piece.quantity, 1)));
    if (originalW <= 0 || originalH <= 0 || quantity <= 0) return;
    for (let copy = 0; copy < quantity; copy += 1) {
      items.push({
        id: `${piece.id}-${copy}`,
        pieceId: piece.id,
        order: order++,
        description: piece.description || 'Peça',
        originalW,
        originalH,
        pad: padding,
        outerW: originalW + padding * 2,
        outerH: originalH + padding * 2,
        colorIndex: materialIndex(material.id),
      });
    }
  });
  return items;
}

function rectanglesOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function containsRectangle(a, b) {
  return a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;
}

function pruneFreeRectangles(rectangles) {
  const pruned = [];
  for (let index = 0; index < rectangles.length; index += 1) {
    const rectangle = rectangles[index];
    if (!rectangle || rectangle.w <= 0.01 || rectangle.h <= 0.01) continue;
    let contained = false;
    for (let otherIndex = 0; otherIndex < rectangles.length; otherIndex += 1) {
      if (index === otherIndex) continue;
      if (containsRectangle(rectangles[otherIndex], rectangle)) {
        contained = true;
        break;
      }
    }
    if (!contained) pruned.push(rectangle);
  }
  return pruned;
}

function splitFreeRectangles(freeRectangles, used) {
  const next = [];
  freeRectangles.forEach((free) => {
    if (!rectanglesOverlap(free, used)) {
      next.push(free);
      return;
    }
    if (used.x > free.x) next.push({ x: free.x, y: free.y, w: used.x - free.x, h: free.h });
    if (used.x + used.w < free.x + free.w) next.push({ x: used.x + used.w, y: free.y, w: free.x + free.w - (used.x + used.w), h: free.h });
    if (used.y > free.y) next.push({ x: free.x, y: free.y, w: free.w, h: used.y - free.y });
    if (used.y + used.h < free.y + free.h) next.push({ x: free.x, y: used.y + used.h, w: free.w, h: free.y + free.h - (used.y + used.h) });
  });
  return pruneFreeRectangles(next);
}

function comparePlacement(a, b) {
  if (!b) return -1;
  const keys = ['shortFit', 'bottom', 'longFit', 'y', 'x'];
  for (const key of keys) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  return 0;
}

function packMaxRects(sourceItems, rollWidth, allowRotation, fixedHeight = null) {
  const items = sourceItems.map((item) => ({ ...item }));
  const estimatedHeight = Math.max(rollWidth, items.reduce((total, item) => total + Math.max(item.outerW, item.outerH), 0) + rollWidth);
  const containerHeight = positive(fixedHeight) || estimatedHeight;
  let freeRectangles = [{ x: 0, y: 0, w: rollWidth, h: containerHeight }];
  const placed = [];
  const unfit = [];
  items.forEach((item) => {
    let best;
    const options = [{ w: item.outerW, h: item.outerH, rotated: false }];
    if (allowRotation && Math.abs(item.outerW - item.outerH) > 0.01) options.push({ w: item.outerH, h: item.outerW, rotated: true });
    freeRectangles.forEach((free, freeIndex) => {
      options.forEach((option) => {
        if (option.w > free.w + 0.01 || option.h > free.h + 0.01) return;
        const leftoverW = Math.abs(free.w - option.w);
        const leftoverH = Math.abs(free.h - option.h);
        const candidate = {
          freeIndex,
          x: free.x,
          y: free.y,
          w: option.w,
          h: option.h,
          rotated: option.rotated,
          shortFit: Math.min(leftoverW, leftoverH),
          longFit: Math.max(leftoverW, leftoverH),
          bottom: free.y + option.h,
        };
        if (comparePlacement(candidate, best) < 0) best = candidate;
      });
    });
    if (!best) {
      unfit.push(item);
      return;
    }
    const placedItem = {
      ...item,
      x: best.x,
      y: best.y,
      w: best.w,
      h: best.h,
      rotated: best.rotated,
      actualW: best.rotated ? item.originalH : item.originalW,
      actualH: best.rotated ? item.originalW : item.originalH,
    };
    placed.push(placedItem);
    freeRectangles = splitFreeRectangles(freeRectangles, { x: best.x, y: best.y, w: best.w, h: best.h });
  });
  const usedLength = placed.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  return { items: placed, usedLength, unfit };
}

function sortStrategies(items) {
  const strategies = [
    (a, b) => (b.outerW * b.outerH) - (a.outerW * a.outerH) || Math.max(b.outerW, b.outerH) - Math.max(a.outerW, a.outerH),
    (a, b) => Math.max(b.outerW, b.outerH) - Math.max(a.outerW, a.outerH) || (b.outerW * b.outerH) - (a.outerW * a.outerH),
    (a, b) => Math.min(b.outerW, b.outerH) - Math.min(a.outerW, a.outerH) || (b.outerW * b.outerH) - (a.outerW * a.outerH),
    (a, b) => (b.outerW + b.outerH) - (a.outerW + a.outerH) || (b.outerW * b.outerH) - (a.outerW * a.outerH),
    (a, b) => a.order - b.order,
  ];
  return strategies.map((compare) => [...items].sort(compare));
}

function chooseBestLayout(items, rollWidth, allowRotation, optimize = true) {
  if (!items.length) return { items: [], usedLength: 0, unfit: [] };
  const runs = (optimize ? sortStrategies(items) : [items]).map((strategy) => packMaxRects(strategy, rollWidth, allowRotation));
  runs.sort((a, b) => {
    const aInvalid = a.unfit.length ? 1 : 0;
    const bInvalid = b.unfit.length ? 1 : 0;
    if (aInvalid !== bInvalid) return aInvalid - bInvalid;
    if (a.usedLength !== b.usedLength) return a.usedLength - b.usedLength;
    return b.items.length - a.items.length;
  });
  return runs[0];
}

function packIntoSheets(sourceItems, sheetWidth, sheetHeight, allowRotation, orderedItems) {
  let remaining = orderedItems.map((item) => ({ ...item }));
  const layouts = [];
  let attempts = 0;
  while (remaining.length && attempts < sourceItems.length) {
    const layout = packMaxRects(remaining, sheetWidth, allowRotation, sheetHeight);
    if (!layout.items.length) return { layouts, unfit: layout.unfit };
    layouts.push(layout);
    remaining = layout.unfit;
    attempts += 1;
  }
  return { layouts, unfit: remaining };
}

function chooseBestSheetLayouts(items, sheetWidth, sheetHeight, allowRotation, optimize = true) {
  if (!items.length) return { layouts: [], unfit: [] };
  const strategies = optimize ? sortStrategies(items) : [items];
  const runs = strategies.map((strategy) => packIntoSheets(items, sheetWidth, sheetHeight, allowRotation, strategy));
  const usedLengthScore = (run) => run.layouts.reduce((total, layout) => total + layout.usedLength, 0);
  runs.sort((a, b) => a.unfit.length - b.unfit.length || a.layouts.length - b.layouts.length || usedLengthScore(a) - usedLengthScore(b));
  return runs[0];
}

function sumPlacedPieceAreaM2(layouts) {
  return layouts.reduce((total, layout) => total + layout.items.reduce((area, item) => {
    const width = positive(item.actualW, item.originalW);
    const height = positive(item.actualH, item.originalH);
    return area + (width * height) / 1000000;
  }, 0), 0);
}

function calculateQuote() {
  const result = emptyComputed();
  const warnings = [];
  state.materials.forEach((material) => {
    const items = buildItemsForMaterial(material);
    if (!items.length) return;
    const pieceAreaM2 = items.reduce((sum, item) => sum + (item.originalW * item.originalH) / 1000000, 0);
    const areaOnly = material.calculationMode === 'area';
    if (areaOnly) {
      const billingQuantity = pieceAreaM2;
      const pricing = resolveMaterialPricing(material, billingQuantity);
      const cost = billingQuantity * pricing.unitPrice;
      const materialResult = {
        material,
        calculationMode: 'area',
        rollWidth: 0,
        layout: null,
        areaOnly: true,
        usedLengthM: 0,
        consumedAreaM2: pieceAreaM2,
        pieceAreaM2,
        billingQuantity,
        unitPrice: pricing.unitPrice,
        volumeTier: pricing.tier,
        cost,
        warnings: [],
      };
      result.materialResults.push(materialResult);
      result.consumedAreaM2 += pieceAreaM2;
      result.piecesAreaM2 += pieceAreaM2;
      result.baseMaterialCost += cost;
      return;
    }
    if (material.calculationMode === 'sheet') {
      const sheetWidth = positive(material.widthCm) * 10;
      const sheetHeight = positive(material.heightCm) * 10;
      if (sheetWidth <= 0 || sheetHeight <= 0) {
        warnings.push(`${material.name}: informe a largura e a altura da chapa.`);
        return;
      }
      const sheetPacking = chooseBestSheetLayouts(items, sheetWidth, sheetHeight, material.rotate, state.optimize);
      const layouts = sheetPacking.layouts;
      layouts.forEach((layout) => layout.items.forEach((item) => { item.description = item.description || 'Peça'; }));
      const sheetCount = layouts.length;
      const sheetAreaM2 = (sheetWidth * sheetHeight) / 1000000;
      const consumedAreaM2 = sheetAreaM2 * sheetCount;
      const placedPieceAreaM2 = sumPlacedPieceAreaM2(layouts);
      const billingQuantity = material.basis === 'm2' ? placedPieceAreaM2 : sheetCount;
      const pricing = resolveMaterialPricing(material, billingQuantity);
      const cost = billingQuantity * pricing.unitPrice;
      const unfitNames = sheetPacking.unfit.map((item) => item.description);
      if (unfitNames.length) warnings.push(`${material.name}: ${unfitNames.join(', ')} não coube em nenhuma chapa.`);
      const layout = {
        items: layouts.flatMap((sheetLayout) => sheetLayout.items),
        usedLength: sheetHeight * sheetCount,
        unfit: sheetPacking.unfit,
      };
      result.materialResults.push({
        material,
        calculationMode: 'sheet',
        sheetOnly: true,
        rollWidth: sheetWidth,
        sheetHeight,
        layouts,
        layout,
        sheetCount,
        areaOnly: false,
        usedLengthM: 0,
        consumedAreaM2,
        pieceAreaM2,
        placedPieceAreaM2,
        billingQuantity,
        unitPrice: pricing.unitPrice,
        volumeTier: pricing.tier,
        cost,
        warnings: unfitNames,
      });
      result.totalSheets += sheetCount;
      result.consumedAreaM2 += consumedAreaM2;
      result.piecesAreaM2 += pieceAreaM2;
      result.baseMaterialCost += cost;
      return;
    }
    const rollWidth = positive(material.widthCm) * 10;
    if (rollWidth <= 0) {
      warnings.push(`${material.name}: informe a largura da bobina.`);
      return;
    }
    const layout = chooseBestLayout(items, rollWidth, material.rotate, state.optimize);
    layout.items.forEach((item) => {
      item.description = item.description || 'Peça';
    });
    const usedLengthM = layout.usedLength / 1000;
    const consumedAreaM2 = (rollWidth * layout.usedLength) / 1000000;
    const billingQuantity = material.basis === 'm2' ? consumedAreaM2 : usedLengthM;
    const pricing = resolveMaterialPricing(material, billingQuantity);
    const cost = billingQuantity * pricing.unitPrice;
    const unfitNames = layout.unfit.map((item) => item.description);
    if (layout.unfit.length) warnings.push(`${material.name}: ${unfitNames.join(', ')} não coube na largura informada.`);
    const materialResult = {
      material,
      calculationMode: 'roll',
      rollWidth,
      layout,
      areaOnly: false,
      usedLengthM,
      consumedAreaM2,
      pieceAreaM2,
      billingQuantity,
      unitPrice: pricing.unitPrice,
      volumeTier: pricing.tier,
      cost,
      warnings: unfitNames,
    };
    result.materialResults.push(materialResult);
    result.totalLengthM += usedLengthM;
    result.consumedAreaM2 += consumedAreaM2;
    result.piecesAreaM2 += pieceAreaM2;
    result.baseMaterialCost += cost;
  });
  result.wasteAreaM2 = Math.max(0, result.consumedAreaM2 - result.piecesAreaM2);
  result.utilization = result.consumedAreaM2 > 0 ? Math.min(100, (result.piecesAreaM2 / result.consumedAreaM2) * 100) : 0;
  result.materialResults.forEach((baseResult) => {
    const laminateId = baseResult.material.laminationMaterialId;
    if (!laminateId) return;
    const laminate = getMaterial(laminateId);
    if (!laminate || laminate.id === baseResult.material.id) {
      warnings.push(`${baseResult.material.name}: material de laminação não encontrado.`);
      return;
    }
    const baseAreaM2 = baseResult.areaOnly
      ? baseResult.pieceAreaM2
      : baseResult.sheetOnly
        ? baseResult.placedPieceAreaM2
        : baseResult.consumedAreaM2;
    const laminateAreaOnly = laminate.calculationMode === 'area';
    const laminateIsSheet = laminate.calculationMode === 'sheet';
    const laminateWidth = positive(laminate.widthCm) * 10;
    const laminateHeight = positive(laminate.heightCm) * 10;
    let laminationLayout = null;
    let laminationLayouts = [];
    let laminationSheetCount = 0;
    let laminationUsedLengthM = 0;
    const laminateWarnings = [];
    if (!laminateAreaOnly) {
      if (laminateWidth <= 0 || (laminateIsSheet && laminateHeight <= 0)) {
        const message = laminateIsSheet ? 'Informe a largura e a altura da chapa para calcular a laminação.' : 'Informe a largura da bobina para calcular a laminação.';
        laminateWarnings.push(message);
        warnings.push(`${laminate.name}: ${message}`);
      } else if (laminateIsSheet) {
        const sheetPacking = chooseBestSheetLayouts(buildItemsForMaterial(baseResult.material), laminateWidth, laminateHeight, laminate.rotate, state.optimize);
        laminationLayouts = sheetPacking.layouts;
        laminationLayouts.forEach((layout) => layout.items.forEach((item) => { item.description = item.description || 'Peça'; }));
        laminationSheetCount = laminationLayouts.length;
        laminationLayout = {
          items: laminationLayouts.flatMap((sheetLayout) => sheetLayout.items),
          usedLength: laminateHeight * laminationSheetCount,
          unfit: sheetPacking.unfit,
        };
        const unfitNames = sheetPacking.unfit.map((item) => item.description);
        if (unfitNames.length) {
          const warning = `${unfitNames.join(', ')} não coube em nenhuma chapa de laminação.`;
          laminateWarnings.push(warning);
          warnings.push(`${laminate.name}: ${warning}`);
        }
      } else {
        laminationLayout = chooseBestLayout(buildItemsForMaterial(baseResult.material), laminateWidth, laminate.rotate, state.optimize);
        laminationUsedLengthM = laminationLayout.usedLength / 1000;
        const unfitNames = laminationLayout.unfit.map((item) => item.description);
        if (unfitNames.length) {
          const warning = `${unfitNames.join(', ')} não coube na largura informada para laminação.`;
          laminateWarnings.push(warning);
          warnings.push(`${laminate.name}: ${warning}`);
        }
      }
    }
    const laminationAreaM2 = laminateAreaOnly
      ? baseAreaM2
      : laminateIsSheet
        ? ((laminateWidth * laminateHeight) / 1000000) * laminationSheetCount
        : (laminateWidth * (laminationLayout?.usedLength || 0)) / 1000000;
    const laminationPieceAreaM2 = sumPlacedPieceAreaM2(laminationLayouts);
    const billingQuantity = laminateAreaOnly
      ? baseAreaM2
      : laminate.basis === 'm2'
        ? laminateIsSheet ? laminationPieceAreaM2 : laminationAreaM2
        : laminateIsSheet
          ? laminationSheetCount
          : laminationUsedLengthM;
    const pricing = resolveMaterialPricing(laminate, billingQuantity);
    const laminationCost = billingQuantity * pricing.unitPrice;
    const laminationResult = {
      baseMaterial: baseResult.material,
      material: laminate,
      calculationMode: laminate.calculationMode,
      sheetOnly: laminateIsSheet,
      rollWidth: laminateAreaOnly ? 0 : laminateWidth,
      sheetHeight: laminateIsSheet ? laminateHeight : 0,
      layouts: laminationLayouts,
      sheetCount: laminationSheetCount,
      layout: laminationLayout,
      usedLengthM: laminationUsedLengthM,
      consumedAreaM2: laminationAreaM2,
      areaOnly: laminateAreaOnly,
      billingQuantity,
      unitPrice: pricing.unitPrice,
      volumeTier: pricing.tier,
      cost: laminationCost,
      warnings: laminateWarnings,
    };
    baseResult.laminationResult = laminationResult;
    result.laminationResults.push(laminationResult);
    result.laminationLengthM += laminationUsedLengthM;
    result.laminationSheets += laminationSheetCount;
    result.laminationAreaM2 += laminationAreaM2;
    result.laminationCost += laminationCost;
  });
  result.materialCost = result.baseMaterialCost + result.laminationCost;
  result.warnings = warnings;
  result.installationBasisQuantity = state.installation.basis === 'm2' ? result.piecesAreaM2 : state.installation.basis === 'linear' ? result.totalLengthM : 1;
  const suppliesCost = state.installation.supplies.reduce((sum, supply) => sum + positive(supply.quantity) * positive(supply.unitPrice), 0);
  const installationQuantity = state.installation.autoQuantity ? result.installationBasisQuantity : positive(state.installation.quantity);
  result.installationQuantity = state.installation.basis === 'fixed' ? 1 : installationQuantity;
  const installationLaborCost = state.installation.basis === 'fixed' ? positive(state.installation.unitPrice) : installationQuantity * positive(state.installation.unitPrice);
  const travelCost = positive(state.installation.travel);
  const otherCosts = positive(state.otherCosts);
  result.suppliesCost = suppliesCost;
  result.installationLaborCost = installationLaborCost;
  result.installationCost = installationLaborCost + suppliesCost + travelCost;
  result.travelCost = travelCost;
  result.otherCosts = otherCosts;
  result.totalCost = result.materialCost + result.installationCost + otherCosts;
  result.salePrice = positive(state.salePrice);
  result.profit = result.salePrice - result.totalCost;
  result.margin = result.salePrice > 0 ? (result.profit / result.salePrice) * 100 : 0;
  result.markup = result.totalCost > 0 ? ((result.salePrice / result.totalCost) - 1) * 100 : 0;
  const marginDecimal = Math.min(0.999, Math.max(0, positive(state.targetMargin) / 100));
  result.suggestedPrice = result.totalCost > 0 ? result.totalCost / (1 - marginDecimal) : 0;
  return result;
}

let installationExpanded = true;

function switchView(viewId) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === viewId));
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === viewId));
  const labels = {
    'calculator-view': ['OFICINA / PRODUÇÃO', 'Calculadora'],
    'quotes-view': ['HISTÓRICO LOCAL', 'Orçamentos'],
    'materials-view': ['CATÁLOGO LOCAL', 'Materiais'],
    'help-view': ['GUIA RÁPIDO', 'Como usar'],
  };
  const [eyebrow, title] = labels[viewId] || labels['calculator-view'];
  const eyebrowElement = document.getElementById('page-eyebrow');
  const titleElement = document.getElementById('page-title');
  if (eyebrowElement) eyebrowElement.textContent = eyebrow;
  if (titleElement) titleElement.textContent = title;
  if (viewId === 'quotes-view') renderQuotes();
  if (viewId === 'materials-view') renderSavedMaterials();
}

function renderAll({ persistDraft = true } = {}) {
  renderStaticControls();
  renderMaterialEditors();
  renderPieces();
  renderSupplies();
  renderClientQuoteForm();
  renderQuotes();
  renderSavedMaterials();
  calculateAndRender({ persistDraft });
}

function resetCurrentCalculation({ empty = false, message = 'Novo cálculo pronto.' } = {}) {
  const source = !empty && savedMaterials[0] ? normalizeMaterial({ ...savedMaterials[0], id: uid('mat') }) : defaultMaterial();
  const businessProfile = {
    businessName: state.clientQuote?.businessName || '',
    businessPhone: state.clientQuote?.businessPhone || '',
    businessEmail: state.clientQuote?.businessEmail || '',
  };
  state.quoteId = null;
  state.quoteName = '';
  state.clientQuote = { ...defaultClientQuote(), ...businessProfile };
  state.materials = [source];
  state.pieces = empty ? [] : [defaultPiece(source.id)];
  state.globalBleed = 0;
  state.globalGap = source.gapMm ?? 2;
  state.optimize = true;
  state.installation = { type: 'lona', basis: 'm2', quantity: 0, unitPrice: 0, travel: 0, autoQuantity: true, supplies: [] };
  state.salePrice = 0;
  state.otherCosts = 0;
  state.targetMargin = 35;
  renderAll();
  switchView('calculator-view');
  showToast(message);
}

function clearCurrentQuote() {
  if (!window.confirm('Limpar os dados deste orçamento? Os orçamentos já salvos no histórico não serão apagados.')) return;
  resetCurrentCalculation({ empty: true, message: 'Orçamento limpo. Agora você pode puxar um produto do catálogo.' });
}

function addMaterial() {
  const material = {
    id: uid('mat'),
    name: `Material ${state.materials.length + 1}`,
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
  };
  state.materials.push(material);
  renderMaterialEditors();
  renderPieces();
  calculateAndRender();
}

function addMaterialTier(id) {
  const material = state.materials.find((item) => item.id === id);
  if (!material) return;
  if (!Array.isArray(material.volumePricing)) material.volumePricing = [];
  material.volumePricing.push({ minQuantity: 0, unitPrice: 0 });
  renderMaterialEditors();
  calculateAndRender();
  const card = [...document.querySelectorAll('[data-material-card]')].find((element) => element.dataset.materialCard === id);
  const rows = card?.querySelectorAll('.volume-pricing-row');
  if (rows?.length) rows[rows.length - 1].querySelector('input')?.focus();
}

function removeMaterialTier(id, tierIndex) {
  const material = state.materials.find((item) => item.id === id);
  if (!material || !Array.isArray(material.volumePricing)) return;
  material.volumePricing.splice(Number(tierIndex), 1);
  renderMaterialEditors();
  calculateAndRender();
}

function addPiece() {
  state.pieces.push(defaultPiece(state.materials[0]?.id));
  renderPieces();
  calculateAndRender();
  const rows = document.querySelectorAll('[data-piece-card]');
  rows[rows.length - 1]?.querySelector('input')?.focus();
}

function addSupply() {
  state.installation.supplies.push({ id: uid('supply'), description: 'Novo insumo', descriptionIsDefault: true, quantity: 1, unit: 'un', unitIsDefault: true, unitPrice: 0 });
  renderSupplies();
  calculateAndRender();
  const rows = document.querySelectorAll('.supply-row');
  rows[rows.length - 1]?.querySelector('input')?.focus();
}

function removePiece(id) {
  state.pieces = state.pieces.filter((piece) => piece.id !== id);
  renderPieces();
  calculateAndRender();
}

function removeSupply(id) {
  state.installation.supplies = state.installation.supplies.filter((supply) => supply.id !== id);
  renderSupplies();
  calculateAndRender();
}

function removeMaterial(id) {
  if (state.materials.length <= 1) return;
  const fallback = state.materials.find((material) => material.id !== id);
  state.materials = state.materials.filter((material) => material.id !== id);
  state.pieces = state.pieces.map((piece) => piece.materialId === id ? { ...piece, materialId: fallback.id } : piece);
  state.materials = state.materials.map((material) => material.laminationMaterialId === id ? { ...material, laminationMaterialId: null } : material);
  renderMaterialEditors();
  renderPieces();
  calculateAndRender();
  showToast('Material removido e peças transferidas para o material principal.');
}

function updateMaterialFromElement(element) {
  const material = state.materials.find((item) => item.id === element.dataset.materialId);
  if (!material) return;
  const field = element.dataset.materialField;
  if (field === 'tierMinQuantity' || field === 'tierUnitPrice') {
    const tier = material.volumePricing?.[Number(element.dataset.tierIndex)];
    if (!tier) return;
    tier[field === 'tierMinQuantity' ? 'minQuantity' : 'unitPrice'] = positive(element.value);
    return;
  }
  if (field === 'widthCm') {
    material.widthCm = positive(element.value);
    material.widthIsDefault = false;
  } else if (field === 'heightCm' || field === 'price') material[field] = positive(element.value);
  else if (field === 'calculationMode') {
    material.calculationMode = ['area', 'sheet'].includes(element.value) ? element.value : 'roll';
    if (material.calculationMode === 'area') material.basis = 'm2';
    else if (material.calculationMode === 'sheet' && !['m2', 'sheet'].includes(material.basis)) material.basis = 'sheet';
    else if (material.calculationMode === 'roll' && !['linear', 'm2'].includes(material.basis)) material.basis = 'linear';
  } else if (field === 'basis') {
    material[field] = material.calculationMode === 'area' ? 'm2' : element.value;
  } else material[field] = element.value;
  if (field === 'name') {
    material.nameIsDefault = false;
    const card = [...document.querySelectorAll('[data-material-card]')].find((item) => item.dataset.materialCard === material.id);
    const title = card?.querySelector('.material-title');
    if (title) title.textContent = material.name || 'Material';
  }
}

function updatePieceFromElement(element) {
  const piece = state.pieces.find((item) => item.id === element.dataset.pieceId);
  if (!piece) return;
  const field = element.dataset.pieceField;
  if (field === 'description') {
    piece[field] = element.value;
    piece.descriptionIsDefault = false;
  }
  else if (field === 'materialId') piece[field] = element.value;
  else if (field === 'quantity') piece[field] = Math.max(1, Math.floor(positive(element.value, 1)));
  else piece[field] = positive(element.value);
}

function updateSupplyFromElement(element) {
  const supply = state.installation.supplies.find((item) => item.id === element.dataset.supplyId);
  if (!supply) return;
  const field = element.dataset.supplyField;
  supply[field] = ['quantity', 'unitPrice'].includes(field) ? positive(element.value) : element.value;
  if (field === 'description') supply.descriptionIsDefault = false;
  if (field === 'unit') supply.unitIsDefault = false;
}

function updateDirectField(element) {
  const id = element.id;
  if (id === 'quote-name') state.quoteName = element.value;
  if (id === 'global-bleed') state.globalBleed = positive(element.value);
  if (id === 'global-gap') state.globalGap = positive(element.value);
  if (id === 'installation-type') state.installation.type = element.value;
  if (id === 'installation-basis') state.installation.basis = element.value;
  if (id === 'installation-quantity') state.installation.quantity = positive(element.value);
  if (id === 'installation-unit-price') state.installation.unitPrice = positive(element.value);
  if (id === 'installation-travel') state.installation.travel = positive(element.value);
  if (id === 'sale-price') state.salePrice = positive(element.value);
  if (id === 'other-costs') state.otherCosts = positive(element.value);
  if (id === 'target-margin') state.targetMargin = Math.min(99.9, Math.max(0, num(element.value, 35)));
}

function handleFieldEvent(element) {
  if (element.id === 'saved-material-calculation-mode' || element.id === 'saved-material-basis') {
    syncSavedMaterialFormMode();
    return;
  }
  if (element.dataset.savedTierIndex !== undefined) {
    const tier = savedMaterialVolumeTiers[Number(element.dataset.savedTierIndex)];
    if (tier) tier[element.dataset.savedTierField] = positive(element.value);
    return;
  }
  if (element.dataset.clientField) {
    const field = element.dataset.clientField;
    state.clientQuote[field] = element.value;
    if (field === 'validity') state.clientQuote.validityIsDefault = false;
    if (field === 'paymentTerms') state.clientQuote.paymentTermsIsDefault = false;
    renderClientQuotePreview();
    persistDraftSoon();
    return;
  }
  if (element.dataset.materialId) {
    updateMaterialFromElement(element);
    if (['laminationMaterialId', 'calculationMode', 'basis'].includes(element.dataset.materialField)) renderMaterialEditors();
  }
  else if (element.dataset.pieceId) updatePieceFromElement(element);
  else if (element.dataset.supplyId) updateSupplyFromElement(element);
  else updateDirectField(element);
  calculateAndRender();
}

function toggleButton(button, active) {
  button.classList.toggle('on', active);
  button.setAttribute('aria-checked', String(active));
}

function toggleInstallationPanel() {
  installationExpanded = !installationExpanded;
  const content = document.getElementById('installation-content');
  const button = document.getElementById('toggle-installation');
  content?.classList.toggle('installation-content-hidden', !installationExpanded);
  if (button) {
    button.textContent = installationExpanded ? 'Recolher' : 'Expandir';
    button.setAttribute('aria-expanded', String(installationExpanded));
  }
}

async function saveQuote() {
  const name = state.quoteName.trim() || `Orçamento ${new Date().toLocaleDateString('pt-BR')}`;
  const id = state.quoteId || uid('quote');
  const snapshot = clone(state);
  snapshot.materials = snapshot.materials.map((material) => ({ ...material, widthIsDefault: false }));
  const quote = {
    id,
    name,
    snapshot,
    salePrice: computed.salePrice,
    totalCost: computed.totalCost,
    profit: computed.profit,
    updatedAt: new Date().toISOString(),
    piecesCount: state.pieces.reduce((sum, piece) => sum + Math.max(0, Math.floor(positive(piece.quantity, 1))), 0),
    materialsCount: state.materials.length,
  };
  try {
    await storePut('quotes', quote);
    savedQuotes = [quote, ...savedQuotes.filter((item) => item.id !== id)].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    state.quoteId = id;
    state.quoteName = name;
    state.materials = state.materials.map((material) => ({ ...material, widthIsDefault: false }));
    persistDraftSoon();
    setValue('quote-name', name);
    showToast('Orçamento salvo neste dispositivo.');
    renderQuotes();
  } catch (error) {
    console.error(error);
    showToast('Não foi possível salvar o orçamento.', 'error');
  }
}

function loadQuote(id) {
  const quote = savedQuotes.find((item) => item.id === id);
  if (!quote?.snapshot) return;
  hydrateState(quote.snapshot);
  state.quoteId = quote.id;
  state.quoteName = quote.name;
  renderAll();
  switchView('calculator-view');
  showToast('Orçamento aberto.');
}

async function deleteQuote(id) {
  const quote = savedQuotes.find((item) => item.id === id);
  if (!quote || !window.confirm(`Excluir “${quote.name}”?`)) return;
  try {
    await storeDelete('quotes', id);
    savedQuotes = savedQuotes.filter((item) => item.id !== id);
    renderQuotes();
    showToast('Orçamento excluído.');
  } catch (error) {
    showToast('Não foi possível excluir o orçamento.', 'error');
  }
}

function downloadFile(filename, content, type = 'application/json') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function exportBackup() {
  const backup = {
    app: 'GrafiFlow',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    draft: clone(state),
    materials: clone(savedMaterials),
    quotes: clone(savedQuotes),
  };
  downloadFile(`grafiflow-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup, null, 2));
  showToast('Backup exportado.');
}

async function importBackup(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || !['GrafiFlow', 'Nesto'].includes(parsed.app)) throw new Error('Arquivo incompatível');
    if (parsed.draft) hydrateState(parsed.draft, { inferDefaultText: !parsed.draft.quoteId });
    if (Array.isArray(parsed.materials)) savedMaterials = parsed.materials.map(normalizeMaterial);
    if (Array.isArray(parsed.quotes)) savedQuotes = parsed.quotes;
    await storePut('settings', { key: 'draft', value: clone(state), updatedAt: new Date().toISOString(), cloudIntent: true });
    for (const material of savedMaterials) await storePut('materials', material);
    for (const quote of savedQuotes) await storePut('quotes', quote);
    renderAll({ persistDraft: false });
    showToast('Backup importado com sucesso.');
  } catch (error) {
    console.error(error);
    showToast('Esse arquivo não é um backup válido do GrafiFlow.', 'error');
  }
}

function syncSavedMaterialFormMode() {
  const mode = document.getElementById('saved-material-calculation-mode')?.value || 'roll';
  const areaOnly = mode === 'area';
  const sheetMode = mode === 'sheet';
  const width = document.getElementById('saved-material-width');
  const height = document.getElementById('saved-material-height');
  const widthLabel = document.getElementById('saved-material-width-label');
  const heightField = document.getElementById('saved-material-height-field');
  const basis = document.getElementById('saved-material-basis');
  const priceLabel = document.getElementById('saved-material-price-label');
  const gap = document.getElementById('saved-material-gap');
  const rotate = document.getElementById('saved-material-rotate');
  if (widthLabel) widthLabel.textContent = sheetMode ? 'Largura da chapa' : 'Largura da bobina';
  if (width) {
    width.disabled = areaOnly;
    width.required = !areaOnly;
  }
  if (heightField) heightField.hidden = !sheetMode;
  if (height) {
    height.disabled = !sheetMode;
    height.required = sheetMode;
  }
  if (gap) gap.disabled = areaOnly;
  if (rotate) rotate.disabled = areaOnly;
  if (basis) {
    const linearOption = basis.querySelector('option[value="linear"]');
    const sheetOption = basis.querySelector('option[value="sheet"]');
    if (linearOption) linearOption.disabled = areaOnly || sheetMode;
    if (sheetOption) sheetOption.disabled = !sheetMode;
    if (areaOnly) basis.value = 'm2';
    else if (sheetMode && !['m2', 'sheet'].includes(basis.value)) basis.value = 'sheet';
    else if (!sheetMode && basis.value === 'sheet') basis.value = 'linear';
    basis.disabled = areaOnly;
  }
  const priceUnit = areaOnly || basis?.value === 'm2' ? 'R$/m²' : sheetMode ? 'R$/chapa' : 'R$/metro linear';
  if (priceLabel) priceLabel.textContent = `Preço base (${priceUnit})`;
  [width, height, basis, gap, rotate].forEach((element) => element?.closest('.field')?.classList.toggle('field-disabled', element?.disabled || false));
  renderSavedMaterialVolumePricing();
}
function addSavedMaterialTier() {
  savedMaterialVolumeTiers.push({ minQuantity: 0, unitPrice: 0 });
  renderSavedMaterialVolumePricing();
  const rows = document.querySelectorAll('#saved-material-volume-tiers .volume-pricing-row');
  if (rows.length) rows[rows.length - 1].querySelector('input')?.focus();
}

function removeSavedMaterialTier(tierIndex) {
  savedMaterialVolumeTiers.splice(Number(tierIndex), 1);
  renderSavedMaterialVolumePricing();
}

function resetSavedMaterialForm() {
  const form = document.getElementById('saved-material-form');
  form?.reset();
  savedMaterialVolumeTiers = [];
  setValue('saved-material-id', '');
  setValue('saved-material-calculation-mode', 'roll');
  setValue('saved-material-gap', 2);
  const title = document.getElementById('saved-material-form-title');
  if (title) title.textContent = 'Novo material';
  const rotate = document.getElementById('saved-material-rotate');
  if (rotate) rotate.checked = true;
  syncSavedMaterialFormMode();
}
function editSavedMaterial(id) {
  const material = savedMaterials.find((item) => item.id === id);
  if (!material) return;
  setValue('saved-material-id', material.id);
  setValue('saved-material-name', material.name);
  setValue('saved-material-supplier', material.supplier || '');
  setValue('saved-material-calculation-mode', material.calculationMode);
  setValue('saved-material-width', material.widthCm);
  setValue('saved-material-height', material.heightCm);
  setValue('saved-material-price', material.price);
  setValue('saved-material-basis', material.basis);
  setValue('saved-material-gap', material.gapMm ?? 2);
  savedMaterialVolumeTiers = clone(material.volumePricing || []);
  const rotate = document.getElementById('saved-material-rotate');
  if (rotate) rotate.checked = material.rotate !== false;
  const title = document.getElementById('saved-material-form-title');
  if (title) title.textContent = 'Editar material';
  syncSavedMaterialFormMode();
  document.getElementById('saved-material-form-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function submitSavedMaterial(event) {
  event.preventDefault();
  const id = document.getElementById('saved-material-id').value || uid('saved-mat');
  const selectedMode = document.getElementById('saved-material-calculation-mode').value;
  const calculationMode = ['area', 'sheet'].includes(selectedMode) ? selectedMode : 'roll';
  const selectedBasis = document.getElementById('saved-material-basis').value;
  const material = {
    id,
    name: document.getElementById('saved-material-name').value.trim() || 'Material sem nome',
    supplier: document.getElementById('saved-material-supplier').value.trim(),
    calculationMode,
    widthCm: calculationMode === 'area' ? 0 : positive(document.getElementById('saved-material-width').value),
    heightCm: calculationMode === 'sheet' ? positive(document.getElementById('saved-material-height').value) : 0,
    price: positive(document.getElementById('saved-material-price').value),
    basis: calculationMode === 'area' ? 'm2' : calculationMode === 'sheet' ? (selectedBasis === 'm2' ? 'm2' : 'sheet') : selectedBasis === 'm2' ? 'm2' : 'linear',
    volumePricing: normalizeVolumePricing(savedMaterialVolumeTiers),
    gapMm: positive(document.getElementById('saved-material-gap').value, 2),
    rotate: document.getElementById('saved-material-rotate').checked,
  };
  if (calculationMode !== 'area' && !material.widthCm) {
    showToast(`Informe a largura da ${calculationMode === 'sheet' ? 'chapa' : 'bobina'}.`, 'error');
    return;
  }
  if (calculationMode === 'sheet' && !material.heightCm) {
    showToast('Informe a altura da chapa.', 'error');
    return;
  }
  try {
    await storePut('materials', material);
    savedMaterials = [normalizeMaterial(material), ...savedMaterials.filter((item) => item.id !== id)];
    resetSavedMaterialForm();
    renderSavedMaterials();
    showToast('Material cadastrado.');
  } catch (error) {
    showToast('Não foi possível salvar o material.', 'error');
  }
}
function useSavedMaterial(id) {
  const source = savedMaterials.find((item) => item.id === id);
  if (!source) return;
  const currentMaterial = state.materials[0];
  const material = normalizeMaterial({
    ...source,
    id: currentMaterial?.id || uid('mat'),
    widthIsDefault: false,
    laminationMaterialId: currentMaterial?.laminationMaterialId || null,
  });
  if (currentMaterial) state.materials[0] = material;
  else state.materials = [material];
  if (!state.pieces.length) state.pieces.push(defaultPiece(material.id));
  closeMaterialPicker();
  renderAll();
  switchView('calculator-view');
  showToast(`“${source.name}” substituiu o material principal.`);
}

async function deleteSavedMaterial(id) {
  const material = savedMaterials.find((item) => item.id === id);
  if (!material || !window.confirm(`Excluir o material “${material.name}”?`)) return;
  await storeDelete('materials', id);
  savedMaterials = savedMaterials.filter((item) => item.id !== id);
  renderSavedMaterials();
  showToast('Material excluído.');
}

function openMapSearch() {
  if (!navigator.onLine) {
    showToast('Conecte-se à internet para pesquisar lojas próximas.', 'error');
    return;
  }
  const names = [...state.materials.map((material) => material.name), ...state.installation.supplies.map((supply) => supply.description)].filter(Boolean);
  const query = names.length ? `${names.slice(0, 3).join(' ')} loja de comunicação visual perto de mim` : 'materiais para comunicação visual perto de mim';
  window.open(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, '_blank', 'noopener');
}

function openLayoutModal() {
  const modal = document.getElementById('layout-modal');
  const canvas = document.getElementById('modal-layout-canvas');
  if (!modal || !canvas) return;
  canvas.innerHTML = computed.materialResults.length ? computed.materialResults.map((result) => renderMaterialResultBlock(result, false)).join('') : '<div class="canvas-placeholder">Adicione peças válidas primeiro.</div>';
  modal.hidden = false;
}

function updateConnectionStatus() {
  const online = navigator.onLine;
  const badge = document.getElementById('connection-badge');
  const sidebarDot = document.getElementById('sidebar-status-dot');
  const sidebarText = document.getElementById('sidebar-status-text');
  if (badge) {
    badge.classList.toggle('online', online);
    badge.innerHTML = `<span class="status-dot ${online ? 'online' : ''}"></span><span>${online ? 'Online' : 'Offline'}</span>`;
  }
  sidebarDot?.classList.toggle('online', online);
  if (sidebarText) sidebarText.textContent = online ? 'Conexão disponível' : 'Modo local ativo';
  updateAccountStatus();
}

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  try {
    const register = (tool) => Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined);
    register({
      name: 'calculate_nesting',
      title: 'Calcular aproveitamento',
      description: 'Atualiza o cálculo do GrafiFlow usando as peças e bobinas que já estão na tela.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute() {
        calculateAndRender();
        return { status: 'calculated', totalLengthM: computed.totalLengthM, utilization: computed.utilization, laminationCost: computed.laminationCost, totalCost: computed.totalCost };
      },
    });
    register({
      name: 'read_grafiflow_summary',
      title: 'Ler resumo do cálculo',
      description: 'Retorna o resumo do encaixe, custo e lucro exibidos no GrafiFlow.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute() {
        return { totalLengthM: computed.totalLengthM, consumedAreaM2: computed.consumedAreaM2, laminationAreaM2: computed.laminationAreaM2, utilization: computed.utilization, materialCost: computed.materialCost, laminationCost: computed.laminationCost, totalCost: computed.totalCost, salePrice: computed.salePrice, profit: computed.profit, margin: computed.margin };
      },
    });
  } catch (error) {
    console.warn('WebMCP indisponível.', error);
  }
}

function handleClick(event) {
  const nav = event.target.closest('.nav-item');
  if (nav) {
    switchView(nav.dataset.view);
    return;
  }
  const actionButton = event.target.closest('[data-action]');
  if (actionButton) {
    const action = actionButton.dataset.action;
    const id = actionButton.dataset.id;
    if (action === 'remove-piece') removePiece(id);
    if (action === 'remove-supply') removeSupply(id);
    if (action === 'remove-material') removeMaterial(id);
    if (action === 'add-material-tier') addMaterialTier(id);
    if (action === 'remove-material-tier') removeMaterialTier(id, actionButton.dataset.tierIndex);
    if (action === 'add-saved-material-tier') addSavedMaterialTier();
    if (action === 'remove-saved-material-tier') removeSavedMaterialTier(actionButton.dataset.tierIndex);
    if (action === 'toggle-material-rotate') {
      const material = state.materials.find((item) => item.id === id);
      if (material) {
        material.rotate = !material.rotate;
        toggleButton(actionButton, material.rotate);
        calculateAndRender();
      }
    }
    if (action === 'load-quote') loadQuote(id);
    if (action === 'delete-quote') deleteQuote(id);
    if (action === 'use-saved-material') useSavedMaterial(id);
    if (action === 'edit-saved-material') editSavedMaterial(id);
    if (action === 'delete-saved-material') deleteSavedMaterial(id);
    return;
  }
  const id = event.target.closest('button')?.id;
  if (id === 'new-quote-button' || id === 'quotes-new-button') resetCurrentCalculation();
  if (id === 'clear-quote-button') clearCurrentQuote();
  if (id === 'save-quote-button') saveQuote();
  if (id === 'print-button') openClientQuoteModal();
  if (id === 'client-quote-print') printClientQuote();
  if (id === 'close-client-quote-modal' || id === 'cancel-client-quote') closeClientQuoteModal();
  if (id === 'add-material-button') addMaterial();
  if (id === 'add-piece-button') addPiece();
  if (id === 'add-supply-button') addSupply();
  if (id === 'toggle-installation') toggleInstallationPanel();
  if (id === 'zoom-layout-button') openLayoutModal();
  if (id === 'close-layout-modal') document.getElementById('layout-modal').hidden = true;
  if (id === 'find-stores-button') openMapSearch();
  if (id === 'account-button') openAccountModal();
  if (id === 'close-account-modal' || id === 'cancel-account-modal') document.getElementById('account-modal').hidden = true;
  if (id === 'auth-mode-toggle') {
    authMode = authMode === 'signup' ? 'login' : 'signup';
    renderAuthMode();
  }
  if (id === 'auth-signout') signOutCloudAccount();
  if (id === 'auth-sync-now') syncCloudNow().then(() => showToast('Dados sincronizados.')).catch((error) => showToast(error.message || 'Não foi possível sincronizar.', 'error'));
  if (id === 'open-material-picker') openMaterialPicker();
  if (id === 'close-material-picker') closeMaterialPicker();
  if (id === 'picker-open-catalog') openMaterialCatalog();
  if (id === 'backup-button') exportBackup();
  if (id === 'install-button' || id === 'help-install-button') installApp();
  if (id === 'materials-new-button' || id === 'cancel-saved-material') resetSavedMaterialForm();
  if (id === 'optimize-button') {
    state.optimize = !state.optimize;
    toggleButton(event.target.closest('#optimize-button'), state.optimize);
    calculateAndRender();
  }
  if (id === 'auto-installation-button') {
    state.installation.autoQuantity = !state.installation.autoQuantity;
    toggleButton(event.target.closest('#auto-installation-button'), state.installation.autoQuantity);
    calculateAndRender();
  }
}

function handleInput(event) {
  const element = event.target;
  if (!(element.matches('input, select, textarea'))) return;
  handleFieldEvent(element);
}

function clearPresetTextOnFocus(event) {
  const element = event.target;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;
  if (element.dataset.clearOnFocus !== 'true' || !element.value) return;
  element.value = '';
  delete element.dataset.clearOnFocus;
  handleFieldEvent(element);
}

function initialize() {
  document.addEventListener('click', handleClick);
  document.addEventListener('focusin', clearPresetTextOnFocus);
  document.addEventListener('input', handleInput);
  document.addEventListener('change', handleInput);
  document.getElementById('saved-material-form')?.addEventListener('submit', submitSavedMaterial);
  document.getElementById('account-auth-form')?.addEventListener('submit', submitCloudAuth);
  document.getElementById('restore-input')?.addEventListener('change', (event) => importBackup(event.target.files?.[0]));
  document.getElementById('layout-modal')?.addEventListener('click', (event) => {
    if (event.target.id === 'layout-modal') event.currentTarget.hidden = true;
  });
  document.getElementById('material-picker-modal')?.addEventListener('click', (event) => {
    if (event.target.id === 'material-picker-modal') closeMaterialPicker();
  });
  document.getElementById('client-quote-modal')?.addEventListener('click', (event) => {
    if (event.target.id === 'client-quote-modal') closeClientQuoteModal();
  });
  document.getElementById('account-modal')?.addEventListener('click', (event) => {
    if (event.target.id === 'account-modal') event.currentTarget.hidden = true;
  });
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('client-quote-printing');
    document.documentElement.classList.remove('client-quote-printing');
  });
  window.addEventListener('online', updateConnectionStatus);
  window.addEventListener('offline', updateConnectionStatus);
  window.addEventListener('online', () => restoreCloudAccount());
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    renderInstallButton();
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    renderInstallButton();
    showToast('GrafiFlow instalado como aplicativo.');
  });
  updateConnectionStatus();
  renderInstallButton();
  registerWebMcpTools();
  loadPersistence().then(() => {
    if (!state.pieces.length) state.pieces.push(defaultPiece(state.materials[0]?.id));
    renderAll({ persistDraft: false });
    restoreCloudAccount();
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js?v=20261003-grafiflow-cloud-sync-v1').catch(() => undefined);
}

initialize();
