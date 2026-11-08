import { state, save, countryHints } from './state.js';

/**
 * Game server origin when the page is hosted somewhere else (e.g. Netlify): set VITE_SERVER_URL
 * at build time. Empty means the page and the server share one origin.
 */
const SERVER = (import.meta.env.VITE_SERVER_URL ?? '').replace(/\/$/, '');
export const apiUrl = (path) => `${SERVER}${path}`;
/** ngrok's free tier answers browser requests with a warning page unless this header is sent. */
export const apiHeaders = SERVER ? { 'ngrok-skip-browser-warning': '1' } : {};

const PING_INTERVAL_MS = 2000;
const RECONNECT_MS = 3000;

const handlers = {};
let ws = null;
let pingTimer = null;

export const net = {
  connected: false,
  ping: null,
  online: 0,
  chat: [],
  feed: [],
  leaderboard: { towers: [], cards: [], wins: [], trophies: [] },

  /** Ladder title: a player's place (1–100) on the trophy board, or null. Usernames are unique. */
  rankOf(name) {
    const i = this.leaderboard.trophies?.findIndex((r) => r.name === name) ?? -1;
    return i < 0 ? null : i + 1;
  },
  /** Server-owned progression (trophies, currencies, cards, chests...). Read-only here. */
  profile: null,
  /** { id, username, guest } once the server accepted our session; guests must log in to play. */
  account: null,
  clan: null,

  on(type, fn) {
    (handlers[type] ??= new Set()).add(fn);
    return () => handlers[type].delete(fn);
  },

  send(msg) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  },

  /** Sends `msg` and resolves with the next `replyType` message (matching `op` if given), or null. */
  request(msg, replyType, { timeout = 8000, op } = {}) {
    return new Promise((resolve) => {
      if (!this.connected) return resolve(null);
      const timer = setTimeout(() => (off(), resolve(null)), timeout);
      const off = this.on(replyType, (m) => {
        if (op && m.op !== op) return;
        clearTimeout(timer);
        off();
        resolve(m);
      });
      this.send(msg);
    });
  },

  sendChat(text) {
    this.send({ t: 'chat', text });
  },

  connect,
  /** Re-introduces this connection after the session token changed (log in / sign up). */
  hello,
};

function hello() {
  net.send({ t: 'hello', token: state.token, id: state.id, country: state.country, tzCountry: countryHints.tz, langCountry: countryHints.lang });
}

function emit(type, data) {
  for (const fn of handlers[type] ?? []) fn(data);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(SERVER ? `${SERVER.replace(/^http/, 'ws')}/ws` : `${proto}://${location.host}/ws`);

  ws.onopen = () => {
    net.connected = true;
    hello();
    sendPing();
    clearInterval(pingTimer);
    pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
    emit('status');
  };

  ws.onclose = () => {
    net.connected = false;
    net.ping = null;
    clearInterval(pingTimer);
    emit('status');
    setTimeout(connect, RECONNECT_MS);
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.profile) {
      net.profile = msg.profile;
      emit('profile', msg.profile);
    }
    switch (msg.t) {
      case 'session':
        if (msg.error) {
          emit('session', msg);
          break;
        }
        adoptSession(msg);
        break;
      case 'auth-required':
        // Our token is gone but the id is protected: start over as a fresh guest.
        state.id = crypto.randomUUID();
        state.token = null;
        save();
        ws.close();
        break;
      case 'clan':
        net.clan = msg.clan;
        emit('clan', msg.clan);
        break;
      case 'pong':
        net.ping = Math.round(performance.now() - msg.ts);
        emit('status');
        break;
      case 'welcome':
        net.online = msg.online;
        net.chat = msg.chat;
        net.feed = msg.feed;
        net.leaderboard = { wins: [], trophies: [], clans: [], ...msg.leaderboard };
        emit('welcome');
        emit('status');
        emit('leaderboard');
        break;
      case 'online':
        net.online = msg.count;
        emit('status');
        break;
      case 'chat':
        net.chat.push(msg.msg);
        if (net.chat.length > 50) net.chat.shift();
        emit('chat', msg.msg);
        break;
      case 'feed':
        net.feed.push(msg.item);
        if (net.feed.length > 12) net.feed.shift();
        emit('feed', msg.item);
        break;
      case 'leaderboard':
        net.leaderboard = { towers: msg.towers, cards: msg.cards, wins: msg.wins ?? [], trophies: msg.trophies ?? [], clans: msg.clans ?? [] };
        emit('leaderboard');
        break;
      default:
        // Match traffic: snap, play-fail, match-found, match-end, queue, gchat, opp-status.
        emit(msg.t, msg);
    }
  };
}

/** Stores the server's session; signing into another account reloads into it. */
function adoptSession(msg) {
  const switched = state.id && state.id !== msg.account.id;
  state.token = msg.token;
  state.id = msg.account.id;
  if (msg.account.username) state.name = msg.account.username;
  if (msg.country) state.country = msg.country;
  save();
  net.account = msg.account;
  emit('session', msg);
  if (switched) location.reload();
}

function sendPing() {
  net.send({ t: 'ping', ts: performance.now() });
}
