import { DEFAULT_SETTINGS } from "./models";
import { base64ToBytes, bytesToBase64 } from "../shared/util";
import { decryptPayload, replacePayload } from "../crypto/vault-crypto";
const VAULT = "vault";
const SESSION = "unlocked";
async function getEnvelope() {
  return (await chrome.storage.local.get(VAULT))[VAULT];
}
async function setEnvelope(envelope) {
  await chrome.storage.local.set({ [VAULT]: envelope });
}
async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get("settings")).settings || {} };
}
async function setSettings(patch) {
  const settings = { ...await getSettings(), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}
async function setSessionKey(key) {
  await chrome.storage.session.set({ [SESSION]: { key: bytesToBase64(key), touched: Date.now() } });
}
async function clearSession() {
  await chrome.storage.session.remove(SESSION);
}
async function getSessionKey(touch = true) {
  const entry = (await chrome.storage.session.get(SESSION))[SESSION];
  if (!entry?.key) throw new Error("PassMan is locked.");
  const settings = await getSettings();
  if (settings.autoLockMinutes > 0 && Date.now() - entry.touched > settings.autoLockMinutes * 6e4) {
    await clearSession();
    throw new Error("PassMan is locked.");
  }
  if (touch) await chrome.storage.session.set({ [SESSION]: { ...entry, touched: Date.now() } });
  return base64ToBytes(entry.key);
}
async function readVault() {
  const envelope = await getEnvelope();
  if (!envelope) throw new Error("PassMan is not set up.");
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
