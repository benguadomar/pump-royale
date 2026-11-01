// Balance probes: equal-cost duels in open field, tower damage per elixir, and hits-to-kill.
import { BattleSim } from '../src/sim/sim.js';
import { CARDS as ALL_CARDS, CARD_BY_ID, DEFAULT_DECK, isSpell } from '../src/data/cards.js';

// Spells are probed by tests/mechanics.mjs; duels are troops and buildings only.
const CARDS = ALL_CARDS.filter((c) => !isSpell(c));

const DT = 1 / 30;
const FIGHTERS = CARDS.filter((c) => c.targets !== 'Buildings').map((c) => c.id);
const fresh = () => new BattleSim([DEFAULT_DECK, DEFAULT_DECK], { seed: 7 });

/** Towers stay as walking targets but are harmless and unbreakable, so only the two cards fight. */
function arena() {
  const sim = fresh();
  for (const t of sim.entities) {
    t.damage = 0;
    t.hp = t.maxHp = 1e9;
  }
  return sim;
}
const spawn = (sim, id, team, x, y) => {
  sim.spawnCard(CARD_BY_ID[id], team, x, y);
  for (const e of sim.entities) if (e.team === team) e.deploy = 0;
};
const alive = (sim, team) => sim.entities.filter((e) => !e.dead && e.team === team && e.kind !== 'tower');
const hpLeft = (sim, team) => alive(sim, team).reduce((s, e) => s + e.hp / e.maxHp, 0);
const unitCount = (id) => CARD_BY_ID[id].count;

/**
 * A (bottom) vs B (top), each played once. Score is elixir value traded for A:
 * the share of B destroyed × B's cost, minus the share of A lost × A's cost.
 */
function duel(a, b) {
  const sim = arena();
  spawn(sim, a, 0, 9, 8);
  spawn(sim, b, 1, 9, 14);
  for (let t = 0; t < 40 && alive(sim, 0).length && alive(sim, 1).length; t += DT) sim.step(DT);
  const ca = CARD_BY_ID[a];
  const cb = CARD_BY_ID[b];
  const lostA = 1 - hpLeft(sim, 0) / unitCount(a);
  const lostB = 1 - hpLeft(sim, 1) / unitCount(b);
  return lostB * cb.cost - lostA * ca.cost;
}

const matrix = {};
for (const a of FIGHTERS) {
  matrix[a] = {};
  for (const b of FIGHTERS) if (a !== b) matrix[a][b] = (duel(a, b) - duel(b, a)) / 2;
}
console.log('Open-field duels (elixir won per fight, + is good):');
const duelRows = FIGHTERS.map((a) => ({ a, avg: Object.values(matrix[a]).reduce((s, v) => s + v, 0) / (FIGHTERS.length - 1) })).sort((x, y) => y.avg - x.avg);
for (const r of duelRows) console.log(`  ${r.a.padEnd(10)} ${r.avg >= 0 ? '+' : ''}${r.avg.toFixed(2)}   ` + FIGHTERS.filter((b) => b !== r.a).map((b) => `${b.slice(0, 4)} ${matrix[r.a][b] >= 0 ? '+' : ''}${matrix[r.a][b].toFixed(1)}`).join('  '));

// Unopposed push on a princess tower (which shoots back): tower damage per elixir.
console.log('\nDamage to a defended Princess Tower per elixir:');
const towerRows = [];
for (const c of CARDS) {
  if (c.type === 'Building') continue;
  const sim = fresh();
  const tower = sim.entities.find((e) => e.kind === 'tower' && e.team === 1 && e.x < 9);
  const hp0 = tower.hp;
  spawn(sim, c.id, 0, 3.5, 14);
  for (let t = 0; t < 60 && alive(sim, 0).length && !tower.dead; t += DT) sim.step(DT);
  towerRows.push({ id: c.id, perElixir: (hp0 - Math.max(0, tower.hp)) / c.cost });
}
towerRows.sort((x, y) => y.perElixir - x.perElixir).forEach((r) => console.log(`  ${r.id.padEnd(10)} ${r.perElixir.toFixed(0)}`));

// Hits to kill each fighter (the "feel" of a matchup).
console.log('\nHits to kill (attacker → victim):');
for (const a of FIGHTERS) {
  const dmg = CARD_BY_ID[a].damage;
  console.log(`  ${a.padEnd(10)} ` + CARDS.map((v) => `${v.id.slice(0, 4)} ${Math.ceil(v.hp / dmg)}`).join('  '));
}
