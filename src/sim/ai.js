import { CARD_BY_ID, TOWER_SPELL_FACTOR, isSpell } from '../data/cards.js';
import { ARENA_H, ARENA_W, RIVER_Y, BRIDGES_X } from './constants.js';

const TANKS = ['giant', 'pekka', 'hog-rider', 'balloon', 'prince'];
// Preferred follow-up for each win condition; falls back to any ranged/swarm support.
const COMBOS = {
  giant: ['wizard', 'musketeer', 'baby-dragon', 'archer', 'bomber'],
  'hog-rider': ['freeze', 'bomber', 'goblin', 'skeleton', 'zap'],
  pekka: ['wizard', 'musketeer', 'archer'],
  balloon: ['rage', 'freeze', 'minions', 'baby-dragon'],
  prince: ['musketeer', 'wizard', 'minions', 'rage'],
};
const SUPPORT = new Set(['wizard', 'archer', 'bomber', 'goblin', 'skeleton', 'barbarian', 'musketeer', 'minions', 'baby-dragon', 'valkyrie', 'knight']);
const TANK_COUNTERS = new Set(['pekka', 'mini-pekka', 'barbarian', 'cannon', 'goblin', 'skeleton', 'inferno-tower', 'knight', 'prince', 'minions', 'tesla']);
const SWARM_SPELLS = new Set(['arrows', 'zap', 'fireball']);
/** Minimum enemy hp a damage spell must remove to be worth casting. */
const SPELL_VALUE = { arrows: 520, zap: 330, fireball: 900 };

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Autonomous opponent with the same elixir pool and regen as a player. It defends
 * whenever enemy troops press into its half and otherwise builds lane pushes:
 * a win condition first, then its combo partner right behind it.
 */
export class BattleAI {
  constructor(sim, team) {
    this.sim = sim;
    this.team = team;
    this.think = rand(2, 3.5);
    this.pending = null;
  }

  get side() {
    return this.sim.sides[this.team];
  }

  /** Mirror y so the logic reads as if the AI sits at the bottom. */
  y(v) {
    return this.team === 1 ? ARENA_H - v : v;
  }

  isOwnHalf(y) {
    return this.team === 1 ? y > RIVER_Y : y < RIVER_Y;
  }

  update(dt) {
    this.think -= dt;
    if (this.think > 0) return;
    this.think = rand(0.45, 1.0);
    if (this.castSpells()) return;
    if (this.followUp()) return;
    if (this.defend()) return;
    this.attack();
  }

  /** Affordable cards; troops/buildings only unless `spells` is set. */
  hand(spells = false) {
    return this.side.hand
      .map((id, i) => ({ i, card: CARD_BY_ID[id] }))
      .filter(({ card }) => card.cost <= this.side.elixir && isSpell(card) === spells);
  }

  enemies() {
    return this.sim.entities.filter((e) => !e.dead && e.team !== this.team);
  }

  /** Best place for an area spell and the hp it would remove there. */
  bestSpellSpot(card) {
    const sp = card.spell;
    let best = null;
    for (const c of this.enemies()) {
      if (c.kind === 'tower' || c.hidden) continue;
      let value = 0;
      for (const o of this.enemies()) {
        if (o.hidden || Math.hypot(o.x - c.x, o.y - c.y) > sp.radius + o.radius - 0.3) continue;
        value += o.kind === 'tower' ? Math.min(o.hp, sp.damage * TOWER_SPELL_FACTOR) : Math.min(o.hp, sp.damage);
      }
      if (!best || value > best.value) best = { x: c.x, y: c.y, value };
    }
    return best;
  }

  /** Spells: clear clusters, finish towers, reset Infernos/Princes, Freeze/Rage pushes, barrel towers. */
  castSpells() {
    const spells = this.hand(true);
    if (!spells.length) return false;
    const own = this.sim.entities.filter((e) => !e.dead && e.team === this.team && e.kind === 'troop');
    const enemyTowers = this.enemies().filter((e) => e.kind === 'tower');
    for (const choice of spells) {
      const { card } = choice;
      const sp = card.spell;
      if (SWARM_SPELLS.has(card.id)) {
        // Only spend a spell for clear value and never drain the bank doing it.
        const spot = this.bestSpellSpot(card);
        const reserve = this.side.elixir - card.cost >= 1.5;
        if (spot && reserve && spot.value >= SPELL_VALUE[card.id]) return this.sim.playCard(this.team, choice.i, spot.x, spot.y) === null;
        const finishable = enemyTowers.find((t) => t.hp < sp.damage * TOWER_SPELL_FACTOR + 40);
        if (finishable) return this.sim.playCard(this.team, choice.i, finishable.x, finishable.y) === null;
      }
      if (card.id === 'zap') {
        const hot = this.enemies().find((e) => (e.ramp && e.rampT > 1.5) || e.charging);
        if (hot) return this.sim.playCard(this.team, choice.i, hot.x, hot.y) === null;
      }
      if (card.id === 'freeze' || card.id === 'rage') {
        // Pushes reaching an enemy tower get frozen defenders / enraged attackers.
        for (const t of enemyTowers) {
          const attackers = own.filter((o) => Math.hypot(o.x - t.x, o.y - t.y) < 5);
          if (attackers.length >= 2 && attackers.reduce((s, o) => s + o.hp, 0) > 900) {
            const cx = attackers.reduce((s, o) => s + o.x, 0) / attackers.length;
            const cy = attackers.reduce((s, o) => s + o.y, 0) / attackers.length;
            return this.sim.playCard(this.team, choice.i, card.id === 'freeze' ? t.x : cx, card.id === 'freeze' ? t.y : cy) === null;
          }
        }
      }
      if (card.id === 'goblin-barrel' && this.side.elixir >= 6) {
        const t = enemyTowers.find((tw) => tw.towerKind === 'princess' && !this.enemies().some((o) => o.kind !== 'tower' && Math.hypot(o.x - tw.x, o.y - tw.y) < 4));
        if (t) return this.sim.playCard(this.team, choice.i, t.x, t.y + (this.team === 0 ? -1.6 : 1.6)) === null;
      }
    }
    return false;
  }

  tryPlay(choice, x, y) {
    for (const dx of [0, 0.8, -0.8, 1.6, -1.6]) {
      if (this.sim.playCard(this.team, choice.i, x + dx, y) === null) return true;
    }
    return false;
  }

  lastSpawned(cardId) {
    for (let i = this.sim.entities.length - 1; i >= 0; i--) {
      const e = this.sim.entities[i];
      if (e.team === this.team && e.card === cardId) return e;
    }
    return null;
  }

  /** Drops the combo partner behind a freshly launched win condition. */
  followUp() {
    const p = this.pending;
    if (!p) return false;
    if (p.tank.dead || p.tries-- <= 0) {
      this.pending = null;
      return false;
    }
    const options = this.hand();
    const preferred = options.filter(({ card }) => p.partners.includes(card.id));
    const choice = preferred[0] ?? options.find(({ card }) => SUPPORT.has(card.id) && card.cost <= 5);
    if (!choice) return true;
    const behind = this.y(this.y(p.tank.y) - (choice.card.range === 'Melee' ? 1 : 2.2));
    if (!this.isOwnHalf(behind)) {
      this.pending = null;
      return false;
    }
    if (this.tryPlay(choice, p.tank.x, behind)) this.pending = null;
    return true;
  }

  defend() {
    const enemyTeam = 1 - this.team;
    const threats = this.sim.entities.filter(
      (e) => !e.dead && e.team === enemyTeam && e.kind === 'troop' && (this.team === 1 ? e.y > RIVER_Y - 3 : e.y < RIVER_Y + 3),
    );
    if (!threats.length) return false;

    const ownNear = this.sim.entities.filter((e) => !e.dead && e.team === this.team && e.kind === 'troop' && this.isOwnHalf(e.y));
    const threatHp = threats.reduce((s, e) => s + e.hp, 0);
    const defenseHp = ownNear.reduce((s, e) => s + e.hp, 0);
    if (defenseHp > threatHp * 1.2) return false;

    const options = this.hand();
    if (!options.length) return true;

    const lead = threats.reduce((a, b) => (this.y(a.y) < this.y(b.y) ? a : b));
    const isTank = lead.maxHp > 1500;
    const swarm = threats.filter((t) => t.maxHp < 700).length >= 3;
    const buildingHunter = threats.some((t) => t.targets === 'buildings');
    const airShare = threats.filter((t) => t.air).reduce((s, t) => s + t.hp, 0) / Math.max(1, threatHp);

    const score = ({ card }) => {
      let s = card.dps / 100 + Math.random() * 0.8;
      if (isTank && TANK_COUNTERS.has(card.id)) s += 4;
      if (buildingHunter && (card.id === 'cannon' || card.id === 'tesla' || card.id === 'inferno-tower')) s += 3;
      if (swarm && (card.splash || card.spin)) s += 4;
      // Mostly-air pushes can only be answered by cards that hit air.
      const hitsAir = card.targets === 'Air & Ground';
      if (airShare > 0.5) s += hitsAir ? 5 : -8;
      if (card.targets === 'Buildings') s -= 6;
      s -= card.cost * 0.35;
      return s;
    };
    const choice = options.sort((a, b) => score(b) - score(a))[0];
    if (score(choice) < 0) return true;

    if (choice.card.type === 'Building') {
      // Pull building-targeters into the middle, between both princess towers.
      const x = lead.x < 9 ? 7 : 11;
      return this.tryPlay(choice, x, this.y(10)) || true;
    }
    const back = choice.card.range === 'Melee' ? 1 : 3.5;
    const y = Math.min(Math.max(this.y(lead.y) - back, 1.5), RIVER_Y - 1.6);
    this.tryPlay(choice, Math.min(Math.max(lead.x, 1), ARENA_W - 1), this.y(y));
    return true;
  }

  attack() {
    const elixir = this.side.elixir;
    if (elixir < 7 && Math.random() < 0.9) return;
    const options = this.hand();
    const tanks = options.filter(({ card }) => TANKS.includes(card.id));
    const choice = tanks.length ? pick(tanks) : elixir >= 9.5 ? pick(options.filter(({ card }) => card.type !== 'Building')) : null;
    if (!choice) return;

    const lane = this.weakerLane();
    const slow = choice.card.speed === 'Slow';
    const y = slow ? rand(2.5, 4) : rand(11, 13.5);
    if (this.tryPlay(choice, lane, this.y(y)) && COMBOS[choice.card.id]) {
      this.pending = { tank: this.lastSpawned(choice.card.id), partners: COMBOS[choice.card.id], tries: 8 };
    }
  }

  /** Lane whose enemy princess tower has less health (or is already down). */
  weakerLane() {
    const enemy = 1 - this.team;
    const hpAt = (x) => {
      const t = this.sim.entities.find((e) => e.team === enemy && e.kind === 'tower' && e.towerKind === 'princess' && e.x < 9 === x < 9);
      return t && !t.dead ? t.hp : 0;
    };
    const [l, r] = BRIDGES_X;
    const hl = hpAt(l);
    const hr = hpAt(r);
    if (Math.abs(hl - hr) < 200) return Math.random() < 0.5 ? l : r;
    return hl < hr ? l : r;
  }
}
