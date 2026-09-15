import { DEFAULT_SETTINGS } from '../vault/models.js';
import { decryptPayload, replacePayload } from '../crypto/vault-crypto.js';

const DB_NAME = 'passman-web';
const STORE_NAME = 'state';
const VAULT = 'vault';
const SETTINGS = 'settings';

let dbPromise;
let sessionKey = null;
let touched = 0;

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

async function getEnvelope() {
  return readValue(VAULT);
}

async function setEnvelope(envelope) {
  await writeValue(VAULT, envelope);
}

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await readValue(SETTINGS) || {}) };
}

async function setSettings(patch) {
  const settings = { ...await getSettings(), ...patch };
  await writeValue(SETTINGS, settings);
  return settings;
}

async function setSessionKey(key) {
  sessionKey?.fill(0);
  sessionKey = new Uint8Array(key);
  touched = Date.now();
}

async function clearSession() {
  sessionKey?.fill(0);
  sessionKey = null;
  touched = 0;
}

async function getSessionKey(touch = true) {
  if (!sessionKey) throw new Error('PassMan is locked.');
  const settings = await getSettings();
  if (settings.autoLockMinutes > 0 && Date.now() - touched > settings.autoLockMinutes * 60_000) {
    await clearSession();
    throw new Error('PassMan is locked.');
  }
  if (touch) touched = Date.now();
  return new Uint8Array(sessionKey);
}

async function readVault() {
  const envelope = await getEnvelope();
  if (!envelope) throw new Error('PassMan is not set up.');
  const key = await getSessionKey();
  return { key, envelope, payload: await decryptPayload(key, envelope) };
}

async function writeVault(key, envelope, payload) {
  const next = await replacePayload(key, envelope, payload);
  await decryptPayload(key, next);
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
  writeVault
};
