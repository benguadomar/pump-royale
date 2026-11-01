import { ARENAS, arenaFor } from '../data/arenas.js';
import { SIM_DT } from './constants.js';

const ticks = (seconds) => Math.max(1, Math.round(seconds / SIM_DT));

/**
 * Deterministic, fair AI profiles. Higher tiers think more often, make less noisy
 * evaluations and unlock more strategy; they never receive extra elixir or stats.
 */
export const AI_DIFFICULTIES = [
  {
    id: 'rookie',
    name: 'Rookie',
    arenaId: 'goblin-stadium',
    thinkTicks: ticks(0.95),
    initialTicks: ticks(2.4),
    jitterTicks: ticks(0.55),
    scoreNoise: 3.2,
    defenseSense: 0.72,
    attackElixir: 8.8,
    overflowElixir: 9.8,
    combo: false,
    laneAware: false,
    counterpush: false,
    tracksElixir: false,
    timeStrategy: false,
  },
  {
    id: 'fighter',
    name: 'Fighter',
    arenaId: 'bone-pit',
    thinkTicks: ticks(0.72),
    initialTicks: ticks(1.9),
    jitterTicks: ticks(0.35),
    scoreNoise: 2.4,
    defenseSense: 0.8,
    attackElixir: 8.6,
    overflowElixir: 9.6,
    combo: false,
    laneAware: true,
    counterpush: false,
    tracksElixir: false,
    timeStrategy: false,
  },
  {
    id: 'tactician',
    name: 'Tactician',
    arenaId: 'barbarian-bowl',
    thinkTicks: ticks(0.5),
    initialTicks: ticks(1.35),
    jitterTicks: ticks(0.22),
    scoreNoise: 1.15,
    defenseSense: 1.05,
    attackElixir: 8.3,
    overflowElixir: 9.3,
    combo: true,
    laneAware: true,
    counterpush: true,
    tracksElixir: false,
    timeStrategy: true,
  },
  {
    id: 'champion',
    name: 'Champion',
    arenaId: 'frozen-peak',
    thinkTicks: ticks(0.3),
    initialTicks: ticks(0.9),
    jitterTicks: ticks(0.12),
    scoreNoise: 0.45,
    defenseSense: 1.3,
    attackElixir: 8.5,
    overflowElixir: 9.2,
    combo: true,
    laneAware: true,
    counterpush: true,
    tracksElixir: true,
    timeStrategy: true,
  },
  {
    id: 'grandmaster',
    name: 'Grandmaster',
    arenaId: 'pump-palace',
    thinkTicks: ticks(0.3),
    initialTicks: ticks(0.7),
    jitterTicks: ticks(0.06),
    scoreNoise: 0.08,
    defenseSense: 1.35,
    attackElixir: 8.6,
    overflowElixir: 9.2,
    combo: true,
    laneAware: true,
    counterpush: true,
    tracksElixir: true,
    timeStrategy: true,
  },
];

export const AI_DIFFICULTY_BY_ID = Object.fromEntries(AI_DIFFICULTIES.map((d) => [d.id, d]));
export const AI_DIFFICULTY_BY_ARENA = Object.fromEntries(AI_DIFFICULTIES.map((d) => [d.arenaId, d]));

export function aiDifficulty(value = 0) {
  if (typeof value === 'string') return AI_DIFFICULTY_BY_ID[value] ?? AI_DIFFICULTY_BY_ARENA[value] ?? AI_DIFFICULTIES[0];
  return AI_DIFFICULTY_BY_ARENA[arenaFor(value).id] ?? AI_DIFFICULTIES[0];
}

/** Guards the one-to-one progression contract used by the server and tests. */
export const AI_ARENA_LADDER_VALID =
  ARENAS.length === AI_DIFFICULTIES.length &&
  ARENAS.every((arena, i) => AI_DIFFICULTIES[i].arenaId === arena.id);
