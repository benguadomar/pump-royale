// AI ladder probe: every arena's bot plays a fixed reference opponent (a mid-skill bot at
// equal levels, standing in for a player). The arena bot's win rate must rise arena by arena.
import { BattleSim, randomDeck, rng } from '../src/sim/sim.js';
import { BattleAI } from '../src/sim/ai.js';
import { AI_DIFFICULTIES } from '../src/sim/aiDifficulty.js';
import { BASE_LEVEL } from '../src/data/cards.js';

const N = Number(process.argv[2] ?? 200);
const REFERENCE = process.argv[3] ?? 'tactician';

function play(tier, m) {
  const rand = rng(m * 2654435761 + 17);
  const decks = [randomDeck(rand), randomDeck(rand)];
  const bonus = tier.levelBonus ?? 0;
  // Team 0 = reference "player", team 1 = the arena bot (its level bonus included).
  const sim = new BattleSim(decks, { seed: m * 7919 + 1, levels: [BASE_LEVEL, BASE_LEVEL + bonus], cardLevels: [{}, Object.fromEntries(decks[1].map((c) => [c, BASE_LEVEL + bonus]))] });
  const a = new BattleAI(sim, 0, { difficulty: REFERENCE });
  const b = new BattleAI(sim, 1, { difficulty: tier.id });
  sim.onStep = (dt) => (a.update(dt), b.update(dt));
  for (let g = 0; !sim.over && g < 20000; g++) {
    sim.advance(1 / 30);
    sim.drainEvents();
  }
  return sim.winner;
}

const rates = [];
for (const tier of AI_DIFFICULTIES) {
  let wins = 0;
  let draws = 0;
  for (let m = 0; m < N; m++) {
    const w = play(tier, m);
    if (w === 1) wins++;
    else if (w == null) draws++;
  }
  const wr = (100 * (wins + draws / 2)) / N;
  rates.push(wr);
  console.log(`${tier.name.padEnd(12)} (+${tier.levelBonus ?? 0} lv)  wins ${wr.toFixed(1)}% vs ${REFERENCE}  draws ${draws}`);
}
const rising = rates.every((r, i) => i === 0 || r > rates[i - 1]);
console.log(rising ? 'LADDER RISES' : 'LADDER NOT MONOTONIC');
process.exit(rising ? 0 : 1);
