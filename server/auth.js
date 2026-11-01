import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { log } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = path.join(__dirname, 'data', 'secret.key');
const SESSION_TTL_S = 180 * 24 * 3600;

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') log.warn('JWT_SECRET is not set: sessions will not survive a redeploy');
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
    return s;
  }
}
const SECRET = loadSecret();

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (data) => crypto.createHmac('sha256', SECRET).update(data).digest();

// ------------------------------------------------------------------ JWT (HS256)

export function signSession(sub) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ sub, iat: now, exp: now + SESSION_TTL_S }));
  return `${head}.${body}.${b64url(hmac(`${head}.${body}`))}`;
}

/** Returns the account id inside a valid, unexpired token, else null. */
export function verifySession(token) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const [head, body, sig] = token.split('.');
  if (!head || !body || !sig) return null;
  const expected = hmac(`${head}.${body}`);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof claims.sub !== 'string' || claims.exp < Date.now() / 1000) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ signed match results

const canonical = (obj) => JSON.stringify(obj, Object.keys(obj).sort());

/** HMAC over the result fields, so stored/forwarded results can be proven server-issued. */
export const signResult = (result) => hmac(canonical(result)).toString('hex');
export const verifyResult = (result, sig) => typeof sig === 'string' && sig === signResult(result);

// ------------------------------------------------------------------ usernames + passwords

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
export const PASSWORD_MIN = 6;
const PASSWORD_MAX = 128;
const RESERVED = new Set(['admin', 'administrator', 'moderator', 'mod', 'system', 'server', 'support', 'staff', 'pump', 'pumproyale', 'pump_royale', 'official', 'root', 'null', 'undefined', 'player', 'guest']);

/** Case is kept for display; uniqueness is case-insensitive ("Zied" and "zied" are the same name). */
export const usernameKey = (name) => name.toLowerCase();

/** Returns the error code for an invalid username, or null. */
export function usernameError(name) {
  if (typeof name !== 'string' || !USERNAME_RE.test(name)) return 'username';
  if (RESERVED.has(usernameKey(name))) return 'taken';
  return null;
}

export function passwordError(password, username) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return 'password';
  if (username && password.toLowerCase() === username.toLowerCase()) return 'password-name';
  return null;
}

// scrypt is memory-hard: each guess costs ~64 MB and tens of ms, so a leaked hash list
// cannot be brute-forced cheaply. Parameters are stored with the hash so they can be raised later.
const scryptRaw = promisify(crypto.scrypt);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const KEY_LEN = 32;
/** Each hash holds ~32 MB; a burst of logins queues instead of exhausting the machine's memory. */
const MAX_PARALLEL_HASHES = 4;
let hashing = 0;
const hashQueue = [];
async function scrypt(...args) {
  // A finishing hash hands its slot straight to the next waiter.
  if (hashing >= MAX_PARALLEL_HASHES) await new Promise((r) => hashQueue.push(r));
  else hashing++;
  try {
    return await scryptRaw(...args);
  } finally {
    const next = hashQueue.shift();
    if (next) next();
    else hashing--;
  }
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Constant-time check. With no stored hash it still burns the same work (no user-exists timing leak). */
export async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored ?? DUMMY_HASH).split('$');
  if (alg !== 'scrypt' || typeof password !== 'string' || password.length > PASSWORD_MAX) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return stored != null && crypto.timingSafeEqual(key, expected);
}
const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${crypto.randomBytes(16).toString('base64')}$${crypto.randomBytes(KEY_LEN).toString('base64')}`;
