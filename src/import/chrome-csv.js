import { displayHost, parseUrl, uuid } from '../shared/util.js';

function rows(csv) {
  const out = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted && c === '"' && csv[i + 1] === '"') {
      field += '"';
      i++;
    } else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && csv[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(Boolean)) out.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some(Boolean)) out.push(row);
  return out;
}

function parseChromeCsv(csv) {
  const all = rows(csv.replace(/^\uFEFF/, ''));
  if (all.length < 2) throw new Error('The CSV is empty.');
  const headers = all[0].map(header => header.trim().toLowerCase());
  const nameAt = headers.indexOf('name');
  const urlAt = headers.indexOf('url');
  const userAt = headers.indexOf('username');
  const passAt = headers.indexOf('password');
  if ([nameAt, urlAt, userAt, passAt].some(index => index < 0)) {
    throw new Error('Choose a Chrome / Google Password Manager CSV with name, url, username and password columns.');
  }
  return all.slice(1).flatMap(row => {
    const parsed = parseUrl((row[urlAt] || '').trim());
    const password = row[passAt] || '';
    if (!parsed || !password) return [];
    return [{
      name: (row[nameAt] || '').trim() || displayHost(parsed.href),
      urls: [parsed.href],
      username: row[userAt] || '',
      password
    }];
  });
}

function importKey(login) {
  const origin = parseUrl(login.urls[0])?.origin.toLowerCase() || login.urls[0].toLowerCase();
  return `${origin}\n${login.username.trim().toLowerCase()}`;
}

function materialize(login) {
  const now = Date.now();
  return { ...login, id: uuid(), createdAt: now, updatedAt: now, lastUsedAt: null };
}

export { importKey, materialize, parseChromeCsv };
