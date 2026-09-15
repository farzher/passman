import { DEFAULT_SETTINGS } from './models';
import { base64ToBytes, bytesToBase64 } from '../shared/util';
import { decryptPayload, replacePayload } from '../crypto/vault-crypto';

const VAULT = 'vault';
const SESSION = 'unlocked';

function settingsFrom(stored, envelope) {
  return { ...DEFAULT_SETTINGS, ...(stored || {}), passwordHint: String(envelope?.passwordHint?.text || '') };
}

async function getEnvelope() {
  return (await chrome.storage.local.get(VAULT))[VAULT];
}

async function setEnvelope(envelope) {
  await chrome.storage.local.set({ [VAULT]: envelope });
}

async function getSettings() {
  const data = await chrome.storage.local.get([VAULT, 'settings']);
  return settingsFrom(data.settings, data[VAULT]);
}

async function setSettings(patch) {
  const data = await chrome.storage.local.get([VAULT, 'settings']);
  let envelope = data[VAULT];
  const next = { ...DEFAULT_SETTINGS, ...(data.settings || {}), ...patch };
  const changes = {};

  if (Object.prototype.hasOwnProperty.call(patch, 'passwordHint') && envelope) {
    const text = String(patch.passwordHint || '').trim().slice(0, 160);
    envelope = { ...envelope, passwordHint: { text, updatedAt: Date.now() } };
    changes[VAULT] = envelope;
  }

  delete next.passwordHint;
  changes.settings = next;
  await chrome.storage.local.set(changes);

  if (Object.prototype.hasOwnProperty.call(patch, 'autoLockMinutes') && next.autoLockMinutes > 0) {
    const entry = (await chrome.storage.session.get(SESSION))[SESSION];
    if (entry?.key) await chrome.storage.session.set({ [SESSION]: { ...entry, touched: Date.now() } });
  }

  return { ...next, passwordHint: String(envelope?.passwordHint?.text || '') };
}

async function setSessionKey(key) {
  await chrome.storage.session.set({ [SESSION]: { key: bytesToBase64(key), touched: Date.now() } });
}

async function clearSession() {
  await chrome.storage.session.remove(SESSION);
}

async function getSessionKey(touch = true, settings) {
  const [entryData, resolvedSettings] = await Promise.all([
    chrome.storage.session.get(SESSION),
    settings ? Promise.resolve(settings) : getSettings()
  ]);
  const entry = entryData[SESSION];
  if (!entry?.key) throw new Error('PassMan is locked.');
  if (resolvedSettings.autoLockMinutes > 0 && Date.now() - entry.touched > resolvedSettings.autoLockMinutes * 6e4) {
    await clearSession();
    throw new Error('PassMan is locked.');
  }
  if (touch && resolvedSettings.autoLockMinutes > 0) {
    await chrome.storage.session.set({ [SESSION]: { ...entry, touched: Date.now() } });
  }
  return base64ToBytes(entry.key);
}

async function readVault() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get([VAULT, 'settings']),
    chrome.storage.session.get(SESSION)
  ]);
  const envelope = local[VAULT];
  if (!envelope) throw new Error('PassMan is not set up.');
  const settings = settingsFrom(local.settings, envelope);
  const entry = session[SESSION];
  if (!entry?.key) throw new Error('PassMan is locked.');
  if (settings.autoLockMinutes > 0 && Date.now() - entry.touched > settings.autoLockMinutes * 6e4) {
    await clearSession();
    throw new Error('PassMan is locked.');
  }
  if (settings.autoLockMinutes > 0) {
    await chrome.storage.session.set({ [SESSION]: { ...entry, touched: Date.now() } });
  }
  const key = base64ToBytes(entry.key);
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
  writeVault
};
