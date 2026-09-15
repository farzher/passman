import { handleWebMessage } from './controller.js';
import { driveConfigured } from './drive.js';
import { touchSession } from './store.js';

globalThis.passmanPlatform = 'web';
globalThis.passmanDriveConfigured = driveConfigured();
globalThis.passmanRpc = handleWebMessage;

let lastActivity = Date.now();
let refreshPromise;
for (const event of ['pointerdown', 'keydown', 'touchstart']) {
  addEventListener(event, () => { lastActivity = Date.now(); touchSession(); }, { passive: true });
}

setInterval(async () => {
  try {
    const status = await handleWebMessage({ type: 'STATUS' });
    const minutes = status.settings.autoLockMinutes;
    if (status.unlocked && minutes > 0 && Date.now() - lastActivity > minutes * 60_000) {
      await handleWebMessage({ type: 'LOCK' });
    }
    if (status.exists && !status.unlocked && location.hash !== '#unlock') {
      location.hash = 'unlock';
      dispatchEvent(new HashChangeEvent('hashchange'));
    }
  } catch {}
}, 30_000);

async function refreshDrive() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const status = await handleWebMessage({ type: 'STATUS' });
      if (!status.unlocked || !status.settings.syncEnabled) return;
      if (status.settings.lastSyncAt && Date.now() - status.settings.lastSyncAt <= 15_000) return;
      await handleWebMessage({ type: 'SYNC' });
      dispatchEvent(new HashChangeEvent('hashchange'));
    } catch {}
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

await import('../app/app.js');
void refreshDrive();
addEventListener('visibilitychange', () => { if (!document.hidden) void refreshDrive(); });
