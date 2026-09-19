import { createEnvelope, rewrapKey, unlockEnvelope, assertEnvelope } from '../crypto/vault-crypto';
import { clearSession, getEnvelope, getSettings, readVault, setEnvelope, setSessionKey, setSettings, writeVault } from '../vault/store';
import { displayHost, loginMatchesUrl, parseUrl, uuid } from '../shared/util';
import { importKey, materialize } from '../import/chrome-csv';
import { refreshMetadata, restoreFromDrive, syncNow } from '../sync/google-drive';

void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
chrome.alarms.create('lock-check', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => {
  void import('../vault/store').then(x => x.getSessionKey(false)).catch(() => {});
});
chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason === 'install') await chrome.tabs.create({ url: new URL('../app/app.html#onboarding', import.meta.url).href });
});

const contentCommands = new Set(['MATCHES', 'GET_CREDENTIAL', 'ASSESS_LOGIN', 'STAGE_LOGIN', 'GET_STAGED_LOGIN', 'DISMISS_STAGED', 'SAVE_CANDIDATE', 'REMEMBER_USERNAME', 'GET_REMEMBERED_USERNAME']);

function senderPage(sender) {
  if (!sender.tab?.id || !sender.url) throw new Error('A webpage tab is required.');
  const url = parseUrl(sender.url);
  if (!url) throw new Error('Unsupported webpage origin.');
  return url.href;
}

function trustedExtension(sender) {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('Untrusted extension request.');
}

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

function publicItems(payload, url) {
  return payload.items
    .filter(item => !url || loginMatchesUrl(item.urls, url))
    .map(({ id, name, username, urls }) => ({ id, name, username, url: urls?.[0] || '' }));
}

function assessLogin(payload, page, username, password) {
  const siteItems = payload.items.filter(item => loginMatchesUrl(item.urls, page));
  const named = username && siteItems.find(item => item.username.trim().toLowerCase() === username.toLowerCase());
  const incomplete = username && !named && siteItems.find(item => !item.username.trim() && item.password === password);
  const found = named || incomplete || (!username && siteItems.length === 1 ? siteItems[0] : undefined);
  if (!found) return { action: 'save', username };
  if (incomplete) return { action: 'update', id: found.id, username, reason: 'username' };
  return found.password === password ? { action: 'none' } : { action: 'update', id: found.id, username: found.username };
}

async function handle(message, sender) {
  if (!message || typeof message.type !== 'string') throw new Error('Invalid request.');
  const isContent = contentCommands.has(message.type);
  const page = isContent ? senderPage(sender) : (trustedExtension(sender), '');

  if (message.type === 'STATE') {
    try {
      const { payload, settings } = await readVault();
      return { exists: true, unlocked: true, settings, items: payload.items };
    } catch {}
    const exists = !!await getEnvelope();
    const settings = await getSettings();
    return { exists, unlocked: false, settings, items: [] };
  }

  if (message.type === 'STATUS') {
    try {
      const { settings } = await readVault();
      return { exists: true, unlocked: true, settings };
    } catch {}
    const exists = !!await getEnvelope();
    const settings = await getSettings();
    if (exists && settings.syncEnabled) void refreshMetadata(false).catch(() => {});
    return { exists, unlocked: false, settings };
  }

  if (message.type === 'REFRESH_METADATA') {
    await refreshMetadata(!!message.interactive);
    return getSettings();
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

  if (message.type === 'MATCHES') {
    const { payload } = await readVault();
    return publicItems(payload, page);
  }

  if (message.type === 'GET_CREDENTIAL') {
    let credential;
    await mutate(payload => {
      const item = payload.items.find(entry => entry.id === message.id);
      if (!item || !loginMatchesUrl(item.urls, page)) throw new Error('That login is not valid for this site.');
      item.lastUsedAt = Date.now();
      credential = { id: item.id, username: item.username, password: item.password };
    });
    return credential;
  }

  if (message.type === 'LIST') {
    const { payload } = await readVault();
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
    if (!input.name || !input.username || !input.password || !Array.isArray(input.urls) || !input.urls.some(parseUrl)) throw new Error('Complete all login fields.');
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
        lastUsedAt: old?.lastUsedAt ?? null
      };
      if (old) Object.assign(old, next);
      else payload.items.push(next);
      delete payload.deleted[next.id];
    });
  }

  if (message.type === 'DELETE') return mutate(payload => {
    const index = payload.items.findIndex(item => item.id === message.id);
    if (index < 0) return;
    payload.deleted[message.id] = Date.now();
    payload.items.splice(index, 1);
  });

  if (message.type === 'ASSESS_LOGIN') {
    const username = String(message.username || '').trim(), password = String(message.password || '');
    if (!password || password.length < 4 || /^\d{4,8}$/.test(password)) return { action: 'none' };
    const { payload } = await readVault();
    return assessLogin(payload, page, username, password);
  }

  if (message.type === 'STAGE_LOGIN') {
    const username = String(message.username || '').trim(), password = String(message.password || '');
    if (!password || password.length < 4 || /^\d{4,8}$/.test(password)) return { action: 'none' };
    const { payload } = await readVault();
    const assessment = assessLogin(payload, page, username, password);
    if (assessment.action !== 'none') {
      const stageKey = `stage:${sender.tab.id}:${new URL(page).origin}`;
      await chrome.storage.session.set({ [stageKey]: { candidate: { username: assessment.username ?? username, password }, assessment, time: Date.now() } });
    }
    return assessment;
  }

  if (message.type === 'GET_STAGED_LOGIN') {
    const stageKey = `stage:${sender.tab.id}:${new URL(page).origin}`;
    const entry = (await chrome.storage.session.get(stageKey))[stageKey];
    if (!entry || Date.now() - entry.time > 2 * 60_000) return null;
    await chrome.storage.session.remove(stageKey);
    return entry;
  }

  if (message.type === 'DISMISS_STAGED') {
    await chrome.storage.session.remove(`stage:${sender.tab.id}:${new URL(page).origin}`);
    return true;
  }

  if (message.type === 'SAVE_CANDIDATE') {
    await chrome.storage.session.remove(`stage:${sender.tab.id}:${new URL(page).origin}`);
    const username = String(message.username || '').trim(), password = String(message.password || '');
    if (!password || password.length < 4) throw new Error('Invalid password.');
    return mutate(payload => {
      const siteItems = payload.items.filter(item => loginMatchesUrl(item.urls, page));
      const requested = message.id && siteItems.find(item => item.id === message.id);
      const sameUsername = username && siteItems.find(item => item.username.trim().toLowerCase() === username.toLowerCase());
      const incomplete = username && siteItems.find(item => !item.username.trim() && item.password === password);
      const duplicate = siteItems.find(item => item.username.trim().toLowerCase() === username.toLowerCase() && item.password === password);
      const existing = requested || sameUsername || incomplete || duplicate;
      if (existing) {
        existing.password = password;
        if (!existing.username.trim() && username) existing.username = username;
        existing.updatedAt = Date.now();
        return;
      }
      const url = new URL(page);
      const now = Date.now();
      payload.items.push({
        id: uuid(),
        name: displayHost(page),
        urls: [url.origin],
        username,
        password,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null
      });
    });
  }

  if (message.type === 'REMEMBER_USERNAME') {
    const key = `user:${sender.tab.id}:${new URL(page).origin}`;
    await chrome.storage.session.set({ [key]: { value: String(message.username || ''), time: Date.now() } });
    return true;
  }

  if (message.type === 'GET_REMEMBERED_USERNAME') {
    const key = `user:${sender.tab.id}:${new URL(page).origin}`, value = (await chrome.storage.session.get(key))[key];
    return value && Date.now() - value.time < 10 * 6e4 ? value.value : '';
  }

  if (message.type === 'IMPORT') {
    if (!Array.isArray(message.items)) throw new Error('Invalid import.');
    let added = 0;
    await mutate(payload => {
      const keys = new Set(payload.items.map(importKey));
      for (const raw of message.items.slice(0, 2e4)) {
        if (!raw || typeof raw.password !== 'string' || !Array.isArray(raw.urls) || !raw.urls[0]) continue;
        const item = materialize({ name: String(raw.name || displayHost(raw.urls[0])), urls: [String(raw.urls[0])], username: String(raw.username || ''), password: raw.password });
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
    await setSettings({ syncEnabled: true });
    await syncNow(true);
    return getSettings();
  }

  if (message.type === 'DISCONNECT_DRIVE') {
    await setSettings({ syncEnabled: false });
    return true;
  }

  if (message.type === 'RESTORE_DRIVE') {
    await restoreFromDrive();
    return true;
  }

  if (message.type === 'SYNC') {
    await syncNow(!!message.interactive);
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
      await setSettings({ syncDirty: true });
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

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(
    value => respond({ ok: true, value }),
    error => respond({ ok: false, error: error instanceof Error ? error.message : String(error) })
  );
  return true;
});
