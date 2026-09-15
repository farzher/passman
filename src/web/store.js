import { DEFAULT_SETTINGS } from '../vault/models.js';
import { decryptPayload, replacePayload } from '../crypto/vault-crypto.js';

const DB_NAME = 'passman-web';
const STORE_NAME = 'state';
const VAULT = 'vault';
const SETTINGS = 'settings';

let dbPromise;
let sessionKey = null;
let touched = 0;
let workerSeededAt = 0;
let workerTouchedAt = 0;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open local PassMan storage.'));
    });
  }
  return dbPromise;
}

async function readValue(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not read local PassMan storage.'));
  });
}

async function writeValue(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Could not write local PassMan storage.'));
    tx.onabort = () => reject(tx.error || new Error('Could not write local PassMan storage.'));
  });
}

function settingsFrom(stored, envelope) {
  return { ...DEFAULT_SETTINGS, ...(stored || {}), passwordHint: String(envelope?.passwordHint?.text || '') };
}

async function workerSession(message) {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const worker = navigator.serviceWorker.controller || registration?.active;
    if (!worker) return null;
    return await new Promise(resolve => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 1500);
      channel.port1.onmessage = event => {
        clearTimeout(timer);
        resolve(event.data?.ok ? event.data : null);
      };
      worker.postMessage(message, [channel.port2]);
    });
  } catch {
    return null;
  }
}

async function getEnvelope() {
  return readValue(VAULT);
}

async function setEnvelope(envelope) {
  await writeValue(VAULT, envelope);
}

async function getSettings() {
  const [stored, envelope] = await Promise.all([readValue(SETTINGS), readValue(VAULT)]);
  return settingsFrom(stored, envelope);
}

async function setSettings(patch) {
  const [stored, currentEnvelope] = await Promise.all([readValue(SETTINGS), readValue(VAULT)]);
  const next = { ...DEFAULT_SETTINGS, ...(stored || {}), ...patch };
  let envelope = currentEnvelope;

  if (Object.prototype.hasOwnProperty.call(patch, 'passwordHint') && envelope) {
    const text = String(patch.passwordHint || '').trim().slice(0, 160);
    envelope = { ...envelope, passwordHint: { text, updatedAt: Date.now() } };
  }

  delete next.passwordHint;
  const writes = [writeValue(SETTINGS, next)];
  if (envelope !== currentEnvelope) writes.push(writeValue(VAULT, envelope));
  await Promise.all(writes);
  if (Object.prototype.hasOwnProperty.call(patch, 'autoLockMinutes') && next.autoLockMinutes > 0 && sessionKey) touchSession();
  return { ...next, passwordHint: String(envelope?.passwordHint?.text || '') };
}

async function setSessionKey(key) {
  sessionKey?.fill(0);
  sessionKey = new Uint8Array(key);
  touched = Date.now();
  const result = await workerSession({ type: 'PASSMAN_SESSION_SET', key: new Uint8Array(sessionKey) });
  workerSeededAt = Date.now();
  workerTouchedAt = workerSeededAt;
  if (Number.isFinite(result?.touched)) touched = result.touched;
}

async function clearSession() {
  sessionKey?.fill(0);
  sessionKey = null;
  touched = 0;
  workerSeededAt = 0;
  workerTouchedAt = 0;
  await workerSession({ type: 'PASSMAN_SESSION_CLEAR' });
}

function touchSession() {
  if (!sessionKey) return;
  touched = Date.now();
  if (touched - workerSeededAt > 10_000) {
    workerSeededAt = touched;
    workerTouchedAt = touched;
    void workerSession({ type: 'PASSMAN_SESSION_SET', key: new Uint8Array(sessionKey) });
  } else if (touched - workerTouchedAt > 5_000) {
    workerTouchedAt = touched;
    void workerSession({ type: 'PASSMAN_SESSION_TOUCH' });
  }
}

async function getSessionKey(touch = true, settings) {
  const resolvedSettings = settings || await getSettings();
  const maxAgeMs = resolvedSettings.autoLockMinutes > 0 ? resolvedSettings.autoLockMinutes * 60_000 : 0;

  if (!sessionKey) {
    const restored = await workerSession({ type: 'PASSMAN_SESSION_GET', maxAgeMs });
    if (restored?.key instanceof Uint8Array && restored.key.length === 32) {
      sessionKey = new Uint8Array(restored.key);
      touched = Number.isFinite(restored.touched) ? restored.touched : Date.now();
      workerSeededAt = Date.now();
      workerTouchedAt = workerSeededAt;
    }
  }

  if (!sessionKey) throw new Error('PassMan is locked.');
  if (maxAgeMs > 0 && Date.now() - touched > maxAgeMs) {
    await clearSession();
    throw new Error('PassMan is locked.');
  }
  if (touch) touchSession();
  return new Uint8Array(sessionKey);
}

async function readVault() {
  const [envelope, stored] = await Promise.all([readValue(VAULT), readValue(SETTINGS)]);
  if (!envelope) throw new Error('PassMan is not set up.');
  const settings = settingsFrom(stored, envelope);
  const key = await getSessionKey(true, settings);
  return { key, envelope, settings, payload: await decryptPayload(key, envelope) };
}

async function writeVault(key, envelope, payload) {
  const next = await replacePayload(key, envelope, payload);
  await setEnvelope(next);
  return next;
}

export {
  clearSession,
  getEnvelope,
  getSessionKey,
  getSettings,
  readVault,
  setEnvelope,
  setSessionKey,
  setSettings,
  touchSession,
  workerSession as workerMessage,
  writeVault
};
