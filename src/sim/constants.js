// Arena geometry in tiles. Team 0 always lives in the bottom half (small y) in canonical coordinates.
export const ARENA_W = 18;
export const ARENA_H = 32;
export const RIVER_Y = 16;
export const RIVER_HALF = 1.1;
export const BRIDGES_X = [3.5, 14.5];
export const BRIDGE_HALF = 1.0;

export const TOWER_LAYOUT = [
  { kind: 'princess', team: 0, x: 3.5, y: 6.5 },
  { kind: 'princess', team: 0, x: 14.5, y: 6.5 },
  { kind: 'king', team: 0, x: 9, y: 3 },
  { kind: 'princess', team: 1, x: 3.5, y: 25.5 },
  { kind: 'princess', team: 1, x: 14.5, y: 25.5 },
  { kind: 'king', team: 1, x: 9, y: 29 },
];

export const MATCH_TIME = 180;
export const OVERTIME = 60;
export const DOUBLE_ELIXIR_AT = 60;
export const ELIXIR_PER_SEC = 1 / 2.8;
export const MAX_ELIXIR = 10;
export const START_ELIXIR = 5;
export const DEPLOY_TIME = 1.0;
export const SIM_DT = 1 / 30;
/** Bumped whenever the rules change the outcome of a recorded match (old replays are hidden). */
export const SIM_VERSION = 2;

/** Mirrors a canonical point across the arena center (what team 1 sees). */
export const mirrorX = (x) => ARENA_W - x;
export const mirrorY = (y) => ARENA_H - y;

/**
 * Deploy rule shared by client previews, the AI and the server: own half always,
 * plus a pocket past the river on a flank whose enemy princess tower has fallen.
 */
export function zoneAllows(team, x, y, enemyPrincessAlive) {
  if (x < 0.5 || x > ARENA_W - 0.5 || y < 0.5 || y > ARENA_H - 0.5) return false;
  if (Math.abs(y - RIVER_Y) < RIVER_HALF + 0.1) return false;
  const ownHalf = team === 0 ? y < RIVER_Y : y > RIVER_Y;
  if (ownHalf) return true;
  if (enemyPrincessAlive(x < ARENA_W / 2)) return false;
  return team === 0 ? y <= RIVER_Y + 5.5 : y >= RIVER_Y - 5.5;
}
