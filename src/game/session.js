import { BattleSim, randomDeck } from '../sim/sim.js';
import { BattleAI } from '../sim/ai.js';
import { decodeSnapshot, encodeSnapshot, eventFor, SnapshotDecoder } from '../sim/snapshot.js';
import { CARD_BY_ID } from '../data/cards.js';
import { ELIXIR_PER_SEC, MAX_ELIXIR, SIM_DT } from '../sim/constants.js';
import { ReplayDriver, roundPos } from '../sim/replay.js';
import { EMOTE_COOLDOWN_MS } from '../data/emotes.js';
import { net } from '../net.js';

const AI_NAMES = ['Sir Bot-a-Lot', 'Grumblebeard', 'Lady Elixira', 'Count Crumble', 'Old Tusk'];
const INTERP_DELAY_MS = 110;
const MIN_INTERP_MS = 70;
const MAX_INTERP_MS = 300;
const PREDICTION_TIMEOUT_MS = 2500;

/**
 * Match vs. the AI: the full simulation runs in the browser. With a server `match`
 * (seed, decks, levels) every play is recorded so the server can re-run the match and
 * award trophies; without one (offline) it is a casual unranked game.
 */
export class LocalSession {
  constructor(deck, match = null) {
    this.mode = 'ai';
    this.match = match;
    this.oppName = match?.oppName ?? AI_NAMES[Math.floor(Math.random() * AI_NAMES.length)];
    this.sim = match
      ? new BattleSim(match.decks, { seed: match.seed, levels: match.levels, cardLevels: match.cardLevels })
      : new BattleSim([deck, randomDeck()]);
    this.inputs = [];
    const ai = new BattleAI(this.sim, 1);
    this.sim.onStep = (dt) => ai.update(dt);
    this.onEmote = null;
    this.aiEmoteAt = 0;
  }

  update(dt) {
    this.sim.advance(dt);
  }

  /** The AI sometimes answers an emote, and reacts to towers falling. */
  emote() {
    if (Math.random() < 0.45) this.aiEmote(['laugh', 'thumbs', 'question', 'peace'], 900 + Math.random() * 900);
  }

  aiEmote(choices, delay = 600) {
    const now = performance.now();
    if (now - this.aiEmoteAt < EMOTE_COOLDOWN_MS) return;
    this.aiEmoteAt = now + delay;
    setTimeout(() => this.onEmote?.(choices[Math.floor(Math.random() * choices.length)]), delay);
  }

  view() {
    const s = this.sim;
    const me = s.sides[0];
    return {
      time: s.time,
      overtime: s.overtime,
      doubleElixir: s.doubleElixir,
      over: s.over,
      ents: s.entities,
      me: { hand: me.hand, next: me.next, elixir: me.elixir, crowns: me.crowns },
      opp: { crowns: s.sides[1].crowns },
    };
  }

  drainEvents() {
    const events = this.sim.drainEvents();
    for (const ev of events) {
      if (ev.e !== 'tower' || Math.random() > 0.6) continue;
      // `team` is the side that lost the tower; team 1 is the AI.
      this.aiEmote(ev.team === 1 ? ['cry', 'angry'] : ['laugh', 'thumbs'], 700);
    }
    return events;
  }

  /** Returns null on success or a reason string. */
  play(handIndex, x, y) {
    const tick = this.sim.tick;
    const err = this.sim.playCard(0, handIndex, roundPos(x), roundPos(y));
    if (!err) this.inputs.push([tick, 0, handIndex, roundPos(x), roundPos(y)]);
    return err;
  }

  forfeit() {
    this.inputs.push([this.sim.tick, 0, 'forfeit']);
    this.sim.forfeit(0);
  }

  result() {
    return this.sim.result(0);
  }

  destroy() {}
}

/**
 * Match vs. a real player. The server owns the simulation; this buffers its snapshots
 * (already mirrored so we are always the bottom/blue team), interpolates positions,
 * and predicts our own elixir between packets.
 */
export class OnlineSession {
  constructor({ room, oppName, oppFlag, matchMode = 'ranked', spectator = null }) {
    this.mode = spectator ? 'spectate' : 'online';
    this.matchMode = matchMode;
    this.room = room;
    this.oppName = oppName;
    this.oppFlag = oppFlag;
    /** Spectators watch from player 0's side: { players: [{ name, country, trophies }] }. */
    this.spectator = spectator;
    this.snaps = [];
    this.events = [];
    this.finalResult = null;
    this.endMsg = null;
    this.onPlayError = null;
    this.onEmote = null;
    this.decoder = new SnapshotDecoder();
    this.lastResync = 0;
    // Adaptive interpolation: mean packet gap + jitter, both smoothed.
    this.gap = 1000 / 15;
    this.jitter = 10;
    this.lastRecv = 0;
    this.interpDelay = INTERP_DELAY_MS;
    /** Deploys we predicted locally, waiting for the server: { card, x, y, cost, sent, at }. */
    this.predicted = [];
    this.offs = [
      net.on('emote', (m) => this.onEmote?.(m.id)),
      net.on('snap', (s) => this.onSnap(s)),
      net.on('play-ack', (m) => {
        const p = this.predicted.find((q) => q.card === m.card && q.at == null);
        if (p) p.at = m.at;
      }),
      net.on('play-fail', (m) => {
        this.predicted = this.predicted.filter((q) => q.card !== m.card);
        this.onPlayError?.(m.reason);
      }),
      net.on('match-end', (m) => {
        this.endMsg = m;
        this.finalResult = m.result;
      }),
    ];
  }

  onSnap(raw) {
    const full = this.decoder.apply(raw);
    const now = performance.now();
    if (!full || this.decoder.desynced) {
      if (now - this.lastResync > 500) {
        this.lastResync = now;
        net.send({ t: 'resync' });
      }
      if (!full) return;
    }
    if (this.lastRecv) {
      const gap = now - this.lastRecv;
      this.gap += (gap - this.gap) * 0.1;
      this.jitter += (Math.abs(gap - this.gap) - this.jitter) * 0.1;
      this.interpDelay = Math.max(MIN_INTERP_MS, Math.min(MAX_INTERP_MS, this.gap + this.jitter * 2 + 20));
    }
    this.lastRecv = now;
    const snap = decodeSnapshot(full);
    snap.recv = now;
    snap.byId = new Map(snap.ents.map((e) => [e.id, e]));
    this.snaps.push(snap);
    if (this.snaps.length > 12) this.snaps.shift();
    this.events.push(...raw.ev);
    // A prediction is settled once a snapshot from after its apply tick arrives.
    this.predicted = this.predicted.filter((p) => (p.at == null || snap.tick < p.at) && now - p.sent < PREDICTION_TIMEOUT_MS);
  }

  update() {}

  view() {
    const latest = this.snaps.at(-1);
    if (!latest) return null;
    const renderAt = performance.now() - this.interpDelay;
    let a = this.snaps[0];
    let b = latest;
    for (let i = 0; i < this.snaps.length - 1; i++) {
      if (this.snaps[i].recv <= renderAt && this.snaps[i + 1].recv >= renderAt) {
        a = this.snaps[i];
        b = this.snaps[i + 1];
        break;
      }
    }
    const span = b.recv - a.recv;
    const k = span > 0 ? Math.max(0, Math.min(1, (renderAt - a.recv) / span)) : 1;
    const ents = b.ents.map((e) => {
      const prev = a.byId.get(e.id);
      if (!prev || prev === e) return e;
      return { ...e, x: prev.x + (e.x - prev.x) * k, y: prev.y + (e.y - prev.y) * k };
    });
    const since = (performance.now() - latest.recv) / 1000;
    const rate = ELIXIR_PER_SEC * (latest.doubleElixir ? 2 : 1);
    const spent = this.predicted.reduce((s, p) => s + p.cost, 0);
    return {
      ...latest,
      ents,
      time: Math.max(0, latest.time - since),
      me: { ...latest.me, elixir: Math.max(0, Math.min(MAX_ELIXIR, latest.me.elixir + rate * since) - spent) },
      pending: this.predicted,
    };
  }

  drainEvents() {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  /** Predicts the deploy locally (ring + elixir) and asks the server; it confirms or rolls back. */
  play(handIndex, x, y) {
    if (this.spectator) return 'spectate';
    const v = this.view();
    const card = CARD_BY_ID[v?.me.hand[handIndex]];
    if (!card) return 'card';
    if (this.predicted.some((p) => p.card === card.id)) return 'card';
    if (v.me.elixir < card.cost) return 'elixir';
    this.predicted.push({ card: card.id, x, y, cost: card.cost, sent: performance.now(), at: null });
    net.send({ t: 'play', room: this.room, card: card.id, x, y });
    return null;
  }

  forfeit() {
    if (this.spectator) return;
    net.send({ t: 'forfeit', room: this.room });
  }

  emote(id) {
    net.send({ t: 'emote', room: this.room, id });
  }

  result() {
    return this.finalResult;
  }

  destroy() {
    this.offs.forEach((off) => off());
    if (this.spectator && !this.finalResult) net.send({ t: 'spectate-leave' });
  }
}

/**
 * Plays back a stored match from the viewer's side (`replay.team`), re-simulated from its
 * seed and recorded inputs. The board is mirrored like an online snapshot for team 1.
 */
export class ReplaySession {
  constructor(replay) {
    this.mode = 'replay';
    this.team = replay.team ?? 0;
    this.oppName = replay.opp;
    this.driver = new ReplayDriver(replay.record);
    this.sim = this.driver.sim;
    this.speed = 1;
    this.acc = 0;
    this.events = [];
    this.onEmote = null;
    this.onPlayError = null;
  }

  update(dt) {
    this.acc += Math.min(dt, 0.25) * this.speed;
    while (this.acc >= SIM_DT && !this.sim.over) {
      this.acc -= SIM_DT;
      this.driver.step();
      this.events.push(...this.sim.drainEvents().map((ev) => eventFor(ev, this.team)));
    }
  }

  view() {
    return decodeSnapshot(encodeSnapshot(this.sim, this.team, []));
  }

  drainEvents() {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  play() {
    return 'replay';
  }

  emote() {}

  forfeit() {
    this.sim.finish(this.sim.winner ?? null);
  }

  result() {
    return this.sim.result(this.team);
  }

  destroy() {}
}
