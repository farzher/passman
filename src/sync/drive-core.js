import { assertEnvelope, decryptPayload, replacePayload } from '../crypto/vault-crypto.js';
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

function sameEnvelope(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function createDriveSync({ request, getEnvelope, getSettings, readVault, setEnvelope, setSettings }) {
  let syncPromise = null;
  let syncQueued = false;
  let syncInteractive = false;

  async function checked(response) {
    if (!response.ok) throw new Error(`Google Drive error (${response.status}).`);
    return response;
  }

  async function findDriveVault(interactive = false) {
    const q = encodeURIComponent(`name='${DRIVE_NAME}' and 'appDataFolder' in parents and trashed=false`);
    const response = await checked(await request(`${API}/files?spaces=appDataFolder&q=${q}&fields=files(id,version,modifiedTime)&pageSize=1`, {}, interactive));
    return (await response.json()).files[0] || null;
  }

  async function getDriveVault(fileId, interactive = false) {
    const response = await request(`${API}/files/${fileId}?fields=id,version,modifiedTime`, {}, interactive);
    if (response.status === 404) return null;
    await checked(response);
    return { file: await response.json(), etag: response.headers.get('etag') || undefined };
  }

  async function locateDriveVault(settings, interactive = false) {
    if (settings.driveFileId) {
      const known = await getDriveVault(settings.driveFileId, interactive);
      if (known) return known;
    }
    const file = await findDriveVault(interactive);
    if (!file) return null;
    const known = await getDriveVault(file.id, interactive);
    return known || { file };
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
    return { file: await response.json(), etag: response.headers.get('etag') || undefined };
  }

  async function restoreFromDrive() {
    const file = await findDriveVault(true);
    if (!file) throw new Error('No PassMan backup was found in this Google account.');
    const remote = await downloadDriveVault(file, true);
    await setEnvelope(remote.envelope);
    await setSettings({ syncEnabled: true, driveFileId: file.id, driveVersion: file.version, driveEtag: remote.etag, lastSyncError: undefined });
    return remote.envelope;
  }

  async function refreshMetadata(interactive = false) {
    const settings = await getSettings();
    if (!settings.syncEnabled) return false;
    const local = await getEnvelope();
    if (!local) return false;
    const located = await locateDriveVault(settings, interactive);
    if (!located) return false;
    if (settings.driveVersion && String(settings.driveVersion) === String(located.file.version)) return false;
    const remote = await downloadDriveVault(located.file, interactive);
    const merged = mergeHint(local, remote.envelope);
    if (merged === local) return false;
    await setEnvelope(merged);
    return true;
  }

  async function finishUpload(startEnvelope, nextEnvelope, uploaded, remoteMerged) {
    const current = await getEnvelope();
    if (sameEnvelope(current, startEnvelope)) {
      await setEnvelope(nextEnvelope);
      await setSettings({
        driveFileId: uploaded.file.id,
        driveVersion: uploaded.file.version,
        driveEtag: uploaded.etag,
        lastSyncAt: Date.now(),
        lastSyncError: undefined,
        syncDirty: false
      });
      return;
    }

    syncQueued = true;
    const patch = { driveFileId: uploaded.file.id, lastSyncError: undefined };
    if (!remoteMerged) {
      patch.driveVersion = uploaded.file.version;
      patch.driveEtag = uploaded.etag;
    }
    await setSettings(patch);
  }

  async function syncAttempt(interactive) {
    const settings = await getSettings();
    if (!settings.syncEnabled) return settings;

    let key;
    try {
      let { key: vaultKey, envelope, payload } = await readVault();
      key = vaultKey;
      const startEnvelope = envelope;
      const localChanged =
        !!settings.syncDirty ||
        payload.syncedRevision !== payload.revision ||
        (Number(envelope?.passwordHint?.updatedAt) || 0) > (Number(settings.lastSyncAt) || 0);

      const located = await locateDriveVault(settings, interactive);
      if (!located) {
        payload = { ...payload, syncBase: snapshot(payload), syncedRevision: payload.revision };
        envelope = await replacePayload(key, envelope, payload);
        const uploaded = await upload(envelope);
        await finishUpload(startEnvelope, envelope, uploaded, false);
        return getSettings();
      }

      const file = located.file;
      if (!settings.driveVersion) {
        throw new Error('A PassMan vault already exists in this Google account. Restore it from the welcome screen instead of replacing it.');
      }

      const remoteChanged = String(settings.driveVersion) !== String(file.version);
      if (!remoteChanged && !localChanged) {
        await setSettings({
          driveFileId: file.id,
          driveVersion: file.version,
          driveEtag: located.etag || settings.driveEtag,
          lastSyncAt: Date.now(),
          lastSyncError: undefined,
          syncDirty: false
        });
        return getSettings();
      }

      let remoteMerged = false;
      let etag = located.etag || (!remoteChanged ? settings.driveEtag : undefined);

      if (remoteChanged) {
        const remote = await downloadDriveVault(file, interactive);
        const remotePayload = await decryptPayload(key, remote.envelope);

        if (!localChanged) {
          const current = await getEnvelope();
          if (sameEnvelope(current, startEnvelope)) {
            await setEnvelope(remote.envelope);
            await setSettings({
              driveFileId: file.id,
              driveVersion: file.version,
              driveEtag: remote.etag,
              lastSyncAt: Date.now(),
              lastSyncError: undefined,
              syncDirty: false
            });
          } else {
            syncQueued = true;
          }
          return getSettings();
        }

        envelope = mergeHint(envelope, remote.envelope);
        payload = mergeVaults(payload, remotePayload);
        etag = remote.etag || located.etag;
        remoteMerged = true;
      } else if (!etag) {
        const remote = await downloadDriveVault(file, interactive);
        envelope = mergeHint(envelope, remote.envelope);
        payload = mergeVaults(payload, await decryptPayload(key, remote.envelope));
        etag = remote.etag;
        remoteMerged = true;
      }

      payload = { ...payload, syncBase: snapshot(payload), syncedRevision: payload.revision };
      envelope = await replacePayload(key, envelope, payload);
      const uploaded = await upload(envelope, file, etag);
      await finishUpload(startEnvelope, envelope, uploaded, remoteMerged);
      return getSettings();
    } finally {
      key?.fill(0);
    }
  }

  async function syncOnce(interactive) {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await syncAttempt(interactive);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'DRIVE_CONFLICT' || attempt === 2) throw error;
        }
      }
    } catch (error) {
      if (error?.code !== 'DRIVE_AUTH_REQUIRED') {
        await setSettings({ lastSyncError: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  }

  function syncNow(interactive = false) {
    syncQueued = true;
    if (interactive) syncInteractive = true;

    if (!syncPromise) {
      syncPromise = (async () => {
        let result;
        while (syncQueued) {
          const runInteractive = syncInteractive;
          syncQueued = false;
          syncInteractive = false;
          try {
            result = await syncOnce(runInteractive);
          } catch (error) {
            if (!syncQueued) throw error;
          }
        }
        return result;
      })().finally(() => { syncPromise = null; });
    }

    return syncPromise;
  }

  return { downloadDriveVault, findDriveVault, refreshMetadata, restoreFromDrive, syncNow };
}

export { createDriveSync };
