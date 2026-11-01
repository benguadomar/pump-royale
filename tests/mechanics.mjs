import { BattleSim } from '../src/sim/sim.js';
import { CARDS, CARD_BY_ID, DEFAULT_DECK } from '../src/data/cards.js';

const deck = DEFAULT_DECK;
let failures = 0;
const check = (name, ok, info = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
};
const fresh = (seed = 1) => new BattleSim([deck, deck], { seed });
const unit = (sim, id, team, x, y) => {
  const u = sim.spawnUnit(CARD_BY_ID[id], team, x, y);
  u.deploy = 0;
  return u;
};
const run = (sim, seconds) => {
  for (let t = 0; t < seconds; t += 1 / 30) sim.step(1 / 30);
};

// Only the original ten cards exist: troops and one building, no spells or flyers.
check('roster is the original 10 cards', CARDS.length === 10 && CARDS.every((c) => c.type !== 'Spell' && !c.air), CARDS.map((c) => c.id).join(','));

// Splash damage clears a skeleton cluster.
{
  const sim = fresh();
  unit(sim, 'wizard', 0, 9, 10);
  const sk = [0, 1, 2].map((i) => unit(sim, 'skeleton', 1, 8.6 + i * 0.4, 14));
  sk.forEach((s) => (s.speed = 0));
  run(sim, 3);
  check('wizard splash kills a skeleton group', sk.filter((s) => s.dead).length === 3, `${sk.filter((s) => s.dead).length}/3`);
}
// Giant ignores troops and walks to buildings.
{
  const sim = fresh();
  const g = unit(sim, 'giant', 0, 3.5, 12);
  const k = unit(sim, 'barbarian', 1, 3.5, 13.5);
  k.speed = 0;
  check('giant cannot target troops', !sim.isValidTarget(g, k));
  const t = sim.entities.find((e) => e.kind === 'tower' && e.team === 1 && e.x < 9);
  check('giant can target towers', sim.isValidTarget(g, t));
}
// Deploy zones: own half only, and not inside a tower.
{
  const sim = fresh();
  sim.sides[0].elixir = 10;
  const i = sim.sides[0].hand.findIndex((id) => CARD_BY_ID[id].type === 'Troop');
  check('cannot deploy in the enemy half', sim.playCard(0, i, 3.5, 24) === 'zone');
  check('can deploy in own half', sim.playCard(0, i, 3.5, 10) === null);
}
// Elixir is checked and spent.
{
  const sim = fresh();
  sim.sides[0].elixir = 1;
  const i = sim.sides[0].hand.findIndex((id) => CARD_BY_ID[id].cost > 1);
  check('not enough elixir is refused', sim.playCard(0, i, 3.5, 10) === 'elixir');
}
// Levels: +10 % per level.
{
  const sim = new BattleSim([deck, deck], { seed: 3, levels: [12, 10] });
  const a = sim.spawnUnit(CARD_BY_ID.barbarian, 0, 5, 5);
  const b = sim.spawnUnit(CARD_BY_ID.barbarian, 1, 5, 25);
  check('card level scales stats', Math.abs(a.maxHp / b.maxHp - 1.21) < 0.01, (a.maxHp / b.maxHp).toFixed(3));
  const t0 = sim.entities.find((e) => e.kind === 'tower' && e.team === 0 && e.towerKind === 'king');
  check('tower level follows player level', Math.round(t0.maxHp) === Math.round(4824 * 1.1));
}
// Determinism: same seed + same inputs = same outcome.
{
  const play = () => {
    const sim = new BattleSim([deck, deck], { seed: 42 });
    for (let tick = 0; tick < 30 * 60; tick++) {
      if (tick % 90 === 0) {
        sim.sides[0].elixir = 10;
        sim.sides[1].elixir = 10;
        sim.playCard(0, tick % 4, 4 + (tick % 10), 9);
        sim.playCard(1, (tick + 1) % 4, 14 - (tick % 10), 23);
      }
      sim.step(1 / 30);
    }
    return JSON.stringify(sim.entities.map((e) => [e.id, Math.round(e.x * 1000), Math.round(e.y * 1000), Math.round(e.hp)]));
  };
  check('deterministic replay', play() === play());
}
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
