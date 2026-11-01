import { log } from './log.js';

const PROD = process.env.NODE_ENV === 'production';
// Local dev and the test bots hammer the server from one address; production gets the real limits.
const SCALE = PROD ? 1 : 20;

/** Per-IP sliding windows: [max requests, window ms]. */
const LIMITS = {
  login: [10, 60_000],
  register: [5, 3_600_000],
  check: [40, 60_000],
  api: [60, 60_000],
  ws: [20, 60_000],
};
const MAX_SOCKETS_PER_IP = 12 * SCALE;
/** Wrong passwords on one username before it is locked (stops slow, distributed guessing). */
const LOGIN_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;
/** Strikes (blocked requests, wrong passwords, floods) before an IP is banned outright. */
const STRIKES_TO_BAN = 30;
const STRIKE_WINDOW_MS = 10 * 60_000;
const BAN_MS = 60 * 60_000;
const MAX_TRACKED = 20_000;

const hits = new Map(); // `${action}|${ip}` -> timestamps
const strikes = new Map(); // ip -> timestamps
const bans = new Map(); // ip -> until
const loginFails = new Map(); // username key -> { times, lockedUntil }
const sockets = new Map(); // ip -> open count

const recent = (list, windowMs, now) => {
  while (list.length && now - list[0] > windowMs) list.shift();
  return list;
};

/** The caller's address. Fly's edge sets Fly-Client-IP; elsewhere trust only the socket. */
export function ipOf(req) {
  const fly = req.headers['fly-client-ip'];
  return (typeof fly === 'string' && fly) || req.socket.remoteAddress || 'unknown';
}

export function banned(ip) {
  const until = bans.get(ip);
  if (!until) return false;
  if (until > Date.now()) return true;
  bans.delete(ip);
  return false;
}

export function strike(ip, reason) {
  const now = Date.now();
  const list = recent(strikes.get(ip) ?? [], STRIKE_WINDOW_MS, now);
  list.push(now);
  strikes.set(ip, list);
  if (list.length >= STRIKES_TO_BAN * SCALE && !banned(ip)) {
    bans.set(ip, now + BAN_MS);
    strikes.delete(ip);
    log.warn('firewall ban', { ip, reason, minutes: BAN_MS / 60_000 });
  }
}

/** True when `ip` may perform `action` now; over the limit counts as a strike. */
export function allow(ip, action) {
  if (banned(ip)) return false;
  const [max, windowMs] = LIMITS[action];
  const key = `${action}|${ip}`;
  const now = Date.now();
  const list = recent(hits.get(key) ?? [], windowMs, now);
  if (list.length >= max * SCALE) {
    strike(ip, `rate:${action}`);
    return false;
  }
  list.push(now);
  hits.set(key, list);
  return true;
}

// ------------------------------------------------------------------ login lockout

export function loginLocked(key) {
  const f = loginFails.get(key);
  return Boolean(f && f.lockedUntil > Date.now());
}

export function loginFailed(key, ip) {
  const now = Date.now();
  const f = loginFails.get(key) ?? { times: [], lockedUntil: 0 };
  recent(f.times, LOGIN_WINDOW_MS, now).push(now);
  if (f.times.length >= LOGIN_FAILS) {
    f.lockedUntil = now + LOCK_MS;
    f.times = [];
    log.warn('login locked', { user: key, ip });
  }
  loginFails.set(key, f);
  strike(ip, 'password');
}

export const loginSucceeded = (key) => loginFails.delete(key);

// ------------------------------------------------------------------ websockets

/** Admits a new socket for `ip` (connection rate + concurrent cap); call `release` on close. */
export function admitSocket(ip) {
  if (!allow(ip, 'ws')) return false;
  const open = sockets.get(ip) ?? 0;
  if (open >= MAX_SOCKETS_PER_IP) {
    strike(ip, 'sockets');
    return false;
  }
  sockets.set(ip, open + 1);
  return true;
}

export function releaseSocket(ip) {
  const open = (sockets.get(ip) ?? 1) - 1;
  if (open > 0) sockets.set(ip, open);
  else sockets.delete(ip);
}

// ------------------------------------------------------------------ HTTP

/**
 * State-changing API calls must be JSON from our own origin: a third-party page cannot make a
 * visitor's browser register or log in (CSRF). Non-browser clients send no Origin header.
 */
export function trustedPost(req) {
  if (req.method !== 'POST') return false;
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    const allowed = [req.headers.host, req.headers['x-forwarded-host'], process.env.PUBLIC_URL && new URL(process.env.PUBLIC_URL).host];
    return allowed.includes(host);
  } catch {
    return false;
  }
}

const CSP = [
  "default-src 'self'",
  // The tower models' meshopt decoder is WebAssembly.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://flagcdn.com",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** Browser-side hardening on every response. */
export function secureHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

// Old entries are dropped so the tables cannot be grown into a memory attack.
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) if (!recent(list, 3_600_000, now).length) hits.delete(k);
  for (const [k, list] of strikes) if (!recent(list, STRIKE_WINDOW_MS, now).length) strikes.delete(k);
  for (const [k, until] of bans) if (until < now) bans.delete(k);
  for (const [k, f] of loginFails) if (f.lockedUntil < now && !recent(f.times, LOGIN_WINDOW_MS, now).length) loginFails.delete(k);
  if (hits.size > MAX_TRACKED) hits.clear();
  if (loginFails.size > MAX_TRACKED) loginFails.clear();
}, 60_000).unref();
