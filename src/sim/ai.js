import { CARD_BY_ID } from '../data/cards.js';
import { ARENA_H, ARENA_W, RIVER_Y, BRIDGES_X, ELIXIR_PER_SEC, MAX_ELIXIR } from './constants.js';
import { aiDifficulty } from './aiDifficulty.js';
import { rng } from './sim.js';

const TANKS = ['giant', 'pekka', 'hog-rider'];
const COMBOS = {
  giant: ['wizard', 'archer', 'bomber'],
  'hog-rider': ['bomber', 'goblin', 'skeleton'],
  pekka: ['wizard', 'archer', 'bomber'],
};
const SUPPORT = new Set(['wizard', 'archer', 'bomber', 'goblin', 'skeleton', 'barbarian']);
const TANK_COUNTERS = new Set(['pekka', 'barbarian', 'cannon', 'goblin', 'skeleton']);
const RANGED = new Set(['wizard', 'archer', 'bomber']);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const laneOf = (x) => (x < ARENA_W / 2 ? 0 : 1);
const laneX = (lane) => BRIDGES_X[lane];

/**
 * Arena-scaled autonomous opponent. Every tier uses normal cards, levels, elixir and
 * deploy rules. Higher tiers improve observation and planning rather than cheating.
 */
export class BattleAI {
  /**
   * options.difficulty is a difficulty id, arena id, or trophy count.
   * A function remains accepted as the third argument for older balance scripts.
   */
  constructor(sim, team, options = {}) {
    this.sim = sim;
    this.team = team;
    this.profile = aiDifficulty(typeof options === 'function' ? 0 : options.difficulty ?? options.tier ?? 0);
    this.random = typeof options === 'function' ? options : options.random ?? rng((sim.seed ^ Math.imul(team + 1, 0x9e3779b1)) >>> 0);
    this.nextThinkTick = sim.tick + this.profile.initialTicks + this.jitter();
    this.pending = null;
    this.supportedPushes = new Set();
    this.enemyElixir = 5;
    this.enemySpent = sim.sides[1 - team].totalCost;
    this.lastDecision = null;
  }

  rand(a, b) {
    return a + this.random() * (b - a);
  }

  jitter() {
    return this.profile.jitterTicks ? Math.floor(this.random() * (this.profile.jitterTicks + 1)) : 0;
  }

  get side() {
    return this.sim.sides[this.team];
  }

  /** Normalize y so every team reads its own king at the bottom. */
  y(v) {
    return this.team === 1 ? ARENA_H - v : v;
  }

  wy(v) {
    return this.team === 1 ? ARENA_H - v : v;
  }

  update(dt) {
    this.observeEnemyElixir(dt);
    if (this.sim.tick < this.nextThinkTick) return;
    this.nextThinkTick = this.sim.tick + this.profile.thinkTicks + this.jitter();

    // Emergency defense always interrupts an offensive combo.
    if (this.defend()) return;
    if (this.followUp()) return;
    if (this.profile.counterpush && this.supportCounterpush()) return;
    this.attack();
  }

  /** Public-information estimate: known regeneration minus visibly deployed card costs. */
  observeEnemyElixir(dt) {
    if (!this.profile.tracksElixir) return;
    const enemy = this.sim.sides[1 - this.team];
    const spent = Math.max(0, enemy.totalCost - this.enemySpent);
    this.enemySpent = enemy.totalCost;
    const rate = ELIXIR_PER_SEC * (this.sim.doubleElixir ? 2 : 1);
    this.enemyElixir = clamp(this.enemyElixir + rate * dt - spent, 0, MAX_ELIXIR);
  }

  /** Affordable cards in hand, in stable hand order. */
  hand() {
    return this.side.hand.map((id, i) => ({ i, card: CARD_BY_ID[id] })).filter(({ card }) => card.cost <= this.side.elixir);
  }

  tryPlay(choice, x, y) {
    for (const [dx, dy] of [[0, 0], [0.65, 0], [-0.65, 0], [1.3, 0], [-1.3, 0], [0, -0.65]]) {
      const px = clamp(x + dx, 0.6, ARENA_W - 0.6);
      const py = clamp(y + dy, 0.6, ARENA_H - 0.6);
      if (this.sim.playCard(this.team, choice.i, px, py) === null) {
        this.lastDecision = { tick: this.sim.tick, card: choice.card.id, x: px, y: py };
        return true;
      }
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

  /** Drops a combo partner behind a living win condition without blocking defense. */
  followUp() {
    const p = this.pending;
    if (!p) return false;
    if (p.tank.dead || this.sim.tick > p.expires) {
      this.pending = null;
      return false;
    }
    const options = this.hand();
    const preferred = options.filter(({ card }) => p.partners.includes(card.id));
    const choice = preferred[0] ?? options.find(({ card }) => SUPPORT.has(card.id) && card.cost <= 4);
    if (!choice) return false;
    const behind = clamp(this.y(p.tank.y) - (RANGED.has(choice.card.id) ? 2.4 : 1.35), 2.5, 15.1);
    const played = this.tryPlay(choice, p.tank.x, this.wy(behind));
    if (played) {
      this.supportedPushes.add(p.tank.id);
      this.pending = null;
    }
    return played;
  }

  entityDps(e) {
    return e.damage && e.hitSpeed ? e.damage / e.hitSpeed : 0;
  }

  threatValue(e) {
    const ny = this.y(e.y);
    const progress = clamp((20 - ny) / 14, 0, 1);
    const purpose = e.targets === 'buildings' ? 1.25 : 1;
    return (this.entityDps(e) * 0.75 + Math.max(0, e.hp) * 0.055) * purpose * (0.72 + progress * 0.85);
  }

  defenderValue(e, lane) {
    if (e.targets === 'buildings' || (this.profile.laneAware && laneOf(e.x) !== lane)) return 0;
    return this.entityDps(e) * 0.75 + Math.max(0, e.hp) * 0.05;
  }

  defend() {
    const enemyTeam = 1 - this.team;
    const threats = this.sim.entities.filter(
      (e) => !e.dead && !e.hidden && e.team === enemyTeam && e.kind === 'troop' && this.y(e.y) < RIVER_Y + 3.8,
    );
    if (!threats.length) return false;

    const defenders = this.sim.entities.filter(
      (e) => !e.dead && e.team === this.team && (e.kind === 'troop' || e.kind === 'building') && this.y(e.y) < RIVER_Y + 1.5,
    );
    const lanes = [0, 1].map((lane) => {
      const laneThreats = this.profile.laneAware ? threats.filter((e) => laneOf(e.x) === lane) : threats;
      const threat = laneThreats.reduce((sum, e) => sum + this.threatValue(e), 0);
      const defense = defenders.reduce((sum, e) => sum + this.defenderValue(e, lane), 0) * this.profile.defenseSense;
      return { lane, threats: laneThreats, threat, defense, deficit: threat - defense };
    });
    const danger = lanes.sort((a, b) => b.deficit - a.deficit || a.lane - b.lane)[0];
    if (!danger.threats.length || danger.deficit <= Math.max(28, danger.threat * 0.08)) return false;

    const options = this.hand();
    if (!options.length) return true;

    const lead = danger.threats.reduce((a, b) => (this.y(a.y) < this.y(b.y) ? a : b));
    const isTank = danger.threats.some((e) => e.maxHp >= 1500);
    const buildingHunter = danger.threats.some((e) => e.targets === 'buildings');
    const swarm = danger.threats.filter((e) => e.maxHp < 800).length >= 3;
    const scored = options.map((choice) => {
      const { card } = choice;
      const count = card.count ?? 1;
      let score = ((card.dps * count + card.hp * count * 0.045) / Math.max(1, card.cost)) * 0.055;
      if (isTank && TANK_COUNTERS.has(card.id)) score += card.id === 'pekka' ? 7 : 4;
      if (buildingHunter && card.id === 'cannon') score += 7;
      if (buildingHunter && (card.id === 'skeleton' || card.id === 'goblin')) score += 2.5;
      if (swarm && card.splash) score += 7;
      if (RANGED.has(card.id) && danger.threats.some((e) => e.melee)) score += 1.5;
      if (card.targets === 'Buildings') score -= 12;
      if (card.cost > this.side.elixir - 1 && danger.deficit < 180) score -= 2;
      score += (this.random() - 0.5) * this.profile.scoreNoise;
      return { ...choice, score };
    });
    scored.sort((a, b) => b.score - a.score || a.i - b.i || a.card.id.localeCompare(b.card.id));
    const choice = scored[0];
    if (!choice || choice.score < 0) return true;

    if (choice.card.type === 'Building') {
      // Pull win conditions toward the middle and into both crown towers' coverage.
      const x = danger.lane === 0 ? 7 : 11;
      return this.tryPlay(choice, x, this.wy(buildingHunter ? 10.3 : 8.8)) || true;
    }
    const back = RANGED.has(choice.card.id) ? 3.2 : choice.card.count > 1 ? 1.6 : 1.15;
    const y = clamp(this.y(lead.y) - back, 3.2, RIVER_Y - 1.25);
    const x = clamp(this.profile.laneAware ? lead.x : laneX(danger.lane), 1, ARENA_W - 1);
    this.tryPlay(choice, x, this.wy(y));
    return true;
  }

  /** Adds efficient support to defenders that survived and are crossing a bridge. */
  supportCounterpush() {
    const push = this.sim.entities
      .filter((e) => !e.dead && e.team === this.team && e.kind === 'troop' && this.y(e.y) > 11.5 && this.y(e.y) < 22 && (e.hp > 700 || e.targets === 'buildings'))
      .filter((e) => !this.supportedPushes.has(e.id))
      .sort((a, b) => this.y(b.y) - this.y(a.y) || b.hp - a.hp)[0];
    if (!push || this.side.elixir < (this.profile.tracksElixir ? 6 : 5)) return false;
    if (this.profile.tracksElixir && this.enemyElixir > 6.5 && this.side.elixir < 8) return false;
    const choices = this.hand()
      .filter(({ card }) => SUPPORT.has(card.id) && card.targets !== 'Buildings')
      .map((choice) => ({
        ...choice,
        score: (RANGED.has(choice.card.id) ? 4 : 1.5) + choice.card.dps / 100 - choice.card.cost * 0.45,
      }))
      .sort((a, b) => b.score - a.score || a.i - b.i);
    const choice = choices[0];
    if (!choice) return false;
    const y = clamp(this.y(push.y) - (RANGED.has(choice.card.id) ? 2.5 : 1.4), 4, 15.1);
    const played = this.tryPlay(choice, push.x, this.wy(y));
    if (played) this.supportedPushes.add(push.id);
    return played;
  }

  attack() {
    const elixir = this.side.elixir;
    const protectLead = this.profile.timeStrategy && this.sim.time < 42 && this.isAhead();
    const enemyLow = this.profile.tracksElixir && this.enemyElixir < 4;
    const threshold = protectLead ? 8.7 : Math.max(4, this.profile.attackElixir - (enemyLow ? 1.2 : 0) - (this.sim.doubleElixir ? 0.6 : 0));
    if (elixir < threshold && elixir < this.profile.overflowElixir) return false;

    const options = this.hand();
    if (!options.length) return false;
    const lane = this.chooseAttackLane();
    const tanks = options
      .filter(({ card }) => TANKS.includes(card.id))
      .map((choice) => {
        let score = choice.card.id === 'hog-rider' ? 5 : choice.card.id === 'giant' ? 4.5 : 3.3;
        if (choice.card.id === 'pekka' && elixir < 8.5) score -= 4;
        if (enemyLow && choice.card.id === 'hog-rider') score += 3;
        score += (this.random() - 0.5) * this.profile.scoreNoise;
        return { ...choice, score };
      })
      .sort((a, b) => b.score - a.score || a.i - b.i);
    let choice = tanks[0];
    if (!choice && elixir >= this.profile.overflowElixir) {
      choice = options
        .filter(({ card }) => card.type !== 'Building')
        .map((o) => ({ ...o, score: o.card.dps / Math.max(1, o.card.cost) - o.card.cost * 3 + (this.random() - 0.5) * this.profile.scoreNoise }))
        .sort((a, b) => b.score - a.score || a.i - b.i)[0];
    }
    if (!choice) return false;

    const slow = choice.card.speed === 'Slow';
    let y = slow ? (this.sim.doubleElixir ? 5 : 3.2) : 13.3;
    if (protectLead) y = slow ? 3 : 7;
    if (this.profile.counterpush) {
      const ally = this.sim.entities.find(
        (e) => !e.dead && e.team === this.team && e.kind === 'troop' && laneOf(e.x) === lane && this.y(e.y) > 10,
      );
      if (ally && choice.card.id === 'hog-rider') y = 14.2;
    }
    y += this.profile.scoreNoise > 1 ? this.rand(-0.6, 0.6) : 0;
    const played = this.tryPlay(choice, laneX(lane), this.wy(y));
    if (!played) return false;
    if (this.profile.combo && COMBOS[choice.card.id]) {
      this.pending = {
        tank: this.lastSpawned(choice.card.id),
        partners: COMBOS[choice.card.id],
        expires: this.sim.tick + this.profile.thinkTicks * 10,
      };
    }
    return true;
  }

  chooseAttackLane() {
    const enemy = 1 - this.team;
    const score = (lane) => {
      const tower = this.sim.entities.find(
        (e) => e.team === enemy && e.kind === 'tower' && e.towerKind === 'princess' && laneOf(e.x) === lane,
      );
      let value = tower && !tower.dead ? (1 - tower.hp / tower.maxHp) * 7 : 12;
      if (this.profile.counterpush) {
        const allies = this.sim.entities.filter(
          (e) => !e.dead && e.team === this.team && e.kind === 'troop' && laneOf(e.x) === lane && this.y(e.y) > 10,
        );
        value += allies.reduce((sum, e) => sum + e.hp / Math.max(500, e.maxHp), 0) * 1.7;
      }
      if (this.profile.tracksElixir) {
        const enemyCommitment = this.sim.entities
          .filter((e) => !e.dead && e.team === enemy && e.kind === 'troop' && laneOf(e.x) === lane && this.y(e.y) > RIVER_Y)
          .reduce((sum, e) => sum + e.hp / 700, 0);
        value -= enemyCommitment;
      }
      value += (this.random() - 0.5) * this.profile.scoreNoise * 0.25;
      return value;
    };
    const left = score(0);
    const right = score(1);
    return left >= right ? 0 : 1;
  }

  isAhead() {
    const mine = this.side.crowns;
    const theirs = this.sim.sides[1 - this.team].crowns;
    if (mine !== theirs) return mine > theirs;
    const health = (team) =>
      this.sim.entities
        .filter((e) => e.kind === 'tower' && e.team === team && !e.dead)
        .reduce((sum, e) => sum + e.hp / e.maxHp, 0);
    return health(this.team) > health(1 - this.team) + 0.08;
  }
}
