import { CARDS } from '../data/cards.js';
import { mirrorX, mirrorY, DOUBLE_ELIXIR_AT } from './constants.js';

const CARD_INDEX = Object.fromEntries(CARDS.map((c, i) => [c.id, i]));
const KIND = ['tower', 'troop', 'building'];
const KIND_CODE = { tower: 0, troop: 1, building: 2 };
const F_MOVING = 1;
const F_LEFT = 2;
const F_DEPLOY = 4;
const F_LUNGE = 8;
const F_ACTIVE = 16;
const F_DEAD = 32;
const F_KING = 64;
const F_FROZEN = 128;
const F_STUNNED = 256;
const F_RAGED = 512;
const F_HIDDEN = 1024;
const F_CHARGING = 2048;

const POINT_KEYS = [['x', 'y'], ['fx', 'fy'], ['tx', 'ty']];

/** Rewrites an event into `team`'s perspective (team 1 sees the board rotated 180°). */
export function eventFor(ev, team) {
  if (team === 0) return ev;
  const out = { ...ev };
  for (const [kx, ky] of POINT_KEYS) {
    if (kx in out) out[kx] = mirrorX(out[kx]);
    if (ky in out) out[ky] = mirrorY(out[ky]);
  }
  if ('team' in out) out.team = 1 - out.team;
  if ('winner' in out && out.winner != null) out.winner = 1 - out.winner;
  return out;
}

/**
 * Compact per-player snapshot. Coordinates are in hundredths of a tile and already
 * mirrored for team 1, so every client renders itself as team 0 at the bottom.
 */
export function encodeSnapshot(sim, team, events = []) {
  const flip = team === 1;
  const ents = [];
  for (const e of sim.entities) {
    let flags = 0;
    if (e.moving) flags |= F_MOVING;
    if (e.facingLeft !== flip) flags |= F_LEFT;
    if (e.deploy > 0) flags |= F_DEPLOY;
    if (e.lunge > 0) flags |= F_LUNGE;
    if (e.active) flags |= F_ACTIVE;
    if (e.dead) flags |= F_DEAD;
    if (e.towerKind === 'king') flags |= F_KING;
    if (e.frozen > 0) flags |= F_FROZEN;
    if (e.stunned > 0) flags |= F_STUNNED;
    if (e.raged > 0) flags |= F_RAGED;
    if (e.hidden) flags |= F_HIDDEN;
    if (e.charging) flags |= F_CHARGING;
    ents.push([
      e.id,
      KIND_CODE[e.kind],
      e.card ? CARD_INDEX[e.card] : -1,
      flip ? 1 - e.team : e.team,
      Math.round((flip ? mirrorX(e.x) : e.x) * 100),
      Math.round((flip ? mirrorY(e.y) : e.y) * 100),
      Math.ceil(e.hp),
      Math.round(e.maxHp),
      flags,
      Math.round((e.deploy > 0 ? e.deploy : 0) * 100),
    ]);
  }
  const me = sim.sides[team];
  const opp = sim.sides[1 - team];
  return {
    tick: sim.tick,
    time: Math.round(sim.time * 100) / 100,
    overtime: sim.overtime,
    over: sim.over,
    ents,
    me: { hand: me.hand, next: me.next, elixir: Math.round(me.elixir * 100) / 100, crowns: me.crowns },
    opp: { crowns: opp.crowns },
    ev: events.map((ev) => eventFor(ev, team)),
  };
}

/** Expands a snapshot into the plain view objects the renderer consumes. */
export function decodeSnapshot(s) {
  return {
    tick: s.tick,
    time: s.time,
    overtime: s.overtime,
    over: s.over,
    doubleElixir: s.overtime || s.time <= DOUBLE_ELIXIR_AT,
    me: s.me,
    opp: s.opp,
    ents: s.ents.map(([id, k, ci, team, x, y, hp, maxHp, f, dep]) => ({
      id,
      kind: KIND[k],
      card: ci >= 0 ? CARDS[ci].id : null,
      towerKind: k === 0 ? (f & F_KING ? 'king' : 'princess') : null,
      team,
      x: x / 100,
      y: y / 100,
      hp,
      maxHp,
      moving: Boolean(f & F_MOVING),
      facingLeft: Boolean(f & F_LEFT),
      deploy: dep / 100,
      lunge: Boolean(f & F_LUNGE),
      active: Boolean(f & F_ACTIVE),
      dead: Boolean(f & F_DEAD),
      frozen: Boolean(f & F_FROZEN),
      stunned: Boolean(f & F_STUNNED),
      raged: Boolean(f & F_RAGED),
      hidden: Boolean(f & F_HIDDEN),
      charging: Boolean(f & F_CHARGING),
    })),
  };
}

// ------------------------------------------------------------------ delta streams

const FIELDS = 10;
const KEYFRAME_EVERY = 150; // snapshots (10 s at 15 Hz)
const CHECKSUM_EVERY = 30; // snapshots (2 s)

/** FNV-1a over every integer of the entity table, in order. */
export function checksumEnts(ents) {
  let h = 0x811c9dc5;
  for (const row of ents) {
    for (const v of row) {
      h ^= v & 0xffff;
      h = Math.imul(h, 0x01000193);
      h ^= (v >>> 16) & 0xffff;
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}

/**
 * Server side, one per recipient: turns full snapshots into deltas against the last one
 * that recipient received. Rows that changed are sent as [id, mask, ...changed fields];
 * removed ids go in `rm`. A keyframe (`k: 1`) carries the full table.
 */
export class SnapshotEncoder {
  constructor() {
    this.base = null;
    this.count = 0;
    this.forceKey = true;
  }

  encode(snap) {
    const n = this.count++;
    const key = this.forceKey || n % KEYFRAME_EVERY === 0;
    const { ents, ...rest } = snap;
    const msg = { ...rest };
    if (key) {
      this.forceKey = false;
      msg.k = 1;
      msg.ents = ents;
    } else {
      const d = [];
      const seen = new Set();
      for (const row of ents) {
        seen.add(row[0]);
        const prev = this.base.get(row[0]);
        let mask = 0;
        const vals = [];
        for (let i = 1; i < FIELDS; i++) {
          if (!prev || prev[i] !== row[i]) {
            mask |= 1 << i;
            vals.push(row[i]);
          }
        }
        if (mask) d.push([row[0], mask, ...vals]);
      }
      const rm = [];
      for (const id of this.base.keys()) if (!seen.has(id)) rm.push(id);
      msg.d = d;
      if (rm.length) msg.rm = rm;
    }
    if (n % CHECKSUM_EVERY === 0) msg.ck = checksumEnts(ents);
    this.base = new Map(ents.map((row) => [row[0], row]));
    return msg;
  }
}

/**
 * Client side: rebuilds the full entity table from keyframes + deltas. Returns the raw
 * snapshot (with `ents`) or null while waiting for a keyframe; `desynced` is set when a
 * checksum disagrees, so the caller can ask the server for a keyframe.
 */
export class SnapshotDecoder {
  constructor() {
    this.base = null;
    this.desynced = false;
  }

  apply(msg) {
    if (msg.k) this.base = new Map(msg.ents.map((row) => [row[0], row]));
    else if (!this.base) return null;
    else {
      const next = new Map(this.base);
      for (const id of msg.rm ?? []) next.delete(id);
      for (const [id, mask, ...vals] of msg.d) {
        const row = next.get(id)?.slice() ?? new Array(FIELDS).fill(0);
        row[0] = id;
        let j = 0;
        for (let i = 1; i < FIELDS; i++) if (mask & (1 << i)) row[i] = vals[j++];
        next.set(id, row);
      }
      this.base = next;
    }
    const ents = [...this.base.values()];
    this.desynced = msg.ck != null && checksumEnts(ents) !== msg.ck;
    return { ...msg, ents };
  }
}
