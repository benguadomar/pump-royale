import { CARDS, CARD_BY_ID } from './cards.js';
import { ARENAS } from './arenas.js';

// Progression rules shared by the server (which applies them) and the client (which
// only displays them). Every function takes the profile and returns what changed.

export const STARTING = { gold: 300, gems: 30, trophies: 0 };

// ------------------------------------------------------------------ trophies & leagues

export const LEAGUES = [
  { id: 'bronze', name: 'Bronze League', min: 0, color: '#c98a4e' },
  { id: 'silver', name: 'Silver League', min: 400, color: '#c7d0da' },
  { id: 'gold', name: 'Gold League', min: 800, color: '#f2c14e' },
  { id: 'crystal', name: 'Crystal League', min: 1200, color: '#7fd8f5' },
  { id: 'master', name: 'Master League', min: 1600, color: '#b07cf0' },
  { id: 'champion', name: 'Champion League', min: 2000, color: '#ff6b6b' },
];
export const leagueFor = (trophies) => [...LEAGUES].reverse().find((l) => trophies >= l.min) ?? LEAGUES[0];

/** Elo-flavoured swing: beating a stronger opponent is worth more (20–40 per match). */
export function trophyDelta(result, mine, theirs) {
  if (result === 'draw') return 0;
  const edge = Math.max(-10, Math.min(10, Math.round((theirs - mine) / 25)));
  return result === 'win' ? 30 + edge : -(30 - edge);
}

/** Milestones along the trophy road; arenas unlock at their own thresholds. */
export const TROPHY_ROAD = [
  { at: 50, reward: { gold: 100 } },
  { at: 100, reward: { chest: 'silver' } },
  { at: 150, reward: { gems: 10 } },
  { at: 200, reward: { gold: 200 } },
  { at: 300, reward: { chest: 'gold' }, arena: 'bone-pit' },
  { at: 400, reward: { gems: 20 } },
  { at: 500, reward: { gold: 400 } },
  { at: 600, reward: { chest: 'gold' }, arena: 'barbarian-bowl' },
  { at: 800, reward: { gems: 40 } },
  { at: 1000, reward: { chest: 'magical' }, arena: 'frozen-peak' },
  { at: 1250, reward: { gold: 1000 } },
  { at: 1500, reward: { chest: 'magical' }, arena: 'pump-palace' },
  { at: 1800, reward: { gems: 100 } },
  { at: 2000, reward: { chest: 'magical' } },
];
export const ROAD_ARENAS = ARENAS;

// ------------------------------------------------------------------ chests

export const CHESTS = {
  wooden: { name: 'Wooden Chest', unlock: 30, gold: [20, 40], cards: 6, weights: { Common: 90, Rare: 10, Epic: 0, Legendary: 0 } },
  silver: { name: 'Silver Chest', unlock: 180, gold: [40, 80], cards: 12, weights: { Common: 75, Rare: 22, Epic: 3, Legendary: 0 } },
  gold: { name: 'Golden Chest', unlock: 480, gold: [120, 200], cards: 28, weights: { Common: 65, Rare: 27, Epic: 7, Legendary: 1 } },
  magical: { name: 'Magical Chest', unlock: 900, gold: [300, 450], cards: 60, weights: { Common: 54, Rare: 31, Epic: 12, Legendary: 3 } },
};
/** A chest stack of a rarer card holds proportionally fewer shards. */
const STACK_DIVISOR = { Common: 1, Rare: 3, Epic: 6, Legendary: 12 };
export const CHEST_SLOTS = 4;
/** Wins hand out chests in this repeating order. */
export const CHEST_CYCLE = ['wooden', 'wooden', 'silver', 'wooden', 'silver', 'wooden', 'gold', 'wooden', 'silver', 'wooden', 'silver', 'magical'];
/** Gems to skip a chest's remaining unlock time. */
export const gemsToOpen = (secondsLeft) => Math.max(1, Math.ceil(secondsLeft / 60));

// ------------------------------------------------------------------ cards

export const START_LEVEL = 9;
export const MAX_CARD_LEVEL = 14;
/** Shards needed to go from level L to L+1 (index = L - START_LEVEL). */
const SHARDS = { Common: [4, 10, 20, 50, 100], Rare: [2, 4, 10, 20, 40], Epic: [1, 2, 4, 8, 16], Legendary: [1, 1, 2, 4, 8] };
const UPGRADE_GOLD = [50, 150, 400, 1000, 2000];
const RARITY_GOLD = { Common: 1, Rare: 2, Epic: 4, Legendary: 8 };

export function upgradeCost(card, level) {
  const i = level - START_LEVEL;
  if (i < 0 || i >= UPGRADE_GOLD.length) return null;
  const rarity = card.rarity ?? 'Common';
  return { shards: SHARDS[rarity][i], gold: UPGRADE_GOLD[i] * RARITY_GOLD[rarity], xp: 4 * (i + 1) * RARITY_GOLD[rarity] };
}

// ------------------------------------------------------------------ king level

/** XP needed to reach each King level (index = level - 1). */
export const XP_LEVELS = [0, 40, 120, 250, 450, 700, 1000, 1400, 1900, 2500, 3200, 4000, 5000, 6200];
export const kingLevel = (xp) => XP_LEVELS.filter((x) => xp >= x).length;
/** Towers start at level 9 and gain a level every King level, capped at 14. */
export const towerLevel = (xp) => Math.min(MAX_CARD_LEVEL, START_LEVEL - 1 + kingLevel(xp));

// ------------------------------------------------------------------ quests & season pass

export const QUEST_KINDS = [
  { kind: 'win', text: 'Win {n} battles', n: [1, 2, 3], reward: { gold: 60, pass: 40 } },
  { kind: 'play', text: 'Play {n} battles', n: [2, 3, 4], reward: { gold: 40, pass: 30 } },
  { kind: 'crowns', text: 'Destroy {n} towers', n: [2, 4, 6], reward: { gold: 70, pass: 40 } },
  { kind: 'elixir', text: 'Spend {n} elixir', n: [40, 80, 120], reward: { gems: 5, pass: 40 } },
];
export const QUESTS_PER_DAY = 3;
export const dayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const DAY_MS = 24 * 3600 * 1000;

// ------------------------------------------------------------------ daily login reward

/**
 * A 7-day login calendar (about one day of quests each, rising to a chest on day 7).
 * Missing a day restarts the streak at day 1; after day 7 it loops.
 */
export const DAILY_REWARDS = [{ gold: 60 }, { gems: 5 }, { gold: 120 }, { chest: 'silver' }, { gold: 200 }, { gems: 15 }, { chest: 'gold' }];

/** { claimable, day: 1..7 of the next claim, streak: days claimed in a row so far }. */
export function dailyStatus(p, now = Date.now()) {
  const d = p.daily ?? { day: null, streak: 0 };
  const today = dayKey(now);
  if (d.day === today) return { claimable: false, day: ((d.streak - 1) % DAILY_REWARDS.length) + 1, streak: d.streak };
  const continues = d.day === dayKey(now - DAY_MS);
  const streak = continues ? d.streak : 0;
  return { claimable: true, day: (streak % DAILY_REWARDS.length) + 1, streak };
}

// ------------------------------------------------------------------ leaderboard

export const LEADERBOARD_SIZE = 100;
/** Paid every day at 00:00 UTC to the top 10 of the trophy board. */
export function leaderboardReward(rank) {
  if (rank === 1) return { gems: 50, gold: 800 };
  if (rank === 2) return { gems: 40, gold: 600 };
  if (rank === 3) return { gems: 30, gold: 450 };
  if (rank <= 10) return { gems: 15, gold: 200 };
  return null;
}

export const PASS_TIERS = 30;
export const PASS_XP_PER_TIER = 100;
/** Free-track reward for each tier (1-based). */
export function passReward(tier) {
  if (tier % 10 === 0) return { chest: 'magical' };
  if (tier % 5 === 0) return { chest: 'gold' };
  if (tier % 3 === 0) return { gems: 10 };
  return { gold: 50 + tier * 10 };
}
export const passTier = (xp) => Math.min(PASS_TIERS, Math.floor(xp / PASS_XP_PER_TIER));

// ------------------------------------------------------------------ profile

export function newProfile(now = Date.now()) {
  const cards = {};
  for (const c of CARDS) cards[c.id] = { level: START_LEVEL, shards: 0 };
  return {
    v: 1,
    trophies: STARTING.trophies,
    bestTrophies: STARTING.trophies,
    gold: STARTING.gold,
    gems: STARTING.gems,
    xp: 0,
    cards,
    chests: [{ type: 'wooden', unlockAt: null }, null, null, null],
    chestCycle: 0,
    road: [],
    quests: { day: null, list: [] },
    pass: { xp: 0, claimed: [] },
    cardStats: {},
    wins: 0,
    losses: 0,
    draws: 0,
    created: now,
  };
}

/** Rolls fresh daily quests when the UTC day changes. */
export function refreshQuests(p, rand, now = Date.now()) {
  const day = dayKey(now);
  // Same day keeps its quests, unless one of them is a kind that no longer exists.
  if (p.quests.day === day && p.quests.list.every((q) => QUEST_KINDS.some((k) => k.kind === q.kind))) return false;
  const pool = [...QUEST_KINDS];
  const list = [];
  for (let i = 0; i < QUESTS_PER_DAY && pool.length; i++) {
    const q = pool.splice(Math.floor(rand() * pool.length), 1)[0];
    const n = q.n[Math.floor(rand() * q.n.length)];
    list.push({ kind: q.kind, text: q.text.replace('{n}', n), target: n, progress: 0, reward: q.reward, claimed: false });
  }
  p.quests = { day, list };
  return true;
}

/** Adds a reward bundle to the profile (chests go into the first free slot). */
export function grant(p, reward) {
  const out = { ...reward };
  if (reward.gold) p.gold += reward.gold;
  if (reward.gems) p.gems += reward.gems;
  if (reward.pass) p.pass.xp += reward.pass;
  if (reward.chest) {
    const slot = p.chests.indexOf(null);
    if (slot >= 0) p.chests[slot] = { type: reward.chest, unlockAt: null };
    else out.chestLost = true;
  }
  return out;
}

/**
 * Applies a verified match outcome. `stats` = { result, myCrowns, deck, deployed, oppTrophies }.
 * Returns the summary shown on the result screen.
 */
export function applyMatch(p, stats) {
  const delta = trophyDelta(stats.result, p.trophies, stats.oppTrophies ?? p.trophies);
  const before = p.trophies;
  p.trophies = Math.max(0, p.trophies + delta);
  p.bestTrophies = Math.max(p.bestTrophies, p.trophies);
  p[stats.result === 'win' ? 'wins' : stats.result === 'loss' ? 'losses' : 'draws']++;
  const xp = stats.result === 'win' ? 20 : 6;
  p.xp += xp;
  const passXp = stats.myCrowns * 10 + (stats.result === 'win' ? 10 : 0);
  p.pass.xp += passXp;

  let chest = null;
  let chestLost = false;
  if (stats.result === 'win') {
    const type = CHEST_CYCLE[p.chestCycle % CHEST_CYCLE.length];
    const slot = p.chests.indexOf(null);
    if (slot >= 0) {
      p.chests[slot] = { type, unlockAt: null };
      p.chestCycle++;
      chest = type;
    } else chestLost = true;
  }

  for (const id of stats.deck) {
    const s = (p.cardStats[id] ??= { games: 0, wins: 0 });
    s.games++;
    if (stats.result === 'win') s.wins++;
  }

  const elixir = Object.entries(stats.deployed).reduce((n, [id, c]) => n + CARD_BY_ID[id].cost * c, 0);
  const progress = { win: stats.result === 'win' ? 1 : 0, play: 1, crowns: stats.myCrowns, elixir };
  for (const q of p.quests.list) if (!q.claimed) q.progress = Math.min(q.target, q.progress + (progress[q.kind] ?? 0));

  const arenasBefore = ARENAS.filter((a) => before >= a.trophies).length;
  const arenasAfter = ARENAS.filter((a) => p.trophies >= a.trophies).length;
  return { trophies: p.trophies, delta: p.trophies - before, xp, passXp, chest, chestLost, newArena: arenasAfter > arenasBefore ? ARENAS[arenasAfter - 1].id : null };
}

/** Random card shards from a chest, weighted by rarity. */
export function rollChest(type, rand) {
  const def = CHESTS[type];
  const gold = Math.round(def.gold[0] + rand() * (def.gold[1] - def.gold[0]));
  const byRarity = {};
  for (const c of CARDS) (byRarity[c.rarity ?? 'Common'] ??= []).push(c.id);
  const total = Object.values(def.weights).reduce((a, b) => a + b, 0);
  const cards = {};
  // Split the shards across a few distinct cards, like a real chest opening.
  const stacks = Math.min(def.cards, 3 + Math.floor(def.cards / 12));
  for (let s = 0; s < stacks; s++) {
    let roll = rand() * total;
    let rarity = 'Common';
    for (const [r, w] of Object.entries(def.weights)) {
      if ((roll -= w) < 0) {
        rarity = r;
        break;
      }
    }
    const pool = byRarity[rarity] ?? byRarity.Common;
    const id = pool[Math.floor(rand() * pool.length)];
    const base = Math.max(1, Math.round(def.cards / stacks / STACK_DIVISOR[rarity]));
    cards[id] = (cards[id] ?? 0) + base;
  }
  return { gold, cards };
}

// ------------------------------------------------------------------ shop

/**
 * Gold value of one shard. A Rare shard is ~6 Commons, an Epic ~40, a Legendary ~200: about
 * how much scarcer each tier is in chests once you account for how many shards a level needs.
 */
export const SHARD_GOLD = { Common: 10, Rare: 60, Epic: 400, Legendary: 2000 };
/** Hourly offers sell `qty` shards per purchase, at most `limit` purchases per hour. */
export const SHOP_BUNDLE = { Common: { qty: 10, limit: 4 }, Rare: { qty: 4, limit: 3 }, Epic: { qty: 1, limit: 2 }, Legendary: { qty: 1, limit: 1 } };
/** Rarity of each hourly slot; the last slot turns Legendary one hour in four. */
export const SHOP_SLOTS = ['Common', 'Common', 'Common', 'Rare', 'Rare', 'Epic'];
const LEGENDARY_HOUR_CHANCE = 0.25;
/**
 * Gem price of a chest bought from the shop (opened on the spot, no slot needed). Priced at
 * ~5.7 (wooden) to ~7.5 (magical) gold-equivalent per gem of expected contents (gold + shards
 * at SHARD_GOLD), so bigger chests are better value. Always far above gemsToOpen for a slot chest.
 * Gem income is ~5–10 a day (quests + login calendar) plus the trophy road.
 */
export const CHEST_GEMS = { wooden: 18, silver: 40, gold: 110, magical: 270 };

export const HOUR_MS = 3600 * 1000;
export const hourKey = (now = Date.now()) => Math.floor(now / HOUR_MS);

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The hourly card offers for one player: deterministic in (player id, UTC hour). */
export function shopOffers(playerId, hour) {
  const rand = mulberry(hashSeed(`${playerId}:${hour}`));
  const pools = {};
  for (const c of CARDS) (pools[c.rarity ?? 'Common'] ??= []).push(c.id);
  const slots = [...SHOP_SLOTS];
  if (pools.Legendary && rand() < LEGENDARY_HOUR_CHANCE) slots[slots.length - 1] = 'Legendary';
  const offers = [];
  for (const rarity of slots) {
    const pool = pools[rarity];
    if (!pool?.length) continue;
    const card = pool.splice(Math.floor(rand() * pool.length), 1)[0];
    const { qty, limit } = SHOP_BUNDLE[rarity];
    offers.push({ card, rarity, qty, limit, price: qty * SHARD_GOLD[rarity] });
  }
  return offers;
}
