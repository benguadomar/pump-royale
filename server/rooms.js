import crypto from 'node:crypto';
import { BattleSim } from '../src/sim/sim.js';
import { encodeSnapshot, SnapshotEncoder } from '../src/sim/snapshot.js';
import { SIM_DT, ARENA_W, ARENA_H, mirrorX, mirrorY } from '../src/sim/constants.js';
import { CARD_BY_ID } from '../src/data/cards.js';
import { EMOTE_IDS, EMOTE_COOLDOWN_MS } from '../src/data/emotes.js';
import { roundPos } from '../src/sim/replay.js';
import { signResult } from './auth.js';
import { log } from './log.js';

const SNAPSHOT_EVERY = 2; // ticks -> 15 Hz at a 30 Hz simulation
/** Plays are applied this many ticks after they arrive (100 ms) so both players get the same delay. */
export const INPUT_DELAY_TICKS = 3;
const MIN_PLAY_GAP_MS = 150;
const MAX_QUEUED_PLAYS = 3;
const RECONNECT_GRACE_MS = 12000;
const START_DELAY_MS = 2500;
const MAX_GAME_CHAT = 120;
const MAX_SPECTATORS = 50;
const REMATCH_WINDOW_MS = 30000;
const FRIENDLY_TTL_MS = 15 * 60 * 1000;
/** A host whose connection drops (e.g. a phone switching apps to share the link) keeps its code this long. */
const FRIENDLY_RECONNECT_MS = 60000;
const MATCH_WINDOW_BASE = 100;
const MATCH_WINDOW_PER_S = 50;
const MATCH_WINDOW_MAX = 4000;

const isValidDeck = (d) => Array.isArray(d) && d.length === 8 && new Set(d).size === 8 && d.every((id) => CARD_BY_ID[id]);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');

/**
 * One authoritative match. Seats carry a `team`; player 1 receives every snapshot/event
 * mirrored so both clients see themselves at the bottom, and their inputs are mirrored
 * back. Every recipient (players and spectators) has its own delta encoder.
 */
class Room {
  constructor(id, players, { mode = 'ranked', hooks }) {
    this.id = id;
    this.mode = mode;
    this.players = players.map((p, team) => ({ ...p, team, lastPlay: 0 }));
    this.hooks = hooks;
    const lv = players.map((p) => hooks.levelsFor(p.id, p.deck));
    this.levels = lv.map((l) => l.tower);
    this.cardLevels = lv.map((l) => l.cards);
    this.seed = crypto.randomInt(1, 2 ** 31);
    this.sim = new BattleSim(players.map((p) => p.deck), { seed: this.seed, levels: this.levels, cardLevels: this.cardLevels });
    /** Accepted plays as [tick, team, handIndex, x, y] (canonical coords) for the replay. */
    this.inputs = [];
    this.queued = [];
    this.pending = [];
    this.ended = false;
    this.started = false;
    this.disconnectTimers = [null, null];
    this.lastEmote = [0, 0];
    this.encoders = new Map(); // ws -> SnapshotEncoder
    this.spectators = new Set();
    this.rematch = new Set();

    for (const p of this.players) this.sendMatchFound(p, START_DELAY_MS);
    this.startTimer = setTimeout(() => this.start(), START_DELAY_MS);
  }

  sendMatchFound(p, startsIn, rejoin = false) {
    const opp = this.players[1 - p.team];
    this.sendWs(p.ws, { t: 'match-found', room: this.id, mode: this.mode, team: p.team, opp: { name: opp.name, country: opp.country, trophies: opp.trophies }, startsIn, rejoin, inputDelay: INPUT_DELAY_TICKS * SIM_DT * 1000 });
  }

  sendWs(ws, msg) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  send(team, msg) {
    this.sendWs(this.players[team].ws, msg);
  }

  /** Everyone watching from team 0's side who is not a player. */
  toSpectators(msg) {
    for (const ws of this.spectators) this.sendWs(ws, msg);
  }

  start() {
    this.started = true;
    this.last = performance.now();
    this.acc = 0;
    this.loop = setInterval(() => this.step(), SIM_DT * 1000);
  }

  step() {
    const now = performance.now();
    this.acc += Math.min((now - this.last) / 1000, 0.25);
    this.last = now;
    while (this.acc >= SIM_DT && !this.sim.over) {
      this.acc -= SIM_DT;
      this.applyDue();
      this.sim.step(SIM_DT);
      this.pending.push(...this.sim.drainEvents());
      if (this.sim.tick % SNAPSHOT_EVERY === 0) this.broadcastSnapshot();
    }
    if (this.sim.over) {
      this.broadcastSnapshot();
      this.end();
    }
  }

  encoderFor(ws) {
    let enc = this.encoders.get(ws);
    if (!enc) this.encoders.set(ws, (enc = new SnapshotEncoder()));
    return enc;
  }

  broadcastSnapshot() {
    const ev = this.pending;
    this.pending = [];
    for (const p of this.players) {
      if (!p.ws) continue;
      this.sendWs(p.ws, { t: 'snap', ...this.encoderFor(p.ws).encode(encodeSnapshot(this.sim, p.team, ev)) });
    }
    if (this.spectators.size) {
      const view = encodeSnapshot(this.sim, 0, ev);
      for (const ws of this.spectators) this.sendWs(ws, { t: 'snap', ...this.encoderFor(ws).encode(view) });
    }
  }

  /** A client whose rebuilt state failed its checksum gets a full keyframe next. */
  resync(ws) {
    const enc = this.encoders.get(ws);
    if (enc) enc.forceKey = true;
  }

  seatOf(ws) {
    return this.players.find((p) => p.ws === ws) ?? null;
  }

  /** Validates and queues a play; it is applied INPUT_DELAY_TICKS later. */
  play(ws, msg) {
    const p = this.seatOf(ws);
    if (!p || !this.started || this.ended) return;
    const team = p.team;
    const card = String(msg.card ?? '');
    let x = Number(msg.x);
    let y = Number(msg.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !CARD_BY_ID[card]) return;
    const now = Date.now();
    const mine = this.queued.filter((q) => q.team === team);
    if (now - p.lastPlay < MIN_PLAY_GAP_MS || mine.length >= MAX_QUEUED_PLAYS) return this.send(team, { t: 'play-fail', reason: 'rate', card });
    // Reject stale taps: the card must be in hand (and not already queued).
    const hand = this.sim.sides[team].hand;
    if (!hand.includes(card) || mine.some((q) => q.card === card)) return this.send(team, { t: 'play-fail', reason: 'card', card });
    p.lastPlay = now;
    if (team === 1) {
      x = mirrorX(x);
      y = mirrorY(y);
    }
    x = roundPos(Math.max(0, Math.min(ARENA_W, x)));
    y = roundPos(Math.max(0, Math.min(ARENA_H, y)));
    const at = this.sim.tick + INPUT_DELAY_TICKS;
    this.queued.push({ at, team, card, x, y });
    this.send(team, { t: 'play-ack', card, at });
  }

  applyDue() {
    if (!this.queued.length) return;
    const due = this.queued.filter((q) => q.at <= this.sim.tick);
    if (!due.length) return;
    this.queued = this.queued.filter((q) => q.at > this.sim.tick);
    for (const q of due) {
      const i = this.sim.sides[q.team].hand.indexOf(q.card);
      const err = i < 0 ? 'card' : this.sim.playCard(q.team, i, q.x, q.y);
      if (err) this.send(q.team, { t: 'play-fail', reason: err, card: q.card });
      else this.inputs.push([this.sim.tick, q.team, i, q.x, q.y]);
    }
  }

  chat(ws, text) {
    const p = this.seatOf(ws);
    if (!p) return;
    const entry = { name: p.name, country: p.country, text: text.slice(0, MAX_GAME_CHAT), ts: Date.now() };
    for (const t of [0, 1]) this.send(t, { t: 'gchat', room: this.id, msg: entry });
  }

  /** Relays a whitelisted emote to the opponent (the sender shows its own locally). */
  emote(ws, id) {
    const p = this.seatOf(ws);
    if (!p || this.ended || !EMOTE_IDS.has(id)) return;
    const now = Date.now();
    if (now - (this.lastEmote[p.team] ?? 0) < EMOTE_COOLDOWN_MS) return;
    this.lastEmote[p.team] = now;
    this.send(1 - p.team, { t: 'emote', id });
  }

  forfeit(ws) {
    const p = this.seatOf(ws);
    if (!p || this.ended) return;
    this.forfeitTeam(p.team);
  }

  forfeitTeam(team) {
    this.inputs.push([this.sim.tick, team, 'forfeit']);
    this.sim.forfeit(team);
    this.pending.push(...this.sim.drainEvents());
    this.broadcastSnapshot();
    this.end();
  }

  disconnected(ws) {
    if (this.spectators.delete(ws)) {
      this.encoders.delete(ws);
      return;
    }
    const p = this.seatOf(ws);
    if (!p || this.ended) return;
    p.ws = null;
    this.encoders.delete(ws);
    this.send(1 - p.team, { t: 'opp-status', online: false });
    this.disconnectTimers[p.team] = setTimeout(() => !this.ended && this.forfeitTeam(p.team), RECONNECT_GRACE_MS);
  }

  /** A player who drops can come back (same account) within the grace period. */
  rejoin(playerId, ws) {
    const p = this.players.find((x) => x.id === playerId);
    if (!p || this.ended) return false;
    clearTimeout(this.disconnectTimers[p.team]);
    p.ws = ws;
    this.sendMatchFound(p, 0, true);
    this.send(1 - p.team, { t: 'opp-status', online: true });
    return true;
  }

  addSpectator(ws) {
    if (this.ended || this.spectators.size >= MAX_SPECTATORS) return false;
    this.spectators.add(ws);
    this.sendWs(ws, { t: 'spectate-start', room: this.id, mode: this.mode, players: this.players.map((p) => ({ name: p.name, country: p.country, trophies: p.trophies })) });
    return true;
  }

  removeSpectator(ws) {
    this.spectators.delete(ws);
    this.encoders.delete(ws);
  }

  /** The signed, canonical outcome (team 0's perspective). */
  signedResult() {
    const r = this.sim.result(0);
    const result = { match: this.id, mode: this.mode, seed: this.seed, players: this.players.map((p) => p.id).join(','), winner: this.sim.winner ?? -1, crowns: `${r.myCrowns}-${r.enemyCrowns}`, ticks: this.sim.tick };
    return { ...result, sig: signResult(result) };
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.endedAt = Date.now();
    clearInterval(this.loop);
    clearTimeout(this.startTimer);
    this.disconnectTimers.forEach(clearTimeout);
    this.signed = this.signedResult();
    for (const p of this.players) this.send(p.team, { t: 'match-end', room: this.id, mode: this.mode, result: this.sim.result(p.team), signed: this.signed, rematch: true });
    this.toSpectators({ t: 'match-end', room: this.id, mode: this.mode, result: this.sim.result(0), spectator: true });
    this.spectators.clear();
    log.info('match end', { room: this.id, mode: this.mode, crowns: this.signed.crowns, ticks: this.sim.tick, inputs: this.inputs.length });
    this.hooks.onEnd(this);
  }

  summary() {
    return {
      room: this.id,
      mode: this.mode,
      time: Math.round(this.sim.time),
      crowns: [this.sim.sides[0].crowns, this.sim.sides[1].crowns],
      spectators: this.spectators.size,
      players: this.players.map((p) => ({ name: p.name, country: p.country, trophies: p.trophies })),
    };
  }
}

/**
 * Ranked queue (by trophies, with a window that widens while waiting), friendly rooms by
 * code, rematches, spectating, and the set of live rooms.
 */
export class Matchmaker {
  constructor(hooks) {
    this.hooks = hooks; // { levelsFor, trophiesOf, onMatchEnd }
    this.queue = [];
    this.rooms = new Map();
    this.recent = new Map(); // ended rooms, kept briefly for rematches
    this.byPlayer = new Map();
    this.friendlies = new Map(); // code -> { ws, deck, created }
    this.nextRoom = 1;
    this.ticker = setInterval(() => this.match(), 1000);
    this.ticker.unref?.();
  }

  queueSize() {
    return this.queue.length;
  }

  /** Reattaches a reconnecting player to their live room. */
  tryRejoin(ws) {
    const id = ws.player?.id;
    const room = this.rooms.get(this.byPlayer.get(id));
    if (room?.rejoin(id, ws)) {
      ws.room = room;
      return true;
    }
    return false;
  }

  join(ws, deck) {
    const player = ws.player;
    if (!player || !isValidDeck(deck)) return;
    if (this.byPlayer.has(player.id)) {
      if (this.tryRejoin(ws)) return;
      this.byPlayer.delete(player.id);
    }
    this.leave(ws);
    this.queue.push({ ws, deck, since: Date.now(), trophies: this.hooks.trophiesOf(player.id) });
    this.match();
    this.broadcastQueue();
  }

  leave(ws, { keepFriendly = false } = {}) {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.ws !== ws && q.ws.player?.id !== ws.player?.id);
    if (this.queue.length !== before) this.broadcastQueue();
    for (const [code, f] of this.friendlies) {
      if (f.ws !== ws) continue;
      if (keepFriendly) f.lostAt = Date.now();
      else this.friendlies.delete(code);
    }
  }

  broadcastQueue() {
    for (const q of this.queue) {
      const wait = (Date.now() - q.since) / 1000;
      q.ws.send(JSON.stringify({ t: 'queue', size: this.queue.length, range: Math.round(this.window(wait)) }));
    }
  }

  window(waitS) {
    return Math.min(MATCH_WINDOW_MAX, MATCH_WINDOW_BASE + MATCH_WINDOW_PER_S * waitS);
  }

  /** Pairs the longest-waiting players with the closest trophy count both windows allow. */
  match() {
    this.queue = this.queue.filter((q) => q.ws.readyState === q.ws.OPEN);
    const now = Date.now();
    this.queue.sort((a, b) => a.since - b.since);
    for (let i = 0; i < this.queue.length; i++) {
      const a = this.queue[i];
      let best = -1;
      let bestDiff = Infinity;
      for (let j = i + 1; j < this.queue.length; j++) {
        const b = this.queue[j];
        if (b.ws.player.id === a.ws.player.id) continue;
        const diff = Math.abs(a.trophies - b.trophies);
        const allowed = Math.min(this.window((now - a.since) / 1000), this.window((now - b.since) / 1000));
        if (diff <= allowed && diff < bestDiff) {
          best = j;
          bestDiff = diff;
        }
      }
      if (best >= 0) {
        const b = this.queue[best];
        this.queue.splice(best, 1);
        this.queue.splice(i, 1);
        i--;
        this.createRoom([a, b], 'ranked');
      }
    }
    for (const [code, f] of this.friendlies) {
      if (f.ws.readyState !== f.ws.OPEN) f.lostAt ??= now;
      else f.lostAt = null;
      if (now - f.created > FRIENDLY_TTL_MS || (f.lostAt && now - f.lostAt > FRIENDLY_RECONNECT_MS)) this.friendlies.delete(code);
    }
    for (const [id, r] of this.recent) if (now - r.endedAt > REMATCH_WINDOW_MS) this.recent.delete(id);
    if (this.queue.length) this.broadcastQueue();
  }

  createRoom(entries, mode) {
    const id = `r${this.nextRoom++}`;
    const players = entries.map((q) => ({ id: q.ws.player.id, name: q.ws.player.name, country: q.ws.player.country, ws: q.ws, deck: q.deck, trophies: this.hooks.trophiesOf(q.ws.player.id) }));
    const room = new Room(id, players, {
      mode,
      hooks: {
        levelsFor: this.hooks.levelsFor,
        onEnd: (r) => {
          this.rooms.delete(r.id);
          this.recent.set(r.id, r);
          for (const p of r.players) this.byPlayer.delete(p.id);
          this.hooks.onMatchEnd(r);
        },
      },
    });
    this.rooms.set(id, room);
    for (const p of players) {
      this.byPlayer.set(p.id, id);
      p.ws.room = room;
    }
    log.info('match start', { room: id, mode, trophies: players.map((p) => p.trophies) });
    return room;
  }

  // ---------------------------------------------------------------- friendly battles

  /** Creates a code, or hands back the one this player already shared if they just reconnected. */
  friendlyCreate(ws, deck) {
    if (!ws.player || !isValidDeck(deck)) return { error: 'deck' };
    const id = ws.player.id;
    this.leave(ws);
    let code = [...this.friendlies].find(([, f]) => f.id === id && f.ws.readyState !== f.ws.OPEN)?.[0];
    if (code) Object.assign(this.friendlies.get(code), { ws, deck, lostAt: null });
    else {
      do code = newCode();
      while (this.friendlies.has(code));
      this.friendlies.set(code, { id, ws, deck, created: Date.now(), lostAt: null });
    }
    return { code };
  }

  friendlyJoin(ws, code, deck) {
    if (!ws.player || !isValidDeck(deck)) return { error: 'deck' };
    const key = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const host = this.friendlies.get(key);
    if (!host) return { error: 'code' };
    // Same account (another tab or device): a room needs two different players.
    if (host.id === ws.player.id) return { error: 'self' };
    if (host.ws.readyState !== host.ws.OPEN) return { error: 'away' };
    this.friendlies.delete(key);
    this.leave(ws);
    this.createRoom([host, { ws, deck }], 'friendly');
    return {};
  }

  // ---------------------------------------------------------------- rematch

  /** Both players vote within 30 s of the end; rematches are always friendly (no trophies). */
  rematch(ws, roomId, deck) {
    const r = this.recent.get(String(roomId));
    const p = r?.players.find((x) => x.ws === ws);
    if (!r || !p) return { error: 'expired' };
    if (isValidDeck(deck)) p.deck = deck;
    r.rematch.add(p.team);
    const opp = r.players[1 - p.team];
    if (r.rematch.size < 2) {
      r.sendWs(opp.ws, { t: 'rematch-offer', room: r.id, name: p.name });
      return { waiting: true };
    }
    this.recent.delete(r.id);
    if (!opp.ws || opp.ws.readyState !== opp.ws.OPEN) return { error: 'opp' };
    this.createRoom(r.players.map((x) => ({ ws: x.ws, deck: x.deck })), 'friendly');
    return {};
  }

  // ---------------------------------------------------------------- spectating

  liveList() {
    return [...this.rooms.values()]
      .filter((r) => r.started && !r.ended)
      .map((r) => r.summary())
      .sort((a, b) => b.players.reduce((s, p) => s + p.trophies, 0) - a.players.reduce((s, p) => s + p.trophies, 0))
      .slice(0, 10);
  }

  spectate(ws, roomId) {
    const room = this.rooms.get(String(roomId));
    if (!room || room.seatOf(ws)) return { error: 'room' };
    this.stopSpectating(ws);
    if (!room.addSpectator(ws)) return { error: 'full' };
    ws.watching = room;
    return {};
  }

  stopSpectating(ws) {
    ws.watching?.removeSpectator(ws);
    ws.watching = null;
  }

  roomOf(ws) {
    return ws.room && !ws.room.ended ? ws.room : null;
  }

  disconnected(ws) {
    this.leave(ws, { keepFriendly: true });
    this.stopSpectating(ws);
    this.roomOf(ws)?.disconnected(ws);
  }
}
