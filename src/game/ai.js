import { CARD_BY_ID } from '../data/cards.js';
import { ARENA_H, RIVER_Y, BRIDGES_X } from './arena.js';

const TANKS = new Set(['giant', 'pekka', 'hog-rider']);
const SUPPORT = new Set(['wizard', 'archer', 'bomber']);
const SWARM = new Set(['skeleton', 'goblin', 'barbarian']);

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * A simple opponent: defends anything that crosses into its half, otherwise
 * builds a push on one lane (tank first, support behind) once elixir allows.
 */
export class BattleAI {
  constructor(battle, team) {
    this.battle = battle;
    this.team = team;
    this.think = rand(2, 3.5);
    this.pushLane = pick(BRIDGES_X);
    this.supportFor = null;
  }

  get side() {
    return this.battle.sides[this.team];
  }

  /** Mirror y so the logic can be written as if the AI sits at the bottom. */
  y(v) {
    return this.team === 1 ? ARENA_H - v : v;
  }

  update(dt) {
    this.think -= dt;
    if (this.think > 0) return;
    this.think = rand(0.5, 1.1);
    if (this.defend()) return;
    this.attack();
  }

  hand() {
    return this.side.hand.map((id, i) => ({ i, card: CARD_BY_ID[id] })).filter(({ card }) => card.cost <= this.side.elixir);
  }

  tryPlay(choice, x, y) {
    for (const dx of [0, 0.8, -0.8, 1.6, -1.6]) {
      if (this.battle.playCard(this.team, choice.i, x + dx, y)) return true;
    }
    return false;
  }

  defend() {
    const enemyTeam = 1 - this.team;
    const threats = this.battle.entities.filter(
      (e) => !e.dead && e.team === enemyTeam && e.kind === 'troop' && (this.team === 1 ? e.y > RIVER_Y - 3 : e.y < RIVER_Y + 3),
    );
    if (!threats.length) return false;

    const ownNear = this.battle.entities.filter((e) => !e.dead && e.team === this.team && e.kind === 'troop' && this.isOwnHalf(e.y));
    const threatHp = threats.reduce((s, e) => s + e.hp, 0);
    const defenseHp = ownNear.reduce((s, e) => s + e.hp, 0);
    if (defenseHp > threatHp * 1.2) return false;

    const options = this.hand();
    if (!options.length) return true;

    const lead = threats.reduce((a, b) => (this.y(a.y) < this.y(b.y) ? a : b));
    const isTank = lead.maxHp > 1500;
    const swarmCount = threats.filter((t) => t.maxHp < 700).length;

    const score = ({ card }) => {
      let s = card.dps / 100 + Math.random();
      if (isTank && (card.id === 'pekka' || card.id === 'barbarian' || card.id === 'cannon' || card.id === 'goblin')) s += 4;
      if (swarmCount >= 3 && card.splash) s += 4;
      if (card.targets === 'Buildings') s -= 6;
      s -= card.cost * 0.35;
      return s;
    };
    const choice = options.sort((a, b) => score(b) - score(a))[0];
    if (score(choice) < 0) return true;

    if (choice.card.type === 'Building') {
      const x = lead.x < 9 ? 6.5 : 11.5;
      return this.tryPlay(choice, x, this.y(10)) || true;
    }
    // Meet ranged/splash units a bit behind the threat; melee right on top of it.
    const back = choice.card.range === 'Melee' ? 1 : 3.5;
    const ty = Math.max(this.y(lead.y) - back, 1.5);
    const y = Math.min(ty, RIVER_Y - 1.6);
    this.tryPlay(choice, lead.x, this.y(y));
    return true;
  }

  isOwnHalf(y) {
    return this.team === 1 ? y > RIVER_Y : y < RIVER_Y;
  }

  attack() {
    const options = this.hand();
    const elixir = this.side.elixir;

    if (this.supportFor && !this.supportFor.dead) {
      const support = options.filter(({ card }) => SUPPORT.has(card.id) || SWARM.has(card.id));
      if (support.length && Math.random() < 0.8) {
        const t = this.supportFor;
        const behind = this.y(this.y(t.y) - 1.8);
        if (this.isOwnHalf(behind) && this.tryPlay(pick(support), t.x, behind)) {
          this.supportFor = null;
          return;
        }
      }
    }

    if (elixir < 7.5 && Math.random() < 0.85) return;

    const tanks = options.filter(({ card }) => TANKS.has(card.id));
    const choice = tanks.length ? pick(tanks) : pick(options.filter(({ card }) => card.type !== 'Building'));
    if (!choice) return;

    this.pushLane = this.weakerLane();
    const slowTank = choice.card.speed === 'Slow';
    const y = slowTank ? rand(2.5, 4) : rand(11, 13.5);
    if (this.tryPlay(choice, this.pushLane, this.y(y))) {
      const placed = this.battle.entities.at(-1);
      if (TANKS.has(choice.card.id)) this.supportFor = placed;
    }
  }

  /** Lane whose enemy princess tower has less health (or is already down). */
  weakerLane() {
    const enemy = 1 - this.team;
    const hpAt = (x) => {
      const t = this.battle.entities.find((e) => e.team === enemy && e.kind === 'tower' && e.towerKind === 'princess' && (e.x < 9) === (x < 9));
      return t && !t.dead ? t.hp : 0;
    };
    const [l, r] = BRIDGES_X;
    const hl = hpAt(l);
    const hr = hpAt(r);
    if (Math.abs(hl - hr) < 200) return Math.random() < 0.5 ? l : r;
    return hl < hr ? l : r;
  }
}
