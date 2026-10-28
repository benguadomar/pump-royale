import { CARD_BY_ID } from '../data/cards.js';
import { ARENA_H, RIVER_Y, BRIDGES_X } from './constants.js';

const TANKS = ['giant', 'pekka', 'hog-rider'];
// Preferred follow-up for each win condition; falls back to any ranged/swarm support.
const COMBOS = { giant: ['wizard', 'archer', 'bomber'], 'hog-rider': ['bomber', 'goblin', 'skeleton'], pekka: ['wizard', 'archer'] };
const SUPPORT = new Set(['wizard', 'archer', 'bomber', 'goblin', 'skeleton', 'barbarian']);
const TANK_COUNTERS = new Set(['pekka', 'barbarian', 'cannon', 'goblin', 'skeleton']);

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
    if (this.followUp()) return;
    if (this.defend()) return;
    this.attack();
  }

  hand() {
    return this.side.hand.map((id, i) => ({ i, card: CARD_BY_ID[id] })).filter(({ card }) => card.cost <= this.side.elixir);
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

    const score = ({ card }) => {
      let s = card.dps / 100 + Math.random() * 0.8;
      if (isTank && TANK_COUNTERS.has(card.id)) s += 4;
      if (buildingHunter && card.id === 'cannon') s += 3;
      if (swarm && card.splash) s += 4;
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
    this.tryPlay(choice, lead.x, this.y(y));
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
