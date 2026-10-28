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
    ents.push([
      e.id,
      KIND_CODE[e.kind],
      e.card ? CARD_INDEX[e.card] : -1,
      flip ? 1 - e.team : e.team,
      Math.round((flip ? mirrorX(e.x) : e.x) * 100),
      Math.round((flip ? mirrorY(e.y) : e.y) * 100),
      Math.ceil(e.hp),
      e.maxHp,
      flags,
      Math.round((e.deploy > 0 ? e.deploy : 0) * 100),
    ]);
  }
  const me = sim.sides[team];
  const opp = sim.sides[1 - team];
  return {
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
    })),
  };
}
