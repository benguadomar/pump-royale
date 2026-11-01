import { CARDS, CARD_BY_ID, TOWERS, SPEEDS, rangeOf, levelMult, BASE_LEVEL, TOWER_SPELL_FACTOR, isSpell } from '../data/cards.js';
import {
  ARENA_W, ARENA_H, RIVER_Y, RIVER_HALF, BRIDGES_X, BRIDGE_HALF, TOWER_LAYOUT,
  MATCH_TIME, OVERTIME, DOUBLE_ELIXIR_AT, ELIXIR_PER_SEC, MAX_ELIXIR, START_ELIXIR, DEPLOY_TIME, SIM_DT,
  zoneAllows,
} from './constants.js';
import { massOf, invMass, drive, seek, integrate, impulse, collide, blockVelocity, KNOCK_PER_DAMAGE } from './physics.js';

const SIGHT = 5.5;
const RETARGET_EVERY = 0.25;
const PROJECTILE_SPEED = { arrow: 16, bomb: 8, fireball: 11, cannonball: 14, bullet: 22, bolt: 14, dragonfire: 10 };
const TOWER_HEIGHT = { king: 5.4, princess: 4.8 };
const AIR_HEIGHT = 1.6;
const RAGE_MULT = 1.35;
const CHARGE_MULT = 2;
const TESLA_REVEAL = 0.6;
const TESLA_HIDE_AFTER = 1.2;
/** Seconds an Inferno beam must stay on one target to reach each damage stage. */
const RAMP_AT = [2, 4];
/** Troops lighter than this get pushed back by Fireball. */
const KNOCKBACK_MAX_HP = 2000;
/** Impulse per unit of a spell's `knockback`. */
const SPELL_BLAST_J = 18;

/** Momentum carried per point of damage, relative to a melee blow (arrows are light, bombs heavy). */
const KNOCK_SCALE = { arrow: 0.3, bolt: 0.4, bullet: 0.5, fireball: 1, bomb: 1.3, cannonball: 1.1 };

/** Extra clearance a troop keeps when walking round a tower or building that isn't its target. */
const AVOID_MARGIN = 0.3;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
/** Closest a ground troop's centre may get to a tower or building's centre. */
const solidGap = (s, a) => s.radius * 0.9 + a.radius * 0.6;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Small fast seeded PRNG so a match is reproducible from its seed (replays, server parity). */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(a, rand = Math.random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const randomDeck = (rand = Math.random) => shuffle(CARDS.map((c) => c.id), rand).slice(0, 8);

/** Per-team hand, elixir and stats. The played card goes to the back of the queue. */
class Side {
  constructor(deck, rand, level, cardLevels) {
    const order = shuffle([...deck], rand);
    this.level = level;
    this.cardLevels = cardLevels ?? {};
    this.hand = order.slice(0, 4);
    this.queue = order.slice(4);
    this.elixir = START_ELIXIR;
    this.crowns = 0;
    this.cardsPlayed = 0;
    this.totalCost = 0;
    this.towerDamage = 0;
    this.deployed = {};
  }
  get next() {
    return this.queue[0];
  }
  cycle(index) {
    const played = this.hand[index];
    this.hand[index] = this.queue.shift();
    this.queue.push(played);
  }
}

/**
 * Deterministic-step battle simulation with no rendering. The local AI mode runs it in
 * the browser; 1v1 online runs the very same code on the server. Everything that a
 * renderer needs to animate is emitted through `events` (drained by the caller).
 */
export class BattleSim {
  /**
   * opts.seed: deterministic shuffles; opts.levels: [team0, team1] player (tower) levels;
   * opts.cardLevels: [{ cardId: level }, ...] per team. Unspecified levels are 11.
   */
  constructor(decks, opts = {}) {
    this.seed = opts.seed ?? Math.floor(Math.random() * 2 ** 32);
    this.rand = rng(this.seed);
    this.time = MATCH_TIME;
    this.elapsed = 0;
    this.overtime = false;
    this.over = false;
    this.winner = undefined;
    this.entities = [];
    this.projectiles = [];
    this.spells = [];
    this.zones = [];
    this.events = [];
    this.nextId = 1;
    this.acc = 0;
    /** Fixed steps simulated so far; recorded inputs are keyed by it. */
    this.tick = 0;
    this.sides = decks.map((d, i) => new Side(d, this.rand, opts.levels?.[i] ?? BASE_LEVEL, opts.cardLevels?.[i]));
    for (const t of TOWER_LAYOUT) this.spawnTower(t);
  }

  cardLevel(team, id) {
    return this.sides[team].cardLevels[id] ?? this.sides[team].level;
  }

  get doubleElixir() {
    return this.overtime || this.time <= DOUBLE_ELIXIR_AT;
  }

  emit(ev) {
    this.events.push(ev);
  }

  drainEvents() {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  // ------------------------------------------------------------- deploy rules

  princessAlive(team, left) {
    return this.entities.some((e) => e.kind === 'tower' && e.team === team && e.towerKind === 'princess' && !e.dead && e.x < ARENA_W / 2 === left);
  }

  canDeploy(team, x, y) {
    if (!zoneAllows(team, x, y, (left) => this.princessAlive(1 - team, left))) return false;
    for (const e of this.entities) {
      if ((e.kind === 'tower' || e.kind === 'building') && !e.dead && dist(e, { x, y }) < e.radius) return false;
    }
    return true;
  }

  /** Returns an error string, or null when the card was played. */
  playCard(team, handIndex, x, y) {
    if (this.over) return 'over';
    const side = this.sides[team];
    const card = CARD_BY_ID[side.hand[handIndex]];
    if (!card) return 'card';
    if (side.elixir < card.cost) return 'elixir';
    const spell = isSpell(card);
    // Spells can land anywhere on the field; troops and buildings need a legal deploy zone.
    if (spell ? x < 0 || x > ARENA_W || y < 0 || y > ARENA_H : !this.canDeploy(team, x, y)) return 'zone';
    side.elixir -= card.cost;
    side.cardsPlayed++;
    side.totalCost += card.cost;
    side.deployed[card.id] = (side.deployed[card.id] ?? 0) + 1;
    side.cycle(handIndex);
    if (spell) this.castSpell(card, team, x, y);
    else {
      this.spawnCard(card, team, x, y);
      this.emit({ e: 'deploy', team, card: card.id, x, y });
    }
    return null;
  }

  // ------------------------------------------------------------- spells

  castSpell(card, team, x, y) {
    const king = this.entities.find((e) => e.kind === 'tower' && e.towerKind === 'king' && e.team === team);
    const sp = card.spell;
    // Lobbed spells fly from the King Tower; sky spells (`delay`) fall after a fixed time.
    const flight = sp.delay ?? (sp.speed && king ? Math.max(0.25, dist(king, { x, y }) / sp.speed) : 0);
    const s = { card, team, x, y, t: 0, flight, wave: 0, mult: levelMult(this.cardLevel(team, card.id)) };
    this.emit({ e: 'spell', team, card: card.id, x, y, fx: king?.x ?? x, fy: king?.y ?? y, flight, radius: sp.radius, waves: sp.waves ?? 1, waveGap: sp.waveGap ?? 0 });
    if (flight === 0) this.resolveSpell(s);
    else this.spells.push(s);
  }

  resolveSpell(s) {
    const sp = s.card.spell;
    const { team, x, y } = s;
    if (sp.spawn) {
      const unit = CARD_BY_ID[sp.spawn];
      for (let i = 0; i < sp.spawnCount; i++) {
        const a = (i / sp.spawnCount) * Math.PI * 2;
        const u = this.spawnUnit(unit, team, clamp(x + Math.cos(a) * 0.6, 0.5, ARENA_W - 0.5), clamp(y + Math.sin(a) * 0.6, 0.5, ARENA_H - 0.5), this.cardLevel(team, s.card.id));
        u.deploy = 0.35;
      }
    }
    if (sp.zone) this.zones.push({ team, x, y, radius: sp.radius, rage: sp.rage, time: sp.rage });
    for (const o of this.entities) {
      if (o.dead || o.hidden || Math.hypot(o.x - x, o.y - y) > sp.radius + o.radius) continue;
      if (sp.rage) continue;
      if (o.team === team) continue;
      if (sp.damage) this.damage(o, (sp.damage / (sp.waves ?? 1)) * s.mult * (o.kind === 'tower' ? TOWER_SPELL_FACTOR : 1), { team });
      if (o.dead) continue;
      if (sp.stun) this.stun(o, sp.stun);
      if (sp.freeze) {
        o.frozen = Math.max(o.frozen ?? 0, sp.freeze);
        this.interrupt(o);
      }
      // Blast impulse away from the centre: Δv = J / m, so light troops fly and tanks barely budge.
      if (sp.knockback && o.kind === 'troop') {
        impulse(o, o.x - x || 0.01, o.y - y, sp.knockback * SPELL_BLAST_J);
        if (o.maxHp < KNOCKBACK_MAX_HP) this.interrupt(o);
      }
    }
    this.emit({ e: 'spellHit', team, card: s.card.id, x, y, radius: sp.radius, duration: sp.rage ?? sp.freeze ?? sp.stun ?? 0, wave: s.wave });
  }

  updateSpells(dt) {
    for (const s of this.spells) {
      s.t += dt;
      const sp = s.card.spell;
      // Multi-wave spells split their damage over `waves` hits, `waveGap` seconds apart.
      while (!s.done && s.t >= s.flight + s.wave * (sp.waveGap ?? 0)) {
        this.resolveSpell(s);
        s.wave++;
        if (s.wave >= (sp.waves ?? 1)) s.done = true;
      }
    }
    this.spells = this.spells.filter((s) => !s.done);
    for (const z of this.zones) {
      z.time -= dt;
      for (const o of this.entities) {
        if (o.dead || o.team !== z.team || o.kind === 'tower') continue;
        if (Math.hypot(o.x - z.x, o.y - z.y) <= z.radius + o.radius) o.raged = Math.max(o.raged ?? 0, 0.4);
      }
    }
    this.zones = this.zones.filter((z) => z.time > 0);
  }

  /** Stuns cancel the current swing, reset charges and Inferno heat. */
  interrupt(e) {
    e.cd = Math.max(e.cd, Math.min(e.hitSpeed ?? 1, 0.5));
    e.rampT = 0;
    e.chargeRun = 0;
    e.charging = false;
  }

  stun(e, seconds) {
    e.stunned = Math.max(e.stunned ?? 0, seconds);
    this.interrupt(e);
  }

  // ------------------------------------------------------------- spawning

  addEntity(e) {
    Object.assign(e, { id: this.nextId++, dead: false, retarget: 0, target: null, lunge: 0, moving: false, facingLeft: e.team === 1 });
    e.cd ??= 0.4;
    this.entities.push(e);
    return e;
  }

  spawnTower({ kind, team, x, y }) {
    const def = TOWERS[kind];
    const mult = levelMult(this.sides[team].level);
    this.addEntity({
      kind: 'tower',
      towerKind: kind,
      team,
      x,
      y,
      hp: def.hp * mult,
      maxHp: def.hp * mult,
      radius: kind === 'king' ? 2.0 : 1.5,
      range: def.range,
      damage: def.damage * mult,
      hitSpeed: def.hitSpeed,
      targets: 'any',
      hitsAir: true,
      projectile: kind === 'king' ? 'cannonball' : 'arrow',
      active: kind === 'princess',
      height: TOWER_HEIGHT[kind],
    });
  }

  spawnCard(card, team, x, y) {
    const n = card.count;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (team ? Math.PI : 0);
      const r = n === 1 ? 0 : n === 2 ? 0.55 : 0.75;
      this.spawnUnit(card, team, clamp(x + Math.cos(a) * r, 0.5, ARENA_W - 0.5), clamp(y + Math.sin(a) * r, 0.5, ARENA_H - 0.5));
    }
  }

  spawnUnit(card, team, x, y, level = this.cardLevel(team, card.id)) {
    const mult = levelMult(level);
    return this.addEntity({
      kind: card.type === 'Building' ? 'building' : 'troop',
      card: card.id,
      team,
      x,
      y,
      hp: card.hp * mult,
      maxHp: card.hp * mult,
      radius: card.radius,
      range: rangeOf(card),
      melee: card.range === 'Melee',
      damage: card.damage * mult,
      hitSpeed: card.hitSpeed,
      speed: SPEEDS[card.speed] ?? 0,
      targets: card.targets === 'Buildings' ? 'buildings' : 'any',
      hitsAir: card.targets === 'Air & Ground',
      air: !!card.air,
      splash: card.splash ?? 0,
      spin: card.spin ?? 0,
      charge: card.charge ?? 0,
      chargeRun: 0,
      charging: false,
      ramp: card.ramp?.map((d) => d * mult) ?? null,
      rampT: 0,
      hidden: !!card.hidden,
      reveal: 0,
      hideT: 0,
      deathDamage: (card.deathDamage ?? 0) * mult,
      projectile: card.projectile,
      lifetime: card.lifetime,
      deploy: DEPLOY_TIME,
      cd: 0.5,
      height: card.air ? AIR_HEIGHT + card.size * 0.5 : card.size,
      frozen: 0,
      stunned: 0,
      raged: 0,
      mass: massOf(card),
      vx: 0,
      vy: 0,
      wvx: 0,
      wvy: 0,
      stagger: 0,
      detour: 0,
      detourSide: 0,
    });
  }

  // ------------------------------------------------------------- simulation

  /** Advances by real elapsed time using a fixed internal step (identical on client and server). */
  advance(dt) {
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= SIM_DT) {
      this.acc -= SIM_DT;
      this.step(SIM_DT);
    }
  }

  step(dt) {
    if (this.over) return;
    this.tick++;
    this.time -= dt;
    this.elapsed += dt;
    const rate = ELIXIR_PER_SEC * (this.doubleElixir ? 2 : 1);
    for (const s of this.sides) s.elixir = Math.min(MAX_ELIXIR, s.elixir + rate * dt);
    this.onStep?.(dt);

    // Alternate update order each tick so neither team systematically acts first.
    this.flipOrder = !this.flipOrder;
    const list = this.flipOrder ? [...this.entities].reverse() : this.entities;
    for (const e of list) if (!e.dead) this.stepEntity(e, dt);
    this.physics(dt);
    this.separate();
    this.updateProjectiles(dt);
    this.updateSpells(dt);
    this.entities = this.entities.filter((e) => !e.dead || e.kind === 'tower');

    if (this.time <= 0) this.onTimeUp();
  }

  onTimeUp() {
    const [a, b] = this.sides.map((s) => s.crowns);
    if (a !== b) return this.finish(a > b ? 0 : 1);
    if (!this.overtime) {
      this.overtime = true;
      this.time = OVERTIME;
      this.emit({ e: 'overtime' });
      return;
    }
    // Still tied after sudden death: the healthier weakest tower wins, else a draw.
    const worst = (team) => Math.min(...this.entities.filter((e) => e.kind === 'tower' && e.team === team).map((e) => (e.dead ? 0 : e.hp / e.maxHp)));
    const w0 = worst(0);
    const w1 = worst(1);
    this.finish(Math.abs(w0 - w1) < 0.001 ? null : w0 > w1 ? 0 : 1);
  }

  finish(winner) {
    if (this.over) return;
    this.over = true;
    this.time = Math.max(0, this.time);
    this.winner = winner;
    this.emit({ e: 'end', winner });
  }

  forfeit(team) {
    if (this.over) return;
    this.sides[1 - team].crowns = Math.max(this.sides[1 - team].crowns, 3);
    this.finish(1 - team);
  }

  /** Match summary from `team`'s point of view. */
  result(team) {
    const me = this.sides[team];
    const opp = this.sides[1 - team];
    return {
      result: this.winner === team ? 'win' : this.winner == null ? 'draw' : 'loss',
      myCrowns: me.crowns,
      enemyCrowns: opp.crowns,
      duration: this.elapsed,
      cardsPlayed: me.cardsPlayed,
      totalCost: me.totalCost,
      towerDamage: Math.round(me.towerDamage),
      myDeployed: me.deployed,
      oppDeployed: opp.deployed,
    };
  }

  isValidTarget(e, o) {
    if (o.dead || o.team === e.team || o.hidden) return false;
    if (o.kind === 'troop' && o.deploy > 0) return false;
    if (e.targets === 'buildings') return o.kind === 'tower' || o.kind === 'building';
    if (o.air && !e.hitsAir) return false;
    return true;
  }

  pickBridge(fromX, toX) {
    return BRIDGES_X.reduce((best, bx) => (Math.abs(fromX - bx) + Math.abs(toX - bx) < Math.abs(fromX - best) + Math.abs(toX - best) ? bx : best));
  }

  pathDist(a, b) {
    if (a.y < RIVER_Y === b.y < RIVER_Y) return dist(a, b);
    const bx = this.pickBridge(a.x, b.x);
    return Math.hypot(a.x - bx, a.y - RIVER_Y) + Math.hypot(b.x - bx, b.y - RIVER_Y);
  }

  nearestBuilding(e) {
    let best = null;
    let bestD = Infinity;
    for (const o of this.entities) {
      if (o.dead || o.hidden || o.team === e.team || (o.kind !== 'tower' && o.kind !== 'building')) continue;
      const d = e.air ? dist(e, o) : this.pathDist(e, o);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  findTarget(e) {
    if (e.kind === 'tower' || e.kind === 'building') {
      let best = null;
      let bestD = Infinity;
      for (const o of this.entities) {
        if (!this.isValidTarget(e, o) || o.kind !== 'troop') continue;
        const d = dist(e, o) - o.radius;
        if (d <= e.range && d < bestD) {
          bestD = d;
          best = o;
        }
      }
      return best;
    }
    if (e.targets === 'buildings') return this.nearestBuilding(e);
    let best = null;
    let bestD = SIGHT;
    for (const o of this.entities) {
      if (!this.isValidTarget(e, o)) continue;
      const d = dist(e, o) - o.radius;
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best ?? this.nearestBuilding(e);
  }

  inReach(e, o) {
    return dist(e, o) - o.radius - (e.melee ? e.radius : 0) <= e.range;
  }

  stepEntity(e, dt) {
    e.lunge = Math.max(0, e.lunge - dt);
    e.wvx = 0;
    e.wvy = 0;
    if (e.deploy > 0) {
      e.deploy -= dt;
      return;
    }
    if (e.kind === 'building') {
      this.damage(e, (e.maxHp / e.lifetime) * dt, null);
      if (e.dead) return;
    }
    if (e.kind === 'tower' && !e.active) return;
    e.raged = Math.max(0, (e.raged ?? 0) - dt);
    e.moving = false;
    if (e.frozen > 0) {
      e.frozen -= dt;
      return;
    }
    if (e.stunned > 0) {
      e.stunned -= dt;
      return;
    }
    const haste = e.raged > 0 ? RAGE_MULT : 1;

    e.cd = Math.max(0, e.cd - dt * haste);
    e.retarget -= dt;
    const t = e.target;
    const stale = !t || t.dead || t.hidden || (e.kind !== 'troop' && !this.inReach(e, t));
    const locked = t && !t.dead && !t.hidden && this.inReach(e, t);
    if (stale || (e.retarget <= 0 && !locked)) {
      e.retarget = RETARGET_EVERY;
      const next = this.findTarget(e);
      if (next && next !== e.target && e.kind === 'troop') e.cd = Math.max(e.cd, e.hitSpeed * 0.35);
      if (next !== e.target) e.rampT = 0;
      e.target = next;
    }

    const target = e.target;
    if (e.card === 'tesla') this.stepTesla(e, target, dt);
    if (!target || e.reveal > 0) return;
    if (this.inReach(e, target)) {
      e.facingLeft = target.x < e.x;
      if (e.ramp) e.rampT += dt;
      if (e.cd <= 0) {
        e.cd = e.hitSpeed;
        this.attack(e, target);
      }
    } else if (e.kind === 'troop') {
      this.moveToward(e, target, dt, haste);
    }
  }

  /** Tesla pops up when something is in range and burrows again after a quiet spell. */
  stepTesla(e, target, dt) {
    if (target) {
      e.hideT = 0;
      if (e.hidden) {
        e.hidden = false;
        e.reveal = TESLA_REVEAL;
        this.emit({ e: 'reveal', id: e.id, up: true });
      }
      e.reveal = Math.max(0, e.reveal - dt);
    } else if (!e.hidden) {
      e.hideT += dt;
      if (e.hideT > TESLA_HIDE_AFTER) {
        e.hidden = true;
        this.emit({ e: 'reveal', id: e.id, up: false });
      }
    }
  }

  /** Sets the troop's desired velocity (the physics pass turns it into motion). */
  moveToward(e, target, dt, haste = 1) {
    if (e.charge) {
      e.chargeRun += e.speed * haste * dt;
      if (!e.charging && e.chargeRun >= e.charge) {
        e.charging = true;
        this.emit({ e: 'charge', id: e.id });
      }
    }
    const speed = e.speed * haste * (e.charging ? CHARGE_MULT : 1);
    if (e.air) {
      // Flyers ignore the river and bridges.
      const dx = target.x - e.x;
      const dy = target.y - e.y;
      const len = Math.hypot(dx, dy) || 1;
      const stepLen = Math.min(len, speed * dt);
      e.x += (dx / len) * stepLen;
      e.y += (dy / len) * stepLen;
      e.moving = true;
      if (Math.abs(dx) > 0.05) e.facingLeft = dx < 0;
      return;
    }
    let gx = target.x;
    let gy = target.y;
    const mySide = e.y < RIVER_Y ? 0 : 1;
    const targetSide = target.y < RIVER_Y ? 0 : 1;
    const onBridge = Math.abs(e.y - RIVER_Y) < RIVER_HALF + 0.6;
    if (mySide !== targetSide || onBridge) {
      const bx = this.pickBridge(e.x, target.x);
      const crossing = Math.abs(e.x - bx) < BRIDGE_HALF * 0.8;
      if (!crossing && mySide !== targetSide) {
        gx = bx;
        gy = RIVER_Y + (mySide === 0 ? -(RIVER_HALF + 0.4) : RIVER_HALF + 0.4);
      } else if (crossing && Math.abs(e.y - RIVER_Y) < RIVER_HALF + 0.5) {
        gx = bx;
        gy = RIVER_Y + (targetSide === 0 ? -(RIVER_HALF + 0.7) : RIVER_HALF + 0.7);
      }
    }
    [gx, gy] = this.steerAround(e, gx, gy, target);
    [e.wvx, e.wvy] = seek(e, gx, gy, speed);
    e.moving = true;
    if (Math.abs(gx - e.x) > 0.05) e.facingLeft = gx < e.x;
  }

  /**
   * If a tower or building other than the target sits on the straight line to (gx, gy),
   * returns a waypoint beside it so the troop walks round instead of pressing into it.
   * The chosen side sticks until the obstacle is cleared so the troop doesn't dither.
   */
  steerAround(e, gx, gy, target) {
    const dx = gx - e.x;
    const dy = gy - e.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) return [gx, gy];
    const ux = dx / len;
    const uy = dy / len;
    let block = null;
    let blockT = Infinity;
    let blockOff = 0;
    for (const s of this.entities) {
      if (s.dead || s === target || (s.kind !== 'tower' && s.kind !== 'building')) continue;
      const rx = s.x - e.x;
      const ry = s.y - e.y;
      const t = rx * ux + ry * uy;
      const off = ry * ux - rx * uy;
      if (t <= 0 || t >= len || Math.abs(off) >= solidGap(s, e) + AVOID_MARGIN || t >= blockT) continue;
      block = s;
      blockT = t;
      blockOff = off;
    }
    if (!block) {
      e.detour = 0;
      return [gx, gy];
    }
    const R = (solidGap(block, e) + AVOID_MARGIN) * 1.1;
    const fits = (side) => {
      const wx = block.x - uy * side * R;
      return wx > 0.6 && wx < ARENA_W - 0.6;
    };
    let side = e.detour === block.id ? e.detourSide : 0;
    if (!side) {
      side = blockOff > 0.05 ? -1 : blockOff < -0.05 ? 1 : -uy * (ARENA_W / 2 - block.x) > 0 ? 1 : -1;
      if (!fits(side) && fits(-side)) side = -side;
      e.detour = block.id;
      e.detourSide = side;
    }
    return [block.x - uy * side * R, block.y + ux * side * R];
  }

  /** F = m·a for every ground troop, then integrate positions. Frozen troops are held still. */
  physics(dt) {
    for (const e of this.entities) {
      if (e.dead || e.kind !== 'troop' || e.air) continue;
      if (e.deploy > 0 || e.frozen > 0) {
        e.vx = 0;
        e.vy = 0;
        continue;
      }
      drive(e, e.wvx, e.wvy, dt);
      integrate(e, dt);
    }
  }

  attack(e, target) {
    e.lunge = 0.14;
    if (e.ramp) {
      // Inferno: damage climbs through stages the longer the beam stays on one target.
      const stage = e.rampT < RAMP_AT[0] ? 0 : e.rampT < RAMP_AT[1] ? 1 : 2;
      this.emit({ e: 'beam', from: e.id, to: target.id, kind: 'inferno', stage });
      this.damage(target, e.ramp[stage], e);
      return;
    }
    if (e.projectile === 'zap') {
      this.emit({ e: 'beam', from: e.id, to: target.id, kind: 'tesla', stage: 0 });
      this.damage(target, e.damage, e);
      return;
    }
    if (!e.projectile || e.melee) {
      const charged = e.charging;
      e.charging = false;
      e.chargeRun = 0;
      this.emit({ e: 'melee', from: e.id, to: target.id, card: e.card ?? null, charged, spin: e.spin || 0 });
      if (e.spin) {
        // Valkyrie: the swing hits every ground enemy around her, always including her target.
        const reach = Math.max(e.spin, dist(e, target) - target.radius + 0.05);
        for (const o of this.entities) {
          if (o.dead || o.team === e.team || o.air || o.hidden || (o.kind === 'troop' && o.deploy > 0)) continue;
          if (Math.hypot(o.x - e.x, o.y - e.y) <= reach + o.radius) this.damage(o, e.damage, e);
        }
        return;
      }
      this.applyHit(charged ? { ...e, damage: e.damage * CHARGE_MULT } : e, target, target.x, target.y);
      return;
    }
    const kind = e.projectile;
    const fh = e.kind === 'tower' ? e.height * 0.8 : e.height * 0.6;
    const flight = Math.max(0.12, dist(e, target) / PROJECTILE_SPEED[kind]);
    this.projectiles.push({ kind, target, tx: target.x, ty: target.y, t: 0, flight, source: e, team: e.team, damage: e.damage, splash: e.splash ?? 0, hitsAir: e.hitsAir });
    this.emit({ e: 'shot', from: e.id, to: target.id, kind, flight, fx: e.x, fy: e.y, fh, tx: target.x, ty: target.y, th: (target.height ?? 1) * 0.5 });
  }

  updateProjectiles(dt) {
    for (const p of this.projectiles) {
      p.t += dt;
      if (!p.target.dead) {
        p.tx = p.target.x;
        p.ty = p.target.y;
      }
      if (p.t >= p.flight) {
        p.done = true;
        this.applyHit(p, p.target.dead ? null : p.target, p.tx, p.ty);
      }
    }
    this.projectiles = this.projectiles.filter((p) => !p.done);
  }

  applyHit(src, target, x, y) {
    const team = src.team;
    const kind = src.projectile ?? src.kind;
    const from = src.source ?? src;
    const J = src.damage * KNOCK_PER_DAMAGE * (KNOCK_SCALE[kind] ?? 1);
    if (src.splash > 0) {
      for (const o of this.entities) {
        if (o.dead || o.team === team || o.hidden) continue;
        if (o.kind === 'troop' && o.deploy > 0) continue;
        if (o.air && !src.hitsAir) continue;
        if (Math.hypot(o.x - x, o.y - y) > src.splash + o.radius) continue;
        this.damage(o, src.damage, src);
        // Blast impulse points away from the impact; a direct hit gets pushed along the shot.
        const rx = o.x - x;
        const ry = o.y - y;
        const r = Math.hypot(rx, ry);
        if (r > 0.05) impulse(o, rx, ry, J);
        else if (from.x != null) impulse(o, o.x - from.x, o.y - from.y, J);
      }
    } else if (target && !target.dead) {
      this.damage(target, src.damage, src);
      if (from.x != null) impulse(target, target.x - from.x, target.y - from.y, J);
    }
    this.emit({ e: 'hit', x, y, splash: src.splash ?? 0, kind, team });
  }

  damage(e, amount, src) {
    if (e.dead) return;
    const dealt = Math.min(amount, e.hp);
    e.hp -= amount;
    if (src && e.kind === 'tower') this.sides[1 - e.team].towerDamage += dealt;
    if (e.kind === 'tower' && e.towerKind === 'king' && !e.active && src) this.activateKing(e.team);
    if (e.hp <= 0) this.kill(e);
  }

  activateKing(team) {
    const king = this.entities.find((o) => o.kind === 'tower' && o.towerKind === 'king' && o.team === team);
    if (king && !king.active && !king.dead) {
      king.active = true;
      this.emit({ e: 'king', team });
    }
  }

  kill(e) {
    e.dead = true;
    e.hp = 0;
    this.emit({ e: 'death', id: e.id, x: e.x, y: e.y, kind: e.kind });
    if (e.deathDamage) {
      // Balloon: one last bomb where it pops.
      this.applyHit({ team: e.team, projectile: 'bomb', damage: e.deathDamage, splash: 2, hitsAir: false }, null, e.x, e.y);
    }
    if (e.kind !== 'tower') return;
    const scorer = this.sides[1 - e.team];
    this.emit({ e: 'tower', team: e.team, kind: e.towerKind, x: e.x, y: e.y });
    if (e.towerKind === 'king') {
      scorer.crowns = 3;
      this.finish(1 - e.team);
      return;
    }
    scorer.crowns++;
    this.activateKing(e.team);
    if (this.overtime) this.finish(1 - e.team);
  }

  /** Contacts: troop↔troop momentum exchange, then walls, towers, arena edges and the river. */
  separate() {
    const movers = this.entities.filter((e) => !e.dead && e.kind === 'troop');
    const solids = this.entities.filter((e) => !e.dead && (e.kind === 'tower' || e.kind === 'building'));
    for (let i = 0; i < movers.length; i++) {
      const a = movers[i];
      for (let j = i + 1; j < movers.length; j++) {
        const b = movers[j];
        if (a.air !== b.air) continue;
        collide(a, b, (a.radius + b.radius) * 0.85);
      }
      if (a.air) {
        a.x = clamp(a.x, 0.4, ARENA_W - 0.4);
        a.y = clamp(a.y, 0.4, ARENA_H - 0.4);
        continue;
      }
      for (const s of solids) {
        const dx = a.x - s.x;
        const dy = a.y - s.y;
        const d = Math.hypot(dx, dy) || 0.001;
        const min = solidGap(s, a);
        if (d < min) {
          a.x = s.x + (dx / d) * min;
          a.y = s.y + (dy / d) * min;
          blockVelocity(a, dx / d, dy / d);
        }
      }
      this.confine(a);
    }
  }

  /** Keeps a ground troop on the field: arena edges, and only crossing the river on a bridge. */
  confine(a) {
    if (a.x < 0.4 || a.x > ARENA_W - 0.4) {
      a.x = clamp(a.x, 0.4, ARENA_W - 0.4);
      a.vx = 0;
    }
    if (a.y < 0.4 || a.y > ARENA_H - 0.4) {
      a.y = clamp(a.y, 0.4, ARENA_H - 0.4);
      a.vy = 0;
    }
    if (Math.abs(a.y - RIVER_Y) < RIVER_HALF) {
      const bx = BRIDGES_X.reduce((best, x) => (Math.abs(a.x - x) < Math.abs(a.x - best) ? x : best));
      const off = a.x - bx;
      if (Math.abs(off) > BRIDGE_HALF + 0.5) {
        a.y = a.y < RIVER_Y ? RIVER_Y - RIVER_HALF : RIVER_Y + RIVER_HALF;
        a.vy = 0;
      } else if (Math.abs(off) > BRIDGE_HALF) {
        a.x = bx + Math.sign(off) * BRIDGE_HALF;
        a.vx = 0;
      }
    }
  }
}

export { CARD_BY_ID };
