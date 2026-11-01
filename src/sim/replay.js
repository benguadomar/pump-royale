import { BattleSim } from './sim.js';
import { BattleAI } from './ai.js';
import { SIM_DT } from './constants.js';

/** Longest a match can last (regulation + overtime) plus a safety margin, in ticks. */
const MAX_TICKS = Math.ceil((180 + 60 + 5) / SIM_DT);

/**
 * Re-runs a recorded match. A record is everything needed to reproduce it exactly:
 * { mode: 'ai' | 'pvp', seed, decks, levels, cardLevels, inputs } where each input is
 * [tick, team, handIndex, x, y] or [tick, team, 'forfeit'], applied right before
 * simulated step `tick + 1`. In 'ai' mode team 1 is the seeded BattleAI.
 */
export class ReplayDriver {
  constructor(record) {
    this.record = record;
    this.sim = new BattleSim(record.decks, { seed: record.seed, levels: record.levels, cardLevels: record.cardLevels });
    if (record.mode === 'ai') {
      const ai = new BattleAI(this.sim, 1, { difficulty: record.aiTier ?? record.arenaId ?? 0 });
      this.sim.onStep = (dt) => ai.update(dt);
    }
    this.inputs = [...(record.inputs ?? [])].sort((a, b) => a[0] - b[0]);
    this.next = 0;
  }

  /** Simulates one fixed step, feeding any inputs due at this tick first. */
  step() {
    const sim = this.sim;
    while (this.next < this.inputs.length && this.inputs[this.next][0] <= sim.tick) {
      const [, team, i, x, y] = this.inputs[this.next++];
      if (i === 'forfeit') sim.forfeit(team);
      else sim.playCard(team, i, x, y);
    }
    sim.step(SIM_DT);
  }

  /** Runs to the end (server-side verification). */
  runToEnd() {
    while (!this.sim.over && this.sim.tick < MAX_TICKS) this.step();
    if (!this.sim.over) this.sim.finish(null);
    return this.sim;
  }
}

/** Rounds a deploy position the same way on client and server so replays match exactly. */
export const roundPos = (v) => Math.round(v * 100) / 100;
