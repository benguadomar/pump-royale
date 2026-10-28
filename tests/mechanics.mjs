import { BattleSim } from '../src/sim/sim.js';
import { CARD_BY_ID } from '../src/data/cards.js';

const deck = ['knight', 'archer', 'giant', 'goblin', 'skeleton', 'wizard', 'bomber', 'cannon'];
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
const cast = (sim, team, id, x, y) => {
  sim.sides[team].hand[0] = id;
  sim.sides[team].elixir = 10;
  return sim.playCard(team, 0, x, y);
};
const run = (sim, seconds) => {
  for (let t = 0; t < seconds; t += 1 / 30) sim.step(1 / 30);
};

// Arrows wipe a Minion swarm anywhere on the map (no deploy-zone limit).
{
  const sim = fresh();
  const ms = [0, 1, 2].map((i) => unit(sim, 'minions', 1, 9 + i * 0.5, 22));
  check('arrows cast on enemy half', cast(sim, 0, 'arrows', 9.5, 22) === null);
  run(sim, 2);
  check('arrows kill minions', ms.every((m) => m.dead));
}
// Zap: damage + stun resets an Inferno's heat.
{
  const sim = fresh();
  const inf = unit(sim, 'inferno-tower', 1, 9, 20);
  inf.rampT = 5;
  cast(sim, 0, 'zap', 9, 20);
  check('zap stuns', inf.stunned > 0.3, `stunned=${inf.stunned.toFixed(2)}`);
  check('zap resets inferno ramp', inf.rampT === 0);
  check('zap damages', inf.hp < inf.maxHp - 150);
}
// Freeze stops attacks for 4 s.
{
  const sim = fresh();
  const k = unit(sim, 'knight', 1, 9, 20);
  cast(sim, 0, 'freeze', 9, 20);
  const x0 = k.x;
  const y0 = k.y;
  run(sim, 2);
  check('freeze holds a troop in place', Math.hypot(k.x - x0, k.y - y0) < 0.01);
  run(sim, 2.5);
  check('freeze wears off', k.frozen <= 0);
}
// Fireball knocks light troops back, not heavy ones.
{
  const sim = fresh();
  const g = unit(sim, 'goblin', 1, 9.5, 20);
  const giant = unit(sim, 'giant', 1, 8.5, 20);
  g.speed = 0;
  giant.speed = 0;
  const gx = giant.x;
  cast(sim, 0, 'fireball', 9, 20);
  run(sim, 2);
  check('fireball kills goblin', g.dead);
  check('fireball does not knock the giant', Math.abs(giant.x - gx) < 0.5);
}
// Rage speeds own troops.
{
  const sim = fresh();
  const k = unit(sim, 'knight', 0, 9, 8);
  cast(sim, 0, 'rage', 9, 8);
  run(sim, 0.5);
  check('rage buffs allies', k.raged > 0);
}
// Goblin Barrel lands three goblins at the target.
{
  const sim = fresh();
  cast(sim, 0, 'goblin-barrel', 3.5, 24);
  run(sim, 3);
  const gobs = sim.entities.filter((e) => e.card === 'goblin' && e.team === 0);
  check('goblin barrel spawns 3 goblins', gobs.length === 3, `n=${gobs.length}`);
}
// Air: ground melee cannot target flyers; archers can.
{
  const sim = fresh();
  const m = unit(sim, 'minions', 1, 9, 14);
  const k = unit(sim, 'knight', 0, 9, 13.5);
  const a = unit(sim, 'archer', 0, 6, 12);
  check('knight cannot target minion', !sim.isValidTarget(k, m));
  check('archer can target minion', sim.isValidTarget(a, m));
}
// Tesla hides until something is in range.
{
  const sim = fresh();
  const t = unit(sim, 'tesla', 0, 9, 8);
  const k = unit(sim, 'knight', 0, 4, 8);
  check('tesla starts hidden', t.hidden);
  check('hidden tesla is untargetable', !sim.isValidTarget({ ...k, team: 1, targets: 'any', hitsAir: false }, t));
  unit(sim, 'knight', 1, 9, 11);
  run(sim, 1);
  check('tesla pops up for a target', !t.hidden);
}
// Inferno damage ramps on a single target.
{
  const sim = fresh();
  const inf = unit(sim, 'inferno-tower', 0, 9, 8);
  const g = unit(sim, 'giant', 1, 9, 12);
  g.speed = 0;
  run(sim, 1);
  const hp1 = g.hp;
  run(sim, 1);
  const early = hp1 - g.hp;
  run(sim, 3);
  const hp2 = g.hp;
  run(sim, 1);
  const late = hp2 - g.hp;
  check('inferno ramps up', late > early * 3, `early=${early.toFixed(0)} late=${late.toFixed(0)}`);
}
// Valkyrie hits everything around her.
{
  const sim = fresh();
  unit(sim, 'valkyrie', 0, 9, 10);
  const sk = [0, 1, 2, 3].map((i) => unit(sim, 'skeleton', 1, 9 + Math.cos(i * 1.57) * 0.8, 10 + Math.sin(i * 1.57) * 0.8));
  run(sim, 2.5);
  check('valkyrie spin kills a skeleton ring', sk.filter((s) => s.dead).length >= 3, `${sk.filter((s) => s.dead).length}/4`);
}
// Balloon pops with a death bomb.
{
  const sim = fresh();
  const b = unit(sim, 'balloon', 1, 9, 10);
  const k = unit(sim, 'knight', 0, 9, 10.3);
  sim.damage(b, 99999, { team: 0 });
  check('balloon death damage', k.hp < k.maxHp - 150, `knight lost ${Math.round(k.maxHp - k.hp)}`);
}
// Prince charges after a run.
{
  const sim = fresh();
  const p = unit(sim, 'prince', 0, 3.5, 9);
  run(sim, 2.5);
  check('prince charges', p.charging || p.chargeRun >= 2.5);
}
// Levels: +10 % per level.
{
  const sim = new BattleSim([deck, deck], { seed: 3, levels: [12, 10] });
  const a = sim.spawnUnit(CARD_BY_ID.knight, 0, 5, 5);
  const b = sim.spawnUnit(CARD_BY_ID.knight, 1, 5, 25);
  check('card level scales stats', Math.abs(a.maxHp / b.maxHp - 1.21) < 0.01, (a.maxHp / b.maxHp).toFixed(3));
  const t0 = sim.entities.find((e) => e.kind === 'tower' && e.team === 0 && e.towerKind === 'king');
  check('tower level follows player level', Math.abs(t0.maxHp / CARD_BY_ID.knight.hp) > 0 && Math.round(t0.maxHp) === Math.round(4824 * 1.1));
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
