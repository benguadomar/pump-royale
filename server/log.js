import os from 'node:os';
import crypto from 'node:crypto';

const PROD = process.env.NODE_ENV === 'production';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[process.env.LOG_LEVEL] ?? (PROD ? LEVELS.info : LEVELS.debug);

/**
 * Structured logs: one JSON object per line in production (Fly ships stdout to its log
 * pipeline), short readable lines in development.
 */
function write(level, msg, fields = {}) {
  if (LEVELS[level] < MIN) return;
  if (PROD) {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })}\n`);
    return;
  }
  const extra = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
  (level === 'error' ? console.error : console.log)(`[${level}] ${msg}${extra}`);
}

export const log = {
  debug: (msg, f) => write('debug', msg, f),
  info: (msg, f) => write('info', msg, f),
  warn: (msg, f) => write('warn', msg, f),
  error: (msg, f) => write('error', msg, f),
};

// ------------------------------------------------------------------ Sentry (optional)

/** Parses https://<key>@<host>/<project> into the envelope endpoint + auth header. */
function parseDsn(dsn) {
  try {
    const u = new URL(dsn);
    const project = u.pathname.replace(/^\//, '');
    return { url: `${u.protocol}//${u.host}/api/${project}/envelope/`, key: u.username, dsn };
  } catch {
    return null;
  }
}
const sentry = process.env.SENTRY_DSN ? parseDsn(process.env.SENTRY_DSN) : null;
const RELEASE = process.env.FLY_IMAGE_REF ?? process.env.RELEASE ?? 'dev';

function parseStack(stack = '') {
  return stack
    .split('\n')
    .slice(1)
    .map((line) => {
      const m = line.match(/at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
      return m ? { function: m[1] ?? '?', filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) } : null;
    })
    .filter(Boolean)
    .reverse();
}

/**
 * Reports an error to Sentry (when SENTRY_DSN is set) via the plain envelope API, so the
 * server needs no SDK. `source` is 'server' or 'client' (browser errors relayed by /api/client-error).
 */
export function captureError(err, { source = 'server', extra = {}, user } = {}) {
  const e = err instanceof Error ? err : new Error(String(err?.message ?? err));
  log.error(e.message, { source, stack: e.stack?.split('\n').slice(0, 4).join(' | '), ...extra });
  if (!sentry) return;
  const event = {
    event_id: crypto.randomUUID().replace(/-/g, ''),
    timestamp: Date.now() / 1000,
    platform: source === 'client' ? 'javascript' : 'node',
    level: 'error',
    release: RELEASE,
    environment: PROD ? 'production' : 'development',
    server_name: os.hostname(),
    tags: { source },
    user: user ? { id: user } : undefined,
    extra,
    exception: { values: [{ type: e.name, value: e.message, stacktrace: { frames: parseStack(e.stack) } }] },
  };
  const body = `${JSON.stringify({ event_id: event.event_id, dsn: sentry.dsn, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
  fetch(sentry.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-sentry-envelope',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${sentry.key}, sentry_client=pump-royale/1.0`,
    },
    body,
  }).catch(() => {});
}

export const sentryEnabled = Boolean(sentry);
