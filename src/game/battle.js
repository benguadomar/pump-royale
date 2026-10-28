import * as THREE from 'three';
import { ARENA_W, ARENA_H, RIVER_Y, BRIDGES_X, TOWER_LAYOUT, tileToWorld } from './arena.js';
import { CARDS, CARD_BY_ID, TOWERS, SPEEDS, cardImg, rangeOf } from '../data/cards.js';
import { sfx } from '../audio.js';
import { BattleAI } from './ai.js';

export const MATCH_TIME = 180;
export const OVERTIME = 60;
const DOUBLE_ELIXIR_AT = 60;
const ELIXIR_PER_SEC = 1 / 2.8;
const MAX_ELIXIR = 10;
const START_ELIXIR = 5;
const DEPLOY_TIME = 1.0;
const SIGHT = 5.5;
const RETARGET_EVERY = 0.25;
const RIVER_HALF = 1.1;
const BRIDGE_HALF = 1.0;
const TEAM_COLOR = [0x3d8ff0, 0xe2463c];

const PROJECTILE = {
  arrow: { speed: 16, arc: 0.6 },
  bomb: { speed: 8, arc: 2.2 },
  fireball: { speed: 11, arc: 0.8 },
  cannonball: { speed: 14, arc: 0.4 },
};

const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Per-team hand + elixir. Cards cycle: the played card goes to the back of the queue. */
class Side {
  constructor(deck) {
    const order = shuffle([...deck]);
    this.hand = order.slice(0, 4);
    this.queue = order.slice(4);
    this.elixir = START_ELIXIR;
    this.crowns = 0;
    this.cardsPlayed = 0;
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

export class Battle {
  constructor(arena, playerDeck, { onEnd, onEvent } = {}) {
    this.arena = arena;
    this.onEnd = onEnd;
    this.onEvent = onEvent ?? (() => {});
    this.time = MATCH_TIME;
    this.overtime = false;
    this.over = false;
    this.entities = [];
    this.projectiles = [];
    this.effects = [];
    this.nextId = 1;
    this.flipTex = new Map();

    const aiDeck = shuffle(CARDS.map((c) => c.id)).slice(0, 8);
    this.sides = [new Side(playerDeck), new Side(aiDeck)];

    this.group = new THREE.Group();
    arena.scene.add(this.group);
    this.buildShared();
    for (const t of TOWER_LAYOUT) this.spawnTower(t);
    this.buildZoneOverlay();

    this.ai = new BattleAI(this, 1);
    this.unsub = arena.onUpdate((dt, t) => this.update(dt, t));
  }

  get doubleElixir() {
    return this.overtime || this.time <= DOUBLE_ELIXIR_AT;
  }

  // ------------------------------------------------------------- deploy rules

  towerAlive(team, kind, x) {
    return this.entities.some((e) => e.kind === 'tower' && e.team === team && e.towerKind === kind && !e.dead && (x == null || (e.x < 9) === (x < 9)));
  }

  /** Whether `team` may deploy at tile (x, y). */
  canDeploy(team, x, y) {
    if (x < 0.5 || x > ARENA_W - 0.5 || y < 0.5 || y > ARENA_H - 0.5) return false;
    if (Math.abs(y - RIVER_Y) < RIVER_HALF + 0.1) return false;
    for (const e of this.entities) {
      if ((e.kind === 'tower' || e.kind === 'building') && !e.dead && dist(e, { x, y }) < e.radius) return false;
    }
    const enemy = 1 - team;
    const ownHalf = team === 0 ? y < RIVER_Y : y > RIVER_Y;
    if (ownHalf) return true;
    // A fallen enemy princess tower opens that flank up to a few tiles past the river.
    if (this.towerAlive(enemy, 'princess', x)) return false;
    return team === 0 ? y <= RIVER_Y + 5.5 : y >= RIVER_Y - 5.5;
  }

  /** Returns false (and does nothing) if the move is invalid. */
  playCard(team, handIndex, x, y) {
    if (this.over) return false;
    const side = this.sides[team];
    const card = CARD_BY_ID[side.hand[handIndex]];
    if (!card || side.elixir < card.cost || !this.canDeploy(team, x, y)) return false;
    side.elixir -= card.cost;
    side.cardsPlayed++;
    side.cycle(handIndex);
    this.spawnCard(card, team, x, y);
    if (team === 0) sfx.deploy();
    this.onEvent({ type: 'deploy', team, card });
    return true;
  }

  // ------------------------------------------------------------- spawning

  buildShared() {
    this.geo = {
      disc: new THREE.CircleGeometry(1, 24),
      ring: new THREE.RingGeometry(0.85, 1, 32),
      sphere: new THREE.SphereGeometry(1, 12, 10),
      arrow: new THREE.CylinderGeometry(0.04, 0.04, 0.8, 5),
      rubble: new THREE.DodecahedronGeometry(0.5, 0),
    };
    this.geo.disc.rotateX(-Math.PI / 2);
    this.geo.ring.rotateX(-Math.PI / 2);
    this.geo.arrow.rotateX(Math.PI / 2);
    this.mat = {
      shadow: TEAM_COLOR.map((c) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.35, depthWrite: false })),
      barBg: new THREE.SpriteMaterial({ color: 0x1a0d05, depthTest: false }),
      barFill: TEAM_COLOR.map((c) => new THREE.SpriteMaterial({ color: c, depthTest: false })),
      arrow: new THREE.MeshStandardMaterial({ color: 0x8a5a2b }),
      bomb: new THREE.MeshStandardMaterial({ color: 0x1d1d1f, roughness: 0.4 }),
      cannonball: new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.4, metalness: 0.4 }),
      fireball: new THREE.MeshBasicMaterial({ color: 0xff8a1f }),
      rubble: new THREE.MeshStandardMaterial({ color: 0x7d7f86, roughness: 1 }),
    };
  }

  textureFor(url, flipped) {
    const base = this.arena.textures.get(url);
    if (!flipped || !base) return base;
    if (!this.flipTex.has(url)) {
      const t = base.clone();
      t.wrapS = THREE.RepeatWrapping;
      t.repeat.x = -1;
      t.needsUpdate = true;
      this.flipTex.set(url, t);
    }
    return this.flipTex.get(url);
  }

  makeHpBar(width, yPos, team) {
    const bar = new THREE.Group();
    const bg = new THREE.Sprite(this.mat.barBg);
    bg.scale.set(width + 0.08, 0.2, 1);
    const fill = new THREE.Sprite(this.mat.barFill[team]);
    fill.center.set(0, 0.5);
    fill.position.x = -width / 2;
    fill.scale.set(width, 0.13, 1);
    fill.renderOrder = 2;
    bg.renderOrder = 1;
    bar.add(bg, fill);
    bar.position.y = yPos;
    bar.userData = { fill, width };
    return bar;
  }

  addEntity(e) {
    e.id = this.nextId++;
    e.dead = false;
    e.cd = e.cd ?? 0.4;
    e.retarget = 0;
    e.target = null;
    e.hitFlash = 0;
    e.lunge = 0;
    e.facingLeft = e.team === 1;
    this.entities.push(e);
    return e;
  }

  spawnTower({ kind, team, x, y }) {
    const def = TOWERS[kind];
    const obj = this.arena.makeTower(kind, team);
    obj.position.copy(tileToWorld(x, y));
    const height = kind === 'king' ? 5.4 : 4.8;
    const hpBar = this.makeHpBar(kind === 'king' ? 2.8 : 2.4, height + 0.4, team);
    obj.add(hpBar);
    this.group.add(obj);
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
      obj,
      sprite: obj.userData.sprite,
      hpBar,
      height,
    });
  }

  spawnCard(card, team, x, y) {
    const n = card.count;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (team ? Math.PI : 0);
      const r = n === 1 ? 0 : n === 2 ? 0.55 : 0.75;
      this.spawnUnit(card, team, clamp(x + Math.cos(a) * r, 0.5, ARENA_W - 0.5), clamp(y + Math.sin(a) * r, 0.5, ARENA_H - 0.5));
    }
    this.ringEffect(x, y, TEAM_COLOR[team], 1.6, 0.45);
  }

  spawnUnit(card, team, x, y) {
    const obj = new THREE.Group();
    const url = cardImg(card.id);
    const sprite = this.arena.makeSprite(url, card.size);
    sprite.material = sprite.material.clone();
    if (team === 1) sprite.material.color.set(0xffd6d0);
    sprite.material.map = this.textureFor(url, team === 1);
    sprite.material.opacity = 0.5;
    sprite.material.transparent = true;
    const shadow = new THREE.Mesh(this.geo.disc, this.mat.shadow[team]);
    shadow.scale.setScalar(card.radius * 1.2);
    shadow.position.y = 0.04;
    const hpBar = this.makeHpBar(Math.max(0.9, card.radius * 2), card.size + 0.25, team);
    hpBar.visible = false;
    obj.add(shadow, sprite, hpBar);
    obj.position.copy(tileToWorld(x, y));
    this.group.add(obj);

    const isBuilding = card.type === 'Building';
    this.addEntity({
      kind: isBuilding ? 'building' : 'troop',
      card,
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
      obj,
      sprite,
      hpBar,
      url,
      height: card.size,
    });
  }

  // ------------------------------------------------------------- simulation

  update(dt, t) {
    if (this.over) {
      this.updateVisuals(dt, t);
      return;
    }
    this.time -= dt;
    const rate = ELIXIR_PER_SEC * (this.doubleElixir ? 2 : 1);
    for (const s of this.sides) s.elixir = Math.min(MAX_ELIXIR, s.elixir + rate * dt);

    this.ai.update(dt);

    for (const e of this.entities) if (!e.dead) this.step(e, dt);
    this.separate();
    this.updateProjectiles(dt);
    this.updateVisuals(dt, t);

    if (this.time <= 0) this.onTimeUp();
  }

  onTimeUp() {
    const [a, b] = this.sides.map((s) => s.crowns);
    if (a !== b) return this.finish(a > b ? 0 : 1);
    if (!this.overtime) {
      this.overtime = true;
      this.time = OVERTIME;
      this.onEvent({ type: 'overtime' });
      return;
    }
    // Still tied after overtime: lowest single-tower health decides, else draw.
    const worst = (team) => Math.min(...this.entities.filter((e) => e.kind === 'tower' && e.team === team).map((e) => (e.dead ? 0 : e.hp / e.maxHp)));
    const w0 = worst(0);
    const w1 = worst(1);
    if (Math.abs(w0 - w1) < 0.001) return this.finish(null);
    this.finish(w0 > w1 ? 0 : 1);
  }

  finish(winner) {
    if (this.over) return;
    this.over = true;
    this.time = Math.max(0, this.time);
    this.winner = winner;
    this.hideZones();
    setTimeout(() => this.onEnd?.(this.result()), 1400);
  }

  result() {
    const [me, ai] = this.sides;
    return {
      result: this.winner === 0 ? 'win' : this.winner === 1 ? 'loss' : 'draw',
      myCrowns: me.crowns,
      enemyCrowns: ai.crowns,
      cardsPlayed: me.cardsPlayed,
    };
  }

  isValidTarget(e, o) {
    if (o.dead || o.team === e.team) return false;
    if (o.kind === 'troop' && o.deploy > 0) return false;
    if (e.targets === 'buildings') return o.kind === 'tower' || o.kind === 'building';
    return true;
  }

  /** Nearest enemy building, measured as if walking via a bridge when the river is in the way. */
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

  pathDist(a, b) {
    const sameSide = (a.y < RIVER_Y) === (b.y < RIVER_Y);
    if (sameSide) return dist(a, b);
    const bx = this.pickBridge(a.x, b.x);
    return Math.hypot(a.x - bx, a.y - RIVER_Y) + Math.hypot(b.x - bx, b.y - RIVER_Y);
  }

  pickBridge(fromX, toX) {
    return BRIDGES_X.reduce((best, bx) => (Math.abs(fromX - bx) + Math.abs(toX - bx) < Math.abs(fromX - best) + Math.abs(toX - best) ? bx : best));
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
    const d = dist(e, o) - o.radius - (e.melee ? e.radius : 0);
    return d <= e.range;
  }

  step(e, dt) {
    e.hitFlash = Math.max(0, e.hitFlash - dt);
    e.lunge = Math.max(0, e.lunge - dt);

    if (e.kind === 'troop' && e.deploy > 0) {
      e.deploy -= dt;
      return;
    }
    if (e.kind === 'building') {
      if (e.deploy > 0) {
        e.deploy -= dt;
        return;
      }
      this.damage(e, (e.maxHp / e.lifetime) * dt, null, true);
      if (e.dead) return;
    }
    if (e.kind === 'tower' && !e.active) return;

    e.cd = Math.max(0, e.cd - dt);
    e.retarget -= dt;
    const t = e.target;
    const stale = !t || t.dead || (e.kind !== 'troop' && !this.inReach(e, t));
    const lockedInFight = t && !t.dead && this.inReach(e, t);
    if (stale || (e.retarget <= 0 && !lockedInFight)) {
      e.retarget = RETARGET_EVERY;
      const next = this.findTarget(e);
      if (next !== e.target && next && e.kind === 'troop') e.cd = Math.max(e.cd, e.hitSpeed * 0.35);
      e.target = next;
    }

    const target = e.target;
    if (!target) return;
    if (this.inReach(e, target)) {
      e.moving = false;
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
    if (e.kind === 'tower' && e.team === 0) sfx.shoot();
    if (!e.projectile || e.melee) {
      this.applyHit(e, target, target.x, target.y);
      if (target.team === 0 || e.team === 0) sfx.hit();
      return;
    }
    const kind = e.projectile;
    const mesh = new THREE.Mesh(kind === 'arrow' ? this.geo.arrow : this.geo.sphere, this.mat[kind]);
    const size = { arrow: 1, bomb: 0.26, cannonball: 0.24, fireball: 0.34 }[kind];
    if (kind !== 'arrow') mesh.scale.setScalar(size);
    const startH = e.kind === 'tower' ? e.height * 0.8 : e.height * 0.6;
    mesh.position.copy(tileToWorld(e.x, e.y, startH));
    this.group.add(mesh);
    const from = { x: e.x, y: e.y, h: startH };
    const flight = Math.max(0.12, dist(e, target) / PROJECTILE[kind].speed);
    this.projectiles.push({ mesh, kind, from, target, tx: target.x, ty: target.y, t: 0, flight, source: e, team: e.team });
  }

  updateProjectiles(dt) {
    for (const p of this.projectiles) {
      p.t += dt;
      if (!p.target.dead) {
        p.tx = p.target.x;
        p.ty = p.target.y;
      }
      const k = Math.min(1, p.t / p.flight);
      const x = p.from.x + (p.tx - p.from.x) * k;
      const y = p.from.y + (p.ty - p.from.y) * k;
      const endH = (p.target.height ?? 1) * 0.5;
      const hgt = p.from.h + (endH - p.from.h) * k + Math.sin(Math.PI * k) * PROJECTILE[p.kind].arc;
      const prev = p.mesh.position.clone();
      p.mesh.position.copy(tileToWorld(x, y, hgt));
      if (p.kind === 'arrow') p.mesh.lookAt(p.mesh.position.clone().add(p.mesh.position.clone().sub(prev)));
      if (k >= 1) {
        p.done = true;
        this.group.remove(p.mesh);
        this.applyHit(p.source, p.target.dead ? null : p.target, p.tx, p.ty, p.team);
        if (p.kind !== 'arrow') sfx.hit();
      }
    }
    this.projectiles = this.projectiles.filter((p) => !p.done);
  }

  applyHit(src, target, x, y, team = src.team) {
    const splash = src.splash ?? 0;
    if (splash > 0) {
      for (const o of this.entities) {
        if (o.dead || o.team === team) continue;
        if (o.kind === 'troop' && o.deploy > 0) continue;
        if (Math.hypot(o.x - x, o.y - y) <= splash + o.radius) this.damage(o, src.damage, src);
      }
      this.ringEffect(x, y, src.projectile === 'fireball' ? 0xff7a1a : 0xffd27a, splash, 0.35);
      if (src.projectile === 'bomb') sfx.boom();
    } else if (target && !target.dead) {
      this.damage(target, src.damage, src);
    }
  }

  damage(e, amount, src, silent = false) {
    if (e.dead) return;
    e.hp -= amount;
    if (!silent) e.hitFlash = 0.12;
    if (e.kind === 'tower' && e.towerKind === 'king' && !e.active && src) this.activateKing(e.team);
    if (e.hp <= 0) this.kill(e);
  }

  activateKing(team) {
    const king = this.entities.find((o) => o.kind === 'tower' && o.towerKind === 'king' && o.team === team);
    if (king && !king.active && !king.dead) {
      king.active = true;
      this.onEvent({ type: 'king-awake', team });
    }
  }

  kill(e) {
    e.dead = true;
    e.hp = 0;
    e.deathT = 0;
    if (e.kind !== 'tower') return;

    const scorer = this.sides[1 - e.team];
    sfx.tower();
    this.ringEffect(e.x, e.y, 0xffc04a, 3, 0.7);
    e.sprite.visible = false;
    e.hpBar.visible = false;
    for (let i = 0; i < 7; i++) {
      const r = new THREE.Mesh(this.geo.rubble, this.mat.rubble);
      r.position.set((Math.random() - 0.5) * 2.4, 0.25, (Math.random() - 0.5) * 2.4);
      r.rotation.set(Math.random() * 3, Math.random() * 3, 0);
      r.scale.setScalar(0.5 + Math.random() * 0.7);
      r.castShadow = true;
      e.obj.add(r);
    }
    if (e.towerKind === 'king') {
      scorer.crowns = 3;
      this.onEvent({ type: 'tower', team: e.team, kind: 'king' });
      this.finish(1 - e.team);
      return;
    }
    scorer.crowns++;
    this.activateKing(e.team);
    this.refreshZones();
    this.onEvent({ type: 'tower', team: e.team, kind: 'princess' });
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
        const push = (min - d) / 2;
        const wa = b.radius / (a.radius + b.radius);
        a.x -= (dx / d) * push * wa * 2;
        a.y -= (dy / d) * push * wa * 2;
        b.x += (dx / d) * push * (1 - wa) * 2;
        b.y += (dy / d) * push * (1 - wa) * 2;
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
      // Keep troops out of the water unless they're on a bridge.
      if (Math.abs(a.y - RIVER_Y) < RIVER_HALF) {
        const bx = BRIDGES_X.reduce((best, x) => (Math.abs(a.x - x) < Math.abs(a.x - best) ? x : best));
        const off = a.x - bx;
        if (Math.abs(off) > BRIDGE_HALF + 0.5) a.y = a.y < RIVER_Y ? RIVER_Y - RIVER_HALF : RIVER_Y + RIVER_HALF;
        else if (Math.abs(off) > BRIDGE_HALF) a.x = bx + Math.sign(off) * BRIDGE_HALF;
      }
    }
  }

  // ------------------------------------------------------------- visuals

  updateVisuals(dt, t) {
    for (const e of this.entities) {
      if (e.kind === 'tower') {
        if (e.dead) continue;
        const f = clamp(e.hp / e.maxHp, 0, 1);
        e.hpBar.userData.fill.scale.x = e.hpBar.userData.width * f;
        e.sprite.material.color.setHex(e.hitFlash > 0 ? 0xffb0a0 : e.team === 1 ? 0xffc2c2 : 0xffffff);
        e.sprite.scale.y = e.sprite.userData.baseY ??= e.sprite.scale.y;
        if (e.lunge > 0) e.sprite.scale.y = e.sprite.userData.baseY * 0.97;
        continue;
      }
      if (e.dead) {
        e.deathT += dt;
        e.sprite.material.opacity = Math.max(0, 1 - e.deathT / 0.35);
        e.obj.position.y = -e.deathT * 0.8;
        e.hpBar.visible = false;
        if (e.deathT > 0.35) e.removed = true;
        continue;
      }
      const pos = tileToWorld(e.x, e.y);
      const deploying = e.deploy > 0;
      e.obj.position.copy(pos);
      if (deploying) {
        const k = 1 - e.deploy / DEPLOY_TIME;
        e.sprite.position.y = Math.max(0, (1 - k * 3) * 2.5);
        e.sprite.material.opacity = 0.45 + 0.4 * Math.min(1, k * 3);
      } else {
        e.sprite.material.opacity = 1;
        const bob = e.moving ? Math.abs(Math.sin(t * 11 + e.id)) * 0.14 : 0;
        e.sprite.position.y = bob;
      }
      const flipped = e.facingLeft;
      const tex = this.textureFor(e.url, flipped);
      if (e.sprite.material.map !== tex) e.sprite.material.map = tex;
      const tint = e.hitFlash > 0 ? 0xff8f80 : e.team === 1 ? 0xffd6d0 : 0xffffff;
      e.sprite.material.color.setHex(tint);
      const s = 1 + (e.lunge > 0 ? 0.1 : 0);
      e.sprite.scale.set((e.sprite.userData.bx ??= e.sprite.scale.x) * s, (e.sprite.userData.by ??= e.sprite.scale.y) * s, 1);
      const f = clamp(e.hp / e.maxHp, 0, 1);
      e.hpBar.visible = f < 0.999 || e.kind === 'building';
      e.hpBar.userData.fill.scale.x = e.hpBar.userData.width * f;
    }
    for (const e of this.entities) if (e.removed) this.group.remove(e.obj);
    this.entities = this.entities.filter((e) => !e.removed);

    for (const fx of this.effects) {
      fx.t += dt;
      const k = fx.t / fx.dur;
      fx.mesh.scale.setScalar(fx.size * (0.3 + 0.7 * k));
      fx.mesh.material.opacity = 0.75 * (1 - k);
      if (k >= 1) {
        this.group.remove(fx.mesh);
        fx.mesh.material.dispose();
        fx.done = true;
      }
    }
    this.effects = this.effects.filter((f) => !f.done);

    if (this.preview) this.preview.obj.visible = this.preview.visible;
  }

  ringEffect(x, y, color, size, dur) {
    const mesh = new THREE.Mesh(this.geo.ring, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide }));
    mesh.position.copy(tileToWorld(x, y, 0.08));
    this.group.add(mesh);
    this.effects.push({ mesh, t: 0, dur, size });
  }

  // ------------------------------------------------------------- deploy preview / zones

  buildZoneOverlay() {
    const c = document.createElement('canvas');
    c.width = ARENA_W * 8;
    c.height = ARENA_H * 8;
    this.zoneCanvas = c;
    this.zoneTex = new THREE.CanvasTexture(c);
    this.zoneTex.magFilter = THREE.NearestFilter;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_W, ARENA_H),
      new THREE.MeshBasicMaterial({ map: this.zoneTex, transparent: true, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.06;
    mesh.visible = false;
    this.zoneMesh = mesh;
    this.group.add(mesh);
    this.refreshZones();
  }

  refreshZones() {
    const g = this.zoneCanvas.getContext('2d');
    const S = 8;
    g.clearRect(0, 0, this.zoneCanvas.width, this.zoneCanvas.height);
    g.fillStyle = 'rgba(230, 40, 40, 0.32)';
    for (let ty = 0; ty < ARENA_H; ty++) {
      for (let tx = 0; tx < ARENA_W; tx++) {
        if (!this.canDeployZone(0, tx + 0.5, ty + 0.5)) g.fillRect(tx * S, (ARENA_H - 1 - ty) * S, S, S);
      }
    }
    this.zoneTex.needsUpdate = true;
  }

  /** Like canDeploy but ignores buildings (which move/expire), for the painted overlay. */
  canDeployZone(team, x, y) {
    if (Math.abs(y - RIVER_Y) < RIVER_HALF + 0.1) return false;
    const ownHalf = team === 0 ? y < RIVER_Y : y > RIVER_Y;
    if (ownHalf) return true;
    if (this.towerAlive(1 - team, 'princess', x)) return false;
    return team === 0 ? y <= RIVER_Y + 5.5 : y >= RIVER_Y - 5.5;
  }

  showZones() {
    this.zoneMesh.visible = true;
  }
  hideZones() {
    this.zoneMesh.visible = false;
    this.setPreview(null);
  }

  /** Shows a translucent ghost of `cardId` at tile (x, y); pass null to hide. */
  setPreview(cardId, x, y) {
    if (!cardId) {
      if (this.preview) this.preview.visible = false;
      return;
    }
    if (!this.preview || this.preview.cardId !== cardId) {
      if (this.preview) this.group.remove(this.preview.obj);
      const card = CARD_BY_ID[cardId];
      const obj = new THREE.Group();
      const sprite = this.arena.makeSprite(cardImg(cardId), card.size);
      sprite.material = sprite.material.clone();
      sprite.material.opacity = 0.6;
      const ring = new THREE.Mesh(this.geo.ring, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }));
      ring.scale.setScalar(card.count > 1 ? 1.3 : Math.max(0.7, card.radius * 1.3));
      ring.position.y = 0.09;
      obj.add(sprite, ring);
      this.group.add(obj);
      this.preview = { cardId, obj, sprite, ring, visible: true };
    }
    const ok = this.canDeploy(0, x, y);
    this.preview.visible = true;
    this.preview.obj.position.copy(tileToWorld(x, y));
    this.preview.ring.material.color.setHex(ok ? 0xffffff : 0xff4a3a);
    this.preview.sprite.material.color.setHex(ok ? 0xffffff : 0xff7a70);
    return ok;
  }

  destroy() {
    this.unsub();
    this.arena.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.material && !Object.values(this.mat).flat().includes(o.material)) o.material.dispose?.();
    });
    Object.values(this.geo).forEach((g) => g.dispose());
    this.zoneTex.dispose();
    for (const t of this.flipTex.values()) t.dispose();
  }
}
