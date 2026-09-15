import { createDriveSync } from '../sync/drive-core.js';
import {
  clearDriveToken,
  getDriveToken,
  getEnvelope,
  getSettings,
  readVault,
  setDriveToken,
  setEnvelope,
  setSettings,
  workerMessage,
  writeVault
} from './store.js';

const CLIENT_ID = __PASSMAN_GOOGLE_CLIENT_ID__;
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

let accessToken = '';
let tokenExpiresAt = 0;
let tokenClient = null;
let authorizationPromise = null;
let savedTokenPromise = null;
let savedTokenChecked = false;
let driveConnected = false;

void getSettings().then(settings => { driveConnected = !!settings.syncEnabled; }).catch(() => {});
void restoreSavedToken();

function driveConfigured() {
  return !!CLIENT_ID;
}

function tokenValid() {
  return !!accessToken && Date.now() < tokenExpiresAt;
}

function driveResumeNeeded() {
  return driveConnected && savedTokenChecked && !tokenValid();
}

function setDriveConnected(value) {
  driveConnected = !!value;
}

function authRequired() {
  const error = new Error('Google Drive authorization is required.');
  error.code = 'DRIVE_AUTH_REQUIRED';
  return error;
}

function requireGoogle() {
  if (!CLIENT_ID) {
    throw new Error('Google Drive is not configured for this web build. Set the PASSMAN_GOOGLE_CLIENT_ID repository variable to a Web OAuth client from the same Google Cloud project as the extension.');
  }
  if (!globalThis.google?.accounts?.oauth2) throw new Error('Google authentication could not load. Check your connection and try again.');
}

function getTokenClient() {
  requireGoogle();
  if (!tokenClient) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: () => {}
    });
  }
  return tokenClient;
}

async function restoreSavedToken() {
  if (tokenValid()) return true;
  if (savedTokenChecked) return false;
  if (savedTokenPromise) return savedTokenPromise;
  savedTokenPromise = (async () => {
    const saved = await getDriveToken();
    if (saved?.token && saved.expiresAt > Date.now()) {
      accessToken = saved.token;
      tokenExpiresAt = saved.expiresAt;
      savedTokenChecked = true;
      void workerMessage({ type: 'PASSMAN_DRIVE_SET', token: accessToken, expiresAt: tokenExpiresAt });
      return true;
    }

    const worker = await workerMessage({ type: 'PASSMAN_DRIVE_GET' });
    savedTokenChecked = true;
    if (worker?.token && Number(worker.expiresAt) > Date.now()) {
      accessToken = worker.token;
      tokenExpiresAt = Number(worker.expiresAt);
      void setDriveToken(accessToken, tokenExpiresAt);
      return true;
    }
    return false;
  })().finally(() => { savedTokenPromise = null; });
  return savedTokenPromise;
}

async function rememberToken(token, expiresAt) {
  accessToken = token;
  tokenExpiresAt = expiresAt;
  savedTokenChecked = true;
  await setDriveToken(token, expiresAt);
  void workerMessage({ type: 'PASSMAN_DRIVE_SET', token, expiresAt });
}

async function clearToken() {
  accessToken = '';
  tokenExpiresAt = 0;
  savedTokenChecked = true;
  await clearDriveToken();
  void workerMessage({ type: 'PASSMAN_DRIVE_CLEAR' });
}

async function authorizeDrive() {
  if (tokenValid()) return accessToken;
  if (authorizationPromise) return authorizationPromise;
  const client = getTokenClient();
  authorizationPromise = new Promise((resolve, reject) => {
    client.callback = response => {
      if (response?.error || !response?.access_token) {
        reject(new Error(response?.error_description || response?.error || 'Google authorization was cancelled.'));
        return;
      }
      const expiresAt = Date.now() + Math.max(0, Number(response.expires_in || 0) * 1000 - 60_000);
      void rememberToken(response.access_token, expiresAt)
        .then(() => resolve(accessToken))
        .catch(reject);
    };
    client.error_callback = () => reject(new Error('Google authorization was cancelled.'));
    client.requestAccessToken({ prompt: '' });
  });
  try {
    return await authorizationPromise;
  } finally {
    authorizationPromise = null;
  }
}

async function token(interactive) {
  if (tokenValid()) return accessToken;
  if (await restoreSavedToken()) return accessToken;
  try {
    return await authorizeDrive();
  } catch (error) {
    if (!interactive) throw authRequired();
    throw error;
  }
}

async function request(url, init = {}, interactive = false) {
  let value = await token(interactive);
  let response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${value}`, ...init.headers } });
  if (response.status === 401) {
    await clearToken();
    try {
      value = await authorizeDrive();
    } catch (error) {
      if (!interactive) throw authRequired();
      throw error;
    }
    response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${value}`, ...init.headers } });
  }
  return response;
}

async function disconnectDriveToken() {
  const value = accessToken || (await getDriveToken())?.token || '';
  await clearToken();
  driveConnected = false;
  if (value && globalThis.google?.accounts?.oauth2?.revoke) {
    google.accounts.oauth2.revoke(value, () => {});
  }
}

const { refreshMetadata, restoreFromDrive, syncNow } = createDriveSync({
  request,
  getEnvelope,
  getSettings,
  readVault,
  setEnvelope,
  setSettings,
  writeVault
});

export {
  authorizeDrive,
  disconnectDriveToken,
  driveConfigured,
  driveResumeNeeded,
  refreshMetadata,
  restoreFromDrive,
  setDriveConnected,
  syncNow
};
