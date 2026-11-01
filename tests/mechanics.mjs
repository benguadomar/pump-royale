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

// The original ten troops/buildings plus the three spells; no flyers.
check('roster is the 10 original cards + 3 spells', CARDS.length === 13 && CARDS.filter((c) => c.type === 'Spell').length === 3 && CARDS.every((c) => !c.air), CARDS.map((c) => c.id).join(','));

/** Puts `cardId` in team 0's hand with full elixir and casts it at (x, y). */
const cast = (sim, cardId, x, y) => {
  sim.sides[0].hand[0] = cardId;
  sim.sides[0].elixir = 10;
  return sim.playCard(0, 0, x, y);
};
// Barrel Bomb: flies from the King Tower, then blasts and knocks back.
{
  const sim = fresh();
  const near = unit(sim, 'archer', 1, 9, 20);
  const tank = unit(sim, 'giant', 1, 10, 20);
  [near, tank].forEach((u) => (u.speed = 0));
  check('spells may land in the enemy half', cast(sim, 'barrel-bomb', 9.5, 20) === null);
  check('barrel is still in the air right after the throw', near.hp === near.maxHp);
  run(sim, 2.2);
  check('barrel bomb kills an archer', near.dead, `hp ${Math.round(near.hp)}`);
  check('barrel bomb damages a giant', tank.hp < tank.maxHp && !tank.dead, `${Math.round(tank.maxHp - tank.hp)} dmg`);
}
{
  const sim = fresh();
  const sk = unit(sim, 'barbarian', 1, 9.6, 20);
  const gi = unit(sim, 'giant', 1, 8.4, 20);
  sim.sides[0].hand[0] = 'barrel-bomb';
  sim.sides[0].elixir = 10;
  sim.playCard(0, 0, 9, 20);
  const s = sim.spells[0];
  s.t = s.flight;
  sim.updateSpells(0);
  check('blast pushes light troops harder than tanks (Δv = J / m)', Math.abs(sk.vx) > Math.abs(gi.vx) * 3 && sk.vx > 0 && gi.vx < 0, `${sk.vx.toFixed(2)} vs ${gi.vx.toFixed(2)}`);
}
// Fire Arrows: three volleys, each a third of the damage; towers take the reduced share.
{
  const sim = fresh();
  const w = unit(sim, 'wizard', 1, 9, 20);
  w.speed = 0;
  w.damage = 0;
  cast(sim, 'fire-arrows', 9, 20);
  const per = CARD_BY_ID['fire-arrows'].spell.damage / 3;
  run(sim, 0.95);
  check('first fire arrow volley lands after the sky delay', Math.abs(w.maxHp - w.hp - per) < 1, `${Math.round(w.maxHp - w.hp)}`);
  run(sim, 1);
  check('three volleys deal the full damage', Math.abs(w.maxHp - w.hp - per * 3) < 1, `${Math.round(w.maxHp - w.hp)}`);
  const sim2 = fresh();
  const tower = sim2.entities.find((e) => e.kind === 'tower' && e.team === 1 && e.towerKind === 'princess');
  cast(sim2, 'fire-arrows', tower.x, tower.y);
  run(sim2, 2);
  check('crown towers take reduced spell damage', Math.abs(tower.maxHp - tower.hp - CARD_BY_ID['fire-arrows'].damage * 0.35) < 1, `${Math.round(tower.maxHp - tower.hp)}`);
}
// Fireball: flies from the King Tower, kills/damages everything inside its radius only.
{
  const sim = fresh();
  const wiz = unit(sim, 'archer', 1, 9, 20);
  const tank = unit(sim, 'giant', 1, 10.5, 20);
  const far = unit(sim, 'archer', 1, 9 + CARD_BY_ID.fireball.spell.radius + 1.5, 20);
  [wiz, tank, far].forEach((u) => ((u.speed = 0), (u.damage = 0)));
  cast(sim, 'fireball', 9, 20);
  check('fireball is still in the air right after the throw', wiz.hp === wiz.maxHp);
  run(sim, 2.5);
  check('fireball kills an archer', wiz.dead, `hp ${Math.round(wiz.hp)}`);
  check('fireball damages a giant in the radius', Math.abs(tank.maxHp - tank.hp - CARD_BY_ID.fireball.damage) < 1, `${Math.round(tank.maxHp - tank.hp)} dmg`);
  check('fireball misses troops outside its radius', far.hp === far.maxHp);
  const sim2 = fresh();
  const tower = sim2.entities.find((e) => e.kind === 'tower' && e.team === 1 && e.towerKind === 'princess');
  cast(sim2, 'fireball', tower.x, tower.y);
  run(sim2, 3);
  check('fireball deals reduced damage to crown towers', Math.abs(tower.maxHp - tower.hp - CARD_BY_ID.fireball.damage * 0.35) < 1, `${Math.round(tower.maxHp - tower.hp)}`);
}

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
// Pathing: a Giant dropped behind its own King Tower walks round it instead of pushing into it.
for (const [gx, cx] of [[9, 9], [8.4, 9.6], [10, 9]]) {
  const sim = fresh();
  const king = sim.entities.find((e) => e.kind === 'tower' && e.team === 0 && e.towerKind === 'king');
  const cannon = unit(sim, 'cannon', 1, cx, 7.5);
  cannon.damage = 0;
  cannon.lifetime = Infinity;
  const g = unit(sim, 'giant', 0, gx, 0.8);
  let closest = Infinity;
  let hitAt = null;
  for (let t = 0; t < 15 && hitAt === null; t += 1 / 30) {
    sim.step(1 / 30);
    closest = Math.min(closest, Math.hypot(g.x - king.x, g.y - king.y));
    if (cannon.hp < cannon.maxHp) hitAt = t;
  }
  check(`giant behind the king tower (x ${gx}) walks round it to its target`, g.target === cannon && hitAt !== null && hitAt < 10, hitAt === null ? `stuck at ${g.x.toFixed(2)},${g.y.toFixed(2)}` : `hit after ${hitAt.toFixed(1)}s`);
  check(`giant never sinks into the king tower (x ${gx})`, closest >= king.radius * 0.9 + g.radius * 0.6 - 0.02, `closest ${closest.toFixed(2)}`);
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
// Newton: heavier troops accelerate slower (F = m·a with a bounded drive force).
{
  const sim = fresh();
  const sk = unit(sim, 'skeleton', 0, 3.5, 4);
  const gi = unit(sim, 'giant', 0, 14.5, 4);
  run(sim, 0.1);
  check('light troop reaches speed faster than a heavy one', Math.hypot(sk.vx, sk.vy) / sk.speed > Math.hypot(gi.vx, gi.vy) / gi.speed, `${(Math.hypot(sk.vx, sk.vy) / sk.speed).toFixed(2)} vs ${(Math.hypot(gi.vx, gi.vy) / gi.speed).toFixed(2)}`);
}
// Impulse: the same blow changes a light troop's velocity far more (Δv = J / m).
{
  const sim = fresh();
  const sk = unit(sim, 'skeleton', 1, 6, 20);
  const gi = unit(sim, 'giant', 1, 12, 20);
  sim.applyHit({ team: 0, damage: 40, x: 6, y: 18 }, sk, sk.x, sk.y);
  sim.applyHit({ team: 0, damage: 40, x: 12, y: 18 }, gi, gi.x, gi.y);
  const r = sk.vy / gi.vy;
  check('knockback is inversely proportional to mass', Math.abs(r - gi.mass / sk.mass) < 0.01 * (gi.mass / sk.mass), `ratio ${r.toFixed(1)} vs mass ratio ${(gi.mass / sk.mass).toFixed(1)}`);
  check('knockback pushes away from the attacker', sk.vy > 0);
  check('a knocked troop is staggered', sk.stagger > 0);
  const y0 = sk.y;
  run(sim, 0.1);
  check('a staggered troop slides back under friction', sk.y > y0 + 0.02, `slid ${(sk.y - y0).toFixed(3)} tiles`);
  sk.target = null;
  sk.speed = 0;
  run(sim, 1);
  check('friction brings a pushed troop to rest', Math.hypot(sk.vx, sk.vy) < 0.01);
}
// Momentum: a Giant walking into a Skeleton barely slows; the Skeleton is shoved aside.
{
  const sim = fresh();
  const gi = unit(sim, 'giant', 0, 9, 10);
  const sk = unit(sim, 'skeleton', 0, 9, 10.4);
  gi.speed = sk.speed = 0;
  gi.vy = 1;
  const p0 = gi.mass * gi.vy + sk.mass * sk.vy;
  sim.separate();
  const p1 = gi.mass * gi.vy + sk.mass * sk.vy;
  check('collision conserves momentum', Math.abs(p1 - p0) < 1e-6, `${p0.toFixed(3)} → ${p1.toFixed(3)}`);
  const skMoved = sk.y - 10.4;
  const giMoved = 10 - gi.y;
  check('heavy body pushes the light one', skMoved > giMoved * 20 && sk.vy > gi.vy, `skeleton moved ${skMoved.toFixed(3)}, giant ${giMoved.toFixed(4)}`);
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
