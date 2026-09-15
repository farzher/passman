import { createDriveSync } from '../sync/drive-core.js';
import { getEnvelope, getSettings, readVault, setEnvelope, setSettings, writeVault } from './store.js';

const CLIENT_ID = __PASSMAN_GOOGLE_CLIENT_ID__;
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

let accessToken = '';
let tokenExpiresAt = 0;
let tokenClient = null;

function driveConfigured() {
  return !!CLIENT_ID;
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

async function authorizeDrive() {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  const client = getTokenClient();
  return new Promise((resolve, reject) => {
    client.callback = response => {
      if (response?.error || !response?.access_token) {
        reject(new Error(response?.error_description || response?.error || 'Google authorization was cancelled.'));
        return;
      }
      accessToken = response.access_token;
      tokenExpiresAt = Date.now() + Math.max(0, Number(response.expires_in || 0) * 1000 - 60_000);
      resolve(accessToken);
    };
    client.error_callback = () => reject(new Error('Google authorization was cancelled.'));
    client.requestAccessToken({ prompt: '' });
  });
}

async function token(interactive) {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  if (!interactive) throw new Error('Google Drive authorization expired. Use Sync to reconnect.');
  return authorizeDrive();
}

async function request(url, init = {}, interactive = false) {
  let value = await token(interactive);
  let response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${value}`, ...init.headers } });
  if (response.status === 401) {
    accessToken = '';
    tokenExpiresAt = 0;
    if (!interactive) return response;
    value = await authorizeDrive();
    response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${value}`, ...init.headers } });
  }
  return response;
}

function disconnectDriveToken() {
  const value = accessToken;
  accessToken = '';
  tokenExpiresAt = 0;
  if (value && globalThis.google?.accounts?.oauth2?.revoke) {
    google.accounts.oauth2.revoke(value, () => {});
  }
}

const { restoreFromDrive, syncNow } = createDriveSync({
  request,
  getEnvelope,
  getSettings,
  readVault,
  setEnvelope,
  setSettings,
  writeVault
});

export { authorizeDrive, disconnectDriveToken, driveConfigured, restoreFromDrive, syncNow };
