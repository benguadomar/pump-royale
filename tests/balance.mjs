import { BattleSim, randomDeck } from '../src/sim/sim.js';
import { BattleAI } from '../src/sim/ai.js';
import { CARDS } from '../src/data/cards.js';

const N = Number(process.argv[2] ?? 400);
const stats = Object.fromEntries(CARDS.map((c) => [c.id, { games: 0, wins: 0, played: 0 }]));
let draws = 0;
const t0 = Date.now();
for (let m = 0; m < N; m++) {
  const decks = [randomDeck(), randomDeck()];
  const sim = new BattleSim(decks, { seed: m * 7919 + 1 });
  const a = new BattleAI(sim, 0);
  const b = new BattleAI(sim, 1);
  sim.onStep = (dt) => {
    a.update(dt);
    b.update(dt);
  };
  let g = 0;
  while (!sim.over && g++ < 20000) {
    sim.advance(1 / 30);
    sim.drainEvents();
  }
  if (sim.winner == null) draws++;
  decks.forEach((deck, team) => {
    for (const id of deck) {
      stats[id].games++;
      if (sim.winner === team) stats[id].wins++;
      stats[id].played += sim.sides[team].deployed[id] ?? 0;
    }
  });
}
const rows = Object.entries(stats)
  .map(([id, s]) => ({ id, wr: s.games ? (100 * s.wins) / s.games : 0, games: s.games, perGame: s.games ? s.played / s.games : 0 }))
  .sort((x, y) => y.wr - x.wr);
for (const r of rows) console.log(r.id.padEnd(14), `${r.wr.toFixed(1)}%`.padStart(6), `n=${r.games}`.padStart(7), `plays/game=${r.perGame.toFixed(2)}`);
console.log(`draws ${draws}/${N}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
