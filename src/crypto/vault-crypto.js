import { argon2id } from "@noble/hashes/argon2";
import { base64ToBytes, bytesToBase64, randomBytes } from "../shared/util";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const SALT_BYTES = 16;
const DEFAULT_KDF = Object.freeze({ memory: 65536, iterations: 3, parallelism: 1 });

function assertBytes(value, length, name) {
  if (!(value instanceof Uint8Array) || value.length !== length) throw new Error(`${name} must be exactly ${length} bytes.`);
}
function decodeCanonicalBase64(value, name) {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Invalid ${name}.`);
  }
  const bytes = base64ToBytes(value);
  if (bytesToBase64(bytes) !== value) throw new Error(`Invalid ${name}.`);
  return bytes;
}
async function aesKey(raw) {
  assertBytes(raw, AES_KEY_BYTES, "AES-256 key");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(rawKey, plain) {
  const iv = randomBytes(GCM_IV_BYTES);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, await aesKey(rawKey), plain);
  return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(data)) };
}
async function decrypt(rawKey, box) {
  const iv = decodeCanonicalBase64(box?.iv, "AES-GCM IV");
  const data = decodeCanonicalBase64(box?.data, "AES-GCM ciphertext");
  if (iv.length !== GCM_IV_BYTES || data.length < GCM_TAG_BYTES) throw new Error("Invalid AES-GCM box.");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    await aesKey(rawKey),
    data
  );
  return new Uint8Array(plain);
}
async function deriveRoot(password, salt, params) {
  assertBytes(salt, SALT_BYTES, "Argon2id salt");
  return argon2id(encoder.encode(password), salt, { m: params.memory, t: params.iterations, p: params.parallelism, dkLen: AES_KEY_BYTES });
}
async function createEnvelope(password, payload) {
  const salt = randomBytes(SALT_BYTES);
  const vaultKey = randomBytes(AES_KEY_BYTES);
  const root = await deriveRoot(password, salt, DEFAULT_KDF);
  try {
    const envelope = {
      version: 1,
      kdf: { type: "argon2id", salt: bytesToBase64(salt), params: DEFAULT_KDF },
      wrappedKey: await encrypt(root, vaultKey),
      payload: await encrypt(vaultKey, encoder.encode(JSON.stringify(payload)))
    };
    return { envelope, vaultKey };
  } catch (error) {
    vaultKey.fill(0);
    throw error;
  } finally {
    root.fill(0);
  }
}
async function unlockEnvelope(password, envelope) {
  assertEnvelope(envelope);
  const root = await deriveRoot(password, base64ToBytes(envelope.kdf.salt), envelope.kdf.params);
  let key;
  let authenticated = false;
  try {
    key = await decrypt(root, envelope.wrappedKey);
    const payload = await decryptPayload(key, envelope);
    authenticated = true;
    return { key, payload };
  } catch {
    throw new Error("Incorrect master password or damaged vault.");
  } finally {
    root.fill(0);
    if (!authenticated) key?.fill(0);
  }
}
async function decryptPayload(key, envelope) {
  try {
    const value = JSON.parse(decoder.decode(await decrypt(key, envelope.payload)));
    if (!value || typeof value !== 'object' || !Number.isInteger(value.revision) || !Array.isArray(value.items) ||
        !value.items.every(item => item && typeof item.id === 'string' && typeof item.name === 'string' &&
          Array.isArray(item.urls) && item.urls.every(url => typeof url === 'string') &&
          typeof item.username === 'string' && typeof item.password === 'string' &&
          Number.isFinite(item.createdAt) && Number.isFinite(item.updatedAt))) throw new Error();
    if (value.deleted == null) value.deleted = {};
    if (typeof value.deleted !== 'object' || Array.isArray(value.deleted)) throw new Error();
    return value;
  } catch {
    throw new Error("The vault is damaged or cannot be authenticated.");
  }
}
async function replacePayload(key, envelope, payload) {
  return { ...envelope, payload: await encrypt(key, encoder.encode(JSON.stringify(payload))) };
}
async function rewrapKey(password, key, envelope) {
  assertBytes(key, AES_KEY_BYTES, "Vault key");
  const salt = randomBytes(SALT_BYTES);
  const root = await deriveRoot(password, salt, DEFAULT_KDF);
  try {
    return { ...envelope, kdf: { type: "argon2id", salt: bytesToBase64(salt), params: DEFAULT_KDF }, wrappedKey: await encrypt(root, key) };
  } finally {
    root.fill(0);
  }
}
function assertEnvelope(value) {
  try {
    const e = value;
    const p = e?.kdf?.params;
    if (!e || e.version !== 1 || e.kdf?.type !== 'argon2id' ||
        !p || !Number.isInteger(p.memory) || p.memory < 8192 || p.memory > 262144 ||
        !Number.isInteger(p.iterations) || p.iterations < 1 || p.iterations > 10 || p.parallelism !== 1) throw new Error();
    if (decodeCanonicalBase64(e.kdf.salt, "Argon2id salt").length !== SALT_BYTES ||
        decodeCanonicalBase64(e.wrappedKey?.iv, "wrapped-key IV").length !== GCM_IV_BYTES ||
        decodeCanonicalBase64(e.wrappedKey?.data, "wrapped key").length !== AES_KEY_BYTES + GCM_TAG_BYTES ||
        decodeCanonicalBase64(e.payload?.iv, "payload IV").length !== GCM_IV_BYTES ||
        decodeCanonicalBase64(e.payload?.data, "encrypted payload").length < GCM_TAG_BYTES) throw new Error();
  } catch {
    throw new Error('Unsupported or damaged PassMan vault.');
  }
}
export {
  assertEnvelope,
  createEnvelope,
  decryptPayload,
  deriveRoot,
  replacePayload,
  rewrapKey,
  unlockEnvelope
};
