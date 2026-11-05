import { LEADERBOARD_SIZE, dayKey, leaderboardReward, solPrize } from '../src/data/economy.js';
import { log } from './log.js';

const CACHE_MS = 2000;
const PAYOUT_CHECK_MS = 60_000;

/**
 * The trophy ladder: top 100 registered players by trophies, with their clan. A player's
 * place on it is their title (#1 … #100). Every day at 00:00 UTC the top 10 are paid.
 */
export class Ranking {
  constructor(store, economy, clans, { onPaid } = {}) {
    this.store = store;
    this.economy = economy;
    this.clans = clans;
    this.onPaid = onPaid ?? (() => {});
    this.cached = null;
    this.cachedAt = 0;
  }

  /** Public rows (no account ids): { name, country, value, clan }. */
  board() {
    if (this.cached && Date.now() - this.cachedAt < CACHE_MS) return this.cached.rows;
    const entries = [];
    for (const [id, profile] of Object.entries(this.store.profiles)) {
      if (!profile?.trophies || !this.store.account(id)?.username) continue;
      entries.push({ id, trophies: profile.trophies });
    }
    entries.sort((a, b) => b.trophies - a.trophies || a.id.localeCompare(b.id));
    const top = entries.slice(0, LEADERBOARD_SIZE);
    const rows = top.map(({ id, trophies }) => {
      const p = this.store.get(id);
      const clan = this.clans.clanOf(id);
      return { name: p?.name ?? this.store.account(id).username, country: p?.country ?? null, value: trophies, clan: clan ? { name: clan.name, tag: clan.tag, badge: clan.badge } : null };
    });
    this.cached = { rows, ids: top.map((e) => e.id) };
    this.cachedAt = Date.now();
    return rows;
  }

  rankOf(id) {
    this.board();
    const i = this.cached.ids.indexOf(id);
    return i < 0 ? null : i + 1;
  }

  invalidate() {
    this.cached = null;
  }

  /** Pays the top 10 once per UTC day, from the standings at the moment the day rolls over. */
  checkPayout() {
    const today = dayKey();
    const meta = this.store.doc('meta', 'ladder');
    // First boot ever: start counting from today rather than paying out on deploy.
    if (!meta) return this.store.saveDoc('meta', 'ladder', { paidDay: today });
    if (meta.paidDay === today) return;
    this.invalidate();
    this.board();
    const winners = this.cached.ids.slice(0, 10);
    winners.forEach((id, i) => {
      const profile = this.economy.payLeaderboard(id, i + 1, meta.paidDay, this.store.account(id)?.solana);
      if (profile) this.onPaid(id, profile);
    });
    // Solana prizes are sent by hand: keep who is owed what, and to which wallet.
    const owed = winners.slice(0, 3).map((id, i) => ({ day: meta.paidDay, rank: i + 1, name: this.store.get(id)?.name ?? null, account: id, wallet: this.store.account(id)?.solana ?? null, sol: solPrize(i + 1), paid: false }));
    if (owed.length) {
      this.store.saveDoc('meta', 'sol-payouts', [...owed, ...(this.store.doc('meta', 'sol-payouts') ?? [])].slice(0, 300));
      log.info('sol prizes owed', { day: meta.paidDay, owed: owed.map((o) => `#${o.rank} ${o.name} ${o.sol} SOL ${o.wallet ?? 'NO WALLET'}`) });
    }
    this.store.saveDoc('meta', 'ladder', { paidDay: today, last: { day: meta.paidDay, winners: winners.map((id, i) => ({ rank: i + 1, name: this.store.get(id)?.name, reward: leaderboardReward(i + 1) })) } });
    log.info('ladder rewards paid', { day: meta.paidDay, players: winners.length });
  }

  start() {
    this.checkPayout();
    setInterval(() => this.checkPayout(), PAYOUT_CHECK_MS).unref();
  }
}
