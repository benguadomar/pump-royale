import { BattleSim } from '../src/sim/sim.js';
import { encodeSnapshot } from '../src/sim/snapshot.js';
import { SIM_DT, ARENA_W, ARENA_H, mirrorX, mirrorY } from '../src/sim/constants.js';
import { CARD_BY_ID } from '../src/data/cards.js';

const SNAPSHOT_EVERY = 2; // ticks -> 15 Hz at a 30 Hz simulation
const RECONNECT_GRACE_MS = 12000;
const START_DELAY_MS = 2500;
const MAX_GAME_CHAT = 120;

const isValidDeck = (d) => Array.isArray(d) && d.length === 8 && new Set(d).size === 8 && d.every((id) => CARD_BY_ID[id]);

/**
 * One authoritative 1v1 match. Player 0 is canonical bottom; player 1 receives every
 * snapshot/event mirrored so both clients see themselves at the bottom, and their
 * inputs are mirrored back before reaching the simulation.
 */
class Room {
  constructor(id, players, hooks) {
    this.id = id;
    this.players = players; // [{ id, name, country, ws }]
    this.hooks = hooks;
    this.sim = new BattleSim(players.map((p) => p.deck));
    this.tick = 0;
    this.pending = [];
    this.ended = false;
    this.started = false;
    this.disconnectTimers = [null, null];

    players.forEach((p, team) => {
      const opp = players[1 - team];
      this.send(team, { t: 'match-found', room: id, team, opp: { name: opp.name, country: opp.country }, startsIn: START_DELAY_MS });
    });
    this.startTimer = setTimeout(() => this.start(), START_DELAY_MS);
  }

  send(team, msg) {
    const ws = this.players[team].ws;
    if (ws?.readyState === ws?.OPEN) ws.send(JSON.stringify(msg));
  }

  start() {
    this.started = true;
    this.last = performance.now();
    this.loop = setInterval(() => this.step(), SIM_DT * 1000);
  }

  step() {
    const now = performance.now();
    this.sim.advance((now - this.last) / 1000);
    this.last = now;
    this.pending.push(...this.sim.drainEvents());
    if (++this.tick % SNAPSHOT_EVERY === 0 || this.sim.over) {
      const ev = this.pending;
      this.pending = [];
      for (const team of [0, 1]) this.send(team, { t: 'snap', ...encodeSnapshot(this.sim, team, ev) });
    }
    if (this.sim.over) this.end();
  }

  teamOf(ws) {
    return this.players.findIndex((p) => p.ws === ws);
  }

  play(ws, msg) {
    const team = this.teamOf(ws);
    if (team < 0 || !this.started || this.ended) return;
    const i = Number(msg.i) | 0;
    let x = Number(msg.x);
    let y = Number(msg.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || i < 0 || i > 3) return;
    // Reject stale taps: the card in that slot must be the one the client saw.
    if (msg.card && this.sim.sides[team].hand[i] !== msg.card) return this.send(team, { t: 'play-fail', reason: 'card' });
    if (team === 1) {
      x = mirrorX(x);
      y = mirrorY(y);
    }
    x = Math.max(0, Math.min(ARENA_W, x));
    y = Math.max(0, Math.min(ARENA_H, y));
    const err = this.sim.playCard(team, i, x, y);
    if (err) this.send(team, { t: 'play-fail', reason: err });
  }

  chat(ws, text) {
    const team = this.teamOf(ws);
    if (team < 0) return;
    const p = this.players[team];
    const entry = { name: p.name, country: p.country, text: text.slice(0, MAX_GAME_CHAT), ts: Date.now() };
    for (const t of [0, 1]) this.send(t, { t: 'gchat', room: this.id, msg: entry });
  }

  forfeit(ws) {
    const team = this.teamOf(ws);
    if (team < 0 || this.ended) return;
    this.sim.forfeit(team);
    this.pending.push(...this.sim.drainEvents());
    for (const t of [0, 1]) this.send(t, { t: 'snap', ...encodeSnapshot(this.sim, t, this.pending) });
    this.end();
  }

  disconnected(ws) {
    const team = this.teamOf(ws);
    if (team < 0 || this.ended) return;
    this.players[team].ws = null;
    this.send(1 - team, { t: 'opp-status', online: false });
    this.disconnectTimers[team] = setTimeout(() => {
      if (this.ended) return;
      this.sim.forfeit(team);
      this.end();
    }, RECONNECT_GRACE_MS);
  }

  /** A player who drops can come back (same device id) within the grace period. */
  rejoin(playerId, ws) {
    const team = this.players.findIndex((p) => p.id === playerId);
    if (team < 0 || this.ended) return false;
    clearTimeout(this.disconnectTimers[team]);
    this.players[team].ws = ws;
    const opp = this.players[1 - team];
    this.send(team, { t: 'match-found', room: this.id, team, opp: { name: opp.name, country: opp.country }, startsIn: 0, rejoin: true });
    this.send(1 - team, { t: 'opp-status', online: true });
    return true;
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.loop);
    clearTimeout(this.startTimer);
    this.disconnectTimers.forEach(clearTimeout);
    for (const team of [0, 1]) this.send(team, { t: 'match-end', room: this.id, result: this.sim.result(team) });
    this.hooks.onEnd(this);
  }
}

/** FIFO matchmaking queue plus the set of live rooms. */
export class Matchmaker {
  constructor(hooks) {
    this.hooks = hooks;
    this.queue = [];
    this.rooms = new Map();
    this.byPlayer = new Map();
    this.nextRoom = 1;
  }

  queueSize() {
    return this.queue.length;
  }

  join(ws, deck) {
    const player = ws.player;
    if (!player || !isValidDeck(deck)) return;
    if (this.byPlayer.has(player.id)) {
      const room = this.rooms.get(this.byPlayer.get(player.id));
      if (room?.rejoin(player.id, ws)) {
        ws.room = room;
        return;
      }
      this.byPlayer.delete(player.id);
    }
    this.leave(ws);
    this.queue.push({ ws, deck, since: Date.now() });
    this.match();
    this.broadcastQueue();
  }

  leave(ws) {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.ws !== ws && q.ws.player?.id !== ws.player?.id);
    if (this.queue.length !== before) this.broadcastQueue();
  }

  broadcastQueue() {
    for (const q of this.queue) q.ws.send(JSON.stringify({ t: 'queue', size: this.queue.length }));
  }

  match() {
    this.queue = this.queue.filter((q) => q.ws.readyState === q.ws.OPEN);
    while (this.queue.length >= 2) {
      const [a, b] = this.queue.splice(0, 2);
      const id = `r${this.nextRoom++}`;
      const players = [a, b].map((q) => ({ id: q.ws.player.id, name: q.ws.player.name, country: q.ws.player.country, ws: q.ws, deck: q.deck }));
      const room = new Room(id, players, {
        onEnd: (r) => {
          this.rooms.delete(r.id);
          for (const p of r.players) this.byPlayer.delete(p.id);
          this.hooks.onMatchEnd(r);
        },
      });
      this.rooms.set(id, room);
      for (const p of players) {
        this.byPlayer.set(p.id, id);
        p.ws.room = room;
      }
    }
  }

  roomOf(ws) {
    return ws.room && !ws.room.ended ? ws.room : null;
  }

  disconnected(ws) {
    this.leave(ws);
    this.roomOf(ws)?.disconnected(ws);
  }
}
