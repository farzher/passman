import { parseChromeCsv, importKey } from '../import/chrome-csv.js';
import { generatePassword } from '../shared/password-generator.js';
import { displayHost, faviconUrl, loginMatchesUrl } from '../shared/util.js';

const root = document.querySelector('#app');
const platform = globalThis.passmanPlatform || 'extension';
const driveConfigured = platform !== 'web' || !!globalThis.passmanDriveConfigured;
const extensionRuntime = globalThis.chrome?.runtime;
const rpc = globalThis.passmanRpc || (extensionRuntime?.sendMessage
  ? async message => {
      const r = await extensionRuntime.sendMessage(message);
      if (!r?.ok) throw new Error(r?.error || 'Something went wrong.');
      return r.value;
    }
  : async () => { throw new Error('PassMan platform adapter is unavailable.'); });

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const notice = (text, kind = '') => `<div class="notice ${kind}">${escape(text)}</div>`;
function setError(form, error) { const el = form.querySelector('.form-error'); if (el) { el.classList.remove('success'); el.textContent = error instanceof Error ? error.message : String(error); } }
function go(hash) { location.hash = hash; void render(); }

async function copyText(value, button) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.className = 'clipboard-copy';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  const old = button.textContent;
  button.textContent = 'Copied ✓';
  setTimeout(() => { if (button.isConnected) button.textContent = old; }, 1200);
}

function setupView() {
  const webDriveHint = platform === 'web'
    ? `<p class="hint">${driveConfigured ? 'Web Drive restore uses a Web OAuth client from the same Google Cloud project as the extension.' : 'Google Drive is not configured for this web build. Local encrypted backups still work.'}</p>`
    : '';
  root.innerHTML = `<main class="center-card onboarding"><div class="brand">P</div><h1>Welcome to PassMan</h1><p>Create a master password</p><form><label>Master password<input name="password" type="password" minlength="10" required autofocus></label><label>Confirm password<input name="confirm" type="password" required></label><div class="form-error"></div><button class="primary wide">Continue</button></form><div class="or"><span>or</span></div><button class="secondary wide restore">Restore from Google Drive</button><div class="form-error"></div><p class="hint">Your master password cannot be recovered. Use one you will remember.</p>${webDriveHint}</main>`;
  const form = root.querySelector('form'); form.onsubmit = async event => { event.preventDefault(); const data = new FormData(form); if (data.get('password') !== data.get('confirm')) return setError(form, 'Passwords do not match.'); const button = event.submitter; button.disabled = true; button.textContent = 'Creating securely…'; try { await rpc({ type: 'SETUP', password: data.get('password') }); go('backup'); } catch (e) { setError(form, e); button.disabled = false; button.textContent = 'Continue'; } };
  root.querySelector('.restore').onclick = async event => { event.target.disabled = true; event.target.textContent = 'Connecting…'; try { await rpc({ type: 'RESTORE_DRIVE' }); go('unlock'); } catch (e) { event.target.disabled = false; event.target.textContent = 'Restore from Google Drive'; root.querySelector('.form-error').textContent = e.message; } };
}

function unlockView(error = '') {
  root.innerHTML = `<main class="center-card onboarding"><div class="brand">P</div><h1>Unlock PassMan</h1><p>Enter your master password.</p><form><input name="password" type="password" placeholder="Master password" required autofocus><div class="form-error">${escape(error)}</div><button class="primary wide">Unlock</button></form></main>`;
  const form = root.querySelector('form'); form.onsubmit = async event => { event.preventDefault(); const button = event.submitter; button.disabled = true; button.textContent = 'Unlocking…'; try { await rpc({ type: 'UNLOCK', password: new FormData(form).get('password') }); go(''); } catch (e) { unlockView(e.message); } };
}

function chooseCsv(onParsed) {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.csv,text/csv';
  input.onchange = async () => { if (!input.files?.[0]) return; try { onParsed(parseChromeCsv(await input.files[0].text())); } catch (e) { alert(e.message); } }; input.click();
}

function importCounts(items, existing) {
  const keys = new Set(existing.map(importKey));
  let newCount = 0;
  for (const item of items) { const key = importKey(item); if (!keys.has(key)) { keys.add(key); newCount++; } }
  return { newCount, duplicates: items.length - newCount };
}

function backupChoiceView() {
  const driveChecked = driveConfigured ? ' checked' : '';
  const localChecked = driveConfigured ? '' : ' checked';
  const driveDisabled = driveConfigured ? '' : ' disabled';
  const driveBadge = driveConfigured ? '<em>Recommended</em>' : '<em>Not configured</em>';
  root.innerHTML = `<main class="center-card onboarding"><h1>Keep your passwords backed up</h1><p>Choose where PassMan keeps your encrypted passwords.</p><label class="choice"><input type="radio" name="place" value="drive"${driveChecked}${driveDisabled}><span><b>Google Drive ${driveBadge}</b><small>Sync encrypted passwords between your devices.</small></span></label><label class="choice"><input type="radio" name="place" value="local"${localChecked}><span><b>This device only</b><small>PassMan works fully offline.</small></span></label><div class="form-error"></div><button class="primary wide continue">Continue</button></main>`;
  root.querySelector('.continue').onclick = async event => { event.target.disabled = true; try { if (root.querySelector('[value=drive]').checked) await rpc({ type: 'CONNECT_DRIVE' }); go(''); } catch (e) { root.querySelector('.form-error').textContent = e.message; event.target.disabled = false; } };
}

function shell(content, selected = 'passwords') {
  root.innerHTML = `<aside><div class="wordmark"><span>P</span>PassMan</div><nav><button data-go="" data-label="Passwords" class="${selected === 'passwords' ? 'active' : ''}">Passwords</button><button data-go="settings" data-label="Settings" class="${selected === 'settings' ? 'active' : ''}">Settings</button></nav><button class="lock link">Lock</button></aside><main class="workspace">${content}</main>`;
  root.querySelectorAll('[data-go]').forEach(button => button.onclick = () => go(button.dataset.go)); root.querySelector('.lock').onclick = async () => { await rpc({ type: 'LOCK' }); go('unlock'); };
}

async function listView(siteUrl = '') {
  const items = await rpc({ type: 'LIST' });
  const initialQuery = siteUrl ? displayHost(siteUrl) : '';
  shell(`<header class="page-head"><h1>Passwords <span class="password-count">${items.length}</span></h1><button class="primary add">Add password</button></header><input class="page-search" type="search" placeholder="Search passwords…" value="${escape(initialQuery)}" autofocus><section class="credential-list"></section>`);
  const list = root.querySelector('.credential-list'), search = root.querySelector('.page-search');
  let siteFilterActive = !!siteUrl;
  const draw = () => { const q = search.value.toLowerCase(); const shown = items.filter(i => siteFilterActive ? loginMatchesUrl(i.urls, siteUrl) : `${i.name} ${i.username} ${i.urls.join(' ')}`.toLowerCase().includes(q)).sort((a,b) => a.name.localeCompare(b.name)); list.textContent = ''; if (!shown.length) list.innerHTML = `<div class="large-empty"><div class="brand small">P</div><h2>${items.length ? 'No results' : 'No passwords yet'}</h2><p>${items.length ? 'Try another search.' : 'Add a password or bring yours over from Chrome.'}</p>${items.length ? '' : '<button class="secondary empty-import">Import Chrome CSV</button>'}</div>`; for (const item of shown) { const button = document.createElement('button'); button.className = 'credential'; button.innerHTML = `<span class="site-icon">${escape(item.name[0]?.toUpperCase() || 'P')}</span><span><b>${escape(item.name)}</b><small>${escape(item.username || 'No username')} · ${escape(displayHost(item.urls[0]))}</small></span><i>›</i>`; const mark = button.querySelector('.site-icon'), icon = faviconUrl(item.urls[0]); if (icon) { const image = new Image(); image.alt = ''; image.src = icon; image.onerror = () => image.remove(); mark.prepend(image); } button.onclick = () => go(`edit=${item.id}`); list.append(button); } };
  list.onclick = event => { if (!event.target.closest('.empty-import')) return; chooseCsv(csvItems => { const counts = importCounts(csvItems, items); list.innerHTML = `<div class="import-summary"><b>${csvItems.length} passwords found</b><span>${counts.newCount} new · ${counts.duplicates} duplicates</span><button class="primary confirm-import">Import</button><button class="link cancel-import">Cancel</button></div>`; list.querySelector('.cancel-import').onclick = draw; list.querySelector('.confirm-import').onclick = async importEvent => { importEvent.target.disabled = true; const result = await rpc({ type: 'IMPORT', items: csvItems }); list.innerHTML = `${notice(`${result.added} passwords imported.`, 'success')}<p class="csv-warning">The CSV contains unencrypted passwords. Delete it when you no longer need it.</p><button class="primary import-done">Done</button>`; list.querySelector('.import-done').onclick = () => render(); }; }); };
  search.oninput = () => { siteFilterActive = false; draw(); }; draw(); root.querySelector('.add').onclick = () => go('new');
}

async function editView(id, suggestedUrl = '') {
  const item = id ? (await rpc({ type: 'LIST' })).find(x => x.id === id) : null;
  shell(`<button class="back link">← Passwords</button><div class="editor"><h1>${item ? escape(item.name) : 'Add password'}</h1><form><label>Name<input name="name" value="${escape(item?.name || '')}" required></label><label>Website<input name="url" value="${escape(item?.urls[0] || suggestedUrl)}" placeholder="https://example.com" required></label><label>Username<div class="copy-input"><input name="username" value="${escape(item?.username || '')}" autocomplete="off" required><button type="button" class="copy-username secondary">Copy</button></div></label><label>Password<div class="password-input"><input name="password" value="${escape(item?.password || '')}" type="password" autocomplete="new-password" required><button type="button" class="generate secondary" title="Generate a memorable password">Generate</button><button type="button" class="copy-password secondary">Copy</button><button type="button" class="show secondary">Show</button></div></label><div class="form-error"></div><div class="editor-actions"><button class="primary">Save</button>${item ? '<button type="button" class="danger delete">Delete password</button>' : ''}</div></form></div>`);
  root.querySelector('.back').onclick = () => go(''); const form = root.querySelector('form'); const password = form.elements.password;
  const showButton = root.querySelector('.show');
  showButton.onclick = () => { password.type = password.type === 'password' ? 'text' : 'password'; showButton.textContent = password.type === 'password' ? 'Show' : 'Hide'; };
  root.querySelector('.generate').onclick = () => { password.value = generatePassword(); password.type = 'text'; showButton.textContent = 'Hide'; password.focus(); password.select(); };
  root.querySelector('.copy-username').onclick = event => copyText(form.elements.username.value, event.currentTarget);
  root.querySelector('.copy-password').onclick = event => copyText(password.value, event.currentTarget);
  form.onsubmit = async event => { event.preventDefault(); const data = new FormData(form); try { await rpc({ type: 'UPSERT', login: { id: item?.id, name: data.get('name'), urls: [data.get('url')], username: data.get('username'), password: data.get('password') } }); go(''); } catch (e) { setError(form, e); } };
  root.querySelector('.delete')?.addEventListener('click', async () => { if (confirm(`Delete ${item.name}?`)) { await rpc({ type: 'DELETE', id: item.id }); go(''); } });
}

async function settingsView() {
  const settings = await rpc({ type: 'SETTINGS' });
  const syncText = settings.lastSyncError ? escape(settings.lastSyncError) : settings.syncEnabled ? (settings.lastSyncAt ? `Synced ${new Date(settings.lastSyncAt).toLocaleString()}` : 'Connected') : 'Not connected';
  const icon = path => `<span class="settings-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg></span>`;
  const driveNote = platform === 'web' ? '<small class="setting-help">Use a Web OAuth client from the same Google Cloud project as the extension. Verify Restore from Google Drive finds your existing vault before relying on cross-client sync; Google does not formally guarantee every cross-client app-data combination.</small>' : '';
  const webNote = platform === 'web' ? '<section class="web-note"><b>Mobile autofill</b><p>An installed PassMan PWA can manage and copy passwords, but browsers do not let a PWA provide system-wide mobile autofill like a native password-manager app.</p></section>' : '';
  const reloadLabel = platform === 'web' ? 'When app reloads' : 'When Chrome closes';

  shell(`<header class="page-head"><h1>Settings</h1></header><div class="settings">
    <section class="settings-card">
      <div class="setting-row">${icon('<path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 8.5 4.8 4.8 0 0 0 7 18Z"></path>')}<div class="setting-copy"><h2>Google Drive</h2><small class="setting-status ${settings.lastSyncError ? 'error' : settings.syncEnabled ? 'connected' : ''}">${syncText}</small>${driveNote}</div><div class="row-actions">${settings.syncEnabled ? '<button class="secondary sync">Sync</button><button class="link disconnect">Disconnect</button>' : '<button class="primary connect">Connect</button>'}</div></div>
      <div class="setting-row">${icon('<circle cx="12" cy="12" r="8"></circle><path d="M12 8v4l3 2"></path>')}<div class="setting-copy"><h2>Auto-lock</h2></div><select class="autolock" aria-label="Auto-lock time"><option value="0">${reloadLabel}</option><option value="15">After 15 minutes</option><option value="60">After 1 hour</option><option value="-1">Never this session</option></select></div>
    </section>
    <section class="settings-card">
      <div class="setting-row">${icon('<path d="M12 3v12m-4-4 4 4 4-4"></path><path d="M5 19h14"></path>')}<div class="setting-copy"><h2>Passwords</h2><div class="import-result"></div></div><button class="secondary import">Import</button></div>
      <div class="setting-row">${icon('<path d="M5 7.5 12 4l7 3.5v9L12 20l-7-3.5Z"></path><path d="m5 7.5 7 3.5 7-3.5M12 11v9"></path>')}<div class="setting-copy"><h2>Encrypted backup</h2></div><div class="row-actions"><button class="secondary restore">Import</button><button class="secondary export">Export</button></div></div>
    </section>
    <section class="settings-card">
      <div class="setting-row">${icon('<rect x="5" y="10" width="14" height="10" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path>')}<div class="setting-copy"><h2>Master password</h2></div><button class="secondary change-master">Change</button></div>
    </section>
    ${webNote}
  </div>
  <dialog class="master-dialog"><form class="master"><header><h2>Change master password</h2><button type="button" class="link close-master" aria-label="Close">✕</button></header><label>Current password<input type="password" name="currentPassword" autocomplete="current-password" required></label><label>New password<input type="password" name="password" minlength="10" autocomplete="new-password" required></label><label>Confirm new password<input type="password" name="confirmPassword" minlength="10" autocomplete="new-password" required></label><div class="form-error" role="status"></div><div class="dialog-actions"><button type="button" class="secondary cancel-master">Cancel</button><button class="primary">Change password</button></div></form></dialog>`, 'settings');

  const select = root.querySelector('.autolock'); select.value = String(settings.autoLockMinutes); select.onchange = () => rpc({ type: 'SETTINGS', patch: { autoLockMinutes: Number(select.value) } });
  root.querySelector('.connect')?.addEventListener('click', async event => { event.target.disabled = true; try { await rpc({ type: 'CONNECT_DRIVE' }); settingsView(); } catch (e) { alert(e.message); event.target.disabled = false; } });
  root.querySelector('.sync')?.addEventListener('click', async event => { event.target.disabled = true; event.target.textContent = 'Syncing…'; try { await rpc({ type: 'SYNC', interactive: true }); settingsView(); } catch (e) { alert(e.message); settingsView(); } });
  root.querySelector('.disconnect')?.addEventListener('click', async () => { await rpc({ type: 'DISCONNECT_DRIVE' }); settingsView(); });
  root.querySelector('.import').onclick = () => chooseCsv(async items => { const existing = await rpc({ type: 'LIST' }), counts = importCounts(items, existing); const area = root.querySelector('.import-result'); area.innerHTML = `<div class="import-summary"><b>${items.length} passwords found</b><span>${counts.newCount} new · ${counts.duplicates} duplicates</span><button class="primary confirm-import">Import</button></div>`; area.querySelector('button').onclick = async () => { const result = await rpc({ type: 'IMPORT', items }); area.innerHTML = `${notice(`${result.added} passwords imported.`, 'success')}<p class="csv-warning">The CSV contains unencrypted passwords. Delete it when you no longer need it.</p>`; }; });
  root.querySelector('.export').onclick = async () => { const envelope = await rpc({ type: 'EXPORT_BACKUP' }); const blob = new Blob([JSON.stringify(envelope)], { type: 'application/x-passman' }), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `PassMan-Backup-${new Date().toISOString().slice(0,10)}.pm`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
  root.querySelector('.restore').onclick = () => { const input = document.createElement('input'); input.type = 'file'; input.accept = '.pm'; input.onchange = async () => { try { const envelope = JSON.parse(await input.files[0].text()); if (!confirm('Replace the local vault with this encrypted backup?')) return; const password = prompt('Enter the master password for this backup:'); if (!password) return; await rpc({ type: 'IMPORT_BACKUP', envelope, password }); go(''); } catch (e) { alert(`Could not restore backup: ${e.message}`); } }; input.click(); };
  const dialog = root.querySelector('.master-dialog'), changeMaster = root.querySelector('.change-master'), form = dialog.querySelector('.master');
  changeMaster.onclick = () => { form.reset(); setError(form, ''); dialog.showModal(); form.elements.currentPassword.focus(); };
  root.querySelector('.close-master').onclick = root.querySelector('.cancel-master').onclick = () => dialog.close();
  form.onsubmit = async event => {
    event.preventDefault();
    const data = new FormData(form), currentPassword = data.get('currentPassword'), password = data.get('password'), confirmPassword = data.get('confirmPassword');
    if (password !== confirmPassword) return setError(form, 'New passwords do not match.');
    if (password === currentPassword) return setError(form, 'Choose a new password that is different from your current password.');
    const button = event.submitter;
    button.disabled = true; button.textContent = 'Changing…';
    try {
      await rpc({ type: 'CHANGE_MASTER', currentPassword, password, confirmPassword });
      form.reset(); dialog.close();
      changeMaster.textContent = 'Changed ✓';
      setTimeout(() => { if (changeMaster.isConnected) changeMaster.textContent = 'Change'; }, 2000);
    } catch (e) { setError(form, e); }
    finally { button.disabled = false; button.textContent = 'Change password'; }
  };
}

async function render() {
  const hash = location.hash.slice(1);
  try {
    const status = await rpc({ type: 'STATUS' });
    if (!status.exists) return setupView();
    if (!status.unlocked) return unlockView();
    if (hash === 'backup') return backupChoiceView();
    if (hash === 'settings') return settingsView(); if (hash === 'new') return editView(); if (hash.startsWith('new=')) return editView(null, decodeURIComponent(hash.slice(4))); if (hash.startsWith('edit=')) return editView(hash.slice(5));
    if (hash.startsWith('site=')) return listView(decodeURIComponent(hash.slice(5)));
    return listView();
  } catch (e) { root.innerHTML = `<main class="center-card"><h1>PassMan couldn't open</h1>${notice(e.message, 'error')}<button class="secondary retry">Try again</button></main>`; root.querySelector('.retry').onclick = render; }
}

addEventListener('hashchange', render);
render();
