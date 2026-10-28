import { BattleSim, randomDeck } from '../sim/sim.js';
import { BattleAI } from '../sim/ai.js';
import { decodeSnapshot, encodeSnapshot, eventFor } from '../sim/snapshot.js';
import { ELIXIR_PER_SEC, MAX_ELIXIR, SIM_DT } from '../sim/constants.js';
import { ReplayDriver, roundPos } from '../sim/replay.js';
import { EMOTE_COOLDOWN_MS } from '../data/emotes.js';
import { net } from '../net.js';

const AI_NAMES = ['Sir Bot-a-Lot', 'Grumblebeard', 'Lady Elixira', 'Count Crumble', 'Old Tusk'];
const INTERP_DELAY_MS = 110;

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
  constructor({ room, oppName, oppFlag }) {
    this.mode = 'online';
    this.room = room;
    this.oppName = oppName;
    this.oppFlag = oppFlag;
    this.snaps = [];
    this.events = [];
    this.finalResult = null;
    this.onPlayError = null;
    this.onEmote = null;
    this.offs = [
      net.on('emote', (m) => this.onEmote?.(m.id)),
      net.on('snap', (s) => this.onSnap(s)),
      net.on('play-fail', (m) => this.onPlayError?.(m.reason)),
      net.on('match-end', (m) => (this.finalResult = m.result)),
    ];
  }

  onSnap(raw) {
    const snap = decodeSnapshot(raw);
    snap.recv = performance.now();
    snap.byId = new Map(snap.ents.map((e) => [e.id, e]));
    this.snaps.push(snap);
    if (this.snaps.length > 8) this.snaps.shift();
    this.events.push(...raw.ev);
  }

  update() {}

  view() {
    const latest = this.snaps.at(-1);
    if (!latest) return null;
    const renderAt = performance.now() - INTERP_DELAY_MS;
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
    return {
      ...latest,
      ents,
      time: Math.max(0, latest.time - since),
      me: { ...latest.me, elixir: Math.min(MAX_ELIXIR, latest.me.elixir + rate * since) },
    };
  }

  drainEvents() {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  play(handIndex, x, y) {
    const latest = this.snaps.at(-1);
    net.send({ t: 'play', room: this.room, i: handIndex, card: latest?.me.hand[handIndex], x, y });
    return null;
  }

  forfeit() {
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
