import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = path.join(__dirname, 'data', 'secret.key');
const SESSION_TTL_S = 180 * 24 * 3600;
const MAGIC_TTL_MS = 15 * 60 * 1000;
const NONCE_TTL_MS = 5 * 60 * 1000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') log.warn('JWT_SECRET is not set: sessions will not survive a redeploy');
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, s);
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

// ------------------------------------------------------------------ email magic links

const magic = new Map(); // token -> { email, linkTo, exp }

export const cleanEmail = (s) => {
  const e = String(s ?? '').trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
};

export function createMagicLink(email, linkTo) {
  for (const [k, v] of magic) if (v.exp < Date.now()) magic.delete(k);
  const token = crypto.randomBytes(24).toString('base64url');
  magic.set(token, { email, linkTo, exp: Date.now() + MAGIC_TTL_MS });
  return token;
}

/** One-time use. */
export function consumeMagicLink(token) {
  const m = magic.get(token);
  magic.delete(token);
  return m && m.exp > Date.now() ? m : null;
}

/** Sends through Resend when RESEND_API_KEY is set; otherwise logs the link (local dev). */
export async function sendMagicEmail(email, link) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    log.info('magic link (no RESEND_API_KEY, not emailed)', { email, link });
    return { sent: false };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM ?? 'Pump Royale <login@resend.dev>',
      to: email,
      subject: 'Your Pump Royale sign-in link',
      html: `<p>Tap to sign in to Pump Royale and keep your progress on every device:</p><p><a href="${link}">Sign in</a></p><p>This link expires in 15 minutes. If you did not ask for it, ignore this email.</p>`,
    }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
  return { sent: true };
}

// ------------------------------------------------------------------ Phantom (Solana) signature login

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Decode(s) {
  if (typeof s !== 'string' || !s || s.length > 128) return null;
  const bytes = [0];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const nonces = new Map(); // nonce -> exp

export function walletChallenge() {
  for (const [k, exp] of nonces) if (exp < Date.now()) nonces.delete(k);
  const nonce = crypto.randomBytes(16).toString('hex');
  nonces.set(nonce, Date.now() + NONCE_TTL_MS);
  return { nonce, message: `Sign in to Pump Royale\n\nThis only proves you own this wallet. It costs nothing and sends no transaction.\n\nNonce: ${nonce}` };
}

/** Verifies an ed25519 signature of the challenge message; the nonce is single-use. */
export function verifyWallet({ publicKey, signature, nonce, message }) {
  if (!nonces.has(nonce) || nonces.get(nonce) < Date.now()) return false;
  nonces.delete(nonce);
  if (typeof message !== 'string' || !message.endsWith(`Nonce: ${nonce}`)) return false;
  const pk = base58Decode(publicKey);
  const sig = Array.isArray(signature) ? Buffer.from(signature) : base58Decode(signature);
  if (!pk || pk.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pk]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}
