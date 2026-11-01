import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ws from 'ws';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { log } from './log.js';
import { CARD_BY_ID } from '../src/data/cards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'players.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
const PROFILE_FILE = path.join(DATA_DIR, 'profiles.json');
const REPLAY_FILE = path.join(DATA_DIR, 'replays.json');
const DOCS_FILE = path.join(DATA_DIR, 'docs.json');
const PUBLIC_REPLAYS = 30;
const REPLAYS_PER_PLAYER = 20;
const LEADERBOARD_SIZE = 10;
const CHAT_HISTORY = 50;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  country     TEXT,
  towers      INTEGER NOT NULL DEFAULT 0,
  cards       INTEGER NOT NULL DEFAULT 0,
  wins        INTEGER NOT NULL DEFAULT 0,
  losses      INTEGER NOT NULL DEFAULT 0,
  pvp_wins    INTEGER NOT NULL DEFAULT 0,
  pvp_losses  INTEGER NOT NULL DEFAULT 0,
  streak      INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id      BIGSERIAL PRIMARY KEY,
  name    TEXT NOT NULL,
  country TEXT,
  text    TEXT NOT NULL,
  ts      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS players_pvp_wins_idx ON players (pvp_wins DESC);
-- Progression (trophies, currencies, cards, chests, quests, pass) as one JSON document.
CREATE TABLE IF NOT EXISTS profiles (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS replays (
  id         TEXT PRIMARY KEY,
  player     TEXT NOT NULL,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS replays_player_idx ON replays (player, created_at DESC);
-- Small keyed documents: accounts, clans, the public replay list.
CREATE TABLE IF NOT EXISTS docs (
  kind       TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);
`;

/** Replays that use retired cards can no longer be simulated; they are hidden. */
const playable = (r) => r?.record?.decks?.every((d) => d.every((id) => CARD_BY_ID[id])) ?? false;

const blank = (name, country) => ({ name, country, towers: 0, cards: 0, wins: 0, losses: 0, pvpWins: 0, pvpLosses: 0, streak: 0, bestStreak: 0 });

/**
 * Player profiles, records, leaderboard and chat history. Uses Neon serverless Postgres
 * when DATABASE_URL is set, otherwise a JSON file (local dev). Reads come from an
 * in-memory cache loaded at boot; writes go through to the backing store.
 */
export class Store {
  async init() {
    this.players = {};
    this.chat = [];
    this.profiles = {};
    this.replays = {};
    this.docs = { account: {}, clan: {}, tv: {} };
    const url = process.env.DATABASE_URL;
    if (url) {
      neonConfig.webSocketConstructor = ws;
      this.pool = new Pool({ connectionString: url });
      await this.pool.query(SCHEMA);
      const { rows } = await this.pool.query('SELECT * FROM players');
      for (const r of rows) {
        this.players[r.id] = {
          name: r.name,
          country: r.country,
          towers: r.towers,
          cards: r.cards,
          wins: r.wins,
          losses: r.losses,
          pvpWins: r.pvp_wins,
          pvpLosses: r.pvp_losses,
          streak: r.streak,
          bestStreak: r.best_streak,
        };
      }
      const chat = await this.pool.query('SELECT name, country, text, ts FROM chat_messages ORDER BY id DESC LIMIT $1', [CHAT_HISTORY]);
      this.chat = chat.rows.reverse().map((r) => ({ ...r, ts: Number(r.ts) }));
      const profiles = await this.pool.query('SELECT id, data FROM profiles');
      for (const r of profiles.rows) this.profiles[r.id] = r.data;
      const docs = await this.pool.query('SELECT kind, id, data FROM docs');
      for (const r of docs.rows) (this.docs[r.kind] ??= {})[r.id] = r.data;
      this.kind = 'neon';
    } else {
      try {
        const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        for (const [id, p] of Object.entries(raw)) this.players[id] = { ...blank(p.name, p.country), ...p };
      } catch {}
      try {
        this.chat = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
      } catch {}
      try {
        this.profiles = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
      } catch {}
      try {
        this.replays = JSON.parse(fs.readFileSync(REPLAY_FILE, 'utf8'));
      } catch {}
      try {
        Object.assign(this.docs, JSON.parse(fs.readFileSync(DOCS_FILE, 'utf8')));
      } catch {}
      this.kind = 'json';
    }
    this.byEmail = new Map();
    this.byWallet = new Map();
    for (const a of Object.values(this.docs.account)) this.indexAccount(a);
  }

  // ---------------------------------------------------------------- documents

  doc(kind, id) {
    return this.docs[kind]?.[id] ?? null;
  }

  allDocs(kind) {
    return Object.values(this.docs[kind] ?? {});
  }

  saveDoc(kind, id, data) {
    (this.docs[kind] ??= {})[id] = data;
    if (!this.pool) return this.scheduleFileSave();
    this.pool
      .query('INSERT INTO docs (kind, id, data, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (kind, id) DO UPDATE SET data = $3, updated_at = now()', [kind, id, data])
      .catch((e) => log.error('doc save', { kind, err: e.message }));
  }

  deleteDoc(kind, id) {
    delete this.docs[kind]?.[id];
    if (!this.pool) return this.scheduleFileSave();
    this.pool.query('DELETE FROM docs WHERE kind = $1 AND id = $2', [kind, id]).catch((e) => log.error('doc delete', { kind, err: e.message }));
  }

  // ---------------------------------------------------------------- accounts

  indexAccount(a) {
    if (a.email) this.byEmail.set(a.email, a.id);
    if (a.wallet) this.byWallet.set(a.wallet, a.id);
  }

  account(id) {
    return this.doc('account', id);
  }

  accountByEmail(email) {
    return this.account(this.byEmail.get(email));
  }

  accountByWallet(wallet) {
    return this.account(this.byWallet.get(wallet));
  }

  saveAccount(a) {
    this.indexAccount(a);
    this.saveDoc('account', a.id, a);
  }

  // ---------------------------------------------------------------- public replays (TV)

  addPublicReplay(meta) {
    const list = (this.doc('tv', 'list') ?? []).filter((r) => r.id !== meta.id);
    list.unshift(meta);
    list.length = Math.min(list.length, PUBLIC_REPLAYS);
    this.saveDoc('tv', 'list', list);
  }

  publicReplays() {
    return (this.doc('tv', 'list') ?? []).filter(playable).map(({ record, ...meta }) => meta);
  }

  publicReplay(id) {
    const r = (this.doc('tv', 'list') ?? []).find((x) => x.id === id);
    return playable(r) ? r : null;
  }

  /** For /healthz: the database answers (JSON storage is always healthy). */
  async healthy() {
    if (!this.pool) return true;
    try {
      await Promise.race([this.pool.query('SELECT 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
      return true;
    } catch (e) {
      log.error('health check failed', { err: e.message });
      return false;
    }
  }

  logBoot() {
    log.info('storage ready', { kind: this.kind, players: Object.keys(this.players).length, accounts: Object.keys(this.docs.account).length, clans: Object.keys(this.docs.clan).length });
  }

  has(id) {
    return Boolean(this.players[id]);
  }

  get(id) {
    return this.players[id];
  }

  upsert(id, name, country) {
    const p = (this.players[id] ??= blank(name, country));
    p.name = name;
    if (country) p.country = country;
    this.persist(id);
    return p;
  }

  /** Records a finished match. `pvp` results also feed the WINS leaderboard and streaks. */
  recordMatch(id, { result, towers, cards, pvp }) {
    const p = this.players[id];
    if (!p) return;
    p.towers += towers;
    p.cards += cards;
    if (result === 'win') p.wins++;
    if (result === 'loss') p.losses++;
    if (pvp) {
      if (result === 'win') {
        p.pvpWins++;
        p.streak++;
        p.bestStreak = Math.max(p.bestStreak, p.streak);
      } else {
        if (result === 'loss') p.pvpLosses++;
        p.streak = 0;
      }
    }
    this.persist(id);
  }

  leaderboard() {
    const rows = Object.values(this.players);
    const top = (key) =>
      rows
        .filter((p) => p[key] > 0)
        .sort((a, b) => b[key] - a[key])
        .slice(0, LEADERBOARD_SIZE)
        .map((p) => ({ name: p.name, country: p.country, value: p[key], streak: p.streak }));
    return { towers: top('towers'), cards: top('cards'), wins: top('pvpWins') };
  }

  addChat(entry) {
    this.chat.push(entry);
    if (this.chat.length > CHAT_HISTORY) this.chat.shift();
    if (this.pool) {
      this.pool.query('INSERT INTO chat_messages (name, country, text, ts) VALUES ($1, $2, $3, $4)', [entry.name, entry.country, entry.text, entry.ts]).catch((e) => log.error('chat insert', { err: e.message }));
    } else this.scheduleFileSave();
  }

  persist(id) {
    if (!this.pool) return this.scheduleFileSave();
    const p = this.players[id];
    this.pool
      .query(
        `INSERT INTO players (id, name, country, towers, cards, wins, losses, pvp_wins, pvp_losses, streak, best_streak, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         ON CONFLICT (id) DO UPDATE SET name=$2, country=$3, towers=$4, cards=$5, wins=$6, losses=$7,
           pvp_wins=$8, pvp_losses=$9, streak=$10, best_streak=$11, updated_at=now()`,
        [id, p.name, p.country, p.towers, p.cards, p.wins, p.losses, p.pvpWins, p.pvpLosses, p.streak, p.bestStreak],
      )
      .catch((e) => log.error('player upsert', { err: e.message }));
  }

  getProfile(id) {
    return this.profiles[id] ?? null;
  }

  saveProfile(id, data) {
    this.profiles[id] = data;
    if (!this.pool) return this.scheduleFileSave();
    this.pool
      .query('INSERT INTO profiles (id, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = now()', [id, data])
      .catch((e) => log.error('profile save', { err: e.message }));
  }

  /** Keeps the newest replays per player (metadata is listed, the full record fetched on demand). */
  async saveReplay(player, replay) {
    const list = (this.replays[player] ??= []);
    list.unshift(replay);
    list.length = Math.min(list.length, REPLAYS_PER_PLAYER);
    if (!this.pool) return this.scheduleFileSave();
    await this.pool.query('INSERT INTO replays (id, player, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [replay.id, player, replay]).catch((e) => log.error('replay save', { err: e.message }));
  }

  async listReplays(player) {
    if (this.pool && !this.replays[player]) {
      const { rows } = await this.pool.query('SELECT data FROM replays WHERE player = $1 ORDER BY created_at DESC LIMIT $2', [player, REPLAYS_PER_PLAYER]);
      this.replays[player] = rows.map((r) => r.data);
    }
    return (this.replays[player] ?? []).filter(playable).map(({ record, ...meta }) => meta);
  }

  async getReplay(player, id) {
    const hit = (this.replays[player] ?? []).find((r) => r.id === id);
    if (hit || !this.pool) return playable(hit) ? hit : null;
    const { rows } = await this.pool.query('SELECT data FROM replays WHERE id = $1 AND player = $2', [id, player]);
    return playable(rows[0]?.data) ? rows[0].data : null;
  }

  scheduleFileSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFile(DB_FILE, JSON.stringify(this.players), () => {});
      fs.writeFile(CHAT_FILE, JSON.stringify(this.chat), () => {});
      fs.writeFile(PROFILE_FILE, JSON.stringify(this.profiles), () => {});
      fs.writeFile(REPLAY_FILE, JSON.stringify(this.replays), () => {});
      fs.writeFile(DOCS_FILE, JSON.stringify(this.docs), () => {});
    }, 1000);
  }
}
