import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ws from 'ws';
import { Pool, neonConfig } from '@neondatabase/serverless';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'players.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
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
`;

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
      this.kind = 'neon';
    } else {
      try {
        const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        for (const [id, p] of Object.entries(raw)) this.players[id] = { ...blank(p.name, p.country), ...p };
      } catch {}
      try {
        this.chat = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
      } catch {}
      this.kind = 'json';
    }
    console.log(`Storage: ${this.kind} (${Object.keys(this.players).length} players)`);
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
      this.pool.query('INSERT INTO chat_messages (name, country, text, ts) VALUES ($1, $2, $3, $4)', [entry.name, entry.country, entry.text, entry.ts]).catch((e) => console.error('chat insert', e.message));
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
      .catch((e) => console.error('player upsert', e.message));
  }

  scheduleFileSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFile(DB_FILE, JSON.stringify(this.players), () => {});
      fs.writeFile(CHAT_FILE, JSON.stringify(this.chat), () => {});
    }, 1000);
  }
}
