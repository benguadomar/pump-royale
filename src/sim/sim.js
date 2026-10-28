import { CARDS, CARD_BY_ID, TOWERS, SPEEDS, rangeOf } from '../data/cards.js';
import {
  ARENA_W, ARENA_H, RIVER_Y, RIVER_HALF, BRIDGES_X, BRIDGE_HALF, TOWER_LAYOUT,
  MATCH_TIME, OVERTIME, DOUBLE_ELIXIR_AT, ELIXIR_PER_SEC, MAX_ELIXIR, START_ELIXIR, DEPLOY_TIME, SIM_DT,
  zoneAllows,
} from './constants.js';

const SIGHT = 5.5;
const RETARGET_EVERY = 0.25;
const PROJECTILE_SPEED = { arrow: 16, bomb: 8, fireball: 11, cannonball: 14 };
const TOWER_HEIGHT = { king: 5.4, princess: 4.8 };

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function shuffle(a, rand = Math.random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const randomDeck = () => shuffle(CARDS.map((c) => c.id)).slice(0, 8);

/** Per-team hand, elixir and stats. The played card goes to the back of the queue. */
class Side {
  constructor(deck) {
    const order = shuffle([...deck]);
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
  constructor(decks) {
    this.time = MATCH_TIME;
    this.elapsed = 0;
    this.overtime = false;
    this.over = false;
    this.winner = undefined;
    this.entities = [];
    this.projectiles = [];
    this.events = [];
    this.nextId = 1;
    this.acc = 0;
    this.sides = decks.map((d) => new Side(d));
    for (const t of TOWER_LAYOUT) this.spawnTower(t);
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
    if (!this.canDeploy(team, x, y)) return 'zone';
    side.elixir -= card.cost;
    side.cardsPlayed++;
    side.totalCost += card.cost;
    side.deployed[card.id] = (side.deployed[card.id] ?? 0) + 1;
    side.cycle(handIndex);
    this.spawnCard(card, team, x, y);
    this.emit({ e: 'deploy', team, card: card.id, x, y });
    return null;
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
    this.addEntity({
      kind: 'tower',
      towerKind: kind,
      team,
      x,
      y,
      hp: def.hp,
      maxHp: def.hp,
      radius: kind === 'king' ? 2.0 : 1.5,
      range: def.range,
      damage: def.damage,
      hitSpeed: def.hitSpeed,
      targets: 'any',
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

  spawnUnit(card, team, x, y) {
    this.addEntity({
      kind: card.type === 'Building' ? 'building' : 'troop',
      card: card.id,
      team,
      x,
      y,
      hp: card.hp,
      maxHp: card.hp,
      radius: card.radius,
      range: rangeOf(card),
      melee: card.range === 'Melee',
      damage: card.damage,
      hitSpeed: card.hitSpeed,
      speed: SPEEDS[card.speed] ?? 0,
      targets: card.targets === 'Buildings' ? 'buildings' : 'any',
      splash: card.splash ?? 0,
      projectile: card.projectile,
      lifetime: card.lifetime,
      deploy: DEPLOY_TIME,
      cd: 0.5,
      height: card.size,
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
    this.time -= dt;
    this.elapsed += dt;
    const rate = ELIXIR_PER_SEC * (this.doubleElixir ? 2 : 1);
    for (const s of this.sides) s.elixir = Math.min(MAX_ELIXIR, s.elixir + rate * dt);
    this.onStep?.(dt);

    // Alternate update order each tick so neither team systematically acts first.
    this.flipOrder = !this.flipOrder;
    const list = this.flipOrder ? [...this.entities].reverse() : this.entities;
    for (const e of list) if (!e.dead) this.stepEntity(e, dt);
    this.separate();
    this.updateProjectiles(dt);
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
    if (o.dead || o.team === e.team) return false;
    if (o.kind === 'troop' && o.deploy > 0) return false;
    if (e.targets === 'buildings') return o.kind === 'tower' || o.kind === 'building';
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
      if (o.dead || o.team === e.team || (o.kind !== 'tower' && o.kind !== 'building')) continue;
      const d = this.pathDist(e, o);
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
    if (e.deploy > 0) {
      e.deploy -= dt;
      return;
    }
    if (e.kind === 'building') {
      this.damage(e, (e.maxHp / e.lifetime) * dt, null);
      if (e.dead) return;
    }
    if (e.kind === 'tower' && !e.active) return;

    e.cd = Math.max(0, e.cd - dt);
    e.retarget -= dt;
    const t = e.target;
    const stale = !t || t.dead || (e.kind !== 'troop' && !this.inReach(e, t));
    const locked = t && !t.dead && this.inReach(e, t);
    if (stale || (e.retarget <= 0 && !locked)) {
      e.retarget = RETARGET_EVERY;
      const next = this.findTarget(e);
      if (next && next !== e.target && e.kind === 'troop') e.cd = Math.max(e.cd, e.hitSpeed * 0.35);
      e.target = next;
    }

    const target = e.target;
    e.moving = false;
    if (!target) return;
    if (this.inReach(e, target)) {
      e.facingLeft = target.x < e.x;
      if (e.cd <= 0) {
        e.cd = e.hitSpeed;
        this.attack(e, target);
      }
    } else if (e.kind === 'troop') {
      this.moveToward(e, target, dt);
    }
  }

  moveToward(e, target, dt) {
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
    const dx = gx - e.x;
    const dy = gy - e.y;
    const len = Math.hypot(dx, dy) || 1;
    const stepLen = Math.min(len, e.speed * dt);
    e.x += (dx / len) * stepLen;
    e.y += (dy / len) * stepLen;
    e.moving = true;
    if (Math.abs(dx) > 0.05) e.facingLeft = dx < 0;
  }

  attack(e, target) {
    e.lunge = 0.14;
    if (!e.projectile || e.melee) {
      this.emit({ e: 'melee', from: e.id, to: target.id, card: e.card ?? null });
      this.applyHit(e, target, target.x, target.y);
      return;
    }
    const kind = e.projectile;
    const fh = e.kind === 'tower' ? e.height * 0.8 : e.height * 0.6;
    const flight = Math.max(0.12, dist(e, target) / PROJECTILE_SPEED[kind]);
    this.projectiles.push({ kind, target, tx: target.x, ty: target.y, t: 0, flight, source: e, team: e.team, damage: e.damage, splash: e.splash ?? 0 });
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
    if (src.splash > 0) {
      for (const o of this.entities) {
        if (o.dead || o.team === team) continue;
        if (o.kind === 'troop' && o.deploy > 0) continue;
        if (Math.hypot(o.x - x, o.y - y) <= src.splash + o.radius) this.damage(o, src.damage, src);
      }
    } else if (target && !target.dead) {
      this.damage(target, src.damage, src);
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

  separate() {
    const movers = this.entities.filter((e) => !e.dead && e.kind === 'troop');
    const solids = this.entities.filter((e) => !e.dead && (e.kind === 'tower' || e.kind === 'building'));
    for (let i = 0; i < movers.length; i++) {
      const a = movers[i];
      for (let j = i + 1; j < movers.length; j++) {
        const b = movers[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.001;
        const min = (a.radius + b.radius) * 0.85;
        if (d >= min) continue;
        const push = min - d;
        const wa = b.radius / (a.radius + b.radius);
        a.x -= (dx / d) * push * wa;
        a.y -= (dy / d) * push * wa;
        b.x += (dx / d) * push * (1 - wa);
        b.y += (dy / d) * push * (1 - wa);
      }
      for (const s of solids) {
        const dx = a.x - s.x;
        const dy = a.y - s.y;
        const d = Math.hypot(dx, dy) || 0.001;
        const min = s.radius * 0.8 + a.radius * 0.5;
        if (d < min) {
          a.x = s.x + (dx / d) * min;
          a.y = s.y + (dy / d) * min;
        }
      }
      a.x = clamp(a.x, 0.4, ARENA_W - 0.4);
      a.y = clamp(a.y, 0.4, ARENA_H - 0.4);
      if (Math.abs(a.y - RIVER_Y) < RIVER_HALF) {
        const bx = BRIDGES_X.reduce((best, x) => (Math.abs(a.x - x) < Math.abs(a.x - best) ? x : best));
        const off = a.x - bx;
        if (Math.abs(off) > BRIDGE_HALF + 0.5) a.y = a.y < RIVER_Y ? RIVER_Y - RIVER_HALF : RIVER_Y + RIVER_HALF;
        else if (Math.abs(off) > BRIDGE_HALF) a.x = bx + Math.sign(off) * BRIDGE_HALF;
      }
    }
  }
}

export { CARD_BY_ID };
