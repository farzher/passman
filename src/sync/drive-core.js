import { assertEnvelope, decryptPayload } from '../crypto/vault-crypto.js';
import { mergeVaults, snapshot } from './merge.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const DRIVE_NAME = 'passman.pm';

function mergeHint(local, remote) {
  const a = local?.passwordHint;
  const b = remote?.passwordHint;
  const at = Number(a?.updatedAt) || 0;
  const bt = Number(b?.updatedAt) || 0;
  if (bt <= at) return local;
  return { ...local, passwordHint: { text: String(b?.text || '').slice(0, 160), updatedAt: bt } };
}

function createDriveSync({ request, getSettings, readVault, setEnvelope, setSettings, writeVault }) {
  async function checked(response) {
    if (!response.ok) throw new Error(`Google Drive error (${response.status}).`);
    return response;
  }

  async function findDriveVault(interactive = false) {
    const q = encodeURIComponent(`name='${DRIVE_NAME}' and 'appDataFolder' in parents and trashed=false`);
    const response = await checked(await request(`${API}/files?spaces=appDataFolder&q=${q}&fields=files(id,version,modifiedTime)&pageSize=1`, {}, interactive));
    return (await response.json()).files[0] || null;
  }

  async function downloadDriveVault(file, interactive = false) {
    const response = await checked(await request(`${API}/files/${file.id}?alt=media`, {}, interactive));
    const envelope = await response.json();
    assertEnvelope(envelope);
    return { envelope, etag: response.headers.get('etag') || undefined, file };
  }

  async function upload(envelope, file, etag) {
    let response;
    if (file) {
      response = await request(`${UPLOAD}/files/${file.id}?uploadType=media&fields=id,version,modifiedTime`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) },
        body: JSON.stringify(envelope)
      });
    } else {
      const boundary = `passman_${crypto.randomUUID()}`;
      const body = `--${boundary}\r
Content-Type: application/json; charset=UTF-8\r
\r
${JSON.stringify({ name: DRIVE_NAME, parents: ['appDataFolder'] })}\r
--${boundary}\r
Content-Type: application/json\r
\r
${JSON.stringify(envelope)}\r
--${boundary}--`;
      response = await request(`${UPLOAD}/files?uploadType=multipart&fields=id,version,modifiedTime`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body
      });
    }
    if (response.status === 412) throw new Error('DRIVE_CONFLICT');
    await checked(response);
    return response.json();
  }

  async function restoreFromDrive() {
    const file = await findDriveVault(true);
    if (!file) throw new Error('No PassMan backup was found in this Google account.');
    const remote = await downloadDriveVault(file, true);
    await setEnvelope(remote.envelope);
    await setSettings({ syncEnabled: true, driveFileId: file.id, driveVersion: file.version, driveEtag: remote.etag, lastSyncError: undefined });
    return remote.envelope;
  }

  async function syncNow(interactive = false) {
    const settings = await getSettings();
    if (!settings.syncEnabled) return;
    let key;
    try {
      let envelope, payload;
      ({ key, envelope, payload } = await readVault());
      let file = await findDriveVault(interactive);
      if (!file) {
        payload.syncBase = snapshot(payload);
        envelope = await writeVault(key, envelope, payload);
        file = await upload(envelope);
        await setSettings({ driveFileId: file.id, driveVersion: file.version, lastSyncAt: Date.now(), lastSyncError: undefined });
        return;
      }

      const remote = await downloadDriveVault(file, interactive);
      if (!settings.driveVersion) {
        throw new Error('A PassMan vault already exists in this Google account. Restore it from the welcome screen instead of replacing it.');
      }

      if (settings.driveVersion !== file.version) {
        envelope = mergeHint(envelope, remote.envelope);
        const remotePayload = await decryptPayload(key, remote.envelope);
        payload = mergeVaults(payload, remotePayload);
        envelope = await writeVault(key, envelope, payload);
      } else if (!payload.syncBase) {
        payload.syncBase = snapshot(payload);
        envelope = await writeVault(key, envelope, payload);
      }

      try {
        file = await upload(envelope, file, remote.etag);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'DRIVE_CONFLICT') throw error;
        const latestFile = await findDriveVault(interactive);
        if (!latestFile) throw error;
        const latest = await downloadDriveVault(latestFile, interactive);
        envelope = mergeHint(envelope, latest.envelope);
        payload = mergeVaults(payload, await decryptPayload(key, latest.envelope));
        envelope = await writeVault(key, envelope, payload);
        file = await upload(envelope, latestFile, latest.etag);
      }

      payload.syncBase = snapshot(payload);
      envelope = await writeVault(key, envelope, payload);
      file = await upload(envelope, file);
      await setSettings({ driveFileId: file.id, driveVersion: file.version, lastSyncAt: Date.now(), lastSyncError: undefined });
    } catch (error) {
      await setSettings({ lastSyncError: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      key?.fill(0);
    }
  }

  return { downloadDriveVault, findDriveVault, restoreFromDrive, syncNow };
}

export { createDriveSync };
