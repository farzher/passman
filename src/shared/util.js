const bytesToBase64 = (bytes) => {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};
const base64ToBytes = (text) => {
  const binary = atob(text);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};
function randomBytes(length) {
  if (!Number.isSafeInteger(length) || length < 1 || length > 65_536) throw new RangeError('Invalid secure-random byte length.');
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') throw new Error('A cryptographically secure random source is unavailable.');
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
const uuid = () => crypto.randomUUID();
function parseUrl(value) {
  try {
    const withScheme = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
    const url = new URL(withScheme);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}
function loginMatchesUrl(urls, pageUrl) {
  const page = parseUrl(pageUrl);
  if (!page) return false;
  return urls.some((value) => {
    const saved = parseUrl(value);
    if (!saved) return false;
    if (saved.protocol === 'https:' && page.protocol !== 'https:') return false;
    const host = page.hostname.toLowerCase();
    const wanted = saved.hostname.toLowerCase();
    return host === wanted || host.endsWith(`.${wanted}`);
  });
}
function displayHost(value) {
  return parseUrl(value)?.hostname.replace(/^www\./, '') || value;
}
function faviconUrl(value, size = 32) {
  if (globalThis.passmanPlatform === 'web') return '';
  const page = parseUrl(value);
  const runtime = globalThis.chrome?.runtime;
  if (!page || !runtime?.getURL) return '';
  const url = new URL(runtime.getURL('_favicon/'));
  url.searchParams.set('pageUrl', page.href);
  url.searchParams.set('size', String(size));
  return url.href;
}
function send(message) {
  if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('Extension messaging is unavailable.');
  return globalThis.chrome?.runtime?.sendMessage(message);
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
export {
  base64ToBytes,
  bytesToBase64,
  displayHost,
  errorText,
  faviconUrl,
  loginMatchesUrl,
  parseUrl,
  randomBytes,
  send,
  uuid
};
