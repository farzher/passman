import { createDriveSync } from './drive-core.js';
import { getSettings, readVault, setEnvelope, setSettings, writeVault } from '../vault/store.js';

async function token(interactive) {
  const result = await chrome.identity.getAuthToken({ interactive });
  const value = typeof result === 'string' ? result : result.token;
  if (!value) throw new Error('Google authorization was cancelled.');
  return value;
}

async function request(url, init = {}, interactive = false) {
  let accessToken = await token(interactive);
  let response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${accessToken}`, ...init.headers } });
  if (response.status === 401) {
    await chrome.identity.removeCachedAuthToken({ token: accessToken });
    accessToken = await token(interactive);
    response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${accessToken}`, ...init.headers } });
  }
  return response;
}

const { downloadDriveVault, findDriveVault, restoreFromDrive, syncNow } = createDriveSync({
  request,
  getSettings,
  readVault,
  setEnvelope,
  setSettings,
  writeVault
});

export { downloadDriveVault, findDriveVault, restoreFromDrive, syncNow };
