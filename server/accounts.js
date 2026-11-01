import crypto from 'node:crypto';
import { signSession, verifySession, createMagicLink, consumeMagicLink, sendMagicEmail, cleanEmail, walletChallenge, verifyWallet } from './auth.js';
import { log } from './log.js';

const cleanId = (s) => String(s ?? '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
const maskEmail = (e) => (e ? e.replace(/^(.{1,2}).*(@.*)$/, '$1•••$2') : null);

/**
 * Identity. Every device starts as a guest with a signed session token (JWT). A guest can
 * be upgraded by linking an email (magic link) or a Phantom wallet (signed message);
 * signing in with an already-linked email/wallet on another device switches to that
 * account. Once an account has a token, its id alone is no longer accepted.
 */
export class Accounts {
  constructor(store) {
    this.store = store;
  }

  /** Public view of an account for its owner. */
  view(a) {
    return { id: a.id, email: maskEmail(a.email), wallet: a.wallet ?? null, guest: !a.email && !a.wallet };
  }

  session(a) {
    return { token: signSession(a.id), account: this.view(a) };
  }

  create(id = crypto.randomUUID(), fields = {}) {
    const a = { id, created: Date.now(), ...fields };
    this.store.saveAccount(a);
    return a;
  }

  /**
   * Resolves a `hello`: a valid token wins; otherwise a legacy device id is accepted only
   * if no token was ever issued for it (pre-account players keep their progress).
   */
  resolve({ token, id }) {
    const sub = verifySession(token);
    if (sub) {
      const a = this.store.account(sub) ?? this.create(sub, { tokenIssued: true });
      return { account: a, token };
    }
    const legacy = cleanId(id);
    let a = legacy ? this.store.account(legacy) : null;
    if (a?.tokenIssued) return { error: 'auth' };
    if (!a) a = this.create(legacy || undefined);
    a.tokenIssued = true;
    this.store.saveAccount(a);
    return { account: a, token: signSession(a.id), fresh: true };
  }

  // ---------------------------------------------------------------- email

  async requestEmail(rawEmail, sessionToken, origin) {
    const email = cleanEmail(rawEmail);
    if (!email) return { error: 'email' };
    const linkTo = verifySession(sessionToken);
    const link = `${origin}/api/auth/verify?t=${createMagicLink(email, linkTo)}`;
    try {
      const { sent } = await sendMagicEmail(email, link);
      return { ok: true, sent, ...(sent || process.env.NODE_ENV === 'production' ? {} : { devLink: link }) };
    } catch (e) {
      log.error('magic email failed', { err: e.message });
      return { error: 'send' };
    }
  }

  /** Consumes a magic link: logs into the email's account, or links the email to the requester. */
  verifyEmail(token) {
    const m = consumeMagicLink(token);
    if (!m) return null;
    const existing = this.store.accountByEmail(m.email);
    if (existing) return this.session(existing);
    const target = m.linkTo && this.store.account(m.linkTo);
    if (target && !target.email) {
      target.email = m.email;
      this.store.saveAccount(target);
      log.info('email linked', { account: target.id });
      return this.session(target);
    }
    return this.session(this.create(undefined, { email: m.email, tokenIssued: true }));
  }

  // ---------------------------------------------------------------- wallet

  challenge() {
    return walletChallenge();
  }

  walletLogin(currentId, msg) {
    if (!verifyWallet(msg)) return { error: 'signature' };
    const wallet = String(msg.publicKey);
    const existing = this.store.accountByWallet(wallet);
    if (existing) return this.session(existing);
    const a = this.store.account(currentId);
    if (!a) return { error: 'account' };
    if (a.wallet && a.wallet !== wallet) return this.session(this.create(undefined, { wallet, tokenIssued: true }));
    a.wallet = wallet;
    this.store.saveAccount(a);
    log.info('wallet linked', { account: a.id });
    return this.session(a);
  }
}
