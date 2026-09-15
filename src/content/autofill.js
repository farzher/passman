import { generatePassword } from '../shared/password-generator.js';
import { faviconUrl } from '../shared/util.js';

const rpc = async message => {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'PassMan is unavailable.');
  return response.value;
};

const attached = new WeakSet();
const controls = new Map();
const declined = new Set();
let openHost;
let outsideHandler;
let generatedPassword = '';
let lastPasswordInput;

function visible(input) {
  const r = input.getBoundingClientRect();
  return !input.disabled && !input.readOnly && r.width > 80 && r.height > 18 && getComputedStyle(input).visibility !== 'hidden';
}
function usernameFor(password) {
  const scope = password.form || document;
  const candidates = [...scope.querySelectorAll('input')].filter(el => el instanceof HTMLInputElement && visible(el) && /^(email|text|tel)$/.test(el.type) && !/search|code|otp/i.test(`${el.name} ${el.id} ${el.autocomplete}`));
  return candidates.filter(el => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1) || candidates[0];
}
function dispatch(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
async function copyText(value) {
  try { await navigator.clipboard.writeText(value); return; } catch {}
  const input = document.createElement('textarea'); input.value = value; input.style.position = 'fixed'; input.style.opacity = '0'; document.documentElement.append(input); input.select();
  const copied = document.execCommand('copy'); input.remove();
  if (!copied) throw new Error('Copy failed.');
}
function newPasswordField(input) {
  const passwords = [...(input.form || document).querySelectorAll('input[type=password]')].filter(visible);
  return /new-password/i.test(input.autocomplete) || passwords.length >= 2;
}
async function createAndFillLogin(input, forceGenerate = false) {
  const user = usernameFor(input);
  const username = user?.value || await rpc({ type: 'GET_REMEMBERED_USERNAME' }).catch(() => '');
  const password = forceGenerate ? generatePassword() : (input.value || generatePassword());
  generatedPassword = password;
  const fields = newPasswordField(input)
    ? [...(input.form || document).querySelectorAll('input[type=password]')].filter(field => visible(field) && !/current|old/i.test(`${field.autocomplete} ${field.name} ${field.id}`))
    : [input];
  if (user && username) dispatch(user, username);
  for (const field of fields.length ? fields : [input]) dispatch(field, password);
  // Save immediately so a generated password cannot be lost if navigation or
  // the site's submit handling prevents the later save prompt from appearing.
  await rpc({ type: 'SAVE_CANDIDATE', username, password });
  input.focus();
}
function interactionContainer(input) {
  return input.closest('dialog,[role="dialog"],[aria-modal="true"]') || input.form || input.parentElement || document.documentElement;
}
function position(host, input) {
  const rect = input.getBoundingClientRect();
  host.style.left = `${Math.max(4, rect.right - 27)}px`;
  host.style.top = `${rect.top + Math.max(2, (rect.height - 22) / 2)}px`;
}
function containPointerEvents(element) {
  for (const type of ['pointerdown', 'mousedown']) element.addEventListener(type, event => {
    event.preventDefault(); event.stopPropagation();
  });
}
function close() {
  openHost?.remove(); openHost = undefined;
  if (outsideHandler) document.removeEventListener('pointerdown', outsideHandler, true);
  outsideHandler = undefined;
}

async function showMenu(input, anchor) {
  close();
  const host = document.createElement('div'); openHost = host;
  Object.assign(host.style, { all: 'initial', position: 'fixed', zIndex: '2147483647' });
  const rect = input.getBoundingClientRect(); host.style.left = `${rect.left}px`; host.style.top = `${rect.bottom + 5}px`;
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    *{box-sizing:border-box}.menu{width:min(310px,calc(100vw - 16px));background:#fff;color:#17191c;border:1px solid #dfe2e6;border-radius:10px;padding:6px;box-shadow:0 12px 32px #0003;font:13px/1.35 system-ui,sans-serif}
    .menu>button{display:block;width:100%;border:0;background:none;text-align:left;padding:9px 10px;border-radius:7px;color:inherit;cursor:pointer}.menu>button:hover,.menu>button:focus{background:#f1f3f5;outline:0}.name{font-weight:650}.user{color:#60656c;margin-top:2px;overflow:hidden;text-overflow:ellipsis}.empty{padding:10px;color:#666}.gen{border-bottom:1px solid #eee;margin-bottom:5px}.mark{color:#315efb;font-weight:800;margin-right:7px}.item{display:flex;align-items:center;gap:7px;padding:6px 5px 6px 7px;border-radius:7px;cursor:pointer}.item:hover,.item:focus{background:#f1f3f5;outline:0}.site-icon{position:relative;display:grid;place-items:center;flex:0 0 27px;height:27px;border-radius:7px;background:#f1f3f5;color:#60656c;font-size:11px;font-weight:750}.site-icon img{position:absolute;width:17px;height:17px;object-fit:contain}.account{min-width:0;flex:1;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.action{height:29px;border:0;border-radius:6px;cursor:pointer}.copy{display:grid;place-items:center;width:29px;padding:0;background:transparent;color:#666}.copy:hover,.copy:focus{background:#fff;color:#17191c;outline:0}.copy svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.copy.copied{color:#237547}.copy.copied svg{display:none}.copy.copied::after{content:'✓';font-weight:750}.action:disabled{opacity:.55}.error{color:#b83232}@media(prefers-color-scheme:dark){.menu{background:#24262a;color:#f4f4f5;border-color:#3b3e44}.user,.empty,.copy{color:#adb0b6}.menu>button:hover,.menu>button:focus,.item:hover,.item:focus{background:#32353a}.site-icon{background:#32353a;color:#adb0b6}.copy:hover,.copy:focus{background:#24262a;color:#fff}.gen{border-color:#3b3e44}}
  </style><div class="menu"><div class="empty">Loading…</div></div>`;
  interactionContainer(input).append(host);
  const menu = root.querySelector('.menu');
  containPointerEvents(menu);
  try {
    const items = await rpc({ type: 'MATCHES' }); menu.textContent = '';
    if (newPasswordField(input) && items.length) {
      const button = document.createElement('button'); button.className = 'gen';
      button.innerHTML = `<div class="name"><span class="mark">P</span>Use strong password</div><div class="user">Generate, save, and fill a secure password</div>`;
      button.onclick = async () => {
        button.disabled = true;
        try { await createAndFillLogin(input, true); close(); }
        catch (error) { menu.innerHTML = '<div class="empty error"></div>'; menu.firstElementChild.textContent = error.message || 'Could not save a generated password.'; }
      };
      menu.append(button);
    }
    for (const item of items) {
      const row = document.createElement('div'); row.className = 'item'; row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-label', `Fill password for ${item.username || 'this account'}`);
      row.innerHTML = `<span class="site-icon"></span><div class="account"></div><button class="action copy" type="button" title="Copy password" aria-label="Copy password"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="10" height="11" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1"></path></svg></button>`;
      row.querySelector('.account').textContent = item.username || 'No username';
      const mark = row.querySelector('.site-icon'), icon = faviconUrl(item.url);
      mark.textContent = item.name[0]?.toUpperCase() || 'P';
      if (icon) { const image = new Image(); image.alt = ''; image.src = icon; image.onerror = () => image.remove(); mark.prepend(image); }
      const copy = row.querySelector('.copy');
      copy.onclick = async event => {
        event.stopPropagation(); copy.disabled = true;
        try { const login = await rpc({ type: 'GET_CREDENTIAL', id: item.id }); await copyText(login.password); copy.classList.add('copied'); copy.title = 'Password copied'; copy.setAttribute('aria-label', 'Password copied'); setTimeout(() => { copy.disabled = false; copy.classList.remove('copied'); copy.title = 'Copy password'; copy.setAttribute('aria-label', 'Copy password'); }, 1500); }
        catch (error) { menu.innerHTML = '<div class="empty error"></div>'; menu.firstElementChild.textContent = error.message || 'Could not copy the password.'; }
      };
      row.onclick = async () => {
        try { const login = await rpc({ type: 'GET_CREDENTIAL', id: item.id }); const user = usernameFor(input); if (user) dispatch(user, login.username); dispatch(input, login.password); close(); input.focus(); }
        catch (error) { menu.innerHTML = '<div class="empty error"></div>'; menu.firstElementChild.textContent = error.message || 'Could not fill this login.'; }
      };
      row.onkeydown = event => { if (event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); row.click(); } };
      menu.append(row);
    }
    if (!items.length) {
      menu.textContent = '';
      const add = document.createElement('button'); add.innerHTML = '<div class="name"><span class="mark">＋</span>Create &amp; fill login</div>';
      add.onclick = async () => {
        add.disabled = true;
        try { await createAndFillLogin(input); close(); }
        catch (error) { menu.innerHTML = '<div class="empty"></div>'; menu.firstElementChild.textContent = error.message || 'Could not save this login.'; }
      };
      menu.append(add);
    }
  } catch (e) { menu.innerHTML = '<div class="empty"></div>'; menu.firstElementChild.textContent = e.message.includes('locked') ? 'Unlock PassMan from the toolbar.' : e.message; }
  setTimeout(() => {
    outsideHandler = event => { const path = event.composedPath(); if (!path.includes(host) && !path.includes(anchor)) close(); };
    document.addEventListener('pointerdown', outsideHandler, true);
  }, 0);
}
function attach(input) {
  if (attached.has(input) || !visible(input)) return; attached.add(input);
  const host = document.createElement('span');
  Object.assign(host.style, { all: 'initial', position: 'fixed', zIndex: '2147483646', width: '22px', height: '22px', display: document.activeElement === input ? 'block' : 'none' });
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>button{all:unset;width:20px;height:20px;border-radius:6px;background:#315efb;color:white;text-align:center;font:700 12px/20px system-ui;box-shadow:0 1px 4px #0003;cursor:pointer}button:hover{background:#244bd1}</style><button type="button" title="Fill with PassMan">P</button>`;
  const button = root.querySelector('button');
  containPointerEvents(button);
  button.onclick = event => { event.preventDefault(); event.stopPropagation(); void showMenu(input, host); };
  interactionContainer(input).append(host); position(host, input);
  const show = () => { if (input.isConnected && visible(input)) { host.style.display = 'block'; position(host, input); } };
  const hide = () => { if (document.activeElement !== input) host.style.display = 'none'; };
  const cleanup = () => {
    host.remove(); controls.delete(input); attached.delete(input);
    input.removeEventListener('focus', show); input.removeEventListener('blur', hide);
    removeEventListener('scroll', update); removeEventListener('resize', update);
  };
  const update = () => { if (!input.isConnected || !visible(input)) cleanup(); else if (host.style.display !== 'none') position(host, input); };
  input.addEventListener('focus', show); input.addEventListener('blur', hide);
  controls.set(input, cleanup);
  addEventListener('scroll', update, { passive: true }); addEventListener('resize', update, { passive: true });
}
function scan() {
  for (const [input, cleanup] of controls) if (!input.isConnected || !visible(input)) cleanup();
  document.querySelectorAll('input[type=password]').forEach(input => input instanceof HTMLInputElement && attach(input));
}
document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); }, true);
document.addEventListener('focusin', event => {
  if (event.target instanceof HTMLInputElement && event.target.type === 'password') lastPasswordInput = event.target;
}, true);
let scanFrame;
scan(); new MutationObserver(() => {
  cancelAnimationFrame(scanFrame); scanFrame = requestAnimationFrame(scan);
}).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });

function promptSave(candidate, assessment) {
  const key = `${location.origin}:${candidate.username}:${assessment.action}`; if (declined.has(key)) return;
  const host = document.createElement('div'); Object.assign(host.style, { all: 'initial', position: 'fixed', right: '16px', top: '16px', zIndex: '2147483647' });
  const updateTitle = assessment.reason === 'username' ? 'Add username to saved login?' : 'Update saved password?';
  const root = host.attachShadow({ mode: 'closed' }); root.innerHTML = `<style>*{box-sizing:border-box}.box{width:300px;background:#fff;color:#17191c;border:1px solid #ddd;border-radius:11px;padding:14px;box-shadow:0 12px 32px #0003;font:13px system-ui}.title{font-weight:700;font-size:14px}.user{margin:7px 0 13px;color:#62666c;overflow:hidden;text-overflow:ellipsis}.actions{display:flex;gap:8px;justify-content:flex-end}button{border:0;border-radius:7px;padding:7px 11px;font:600 13px system-ui;cursor:pointer}.yes{background:#315efb;color:#fff}.no{background:#eef0f2;color:#333}@media(prefers-color-scheme:dark){.box{background:#24262a;color:#f5f5f5;border-color:#3c3f44}.user{color:#b3b6bc}.no{background:#383b40;color:#eee}}</style><div class="box"><div class="title">${assessment.action === 'update' ? updateTitle : `Save password for ${location.hostname}?`}</div><div class="user"></div><div class="actions"><button class="no">Not now</button><button class="yes">${assessment.action === 'update' ? 'Update' : 'Save'}</button></div></div>`;
  root.querySelector('.user').textContent = candidate.username || 'No username';
  root.querySelector('.no').onclick = () => { declined.add(key); void rpc({ type: 'DISMISS_STAGED' }).catch(() => {}); host.remove(); };
  root.querySelector('.yes').onclick = async () => { const button = root.querySelector('.yes'); button.textContent = 'Saving…'; try { await rpc({ type: 'SAVE_CANDIDATE', ...candidate, id: assessment.id }); host.remove(); } catch (e) { button.textContent = e.message; } };
  document.documentElement.append(host); setTimeout(() => host.remove(), 20_000);
}
async function inspectSubmit(form) {
  const passwords = [...form.querySelectorAll('input[type=password]')].filter(visible);
  if (!passwords.length) return;
  const likelyNew = passwords.find(p => /new-password|new(?!s)|change/i.test(`${p.autocomplete} ${p.name} ${p.id}`) && !/confirm|repeat/i.test(`${p.name} ${p.id}`));
  const password = (newPasswordField(passwords[0]) && generatedPassword) || likelyNew?.value || passwords.find(p => !/confirm|repeat|current|old/i.test(`${p.name} ${p.id} ${p.autocomplete}`))?.value || passwords[0]?.value;
  if (!password) return;
  let username = usernameFor(passwords[0])?.value || '';
  if (!username) username = await rpc({ type: 'GET_REMEMBERED_USERNAME' }).catch(() => '');
  const candidate = { username, password };
  const assessment = await rpc({ type: 'STAGE_LOGIN', ...candidate }).catch(() => ({ action: 'none' }));
  if (assessment.action !== 'none') promptSave({ ...candidate, username: assessment.username ?? candidate.username }, assessment);
}
document.addEventListener('submit', event => { if (event.target instanceof HTMLFormElement) void inspectSubmit(event.target); }, true);
setTimeout(async () => {
  const staged = await rpc({ type: 'GET_STAGED_LOGIN' }).catch(() => null);
  if (staged) promptSave(staged.candidate, staged.assessment);
}, 700);
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== 'PASSMAN_FILL') return;
  const fields = [...document.querySelectorAll('input[type=password]')].filter(visible);
  const input = lastPasswordInput?.isConnected && visible(lastPasswordInput)
    ? lastPasswordInput
    : fields.find(field => /current-password/i.test(field.autocomplete)) || fields.at(-1);
  if (!input) { respond({ filled: false, error: 'No visible password field was found.' }); return; }
  rpc({ type: 'GET_CREDENTIAL', id: message.id }).then(login => {
    const user = usernameFor(input);
    if (user) dispatch(user, login.username);
    dispatch(input, login.password);
    input.focus();
    respond({ filled: true });
  }).catch(error => respond({ filled: false, error: error instanceof Error ? error.message : 'Could not fill this login.' }));
  return true;
});
document.addEventListener('change', event => {
  const input = event.target;
  if (input instanceof HTMLInputElement && /^(email|text)$/.test(input.type) && input.value && !input.form?.querySelector('input[type=password]')) void rpc({ type: 'REMEMBER_USERNAME', username: input.value }).catch(() => {});
}, true);
