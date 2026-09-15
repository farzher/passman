import { displayHost, faviconUrl, loginMatchesUrl } from '../shared/util.js';

const app = document.querySelector('#app');
const appUrl = (hash = '') => new URL(`../app/app.html${hash}`, location.href).href;
let contextTab;
let contextPageUrl = '';
let refreshPromise;

const rpc = async message => {
  const r = await chrome.runtime.sendMessage(message);
  if (!r?.ok) throw new Error(r?.error || 'Something went wrong.');
  return r.value;
};
const esc = value => {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
};

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {}
  const input = document.createElement('textarea');
  input.value = value;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('Copy failed.');
}

async function activeTab() {
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
}

function applyPageContext(tab) {
  contextTab = tab;
  contextPageUrl = /^https?:/i.test(tab?.url || '') ? tab.url : '';
  if (!contextPageUrl) return;
  const host = displayHost(contextPageUrl);
  const mark = document.querySelector('#site-icon');
  document.querySelector('#site-name').textContent = host;
  mark.textContent = host[0]?.toUpperCase() || 'P';
  const icon = faviconUrl(contextPageUrl);
  if (icon) {
    const image = new Image();
    image.alt = '';
    image.src = icon;
    image.onerror = () => image.remove();
    mark.prepend(image);
  }
}

function updateUnlockHint(settings = {}) {
  const form = app.querySelector('form.unlock');
  if (!form) return;
  const hint = String(settings.passwordHint || '').trim();
  let button = form.querySelector('.show-hint');
  let text = form.querySelector('.password-hint');

  if (!hint) {
    button?.remove();
    text?.remove();
    return;
  }

  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'link show-hint';
    button.textContent = 'Show hint';
    form.append(button);
  }
  if (!text) {
    text = document.createElement('div');
    text.className = 'password-hint';
    text.hidden = true;
    form.append(text);
  }
  if (!text.hidden) text.textContent = hint;
  button.onclick = () => {
    text.textContent = hint;
    text.hidden = false;
    button.hidden = true;
  };
}

function refreshInBackground(state) {
  if (refreshPromise || !state.settings?.syncEnabled) return;
  if (state.unlocked && state.settings.lastSyncAt && Date.now() - state.settings.lastSyncAt <= 15_000) return;
  const message = state.unlocked ? { type: 'SYNC' } : { type: 'REFRESH_METADATA' };
  refreshPromise = rpc(message)
    .then(async () => {
      if (state.unlocked) return render(false);
      const fresh = await rpc({ type: 'STATE' });
      updateUnlockHint(fresh.settings || {});
    })
    .catch(() => {})
    .finally(() => { refreshPromise = null; });
}

function unlockView(error = '', settings = {}) {
  const hint = String(settings.passwordHint || '').trim();
  app.innerHTML = `<form class="unlock"><input name="password" type="password" placeholder="Master password" aria-label="Master password" autofocus required><div class="error">${esc(error)}</div><button class="primary" type="submit">Unlock</button>${hint ? '<button type="button" class="link show-hint">Show hint</button><div class="password-hint" hidden></div>' : ''}</form>`;
  updateUnlockHint(settings);
  app.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    button.textContent = 'Unlocking…';
    try {
      await rpc({ type: 'UNLOCK', password: new FormData(event.target).get('password') });
      await render();
    } catch (e) {
      unlockView(e.message, settings);
    }
  };
}

async function render(allowRefresh = true) {
  try {
    const [state, tab] = await Promise.all([
      rpc({ type: 'STATE' }),
      contextTab ? Promise.resolve(contextTab) : activeTab()
    ]);
    applyPageContext(tab);
    document.querySelector('#lock').hidden = !state.unlocked;
    document.querySelector('#add').hidden = !state.unlocked;

    if (!state.exists) {
      app.innerHTML = `<div class="empty"><div class="lock-mark">P</div><h2>Welcome to PassMan</h2><p>Create your encrypted password store to get started.</p><button class="primary start">Get started</button></div>`;
      app.querySelector('.start').onclick = () => chrome.tabs.create({ url: appUrl('#onboarding') });
      return;
    }

    if (!state.unlocked) {
      unlockView('', state.settings || {});
      if (allowRefresh) refreshInBackground(state);
      return;
    }

    const items = state.items || [];
    const pageUrl = /^https?:/i.test(tab?.url || '') ? tab.url : '';
    const host = pageUrl ? displayHost(pageUrl) : '';
    const suggestions = pageUrl ? items.filter(item => loginMatchesUrl(item.urls, pageUrl)) : items;
    app.innerHTML = `<div id="list"></div><div id="fill-error" class="fill-error" role="status"></div>`;
    const list = app.querySelector('#list');
    const fillError = app.querySelector('#fill-error');

    if (!suggestions.length) {
      const message = items.length && host ? `No login saved for ${host}` : 'No passwords yet';
      list.innerHTML = `<div class="empty compact">${esc(message)}</div>`;
    }

    for (const item of suggestions) {
      const row = document.createElement('div');
      row.className = 'login-row';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `Fill password for ${item.username || item.name}`);
      row.innerHTML = `<span class="login-mark">${esc(item.name[0]?.toUpperCase() || 'P')}</span><span class="login-copy"><b>${esc(item.username || 'No username')}</b></span><button class="row-action copy-password" type="button" title="Copy password" aria-label="Copy password"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="10" height="11" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1"></path></svg></button>`;
      const mark = row.querySelector('.login-mark');
      const icon = faviconUrl(item.urls[0]);
      if (icon) {
        const image = new Image();
        image.alt = '';
        image.src = icon;
        image.onerror = () => image.remove();
        mark.prepend(image);
      }
      const copy = row.querySelector('.copy-password');
      copy.onclick = async event => {
        event.stopPropagation();
        fillError.textContent = '';
        try {
          await copyText(item.password);
          copy.classList.add('copied');
          copy.title = 'Password copied';
          copy.setAttribute('aria-label', 'Password copied');
          void rpc({ type: 'MARK_USED', id: item.id }).catch(() => {});
          setTimeout(() => {
            copy.classList.remove('copied');
            copy.title = 'Copy password';
            copy.setAttribute('aria-label', 'Copy password');
          }, 1500);
        } catch {
          fillError.textContent = 'Could not copy the password.';
        }
      };
      row.onclick = async () => {
        fillError.textContent = '';
        row.setAttribute('aria-disabled', 'true');
        try {
          const result = await chrome.tabs.sendMessage(tab.id, { type: 'PASSMAN_FILL', id: item.id });
          if (result === true || result?.filled) window.close();
          else throw new Error(result?.error || 'Could not fill this login.');
        } catch (error) {
          row.removeAttribute('aria-disabled');
          fillError.textContent = error.message?.includes('Receiving end does not exist') ? 'Refresh this page, then try again.' : error.message;
        }
      };
      row.onkeydown = event => {
        if (event.target === row && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          row.click();
        }
      };
      list.append(row);
    }
    list.querySelector('.login-row')?.focus();
    if (allowRefresh) refreshInBackground(state);
  } catch (e) {
    unlockView(e.message);
  }
}

document.querySelector('#home').onclick = () => chrome.tabs.create({ url: appUrl(contextPageUrl ? `#site=${encodeURIComponent(contextPageUrl)}` : '') });
document.querySelector('#settings').onclick = () => chrome.tabs.create({ url: appUrl('#settings') });
document.querySelector('#add').onclick = () => chrome.tabs.create({ url: appUrl('#new') });
document.querySelector('#lock').onclick = async () => {
  await rpc({ type: 'LOCK' });
  render();
};

render();