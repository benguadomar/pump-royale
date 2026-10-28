import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Store } from './db.js';
import { Matchmaker } from './rooms.js';
import { Economy } from './economy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const DIST = path.join(__dirname, '..', 'dist');

const MAX_FEED_HISTORY = 12;
const MAX_MSG_LEN = 160;
const MAX_NAME_LEN = 16;
const CHAT_COOLDOWN_MS = 700;

const store = new Store();
await store.init();
const economy = new Economy(store);

const feedHistory = [];

const cleanName = (s) =>
  String(s ?? '')
    .replace(/[^\p{L}\p{N}_\- .]/gu, '')
    .trim()
    .slice(0, MAX_NAME_LEN) || 'Player';
const cleanText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_MSG_LEN);
const cleanId = (s) => String(s ?? '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
const cleanCountry = (s) => (/^[A-Z]{2}$/.test(String(s ?? '')) ? s : null);

// ---------- HTTP (serves the built client in production) ----------
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

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
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
  const ids = new Set();
  for (const c of wss.clients) if (c.player) ids.add(c.player.id);
  return ids.size;
}
function pushFeed(item) {
  const entry = { ...item, ts: Date.now() };
  feedHistory.push(entry);
  if (feedHistory.length > MAX_FEED_HISTORY) feedHistory.shift();
  broadcast({ t: 'feed', item: entry });
}
const broadcastLeaderboard = () => broadcast({ t: 'leaderboard', ...store.leaderboard() });

const matchmaker = new Matchmaker({
  levelsFor: (id, deck) => economy.levelsFor(economy.profile(id), deck),
  onMatchEnd(room) {
    economy
      .pvpEnd(room)
      .then((out) => out.forEach((o, team) => room.players[team].ws && send(room.players[team].ws, { t: 'reward', ...o })))
      .catch((e) => console.error('pvp rewards', e));
    const results = [0, 1].map((team) => room.sim.result(team));
    room.players.forEach((p, team) => {
      const r = results[team];
      store.recordMatch(p.id, { result: r.result, towers: r.myCrowns, cards: r.cardsPlayed, pvp: true });
    });
    const winner = room.sim.winner;
    if (winner != null) {
      pushFeed({ kind: 'pvp', name: room.players[winner].name, country: room.players[winner].country, opp: room.players[1 - winner].name, crowns: `${results[winner].myCrowns}-${results[winner].enemyCrowns}` });
    }
    broadcastLeaderboard();
  },
});

wss.on('connection', (ws) => {
  ws.lastChat = 0;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.t === 'ping') {
      send(ws, { t: 'pong', ts: msg.ts });
      return;
    }

    if (msg.t === 'hello') {
      const id = cleanId(msg.id);
      if (!id) return;
      const name = cleanName(msg.name);
      const country = cleanCountry(msg.country);
      const known = store.has(id);
      store.upsert(id, name, country);
      const alreadyConnected = [...wss.clients].some((c) => c !== ws && c.player?.id === id);
      ws.player = { id, name, country };
      send(ws, { t: 'profile', profile: economy.profile(id) });
      send(ws, {
        t: 'welcome',
        online: onlineCount(),
        chat: store.chat,
        feed: feedHistory,
        leaderboard: store.leaderboard(),
        storage: store.kind,
      });
      if (!alreadyConnected) {
        pushFeed({ kind: known ? 'back' : 'join', name, country });
        broadcast({ t: 'online', count: onlineCount() });
      }
      return;
    }

    const player = ws.player;
    if (!player) return;
    const room = matchmaker.roomOf(ws);

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
        store.upsert(player.id, player.name, player.country);
        broadcastLeaderboard();
        return;
      }
      case 'ai-start': {
        const m = economy.aiStart(player.id, msg.deck);
        if (m.error) return send(ws, { t: 'econ', op: 'ai-start', error: m.error });
        send(ws, { t: 'ai-match', matchId: m.matchId, seed: m.seed, decks: m.decks, levels: m.levels, cardLevels: m.cardLevels, oppName: m.oppName });
        return;
      }
      case 'ai-end': {
        // The server re-simulates the match from its seed + the recorded plays before rewarding.
        economy.aiEnd(player.id, String(msg.matchId ?? ''), msg.inputs).then((out) => {
          if (out.error) return send(ws, { t: 'econ', op: 'ai-end', error: out.error });
          const r = out.result;
          store.recordMatch(player.id, { result: r.result, towers: r.myCrowns, cards: r.cardsPlayed, pvp: false });
          pushFeed({ kind: 'match', name: player.name, country: player.country, result: r.result, crowns: r.myCrowns });
          broadcastLeaderboard();
          send(ws, { t: 'reward', ...out });
        });
        return;
      }
      case 'chest-start':
      case 'chest-open':
      case 'upgrade':
      case 'quest-claim':
      case 'pass-claim':
      case 'road-claim': {
        const ops = {
          'chest-start': () => economy.chestStart(player.id, Number(msg.slot) | 0),
          'chest-open': () => economy.chestOpen(player.id, Number(msg.slot) | 0, Boolean(msg.gems)),
          upgrade: () => economy.upgrade(player.id, String(msg.card ?? '')),
          'quest-claim': () => economy.claimQuest(player.id, Number(msg.i) | 0),
          'pass-claim': () => economy.claimPass(player.id, msg.tier),
          'road-claim': () => economy.claimRoad(player.id, msg.at),
        };
        const out = ops[msg.t]();
        send(ws, { t: 'econ', op: msg.t, ...out });
        return;
      }
      case 'replays':
        economy.store.listReplays(player.id).then((list) => send(ws, { t: 'replays', list }));
        return;
      case 'replay':
        economy.store.getReplay(player.id, String(msg.id ?? '')).then((replay) => send(ws, { t: 'replay', replay }));
        return;
      case 'queue-join':
        matchmaker.join(ws, msg.deck);
        return;
      case 'queue-leave':
        matchmaker.leave(ws);
        return;
      case 'play':
        room?.play(ws, msg);
        return;
      case 'forfeit':
        room?.forfeit(ws);
        return;
      case 'emote':
        room?.emote(ws, msg.id);
        return;
      case 'gchat': {
        const text = cleanText(msg.text);
        const now = Date.now();
        if (!room || !text || now - ws.lastChat < CHAT_COOLDOWN_MS) return;
        ws.lastChat = now;
        room.chat(ws, text);
        return;
      }
    }
  });

  ws.on('close', () => {
    matchmaker.disconnected(ws);
    if (ws.player) broadcast({ t: 'online', count: onlineCount() });
  });
});

server.listen(PORT, () => {
  console.log(`Pump Royale server on http://localhost:${PORT}`);
});
