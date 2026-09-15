import { assertEnvelope, createEnvelope, rewrapKey, unlockEnvelope } from '../crypto/vault-crypto.js';
import { importKey, materialize } from '../import/chrome-csv.js';
import { displayHost, parseUrl, uuid } from '../shared/util.js';
import {
  clearSession,
  getEnvelope,
  getSessionKey,
  getSettings,
  readVault,
  setEnvelope,
  setSessionKey,
  setSettings,
  writeVault
} from './store.js';
import { authorizeDrive, disconnectDriveToken, restoreFromDrive, syncNow } from './drive.js';

async function mutate(change) {
  const { key, envelope, payload } = await readVault();
  try {
    change(payload);
    payload.revision++;
    await writeVault(key, envelope, payload);
  } finally {
    key.fill(0);
  }
  void syncNow(false).catch(() => {});
  return payload;
}

async function handleWebMessage(message) {
  if (!message || typeof message.type !== 'string') throw new Error('Invalid request.');

  if (message.type === 'STATUS') {
    const exists = !!await getEnvelope();
    let unlocked = false;
    if (exists) {
      try {
        const key = await getSessionKey(false);
        key.fill(0);
        unlocked = true;
      } catch {}
    }
    return { exists, unlocked, settings: await getSettings() };
  }

  if (message.type === 'SETUP') {
    if (await getEnvelope()) throw new Error('PassMan is already set up.');
    if (typeof message.password !== 'string' || message.password.length < 10) throw new Error('Use at least 10 characters.');
    const payload = { revision: 1, items: [], deleted: {} };
    const { envelope, vaultKey } = await createEnvelope(message.password, payload);
    await setEnvelope(envelope);
    await setSessionKey(vaultKey);
    vaultKey.fill(0);
    return true;
  }

  if (message.type === 'UNLOCK') {
    const envelope = await getEnvelope();
    if (!envelope) throw new Error('PassMan is not set up.');
    const { key } = await unlockEnvelope(String(message.password), envelope);
    await setSessionKey(key);
    key.fill(0);
    return true;
  }

  if (message.type === 'LOCK') {
    await clearSession();
    return true;
  }

  if (message.type === 'LIST') {
    const { key, payload } = await readVault();
    key.fill(0);
    return payload.items;
  }

  if (message.type === 'MARK_USED') {
    return mutate(payload => {
      const item = payload.items.find(entry => entry.id === message.id);
      if (item) item.lastUsedAt = Date.now();
    });
  }

  if (message.type === 'UPSERT') {
    const input = message.login;
    if (!input?.name || !input.username || !input.password || !Array.isArray(input.urls) || !input.urls.some(parseUrl)) {
      throw new Error('Complete all login fields.');
    }
    return mutate(payload => {
      const old = payload.items.find(item => item.id === input.id);
      const now = Date.now();
      const next = {
        id: old?.id || uuid(),
        name: input.name,
        urls: input.urls.map(String),
        username: input.username,
        password: input.password,
        createdAt: old?.createdAt || now,
        updatedAt: now,
        ...(old?.lastUsedAt ? { lastUsedAt: old.lastUsedAt } : {})
      };
      if (old) Object.assign(old, next);
      else payload.items.push(next);
      delete payload.deleted[next.id];
    });
  }

  if (message.type === 'DELETE') {
    return mutate(payload => {
      const index = payload.items.findIndex(item => item.id === message.id);
      if (index < 0) return;
      payload.deleted[message.id] = Date.now();
      payload.items.splice(index, 1);
    });
  }

  if (message.type === 'IMPORT') {
    if (!Array.isArray(message.items)) throw new Error('Invalid import.');
    let added = 0;
    await mutate(payload => {
      const keys = new Set(payload.items.map(importKey));
      for (const raw of message.items.slice(0, 20_000)) {
        if (!raw || typeof raw.password !== 'string' || !Array.isArray(raw.urls) || !raw.urls[0]) continue;
        const item = materialize({
          name: String(raw.name || displayHost(raw.urls[0])),
          urls: [String(raw.urls[0])],
          username: String(raw.username || ''),
          password: raw.password
        });
        if (!keys.has(importKey(item))) {
          payload.items.push(item);
          keys.add(importKey(item));
          added++;
        }
      }
    });
    return { added };
  }

  if (message.type === 'SETTINGS') return message.patch ? setSettings(message.patch) : getSettings();

  if (message.type === 'CONNECT_DRIVE') {
    await authorizeDrive();
    await setSettings({ syncEnabled: true });
    try {
      await syncNow(false);
    } catch (error) {
      await setSettings({ syncEnabled: false });
      throw error;
    }
    return getSettings();
  }

  if (message.type === 'DISCONNECT_DRIVE') {
    disconnectDriveToken();
    await setSettings({ syncEnabled: false, lastSyncError: undefined });
    return true;
  }

  if (message.type === 'RESTORE_DRIVE') {
    await authorizeDrive();
    await restoreFromDrive();
    return true;
  }

  if (message.type === 'SYNC') {
    if (message.interactive) await authorizeDrive();
    await syncNow(false);
    return getSettings();
  }

  if (message.type === 'CHANGE_MASTER') {
    if (typeof message.currentPassword !== 'string' || !message.currentPassword) throw new Error('Enter your current master password.');
    if (typeof message.password !== 'string' || message.password.length < 10) throw new Error('Use at least 10 characters.');
    if (message.password !== message.confirmPassword) throw new Error('New passwords do not match.');
    if (message.password === message.currentPassword) throw new Error('Choose a new password that is different from your current password.');

    const { key: sessionKey, envelope } = await readVault();
    sessionKey.fill(0);
    let verifiedKey;
    try {
      ({ key: verifiedKey } = await unlockEnvelope(message.currentPassword, envelope));
      await setEnvelope(await rewrapKey(message.password, verifiedKey, envelope));
    } finally {
      verifiedKey?.fill(0);
    }
    void syncNow(false).catch(() => {});
    return true;
  }

  if (message.type === 'EXPORT_BACKUP') {
    const envelope = await getEnvelope();
    if (!envelope) throw new Error('No vault.');
    return envelope;
  }

  if (message.type === 'IMPORT_BACKUP') {
    assertEnvelope(message.envelope);
    const { key } = await unlockEnvelope(String(message.password || ''), message.envelope);
    await setEnvelope(message.envelope);
    await setSessionKey(key);
    key.fill(0);
    return true;
  }

  throw new Error('Unknown request.');
}

export { handleWebMessage };
