import { BattleSim, randomDeck } from '../sim/sim.js';
import { BattleAI } from '../sim/ai.js';
import { decodeSnapshot } from '../sim/snapshot.js';
import { ELIXIR_PER_SEC, MAX_ELIXIR } from '../sim/constants.js';
import { net } from '../net.js';

const AI_NAMES = ['Sir Bot-a-Lot', 'Grumblebeard', 'Lady Elixira', 'Count Crumble', 'Old Tusk'];
const INTERP_DELAY_MS = 110;

/** Match vs. the AI: the full simulation runs in the browser. */
export class LocalSession {
  constructor(deck) {
    this.mode = 'ai';
    this.oppName = AI_NAMES[Math.floor(Math.random() * AI_NAMES.length)];
    this.sim = new BattleSim([deck, randomDeck()]);
    const ai = new BattleAI(this.sim, 1);
    this.sim.onStep = (dt) => ai.update(dt);
  }

  update(dt) {
    this.sim.advance(dt);
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
    return this.sim.drainEvents();
  }

  /** Returns null on success or a reason string. */
  play(handIndex, x, y) {
    return this.sim.playCard(0, handIndex, x, y);
  }

  forfeit() {
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
    this.offs = [
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

  result() {
    return this.finalResult;
  }

  destroy() {
    this.offs.forEach((off) => off());
  }
}
