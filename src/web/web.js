import { handleWebMessage } from './controller.js';
import { driveConfigured, driveResumeNeeded } from './drive.js';
import { touchSession } from './store.js';

globalThis.passmanPlatform = 'web';
globalThis.passmanDriveConfigured = driveConfigured();
globalThis.passmanRpc = handleWebMessage;

let lastActivity = Date.now();
let driveResumePromise = null;

function resumeDriveFromGesture(event) {
  if (driveResumePromise || !driveResumeNeeded()) return;
  const target = event.target;
  if (target instanceof Element) {
    if (target.closest('.connect,.sync,.disconnect')) return;
    if (target.matches('input,textarea,select,[contenteditable="true"]')) return;
  }
  driveResumePromise = handleWebMessage({ type: 'RESUME_DRIVE' })
    .then(resumed => {
      if (resumed && (!location.hash || location.hash === '#settings')) {
        dispatchEvent(new HashChangeEvent('hashchange'));
      }
    })
    .catch(() => {})
    .finally(() => { driveResumePromise = null; });
}

for (const event of ['pointerdown', 'keydown', 'touchstart']) {
  addEventListener(event, input => {
    lastActivity = Date.now();
    touchSession();
    resumeDriveFromGesture(input);
  }, { passive: true });
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

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

await import('../app/app.js');
addEventListener('visibilitychange', () => { if (!document.hidden) dispatchEvent(new HashChangeEvent('hashchange')); });
