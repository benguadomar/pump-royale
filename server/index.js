import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const DIST = path.join(__dirname, '..', 'dist');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'players.json');

const MAX_CHAT_HISTORY = 50;
const MAX_FEED_HISTORY = 12;
const MAX_MSG_LEN = 160;
const MAX_NAME_LEN = 16;
const CHAT_COOLDOWN_MS = 700;

/** @type {Record<string, {name: string, towers: number, cards: number, wins: number, losses: number}>} */
let players = {};
try {
  players = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch {
  players = {};
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFile(DB_FILE, JSON.stringify(players), () => {});
  }, 1000);
}

const chatHistory = [];
const feedHistory = [];

const cleanName = (s) =>
  String(s ?? '')
    .replace(/[^\p{L}\p{N}_\- .]/gu, '')
    .trim()
    .slice(0, MAX_NAME_LEN) || 'Player';
const cleanText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_MSG_LEN);
const cleanId = (s) => String(s ?? '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);

function leaderboard() {
  const rows = Object.values(players);
  const top = (key) =>
    rows
      .filter((p) => p[key] > 0)
      .sort((a, b) => b[key] - a[key])
      .slice(0, 10)
      .map((p) => ({ name: p.name, value: p[key] }));
  return { towers: top('towers'), cards: top('cards') };
}

// ---------- HTTP (serves the built client in production) ----------
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.normalize(path.join(DIST, urlPath));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end('Run `npm run build` first, or use `npm run dev`.');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });

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
      const known = Boolean(players[id]);
      players[id] ??= { name, towers: 0, cards: 0, wins: 0, losses: 0 };
      players[id].name = name;
      scheduleSave();

      const alreadyConnected = [...wss.clients].some((c) => c !== ws && c.player?.id === id);
      ws.player = { id, name };
      send(ws, {
        t: 'welcome',
        online: onlineCount(),
        chat: chatHistory,
        feed: feedHistory,
        leaderboard: leaderboard(),
      });
      if (!alreadyConnected) {
        pushFeed({ kind: known ? 'back' : 'join', name });
        broadcast({ t: 'online', count: onlineCount() });
      }
      return;
    }

    const player = ws.player;
    if (!player) return;

    if (msg.t === 'chat') {
      const text = cleanText(msg.text);
      const now = Date.now();
      if (!text || now - ws.lastChat < CHAT_COOLDOWN_MS) return;
      ws.lastChat = now;
      const entry = { name: player.name, text, ts: now };
      chatHistory.push(entry);
      if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();
      broadcast({ t: 'chat', msg: entry });
      return;
    }

    if (msg.t === 'rename') {
      const name = cleanName(msg.name);
      player.name = name;
      if (players[player.id]) players[player.id].name = name;
      scheduleSave();
      broadcast({ t: 'leaderboard', ...leaderboard() });
      return;
    }

    if (msg.t === 'match') {
      const p = players[player.id];
      if (!p) return;
      const towers = Math.max(0, Math.min(3, Number(msg.towers) | 0));
      const cards = Math.max(0, Math.min(200, Number(msg.cards) | 0));
      p.towers += towers;
      p.cards += cards;
      if (msg.result === 'win') p.wins++;
      if (msg.result === 'loss') p.losses++;
      scheduleSave();
      pushFeed({ kind: 'match', name: player.name, result: msg.result, crowns: towers });
      broadcast({ t: 'leaderboard', ...leaderboard() });
    }
  });

  ws.on('close', () => {
    if (ws.player) broadcast({ t: 'online', count: onlineCount() });
  });
});

server.listen(PORT, () => {
  console.log(`Pump Royale server on http://localhost:${PORT}`);
});
