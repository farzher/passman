import { createDriveSync } from '../sync/drive-core.js';
import { getEnvelope, getSettings, readVault, setEnvelope, setSettings, workerMessage, writeVault } from './store.js';

const CLIENT_ID = __PASSMAN_GOOGLE_CLIENT_ID__;
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

let accessToken = '';
let tokenExpiresAt = 0;
let tokenClient = null;
let authorizationPromise = null;
let workerTokenPromise = null;
let workerTokenChecked = false;
let driveConnected = false;

void getSettings().then(settings => { driveConnected = !!settings.syncEnabled; }).catch(() => {});
void restoreWorkerToken();

function driveConfigured() {
  return !!CLIENT_ID;
}

function tokenValid() {
  return !!accessToken && Date.now() < tokenExpiresAt;
}

function driveResumeNeeded() {
  return driveConnected && workerTokenChecked && !tokenValid();
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

async function restoreWorkerToken() {
  if (tokenValid()) return true;
  if (workerTokenChecked) return false;
  if (workerTokenPromise) return workerTokenPromise;
  workerTokenPromise = (async () => {
    const saved = await workerMessage({ type: 'PASSMAN_DRIVE_GET' });
    workerTokenChecked = true;
    if (saved?.token && Number(saved.expiresAt) > Date.now()) {
      accessToken = saved.token;
      tokenExpiresAt = Number(saved.expiresAt);
      return true;
    }
    return false;
  })().finally(() => { workerTokenPromise = null; });
  return workerTokenPromise;
}

function rememberToken(token, expiresAt) {
  accessToken = token;
  tokenExpiresAt = expiresAt;
  workerTokenChecked = true;
  void workerMessage({ type: 'PASSMAN_DRIVE_SET', token, expiresAt });
}

function clearToken() {
  accessToken = '';
  tokenExpiresAt = 0;
  workerTokenChecked = true;
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
      rememberToken(response.access_token, expiresAt);
      resolve(accessToken);
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
  if (await restoreWorkerToken()) return accessToken;
  if (!interactive) throw authRequired();
  return authorizeDrive();
}

async function request(url, init = {}, interactive = false) {
  let value = await token(interactive);
  let response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${value}`, ...init.headers } });
  if (response.status === 401) {
    clearToken();
    if (!interactive) throw authRequired();
    value = await authorizeDrive();
    response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${value}`, ...init.headers } });
  }
  return response;
}

function disconnectDriveToken() {
  const value = accessToken;
  clearToken();
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
