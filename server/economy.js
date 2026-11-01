import crypto from 'node:crypto';
import { CARD_BY_ID } from '../src/data/cards.js';
import {
  newProfile, refreshQuests, applyMatch, grant, rollChest, upgradeCost, towerLevel, kingLevel,
  CHESTS, gemsToOpen, MAX_CARD_LEVEL, TROPHY_ROAD, PASS_TIERS, passReward, passTier, START_LEVEL,
} from '../src/data/economy.js';
import { ReplayDriver } from '../src/sim/replay.js';
import { randomDeck, rng } from '../src/sim/sim.js';
import { signResult } from './auth.js';

const AI_MATCH_TTL_MS = 15 * 60 * 1000;
const MAX_INPUTS = 800;
const AI_NAMES = ['Sir Bot-a-Lot', 'Grumblebeard', 'Lady Elixira', 'Count Crumble', 'Old Tusk'];

const rand = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;
const isValidDeck = (d) => Array.isArray(d) && d.length === 8 && new Set(d).size === 8 && d.every((id) => CARD_BY_ID[id]);

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
    for (const card of Object.values(CARD_BY_ID)) {
      if (!p.cards[card.id]) {
        p.cards[card.id] = { level: START_LEVEL, shards: 0 };
        dirty = true;
      }
    }
    if (refreshQuests(p, rand)) dirty = true;
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
  aiStart(id, deck) {
    if (!isValidDeck(deck)) return { error: 'deck' };
    const p = this.profile(id);
    const seed = crypto.randomInt(1, 2 ** 31);
    const r = rng(seed ^ 0x5bd1e995);
    const aiDeck = randomDeck(r);
    const mine = this.levelsFor(p, deck);
    // The bot plays at the player's average card level so it stays a fair fight.
    const avg = Math.round(deck.reduce((s, c) => s + mine.cards[c], 0) / deck.length);
    const aiCards = Object.fromEntries(aiDeck.map((c) => [c, avg]));
    const match = {
      matchId: crypto.randomUUID(),
      mode: 'ai',
      seed,
      decks: [deck, aiDeck],
      levels: [mine.tower, mine.tower],
      cardLevels: [mine.cards, aiCards],
      oppName: AI_NAMES[seed % AI_NAMES.length],
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
    const record = { mode: 'ai', seed: match.seed, decks: match.decks, levels: match.levels, cardLevels: match.cardLevels, inputs: clean };
    const sim = new ReplayDriver(record).runToEnd();
    const r = sim.result(0);
    const p = this.profile(id);
    const summary = applyMatch(p, { result: r.result, myCrowns: r.myCrowns, deck: match.decks[0], deployed: r.myDeployed, oppTrophies: p.trophies });
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
    const record = { mode: 'pvp', seed: room.sim.seed, decks: room.players.map((pl) => pl.deck), levels: room.levels, cardLevels: room.cardLevels, inputs: room.inputs };
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
