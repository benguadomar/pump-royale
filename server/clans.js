import crypto from 'node:crypto';
import { CARD_BY_ID } from '../src/data/cards.js';

const MAX_MEMBERS = 30;
const MAX_CHAT = 60;
const CREATE_COST = 100;
const REQUEST_COOLDOWN_MS = 4 * 3600 * 1000;
const REQUEST_TTL_MS = 8 * 3600 * 1000;
/** Shards a member may receive per request, by rarity (legendaries cannot be requested). */
const REQUEST_SIZE = { Common: 10, Rare: 3, Epic: 1 };
const DONATE_REWARD = { Common: { gold: 5, xp: 1 }, Rare: { gold: 50, xp: 10 }, Epic: { gold: 500, xp: 100 } };
const BADGES = 8;
/** 'open': anyone joins at once. 'invite': players ask (or are invited) and the leader decides. */
const TYPES = new Set(['open', 'invite']);
const MAX_JOIN_REQUESTS = 20;
const TOP_CLANS = 50;

const cleanName = (s, max) =>
  String(s ?? '')
    .replace(/[^\p{L}\p{N}_\- .!']/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const tagChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newTag = () => Array.from({ length: 6 }, () => tagChars[crypto.randomInt(tagChars.length)]).join('');

/**
 * Clans: membership, chat, card requests and donations, and a trophy leaderboard. All
 * state lives in the store as `clan` documents; donations move shards between two
 * server-side profiles through the economy, never trusting the client.
 */
export class Clans {
  constructor(store, economy, hooks) {
    this.store = store;
    this.economy = economy;
    this.hooks = hooks; // { notify(ids, msg), isOnline(id), nameOf(id), idByName(name) }
    this.memberOf = new Map();
    for (const c of store.allDocs('clan')) for (const m of c.members) this.memberOf.set(m.id, c.id);
  }

  clanOf(playerId) {
    const id = this.memberOf.get(playerId);
    return id ? this.store.doc('clan', id) : null;
  }

  trophies(c) {
    return c.members.reduce((s, m) => s + (this.economy.profile(m.id).trophies ?? 0), 0);
  }

  summary(c) {
    return { id: c.id, name: c.name, tag: c.tag, badge: c.badge, desc: c.desc, type: c.type ?? 'open', members: c.members.length, trophies: this.trophies(c) };
  }

  /** Full view for a member. Requests carry `mine` so the client can hide its own Donate button. */
  view(c, viewer) {
    const now = Date.now();
    c.requests = c.requests.filter((r) => now - r.ts < REQUEST_TTL_MS && r.got < r.need && CARD_BY_ID[r.card]);
    const me = c.members.find((m) => m.id === viewer);
    return {
      ...this.summary(c),
      role: me?.role,
      nextRequestAt: (me?.lastRequest ?? 0) + REQUEST_COOLDOWN_MS,
      members: c.members
        .map((m) => ({ name: this.hooks.nameOf(m.id), role: m.role, trophies: this.economy.profile(m.id).trophies, online: this.hooks.isOnline(m.id), donated: m.donated ?? 0, me: m.id === viewer }))
        .sort((a, b) => b.trophies - a.trophies),
      chat: c.chat,
      requests: c.requests.map((r) => ({ id: r.id, name: r.name, card: r.card, got: r.got, need: r.need, ts: r.ts, mine: r.player === viewer })),
      // Only the leader sees who is waiting to join.
      joinRequests: me?.role === 'leader' ? (c.joinRequests ?? []).map((j) => ({ id: j.player, name: this.hooks.nameOf(j.player), trophies: this.economy.profile(j.player).trophies, ts: j.ts })) : [],
    };
  }

  save(c) {
    this.store.saveDoc('clan', c.id, c);
  }

  /** Pushes a fresh view to every online member. */
  broadcast(c) {
    for (const m of c.members) if (this.hooks.isOnline(m.id)) this.hooks.notify([m.id], { t: 'clan', clan: this.view(c, m.id) });
  }

  // ---------------------------------------------------------------- browsing

  /** Search (by name or #TAG), or the top clans by trophies when the query is empty. */
  list(query = '', viewer = null) {
    const q = cleanName(query, 24).toLowerCase();
    return this.store
      .allDocs('clan')
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.tag.toLowerCase() === q.replace('#', ''))
      .map((c) => ({ ...this.summary(c), asked: Boolean(viewer && c.joinRequests?.some((j) => j.player === viewer)), invited: Boolean(viewer && c.invites?.includes(viewer)) }))
      .sort((a, b) => b.trophies - a.trophies)
      .slice(0, TOP_CLANS);
  }

  /** Clans that invited this player. */
  invitesFor(playerId) {
    return this.store
      .allDocs('clan')
      .filter((c) => c.invites?.includes(playerId))
      .map((c) => ({ ...this.summary(c), invited: true }));
  }

  leaderboard() {
    return this.store
      .allDocs('clan')
      .map((c) => this.summary(c))
      .sort((a, b) => b.trophies - a.trophies)
      .slice(0, 10);
  }

  // ---------------------------------------------------------------- membership

  create(playerId, { name, desc, badge, type }) {
    if (this.clanOf(playerId)) return { error: 'in-clan' };
    const clean = cleanName(name, 20);
    if (clean.length < 3) return { error: 'name' };
    if (this.store.allDocs('clan').some((c) => c.name.toLowerCase() === clean.toLowerCase())) return { error: 'taken' };
    const p = this.economy.profile(playerId);
    if (p.gold < CREATE_COST) return { error: 'gold' };
    p.gold -= CREATE_COST;
    this.economy.save(playerId, p);
    const c = {
      id: crypto.randomUUID(),
      name: clean,
      tag: newTag(),
      badge: Math.abs(Number(badge) | 0) % BADGES,
      desc: cleanName(desc, 120),
      type: TYPES.has(type) ? type : 'open',
      created: Date.now(),
      members: [{ id: playerId, role: 'leader', joined: Date.now() }],
      chat: [],
      requests: [],
      joinRequests: [],
      invites: [],
    };
    this.save(c);
    this.memberOf.set(playerId, c.id);
    this.forgetPending(playerId);
    this.system(c, `${this.hooks.nameOf(playerId)} founded the clan`);
    return { clan: this.view(c, playerId), profile: p };
  }

  /** Open clans (or an invitation) let you straight in; invite-only clans get a join request. */
  join(playerId, clanId) {
    if (this.clanOf(playerId)) return { error: 'in-clan' };
    const c = this.store.doc('clan', String(clanId));
    if (!c) return { error: 'clan' };
    if (c.members.length >= MAX_MEMBERS) return { error: 'full' };
    if ((c.type ?? 'open') === 'invite' && !c.invites?.includes(playerId)) {
      c.joinRequests ??= [];
      if (c.joinRequests.some((j) => j.player === playerId)) return { pending: true };
      if (c.joinRequests.length >= MAX_JOIN_REQUESTS) return { error: 'busy' };
      c.joinRequests.push({ player: playerId, ts: Date.now() });
      this.system(c, `${this.hooks.nameOf(playerId)} asked to join`);
      return { pending: true };
    }
    this.admit(c, playerId);
    return { clan: this.view(c, playerId) };
  }

  admit(c, playerId) {
    c.members.push({ id: playerId, role: 'member', joined: Date.now() });
    this.memberOf.set(playerId, c.id);
    this.forgetPending(playerId);
    this.system(c, `${this.hooks.nameOf(playerId)} joined the clan`);
  }

  /** Once in a clan, a player's other join requests and invitations are void. */
  forgetPending(playerId) {
    for (const c of this.store.allDocs('clan')) {
      const before = (c.joinRequests?.length ?? 0) + (c.invites?.length ?? 0);
      c.joinRequests = (c.joinRequests ?? []).filter((j) => j.player !== playerId);
      c.invites = (c.invites ?? []).filter((id) => id !== playerId);
      if (c.joinRequests.length + c.invites.length !== before) this.save(c);
    }
  }

  leaderClan(playerId) {
    const c = this.clanOf(playerId);
    return c?.members.find((m) => m.id === playerId)?.role === 'leader' ? c : null;
  }

  /** Leader answers a join request. */
  answer(leaderId, playerId, accept) {
    const c = this.leaderClan(leaderId);
    if (!c) return { error: 'leader' };
    const pending = c.joinRequests?.find((j) => j.player === playerId);
    if (!pending) return { error: 'request' };
    c.joinRequests = c.joinRequests.filter((j) => j.player !== playerId);
    if (!accept) {
      this.save(c);
      this.broadcast(c);
      return {};
    }
    if (this.clanOf(playerId)) {
      this.save(c);
      this.broadcast(c);
      return { error: 'in-clan' };
    }
    if (c.members.length >= MAX_MEMBERS) return { error: 'full' };
    this.admit(c, playerId);
    this.hooks.notify([playerId], { t: 'clan', clan: this.view(c, playerId) });
    return {};
  }

  /** Leader invites a player by username; they can then join even an invite-only clan. */
  invite(leaderId, username) {
    const c = this.leaderClan(leaderId);
    if (!c) return { error: 'leader' };
    const id = this.hooks.idByName(String(username ?? '').trim());
    if (!id) return { error: 'player' };
    if (this.clanOf(id)) return { error: 'player-in-clan' };
    c.invites ??= [];
    if (!c.invites.includes(id)) c.invites.push(id);
    this.system(c, `${this.hooks.nameOf(id)} was invited`);
    this.hooks.notify([id], { t: 'clan-invite', clan: this.summary(c) });
    return {};
  }

  /** Leader changes who may join and the description. */
  settings(leaderId, { type, desc }) {
    const c = this.leaderClan(leaderId);
    if (!c) return { error: 'leader' };
    if (TYPES.has(type)) c.type = type;
    if (desc != null) c.desc = cleanName(desc, 120);
    this.save(c);
    this.broadcast(c);
    return { clan: this.view(c, leaderId) };
  }

  leave(playerId) {
    const c = this.clanOf(playerId);
    if (!c) return { error: 'clan' };
    const me = c.members.find((m) => m.id === playerId);
    c.members = c.members.filter((m) => m.id !== playerId);
    c.requests = c.requests.filter((r) => r.player !== playerId);
    this.memberOf.delete(playerId);
    if (!c.members.length) {
      this.store.deleteDoc('clan', c.id);
      return { clan: null };
    }
    if (me.role === 'leader') c.members.sort((a, b) => a.joined - b.joined)[0].role = 'leader';
    this.system(c, `${this.hooks.nameOf(playerId)} left the clan`);
    return { clan: null };
  }

  // ---------------------------------------------------------------- chat

  system(c, text) {
    this.pushChat(c, { kind: 'system', text, ts: Date.now() });
  }

  pushChat(c, entry) {
    c.chat.push(entry);
    if (c.chat.length > MAX_CHAT) c.chat.splice(0, c.chat.length - MAX_CHAT);
    this.save(c);
    this.broadcast(c);
  }

  chat(playerId, text) {
    const c = this.clanOf(playerId);
    if (!c || !text) return { error: 'clan' };
    this.pushChat(c, { name: this.hooks.nameOf(playerId), text, ts: Date.now() });
    return {};
  }

  // ---------------------------------------------------------------- donations

  request(playerId, cardId) {
    const c = this.clanOf(playerId);
    const card = CARD_BY_ID[cardId];
    if (!c) return { error: 'clan' };
    if (!card || !REQUEST_SIZE[card.rarity]) return { error: 'card' };
    const me = c.members.find((m) => m.id === playerId);
    if (Date.now() - (me.lastRequest ?? 0) < REQUEST_COOLDOWN_MS) return { error: 'cooldown' };
    me.lastRequest = Date.now();
    c.requests = c.requests.filter((r) => r.player !== playerId);
    c.requests.push({ id: crypto.randomUUID(), player: playerId, name: this.hooks.nameOf(playerId), card: cardId, got: 0, need: REQUEST_SIZE[card.rarity], ts: Date.now(), donors: {} });
    this.system(c, `${this.hooks.nameOf(playerId)} requests ${card.name}`);
    return {};
  }

  /** Moves one shard from the donor's profile to the requester's; the donor earns gold + XP. */
  donate(playerId, requestId) {
    const c = this.clanOf(playerId);
    if (!c) return { error: 'clan' };
    const r = c.requests.find((x) => x.id === requestId);
    if (!r || r.got >= r.need || Date.now() - r.ts > REQUEST_TTL_MS) return { error: 'request' };
    if (r.player === playerId) return { error: 'own' };
    const card = CARD_BY_ID[r.card];
    const maxPerDonor = card.rarity === 'Common' ? 4 : 1;
    if ((r.donors[playerId] ?? 0) >= maxPerDonor) return { error: 'limit' };
    const donor = this.economy.profile(playerId);
    if ((donor.cards[r.card]?.shards ?? 0) < 1) return { error: 'shards' };
    const receiver = this.economy.profile(r.player);
    donor.cards[r.card].shards -= 1;
    receiver.cards[r.card].shards += 1;
    const reward = DONATE_REWARD[card.rarity];
    donor.gold += reward.gold;
    donor.xp += reward.xp;
    this.economy.save(playerId, donor);
    this.economy.save(r.player, receiver);
    r.got += 1;
    r.donors[playerId] = (r.donors[playerId] ?? 0) + 1;
    const me = c.members.find((m) => m.id === playerId);
    me.donated = (me.donated ?? 0) + 1;
    this.save(c);
    this.broadcast(c);
    this.hooks.notify([r.player], { t: 'profile-push', profile: receiver });
    return { profile: donor, reward };
  }
}
