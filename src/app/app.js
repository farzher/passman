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
function recentTime(item) { return Math.max(Number(item.lastUsedAt) || 0, Number(item.createdAt) || 0); }
function csvCell(value) { const text = String(value ?? ''); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function passwordCsv(items) {
  const rows = [['name', 'url', 'username', 'password', 'note'], ...items.map(item => [item.name, item.urls?.[0] || '', item.username, item.password, ''])];
  return `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

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
  root.innerHTML = `<main class="center-card onboarding"><div class="brand">P</div><h1>Welcome to PassMan</h1><p>Create a master password</p><form><label>Master password<input name="password" type="password" minlength="10" required autofocus></label><label>Confirm password<input name="confirm" type="password" required></label><label>Password hint <span style="font-weight:400;color:var(--muted)">(optional)</span><input name="hint" maxlength="160" placeholder="Something only you will understand"></label><div class="form-error"></div><button class="primary wide">Continue</button></form><div class="or"><span>or</span></div><button class="secondary wide restore">Restore from Google Drive</button><div class="form-error"></div></main>`;
  const form = root.querySelector('form'); form.onsubmit = async event => { event.preventDefault(); const data = new FormData(form); if (data.get('password') !== data.get('confirm')) return setError(form, 'Passwords do not match.'); const button = event.submitter; button.disabled = true; button.textContent = 'Creating securely…'; try { await rpc({ type: 'SETUP', password: data.get('password') }); const hint = String(data.get('hint') || '').trim(); if (hint) await rpc({ type: 'SETTINGS', patch: { passwordHint: hint } }); go('backup'); } catch (e) { setError(form, e); button.disabled = false; button.textContent = 'Continue'; } };
  root.querySelector('.restore').onclick = async event => { event.target.disabled = true; event.target.textContent = 'Connecting…'; try { await rpc({ type: 'RESTORE_DRIVE' }); go('unlock'); } catch (e) { event.target.disabled = false; event.target.textContent = 'Restore from Google Drive'; root.querySelector('.form-error').textContent = e.message; } };
}

function unlockView(error = '', settings = {}) {
  const hint = String(settings.passwordHint || '').trim();
  root.innerHTML = `<main class="center-card onboarding"><div class="brand">P</div><h1>Unlock PassMan</h1><p>Enter your master password.</p><form><input name="password" type="password" placeholder="Master password" required autofocus><div class="form-error">${escape(error)}</div><button class="primary wide">Unlock</button></form>${hint ? '<button type="button" class="link show-hint">Show password hint</button><p class="hint password-hint" hidden></p>' : ''}</main>`;
  if (hint) {
    const button = root.querySelector('.show-hint'), text = root.querySelector('.password-hint');
    button.onclick = () => { text.textContent = hint; text.hidden = false; button.hidden = true; };
  }
  const form = root.querySelector('form'); form.onsubmit = async event => { event.preventDefault(); const button = event.submitter; button.disabled = true; button.textContent = 'Unlocking…'; try { await rpc({ type: 'UNLOCK', password: new FormData(form).get('password') }); go(''); } catch (e) { unlockView(e.message, settings); } };
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
  const draw = () => { const q = search.value.toLowerCase(); const shown = items.filter(i => siteFilterActive ? loginMatchesUrl(i.urls, siteUrl) : `${i.name} ${i.username} ${i.urls.join(' ')}`.toLowerCase().includes(q)).sort((a,b) => recentTime(b) - recentTime(a) || a.name.localeCompare(b.name)); list.textContent = ''; if (!shown.length) list.innerHTML = `<div class="large-empty"><div class="brand small">P</div><h2>${items.length ? 'No results' : 'No passwords yet'}</h2><p>${items.length ? 'Try another search.' : 'Add a password or bring yours over from Chrome.'}</p>${items.length ? '' : '<button class="secondary empty-import">Import Chrome CSV</button>'}</div>`; for (const item of shown) { const button = document.createElement('button'); button.className = 'credential'; button.innerHTML = `<span class="site-icon">${escape(item.name[0]?.toUpperCase() || 'P')}</span><span><b>${escape(item.name)}</b><small>${escape(item.username || 'No username')}</small></span><i>›</i>`; const mark = button.querySelector('.site-icon'), icon = faviconUrl(item.urls[0]); if (icon) { const image = new Image(); image.alt = ''; image.referrerPolicy = 'no-referrer'; image.loading = 'lazy'; image.src = icon; image.onerror = () => image.remove(); mark.prepend(image); } button.onclick = () => go(`edit=${item.id}`); list.append(button); } };
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
  root.querySelector('.copy-username').onclick = async event => { await copyText(form.elements.username.value, event.currentTarget); if (item) void rpc({ type: 'MARK_USED', id: item.id }).catch(() => {}); };
  root.querySelector('.copy-password').onclick = async event => { await copyText(password.value, event.currentTarget); if (item) void rpc({ type: 'MARK_USED', id: item.id }).catch(() => {}); };
  form.onsubmit = async event => { event.preventDefault(); const data = new FormData(form); try { await rpc({ type: 'UPSERT', login: { id: item?.id, name: data.get('name'), urls: [data.get('url')], username: data.get('username'), password: data.get('password') } }); go(''); } catch (e) { setError(form, e); } };
  root.querySelector('.delete')?.addEventListener('click', async () => { if (confirm(`Delete ${item.name}?`)) { await rpc({ type: 'DELETE', id: item.id }); go(''); } });
}

function openPasswordExportDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'master-dialog';
  dialog.innerHTML = `<div class="master"><header><h2>Export passwords</h2><button class="link close" type="button">✕</button></header><p>This creates an unencrypted Chrome-compatible CSV. Anyone with the file can read every password.</p><div class="dialog-actions"><button type="button" class="secondary cancel">Cancel</button><button type="button" class="primary confirm-export">Export CSV</button></div></div>`;
  document.body.append(dialog); dialog.showModal();
  const close = () => dialog.close();
  dialog.querySelector('.close').onclick = close; dialog.querySelector('.cancel').onclick = close;
  dialog.querySelector('.confirm-export').onclick = async event => { event.currentTarget.disabled = true; const items = await rpc({ type: 'LIST' }); download(`passman-passwords-${new Date().toISOString().slice(0,10)}.csv`, passwordCsv(items), 'text/csv;charset=utf-8'); close(); };
  dialog.addEventListener('close', () => dialog.remove());
}

function openHintDialog(settings) {
  const dialog = document.createElement('dialog'); dialog.className = 'master-dialog';
  dialog.innerHTML = `<form method="dialog" class="master"><header><h2>Password hint</h2><button class="link close" value="cancel">✕</button></header><p>Stored only on this device so it can be shown while PassMan is locked. Don't include your password.</p><label>Hint<input name="hint" maxlength="160" value="${escape(settings.passwordHint || '')}" placeholder="Something only you will understand" autofocus></label><div class="form-error"></div><div class="dialog-actions"><button value="cancel" class="secondary">Cancel</button>${settings.passwordHint ? '<button type="button" class="link remove-hint">Remove</button>' : ''}<button value="default" class="primary save-hint">Save</button></div></form>`;
  document.body.append(dialog); dialog.showModal(); dialog.addEventListener('close', () => dialog.remove()); const form = dialog.querySelector('form');
  dialog.querySelector('.remove-hint')?.addEventListener('click', async () => { await rpc({ type: 'SETTINGS', patch: { passwordHint: '' } }); dialog.close(); settingsView(); });
  form.onsubmit = async event => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const hint = String(new FormData(form).get('hint') || '').trim(); await rpc({ type: 'SETTINGS', patch: { passwordHint: hint } }); dialog.close(); settingsView(); };
}

async function settingsView() {
  const settings = await rpc({ type: 'SETTINGS' });
  const syncText = settings.lastSyncError ? escape(settings.lastSyncError) : settings.syncEnabled ? (settings.lastSyncAt ? `Synced ${new Date(settings.lastSyncAt).toLocaleString()}` : 'Connected') : 'Not connected';
  const icon = path => `<span class="settings-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg></span>`;
  const reloadLabel = platform === 'web' ? 'When session ends' : 'When Chrome closes';

  shell(`<header class="page-head"><h1>Settings</h1></header><div class="settings">
    <section class="settings-card">
      <div class="setting-row">${icon('<path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 8.5 4.8 4.8 0 0 0 7 18Z"></path>')}<div class="setting-copy"><h2>Google Drive</h2><small class="setting-status ${settings.lastSyncError ? 'error' : settings.syncEnabled ? 'connected' : ''}">${syncText}</small></div><div class="row-actions">${settings.syncEnabled ? '<button class="secondary sync">Sync</button><button class="link disconnect">Disconnect</button>' : '<button class="primary connect">Connect</button>'}</div></div>
      <div class="setting-row">${icon('<circle cx="12" cy="12" r="8"></circle><path d="M12 8v4l3 2"></path>')}<div class="setting-copy"><h2>Auto-lock</h2></div><select class="autolock" aria-label="Auto-lock time"><option value="0">${reloadLabel}</option><option value="15">After 15 minutes</option><option value="60">After 1 hour</option><option value="-1">Never this session</option></select></div>
    </section>
    <section class="settings-card">
      <div class="setting-row">${icon('<path d="M12 3v12m-4-4 4 4 4-4"></path><path d="M5 19h14"></path>')}<div class="setting-copy"><h2>Passwords</h2><div class="import-result"></div></div><div class="row-actions"><button class="secondary import">Import</button><button class="secondary export-passwords">Export</button></div></div>
      <div class="setting-row">${icon('<path d="M5 7.5 12 4l7 3.5v9L12 20l-7-3.5Z"></path><path d="m5 7.5 7 3.5 7-3.5M12 11v9"></path>')}<div class="setting-copy"><h2>Encrypted backup</h2></div><div class="row-actions"><button class="secondary restore">Import</button><button class="secondary export">Export</button></div></div>
    </section>
    <section class="settings-card">
      <div class="setting-row">${icon('<rect x="5" y="10" width="14" height="10" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path>')}<div class="setting-copy"><h2>Master password</h2></div><button class="secondary change-master">Change</button></div>
      <div class="setting-row">${icon('<path d="M9 18h6M10 22h4M8.5 14.5A6 6 0 1 1 15.5 14.5C14.5 15.2 14 16 14 17h-4c0-1-.5-1.8-1.5-2.5Z"></path>')}<div class="setting-copy"><h2>Password hint</h2><small>${settings.passwordHint ? 'Set · This device only' : 'Not set · This device only'}</small></div><button class="secondary edit-hint">${settings.passwordHint ? 'Edit' : 'Set'}</button></div>
    </section>
  </div>`, 'settings');
  const lock = root.querySelector('.autolock'); lock.value = String(settings.autoLockMinutes); lock.onchange = async () => rpc({ type: 'SETTINGS', patch: { autoLockMinutes: Number(lock.value) } });
  root.querySelector('.connect')?.addEventListener('click', async event => { event.target.disabled = true; try { await rpc({ type: 'CONNECT_DRIVE' }); settingsView(); } catch (e) { alert(e.message); event.target.disabled = false; } });
  root.querySelector('.sync')?.addEventListener('click', async event => { event.target.disabled = true; event.target.textContent = 'Syncing…'; try { await rpc({ type: 'SYNC', interactive: true }); settingsView(); } catch (e) { alert(e.message); event.target.disabled = false; event.target.textContent = 'Sync'; } });
  root.querySelector('.disconnect')?.addEventListener('click', async () => { await rpc({ type: 'DISCONNECT_DRIVE' }); settingsView(); });
  root.querySelector('.import').onclick = () => chooseCsv(async items => { const existing = await rpc({ type: 'LIST' }); const counts = importCounts(items, existing); if (!confirm(`Import ${counts.newCount} new password${counts.newCount === 1 ? '' : 's'}? ${counts.duplicates} duplicate${counts.duplicates === 1 ? '' : 's'} will be skipped.`)) return; const result = await rpc({ type: 'IMPORT', items }); const status = root.querySelector('.import-result'); status.className = 'import-result notice success'; status.textContent = `${result.added} imported · ${result.duplicates} duplicates skipped. Delete the unencrypted CSV when you no longer need it.`; });
  root.querySelector('.export-passwords').onclick = openPasswordExportDialog;
  root.querySelector('.export').onclick = async () => { const backup = await rpc({ type: 'EXPORT_BACKUP' }); const blob = new Blob([backup], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `passman-${new Date().toISOString().slice(0,10)}.pm`; a.click(); URL.revokeObjectURL(url); };
  root.querySelector('.restore').onclick = () => { const input = document.createElement('input'); input.type = 'file'; input.accept = '.pm,application/json'; input.onchange = async () => { if (!input.files?.[0]) return; try { await rpc({ type: 'IMPORT_BACKUP', text: await input.files[0].text() }); go('unlock'); } catch (e) { alert(e.message); } }; input.click(); };
  root.querySelector('.change-master').onclick = () => openMasterDialog();
  root.querySelector('.edit-hint').onclick = () => openHintDialog(settings);
}

function openMasterDialog() {
  const dialog = document.createElement('dialog'); dialog.className = 'master-dialog'; dialog.innerHTML = `<form method="dialog" class="master"><header><h2>Change master password</h2><button class="link close" value="cancel">✕</button></header><label>Current password<input name="current" type="password" required autocomplete="current-password"></label><label>New password<input name="next" type="password" minlength="10" required autocomplete="new-password"></label><label>Confirm new password<input name="confirm" type="password" required autocomplete="new-password"></label><div class="form-error"></div><div class="dialog-actions"><button value="cancel" class="secondary">Cancel</button><button value="default" class="primary save-master">Change password</button></div></form>`; document.body.append(dialog); dialog.showModal(); dialog.addEventListener('close', () => dialog.remove()); const form = dialog.querySelector('form'); form.onsubmit = async event => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const data = new FormData(form); if (data.get('next') !== data.get('confirm')) return setError(form, 'New passwords do not match.'); const button = event.submitter; button.disabled = true; button.textContent = 'Changing…'; try { await rpc({ type: 'CHANGE_MASTER', currentPassword: data.get('current'), password: data.get('next'), confirmPassword: data.get('confirm') }); dialog.close(); } catch (e) { setError(form, e); button.disabled = false; button.textContent = 'Change password'; } };
}

async function render() {
  let status;
  try { status = await rpc({ type: 'STATUS' }); } catch (e) { root.innerHTML = `<main class="center-card">${notice(e.message, 'error')}</main>`; return; }
  if (!status.exists) return setupView();
  if (!status.unlocked) return unlockView('', status.settings || {});
  const hash = location.hash.slice(1);
  if (hash === 'backup') return backupChoiceView();
  if (hash === 'settings') return settingsView();
  if (hash === 'new') return editView(null, new URLSearchParams(location.search).get('site') || '');
  if (hash.startsWith('edit=')) return editView(hash.slice(5));
  return listView(new URLSearchParams(location.search).get('site') || '');
}

addEventListener('hashchange', render);
render();