import crypto from 'node:crypto';
import { CARD_BY_ID } from '../src/data/cards.js';
import {
  newProfile, refreshQuests, applyMatch, grant, rollChest, upgradeCost, towerLevel, kingLevel,
  CHESTS, gemsToOpen, MAX_CARD_LEVEL, TROPHY_ROAD, PASS_TIERS, passReward, passTier, START_LEVEL,
  DAILY_REWARDS, dailyStatus, dayKey, leaderboardReward, solPrize,
  CHEST_GEMS, shopOffers, hourKey,
} from '../src/data/economy.js';
import { ReplayDriver } from '../src/sim/replay.js';
import { randomDeck, rng } from '../src/sim/sim.js';
import { arenaFor, ARENA_BY_ID } from '../src/data/arenas.js';
import { aiDifficulty } from '../src/sim/aiDifficulty.js';
import { signResult } from './auth.js';
import { SIM_VERSION } from '../src/sim/constants.js';

const AI_MATCH_TTL_MS = 15 * 60 * 1000;
const MAX_INPUTS = 800;
const AI_NAMES = ['Sir Bot-a-Lot', 'Grumblebeard', 'Lady Elixira', 'Count Crumble', 'Old Tusk'];

const rand = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;
const isValidDeck = (d) => Array.isArray(d) && d.length === 8 && new Set(d).size === 8 && d.every((id) => CARD_BY_ID[id]);

/** Rolls the player's hourly card offers when the UTC hour changes (purchase counts reset). */
function refreshShop(id, p, now = Date.now()) {
  const hour = hourKey(now);
  if (p.shop?.hour === hour) return false;
  const offers = shopOffers(id, hour);
  p.shop = { hour, offers, bought: offers.map(() => 0) };
  return true;
}

/**
 * Server-authoritative progression. The client only ever *asks*; every reward, unlock and
 * upgrade is validated and applied here, and AI matches are re-simulated from their seed
 * and recorded inputs before any trophies or chests are handed out.
 */
export class Economy {
  constructor(store) {
    this.store = store;
    this.pendingAi = new Map();
  }

  /** Loads (or creates) a profile, migrating new cards in and rolling the daily quests. */
  profile(id) {
    let p = this.store.getProfile(id);
    let dirty = false;
    if (!p) {
      p = newProfile();
      dirty = true;
    }
    // v2: cards start at level 1 instead of 9 (old levels 9..14 become 1..6).
    if ((p.v ?? 1) < 2) {
      for (const c of Object.values(p.cards)) c.level = Math.max(START_LEVEL, c.level - 8);
      p.v = 2;
      dirty = true;
    }
    for (const card of Object.values(CARD_BY_ID)) {
      if (!p.cards[card.id]) {
        p.cards[card.id] = { level: START_LEVEL, shards: 0 };
        dirty = true;
      }
    }
    if (refreshQuests(p, rand)) dirty = true;
    if (refreshShop(id, p)) dirty = true;
    if (dirty) this.store.saveProfile(id, p);
    return p;
  }

  save(id, p) {
    this.store.saveProfile(id, p);
  }

  /** Battle levels for a deck: tower level from King XP, each card at its own level. */
  levelsFor(p, deck) {
    return { tower: towerLevel(p.xp), cards: Object.fromEntries(deck.map((c) => [c, p.cards[c]?.level ?? START_LEVEL])) };
  }

  // ---------------------------------------------------------------- matches

  /** Starts a verified AI match: the server picks the seed and the bot's deck and levels. */
  aiStart(id, deck, arenaId) {
    if (!isValidDeck(deck)) return { error: 'deck' };
    const p = this.profile(id);
    const seed = crypto.randomInt(1, 2 ** 31);
    const r = rng(seed ^ 0x5bd1e995);
    const aiDeck = randomDeck(r);
    const mine = this.levelsFor(p, deck);
    // Any unlocked arena may be chosen; its bot, and its rewards, come with it.
    const picked = ARENA_BY_ID[arenaId];
    const arena = picked && p.trophies >= picked.trophies ? picked : arenaFor(p.trophies);
    const difficulty = aiDifficulty(arena.id);
    // The bot plays at the player's average card level, plus its arena's bonus.
    const avg = deck.reduce((s, c) => s + mine.cards[c], 0) / deck.length;
    const aiLevel = Math.min(MAX_CARD_LEVEL, Math.round(avg) + (difficulty.levelBonus ?? 0));
    const aiCards = Object.fromEntries(aiDeck.map((c) => [c, aiLevel]));
    const match = {
      matchId: crypto.randomUUID(),
      mode: 'ai',
      seed,
      decks: [deck, aiDeck],
      levels: [mine.tower, Math.min(MAX_CARD_LEVEL, mine.tower + (difficulty.levelBonus ?? 0))],
      cardLevels: [mine.cards, aiCards],
      oppName: AI_NAMES[seed % AI_NAMES.length],
      arenaId: arena.id,
      aiTier: difficulty.id,
      created: Date.now(),
      player: id,
    };
    this.pendingAi.set(match.matchId, match);
    for (const [k, m] of this.pendingAi) if (Date.now() - m.created > AI_MATCH_TTL_MS) this.pendingAi.delete(k);
    return match;
  }

  /** Re-runs the AI match from its record and applies the result the server itself computed. */
  async aiEnd(id, matchId, inputs) {
    const match = this.pendingAi.get(matchId);
    if (!match || match.player !== id) return { error: 'match' };
    this.pendingAi.delete(matchId);
    if (!Array.isArray(inputs) || inputs.length > MAX_INPUTS) return { error: 'inputs' };
    const clean = [];
    for (const it of inputs) {
      if (!Array.isArray(it)) continue;
      const tick = Number(it[0]) | 0;
      if (it[2] === 'forfeit') clean.push([tick, 0, 'forfeit']);
      else if (Number.isFinite(it[3]) && Number.isFinite(it[4])) clean.push([tick, 0, Number(it[2]) & 3, Number(it[3]), Number(it[4])]);
    }
    const record = {
      v: SIM_VERSION,
      mode: 'ai',
      seed: match.seed,
      decks: match.decks,
      levels: match.levels,
      cardLevels: match.cardLevels,
      arenaId: match.arenaId,
      aiTier: match.aiTier,
      inputs: clean,
    };
    const sim = new ReplayDriver(record).runToEnd();
    const r = sim.result(0);
    const p = this.profile(id);
    const summary = applyMatch(p, { result: r.result, myCrowns: r.myCrowns, deck: match.decks[0], deployed: r.myDeployed, oppTrophies: p.trophies, arenaId: match.arenaId });
    this.save(id, p);
    const signed = { match: matchId, mode: 'ai', seed: match.seed, players: id, winner: sim.winner ?? -1, crowns: `${r.myCrowns}-${r.enemyCrowns}`, ticks: sim.tick };
    signed.sig = signResult(signed);
    await this.storeReplay(id, { record, result: r, opp: match.oppName, mode: 'ai', sig: signed.sig });
    return { result: r, summary, profile: p, signed };
  }

  /** Online match finished on the server: both sides are scored against each other. */
  async pvpEnd(room) {
    const ranked = room.mode !== 'friendly';
    const profiles = room.players.map((pl) => this.profile(pl.id));
    const before = profiles.map((p) => p.trophies);
    const out = [];
    for (const team of [0, 1]) {
      const p = profiles[team];
      if (!ranked) {
        out.push({ summary: null, friendly: true, profile: p });
        continue;
      }
      const r = room.sim.result(team);
      const summary = applyMatch(p, { result: r.result, myCrowns: r.myCrowns, deck: room.players[team].deck, deployed: r.myDeployed, oppTrophies: before[1 - team] });
      this.save(room.players[team].id, p);
      out.push({ summary, profile: p });
    }
    const record = { v: SIM_VERSION, mode: 'pvp', seed: room.sim.seed, decks: room.players.map((pl) => pl.deck), levels: room.levels, cardLevels: room.cardLevels, inputs: room.inputs };
    const mode = ranked ? 'pvp' : 'friendly';
    for (const team of [0, 1]) {
      await this.storeReplay(room.players[team].id, { record, result: room.sim.result(team), opp: room.players[1 - team].name, mode, team, sig: room.signed?.sig });
    }
    if (ranked) {
      const r = room.sim.result(0);
      this.store.addPublicReplay({
        id: crypto.randomUUID(),
        ts: Date.now(),
        mode,
        team: 0,
        players: room.players.map((pl, t) => ({ name: pl.name, country: pl.country, trophies: before[t] })),
        crowns: [r.myCrowns, r.enemyCrowns],
        winner: room.sim.winner ?? -1,
        duration: Math.round(r.duration),
        sig: room.signed?.sig,
        record,
      });
    }
    return out;
  }

  async storeReplay(player, { record, result, opp, mode, team = 0, sig }) {
    await this.store.saveReplay(player, {
      id: crypto.randomUUID(),
      ts: Date.now(),
      mode,
      team,
      opp,
      result: result.result,
      crowns: [result.myCrowns, result.enemyCrowns],
      duration: Math.round(result.duration),
      sig,
      record,
    });
  }

  // ---------------------------------------------------------------- chests

  chestStart(id, slot) {
    const p = this.profile(id);
    const c = p.chests[slot];
    if (!c || c.unlockAt) return { error: 'chest' };
    if (p.chests.some((o) => o?.unlockAt && o.unlockAt > Date.now())) return { error: 'busy' };
    c.unlockAt = Date.now() + CHESTS[c.type].unlock * 1000;
    this.save(id, p);
    return { profile: p };
  }

  /** Opens a ready chest, or a locked one for gems. Rewards are rolled here, not on the client. */
  chestOpen(id, slot, useGems) {
    const p = this.profile(id);
    const c = p.chests[slot];
    if (!c) return { error: 'chest' };
    const left = c.unlockAt ? Math.max(0, (c.unlockAt - Date.now()) / 1000) : CHESTS[c.type].unlock;
    if (left > 0) {
      if (!useGems) return { error: 'locked' };
      const cost = gemsToOpen(left);
      if (p.gems < cost) return { error: 'gems' };
      p.gems -= cost;
    }
    const loot = rollChest(c.type, rand);
    p.gold += loot.gold;
    for (const [cid, n] of Object.entries(loot.cards)) p.cards[cid].shards += n;
    p.chests[slot] = null;
    this.save(id, p);
    return { profile: p, loot: { type: c.type, ...loot } };
  }

  // ---------------------------------------------------------------- shop

  /** Buys a chest for gems at the server's price and opens it on the spot. */
  chestBuy(id, type) {
    const p = this.profile(id);
    const cost = Object.hasOwn(CHEST_GEMS, type) ? CHEST_GEMS[type] : null;
    if (!cost) return { error: 'chest' };
    if (p.gems < cost) return { error: 'gems' };
    p.gems -= cost;
    const loot = rollChest(type, rand);
    p.gold += loot.gold;
    for (const [cid, n] of Object.entries(loot.cards)) p.cards[cid].shards += n;
    this.save(id, p);
    return { profile: p, loot: { type, ...loot }, cost };
  }

  /** Refreshes the hourly offers (the client asks when its countdown reaches zero). */
  shop(id) {
    return { profile: this.profile(id) };
  }

  /**
   * Buys one bundle of an hourly offer. Only the slot index (and the hour the client was
   * looking at) come from the client; card, amount and price are the server's own.
   */
  shopBuy(id, slot, hour) {
    const p = this.profile(id);
    if (hour !== p.shop.hour) return { error: 'expired', profile: p };
    const offer = p.shop.offers[slot];
    if (!offer) return { error: 'offer' };
    if (p.shop.bought[slot] >= offer.limit) return { error: 'soldout' };
    const own = p.cards[offer.card];
    if (!own || own.level >= MAX_CARD_LEVEL) return { error: 'maxed' };
    if (p.gold < offer.price) return { error: 'gold' };
    p.gold -= offer.price;
    own.shards += offer.qty;
    p.shop.bought[slot]++;
    this.save(id, p);
    return { profile: p, card: offer.card, qty: offer.qty, cost: offer.price };
  }

  // ---------------------------------------------------------------- cards

  upgrade(id, cardId) {
    const p = this.profile(id);
    const card = CARD_BY_ID[cardId];
    const own = p.cards[cardId];
    if (!card || !own || own.level >= MAX_CARD_LEVEL) return { error: 'card' };
    const cost = upgradeCost(card, own.level);
    if (own.shards < cost.shards) return { error: 'shards' };
    if (p.gold < cost.gold) return { error: 'gold' };
    own.shards -= cost.shards;
    p.gold -= cost.gold;
    own.level++;
    const levelBefore = kingLevel(p.xp);
    p.xp += cost.xp;
    this.save(id, p);
    return { profile: p, card: cardId, level: own.level, kingUp: kingLevel(p.xp) > levelBefore };
  }

  // ---------------------------------------------------------------- quests, pass, road

  claimQuest(id, index) {
    const p = this.profile(id);
    const q = p.quests.list[index];
    if (!q || q.claimed || q.progress < q.target) return { error: 'quest' };
    q.claimed = true;
    const reward = grant(p, q.reward);
    this.save(id, p);
    return { profile: p, reward };
  }

  /** Daily login reward: once per UTC day, the streak decides which of the 7 rewards it is. */
  claimDaily(id) {
    const p = this.profile(id);
    const status = dailyStatus(p);
    if (!status.claimable) return { error: 'claimed' };
    p.daily = { day: dayKey(), streak: status.streak + 1 };
    const reward = grant(p, DAILY_REWARDS[status.day - 1]);
    this.save(id, p);
    return { profile: p, reward, day: status.day };
  }

  /** Credits a top-10 finish straight away and leaves a notice the player sees on next login. */
  payLeaderboard(id, rank, day, wallet = null) {
    const reward = leaderboardReward(rank);
    if (!reward) return null;
    const p = this.profile(id);
    grant(p, reward);
    const sol = solPrize(rank);
    p.notices = [...(p.notices ?? []), { kind: 'leaderboard', rank, day, reward, ...(sol ? { sol, wallet: Boolean(wallet) } : {}) }].slice(-5);
    this.save(id, p);
    return p;
  }

  ackNotices(id) {
    const p = this.profile(id);
    if (!p.notices?.length) return { profile: p };
    p.notices = [];
    this.save(id, p);
    return { profile: p };
  }

  claimPass(id, tier) {
    const p = this.profile(id);
    tier = Number(tier) | 0;
    if (tier < 1 || tier > PASS_TIERS || p.pass.claimed.includes(tier) || passTier(p.pass.xp) < tier) return { error: 'pass' };
    p.pass.claimed.push(tier);
    const reward = grant(p, passReward(tier));
    this.save(id, p);
    return { profile: p, reward };
  }

  claimRoad(id, at) {
    const p = this.profile(id);
    const step = TROPHY_ROAD.find((s) => s.at === Number(at));
    if (!step || p.road.includes(step.at) || p.bestTrophies < step.at) return { error: 'road' };
    p.road.push(step.at);
    const reward = grant(p, step.reward);
    this.save(id, p);
    return { profile: p, reward };
  }
}
