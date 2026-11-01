import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Store } from './db.js';
import { Matchmaker } from './rooms.js';
import { Economy } from './economy.js';
import { Accounts } from './accounts.js';
import { Clans } from './clans.js';
import { log, captureError, sentryEnabled } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const DIST = path.join(__dirname, '..', 'dist');
const BOOTED = Date.now();

const MAX_FEED_HISTORY = 12;
const MAX_MSG_LEN = 160;
const MAX_NAME_LEN = 16;
const CHAT_COOLDOWN_MS = 700;
const MAX_BODY = 8 * 1024;
/** Per-connection token bucket: sustained 30 msg/s, bursts of 60; persistent flooding disconnects. */
const BUCKET_SIZE = 60;
const BUCKET_REFILL_PER_S = 30;
const MAX_STRIKES = 300;

// After an uncaught exception the process state is unknown: report it, then exit so Fly restarts us.
process.on('uncaughtException', (e) => {
  captureError(e, { extra: { kind: 'uncaughtException' } });
  setTimeout(() => process.exit(1), 500).unref();
});
process.on('unhandledRejection', (e) => captureError(e, { extra: { kind: 'unhandledRejection' } }));

const store = new Store();
await store.init();
store.logBoot();
const economy = new Economy(store);
const accounts = new Accounts(store);

const feedHistory = [];
/** account id -> open sockets (a player can have several tabs). */
const sockets = new Map();

const cleanName = (s) =>
  String(s ?? '')
    .replace(/[^\p{L}\p{N}_\- .]/gu, '')
    .trim()
    .slice(0, MAX_NAME_LEN) || 'Player';
const cleanText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_MSG_LEN);
const cleanCountry = (s) => (/^[A-Z]{2}$/.test(String(s ?? '')) ? s : null);

const clans = new Clans(store, economy, {
  notify: (ids, msg) => ids.forEach((id) => sockets.get(id)?.forEach((ws) => send(ws, msg))),
  isOnline: (id) => Boolean(sockets.get(id)?.size),
  nameOf: (id) => store.get(id)?.name ?? 'Player',
});

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
const originOf = (req) => process.env.PUBLIC_URL ?? `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** Tiny per-IP limiter for the HTTP API (magic links, client error reports). */
const httpHits = new Map();
function httpLimited(req, max) {
  const ip = req.headers['fly-client-ip'] ?? req.socket.remoteAddress;
  const now = Date.now();
  const hit = httpHits.get(ip) ?? { n: 0, since: now };
  if (now - hit.since > 60000) Object.assign(hit, { n: 0, since: now });
  hit.n++;
  httpHits.set(ip, hit);
  if (httpHits.size > 5000) httpHits.clear();
  return hit.n > max;
}

async function api(req, res, urlPath, query) {
  if (urlPath === '/api/auth/email' && req.method === 'POST') {
    if (httpLimited(req, 5)) return json(res, 429, { error: 'rate' });
    const body = await readBody(req);
    const out = await accounts.requestEmail(body.email, body.token, originOf(req));
    return json(res, out.error ? 400 : 200, out);
  }
  if (urlPath === '/api/auth/verify') {
    const session = accounts.verifyEmail(String(query.get('t') ?? ''));
    res.writeHead(302, { Location: session ? `/?session=${encodeURIComponent(session.token)}&auth=email` : '/?auth=expired' }).end();
    return;
  }
  if (urlPath === '/api/client-error' && req.method === 'POST') {
    if (httpLimited(req, 20)) return json(res, 429, { error: 'rate' });
    const body = await readBody(req);
    const err = new Error(String(body.message ?? 'client error').slice(0, 300));
    const stack = String(body.stack ?? '').slice(0, 3000);
    err.name = stack.match(/^(\w*Error):/)?.[1] ?? 'Error';
    err.stack = `${err.message}\n${stack.split('\n').filter((l) => l.trim().startsWith('at ')).join('\n')}`;
    captureError(err, { source: 'client', extra: { url: String(body.url ?? '').slice(0, 200), ua: String(req.headers['user-agent'] ?? '').slice(0, 200) } });
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const urlPath = decodeURIComponent(url.pathname);
  if (urlPath === '/healthz') {
    store
      .healthy()
      .then((ok) => json(res, ok ? 200 : 503, { ok, storage: store.kind, uptime: Math.round((Date.now() - BOOTED) / 1000), online: onlineCount(), rooms: matchmaker.rooms.size, queue: matchmaker.queueSize(), sentry: sentryEnabled }));
    return;
  }
  if (urlPath.startsWith('/api/')) {
    api(req, res, urlPath, url.searchParams).catch((e) => {
      captureError(e, { extra: { path: urlPath } });
      json(res, 500, { error: 'server' });
    });
    return;
  }
  let file = path.normalize(path.join(DIST, urlPath));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  fs.stat(file, (err, stat) => {
    if (err) {
      res.writeHead(404).end('Run `npm run build` first, or use `npm run dev`.');
      return;
    }
    const hashed = file.includes(`${path.sep}assets${path.sep}index-`);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === c.OPEN && c.player) c.send(data);
}
function onlineCount() {
  return sockets.size;
}
function pushFeed(item) {
  const entry = { ...item, ts: Date.now() };
  feedHistory.push(entry);
  if (feedHistory.length > MAX_FEED_HISTORY) feedHistory.shift();
  broadcast({ t: 'feed', item: entry });
}
const leaderboard = () => ({ ...store.leaderboard(), clans: clans.leaderboard() });
const broadcastLeaderboard = () => broadcast({ t: 'leaderboard', ...leaderboard() });

const matchmaker = new Matchmaker({
  levelsFor: (id, deck) => economy.levelsFor(economy.profile(id), deck),
  trophiesOf: (id) => economy.profile(id).trophies,
  onMatchEnd(room) {
    economy
      .pvpEnd(room)
      .then((out) => out.forEach((o, team) => room.players[team].ws && send(room.players[team].ws, { t: 'reward', ...o, signed: room.signed })))
      .catch((e) => captureError(e, { extra: { room: room.id } }));
    const results = [0, 1].map((team) => room.sim.result(team));
    if (room.mode !== 'friendly') {
      room.players.forEach((p, team) => {
        const r = results[team];
        store.recordMatch(p.id, { result: r.result, towers: r.myCrowns, cards: r.cardsPlayed, pvp: true });
      });
    }
    const winner = room.sim.winner;
    if (winner != null) {
      pushFeed({ kind: 'pvp', mode: room.mode, name: room.players[winner].name, country: room.players[winner].country, opp: room.players[1 - winner].name, crowns: `${results[winner].myCrowns}-${results[winner].enemyCrowns}` });
    }
    broadcastLeaderboard();
  },
});

function attach(ws, id) {
  if (!sockets.has(id)) sockets.set(id, new Set());
  sockets.get(id).add(ws);
}
function detach(ws) {
  const id = ws.player?.id;
  const set = id && sockets.get(id);
  if (!set) return;
  set.delete(ws);
  if (!set.size) sockets.delete(id);
}

/** Token bucket per connection; returns false when the message must be dropped. */
function allow(ws) {
  const now = performance.now();
  ws.tokens = Math.min(BUCKET_SIZE, ws.tokens + ((now - ws.refilled) / 1000) * BUCKET_REFILL_PER_S);
  ws.refilled = now;
  if (ws.tokens >= 1) {
    ws.tokens -= 1;
    return true;
  }
  if (++ws.strikes > MAX_STRIKES && !ws.flooded) {
    ws.flooded = true;
    log.warn('flood disconnect', { player: ws.player?.id });
    ws.close(1008, 'rate limit');
  }
  return false;
}

function hello(ws, msg) {
  const out = accounts.resolve({ token: msg.token, id: msg.id });
  if (out.error) return send(ws, { t: 'auth-required' });
  const id = out.account.id;
  const name = cleanName(store.get(id)?.name ?? msg.name);
  const country = cleanCountry(msg.country);
  const known = store.has(id);
  store.upsert(id, known ? name : cleanName(msg.name), country);
  const alreadyConnected = sockets.has(id);
  detach(ws);
  ws.player = { id, name: store.get(id).name, country };
  attach(ws, id);
  send(ws, { t: 'session', token: out.token, account: accounts.view(out.account), name: ws.player.name });
  send(ws, { t: 'profile', profile: economy.profile(id) });
  const clan = clans.clanOf(id);
  send(ws, { t: 'clan', clan: clan ? clans.view(clan, id) : null });
  send(ws, { t: 'welcome', online: onlineCount(), chat: store.chat, feed: feedHistory, leaderboard: leaderboard(), storage: store.kind });
  if (!alreadyConnected) {
    pushFeed({ kind: known ? 'back' : 'join', name: ws.player.name, country });
    broadcast({ t: 'online', count: onlineCount() });
    if (clan) clans.broadcast(clan);
  }
}

const reply = (ws, op, out) => send(ws, { t: 'econ', op, ...out });

function handle(ws, msg) {
  if (msg.t === 'ping') return send(ws, { t: 'pong', ts: msg.ts });
  if (msg.t === 'hello') return hello(ws, msg);

  const player = ws.player;
  if (!player) return;
  const room = matchmaker.roomOf(ws);
  const id = player.id;

  switch (msg.t) {
    case 'chat': {
      const text = cleanText(msg.text);
      const now = Date.now();
      if (!text || now - ws.lastChat < CHAT_COOLDOWN_MS) return;
      ws.lastChat = now;
      const entry = { name: player.name, country: player.country, text, ts: now };
      store.addChat(entry);
      broadcast({ t: 'chat', msg: entry });
      return;
    }
    case 'rename': {
      player.name = cleanName(msg.name);
      store.upsert(id, player.name, player.country);
      broadcastLeaderboard();
      return;
    }

    // ---- accounts
    case 'wallet-challenge':
      return send(ws, { t: 'wallet-challenge', ...accounts.challenge() });
    case 'wallet-login': {
      const out = accounts.walletLogin(id, msg);
      return send(ws, out.error ? { t: 'session', error: out.error } : { t: 'session', ...out, switched: out.account.id !== id });
    }

    // ---- AI matches + economy
    case 'ai-start': {
      const m = economy.aiStart(id, msg.deck);
      if (m.error) return reply(ws, 'ai-start', { error: m.error });
      return send(ws, {
        t: 'ai-match',
        matchId: m.matchId,
        seed: m.seed,
        decks: m.decks,
        levels: m.levels,
        cardLevels: m.cardLevels,
        oppName: m.oppName,
        arenaId: m.arenaId,
        aiTier: m.aiTier,
      });
    }
    case 'ai-end':
      // The server re-simulates the match from its seed + the recorded plays before rewarding.
      economy.aiEnd(id, String(msg.matchId ?? ''), msg.inputs).then((out) => {
        if (out.error) return reply(ws, 'ai-end', { error: out.error });
        const r = out.result;
        store.recordMatch(id, { result: r.result, towers: r.myCrowns, cards: r.cardsPlayed, pvp: false });
        pushFeed({ kind: 'match', name: player.name, country: player.country, result: r.result, crowns: r.myCrowns });
        broadcastLeaderboard();
        send(ws, { t: 'reward', ...out });
      });
      return;
    case 'chest-start':
      return reply(ws, msg.t, economy.chestStart(id, Number(msg.slot) | 0));
    case 'chest-open':
      return reply(ws, msg.t, economy.chestOpen(id, Number(msg.slot) | 0, Boolean(msg.gems)));
    case 'upgrade':
      return reply(ws, msg.t, economy.upgrade(id, String(msg.card ?? '')));
    case 'quest-claim':
      return reply(ws, msg.t, economy.claimQuest(id, Number(msg.i) | 0));
    case 'pass-claim':
      return reply(ws, msg.t, economy.claimPass(id, msg.tier));
    case 'road-claim':
      return reply(ws, msg.t, economy.claimRoad(id, msg.at));

    // ---- replays + spectating
    case 'replays':
      store.listReplays(id).then((list) => send(ws, { t: 'replays', list }));
      return;
    case 'replay':
      if (msg.public) return send(ws, { t: 'replay', replay: store.publicReplay(String(msg.id ?? '')) });
      store.getReplay(id, String(msg.id ?? '')).then((replay) => send(ws, { t: 'replay', replay }));
      return;
    case 'tv':
      return send(ws, { t: 'tv', live: matchmaker.liveList(), replays: store.publicReplays() });
    case 'spectate':
      return reply(ws, 'spectate', matchmaker.spectate(ws, msg.room));
    case 'spectate-leave':
      return matchmaker.stopSpectating(ws);

    // ---- online matches
    case 'queue-join':
      return matchmaker.join(ws, msg.deck);
    case 'queue-leave':
      return matchmaker.leave(ws);
    case 'friendly-create':
      return reply(ws, 'friendly-create', matchmaker.friendlyCreate(ws, msg.deck));
    case 'friendly-join':
      return reply(ws, 'friendly-join', matchmaker.friendlyJoin(ws, msg.code, msg.deck));
    case 'friendly-cancel':
      return matchmaker.leave(ws);
    case 'rematch':
      return reply(ws, 'rematch', matchmaker.rematch(ws, msg.room, msg.deck));
    case 'play':
      return room?.play(ws, msg);
    case 'resync':
      return (room ?? ws.watching)?.resync(ws);
    case 'forfeit':
      return room?.forfeit(ws);
    case 'emote':
      return room?.emote(ws, msg.id);
    case 'gchat': {
      const text = cleanText(msg.text);
      const now = Date.now();
      if (!room || !text || now - ws.lastChat < CHAT_COOLDOWN_MS) return;
      ws.lastChat = now;
      return room.chat(ws, text);
    }

    // ---- clans
    case 'clan-list':
      return send(ws, { t: 'clan-list', list: clans.list(msg.q) });
    case 'clan-create':
      return reply(ws, msg.t, clans.create(id, msg));
    case 'clan-join':
      return reply(ws, msg.t, clans.join(id, msg.id));
    case 'clan-leave':
      return reply(ws, msg.t, clans.leave(id));
    case 'clan-chat': {
      const text = cleanText(msg.text);
      const now = Date.now();
      if (!text || now - ws.lastChat < CHAT_COOLDOWN_MS) return;
      ws.lastChat = now;
      return clans.chat(id, text);
    }
    case 'clan-request':
      return reply(ws, msg.t, clans.request(id, String(msg.card ?? '')));
    case 'clan-donate':
      return reply(ws, msg.t, clans.donate(id, String(msg.request ?? '')));
  }
}

wss.on('connection', (ws) => {
  ws.lastChat = 0;
  ws.tokens = BUCKET_SIZE;
  ws.refilled = performance.now();
  ws.strikes = 0;

  ws.on('message', (raw) => {
    if (!allow(ws)) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      handle(ws, msg);
    } catch (e) {
      captureError(e, { user: ws.player?.id, extra: { msg: msg.t } });
    }
  });

  ws.on('close', () => {
    matchmaker.disconnected(ws);
    const id = ws.player?.id;
    detach(ws);
    if (id && !sockets.has(id)) {
      broadcast({ t: 'online', count: onlineCount() });
      const clan = clans.clanOf(id);
      if (clan) clans.broadcast(clan);
    }
  });
});

server.listen(PORT, () => log.info('server listening', { port: PORT, storage: store.kind, sentry: sentryEnabled }));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log.info('shutting down', { signal: sig });
    wss.clients.forEach((c) => c.close(1012, 'server restarting'));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
