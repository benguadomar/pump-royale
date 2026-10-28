import { state } from './state.js';

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
  leaderboard: { towers: [], cards: [], wins: [] },
  /** Server-owned progression (trophies, currencies, cards, chests...). Read-only here. */
  profile: null,

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
};

function emit(type, data) {
  for (const fn of handlers[type] ?? []) fn(data);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    net.connected = true;
    net.send({ t: 'hello', id: state.id, name: state.name, country: state.country });
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
      case 'pong':
        net.ping = Math.round(performance.now() - msg.ts);
        emit('status');
        break;
      case 'welcome':
        net.online = msg.online;
        net.chat = msg.chat;
        net.feed = msg.feed;
        net.leaderboard = { wins: [], ...msg.leaderboard };
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
        net.leaderboard = { towers: msg.towers, cards: msg.cards, wins: msg.wins ?? [] };
        emit('leaderboard');
        break;
      default:
        // Match traffic: snap, play-fail, match-found, match-end, queue, gchat, opp-status.
        emit(msg.t, msg);
    }
  };
}

function sendPing() {
  net.send({ t: 'ping', ts: performance.now() });
}
