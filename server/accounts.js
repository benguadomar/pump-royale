import crypto from 'node:crypto';
import { signSession, verifySession, usernameError, passwordError, hashPassword, verifyPassword } from './auth.js';
import { log } from './log.js';

const cleanId = (s) => String(s ?? '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);

/**
 * Identity. A device first gets a guest session token (JWT) so it can reach the server, but a
 * guest cannot play: it must create an account (unique username + password) or log in. Creating
 * an account from a guest session keeps that guest's progress. Once an account has a token, its
 * id alone is no longer accepted.
 */
export class Accounts {
  constructor(store) {
    this.store = store;
  }

  /** Public view of an account for its owner. */
  view(a) {
    return { id: a.id, username: a.username ?? null, guest: !a.username };
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

  /** New username + password. Upgrades the caller's guest account in place when there is one. */
  async register(username, password, guestToken) {
    const name = String(username ?? '').trim();
    const bad = usernameError(name) ?? passwordError(password, name);
    if (bad) return { error: bad };
    if (this.store.userByName(name)) return { error: 'taken' };
    const hash = await hashPassword(password);
    const guest = this.store.account(verifySession(guestToken));
    const id = guest && !guest.username ? guest.id : crypto.randomUUID();
    if (!(await this.store.createUser({ id, username: name, hash, created: Date.now() }))) return { error: 'taken' };
    const a = this.store.account(id) ?? this.create(id);
    a.username = name;
    a.tokenIssued = true;
    this.store.saveAccount(a);
    this.store.upsert(id, name, null);
    log.info('account registered', { account: id, upgraded: id === guest?.id });
    return this.session(a);
  }

  async login(username, password) {
    const user = this.store.userByName(String(username ?? '').trim());
    const ok = await verifyPassword(password, user?.hash);
    if (!user || !ok) return { error: 'credentials' };
    const a = this.store.account(user.id) ?? this.create(user.id, { username: user.username, tokenIssued: true });
    this.store.touchUser(user);
    return this.session(a);
  }
}
