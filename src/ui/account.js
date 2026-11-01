import { h } from './dom.js';
import { toastMsg } from './widgets.js';
import { net } from '../net.js';
import { state, save } from '../state.js';
import { sfx } from '../audio.js';

const phantom = () => window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : null);
export const shortKey = (k) => `${k.slice(0, 4)}…${k.slice(-4)}`;

/**
 * Proves wallet ownership by signing a one-time server challenge (no transaction), then
 * links the wallet to this account — or switches to the account already using it.
 */
export async function walletSignIn() {
  const provider = phantom();
  if (!provider) {
    window.open('https://phantom.app/download', '_blank', 'noopener');
    toastMsg('Install Phantom to sign in with a Solana wallet');
    return false;
  }
  if (!net.connected) {
    toastMsg('Offline — connect to sign in');
    return false;
  }
  try {
    const { publicKey } = await provider.connect();
    const challenge = await net.request({ t: 'wallet-challenge' }, 'wallet-challenge');
    if (!challenge) throw new Error('no challenge');
    const { signature } = await provider.signMessage(new TextEncoder().encode(challenge.message), 'utf8');
    const res = await net.request({ t: 'wallet-login', publicKey: publicKey.toString(), signature: Array.from(signature), nonce: challenge.nonce, message: challenge.message }, 'session');
    if (!res || res.error) {
      toastMsg('Wallet signature was rejected');
      return false;
    }
    state.wallet = publicKey.toString();
    save();
    toastMsg(res.switched ? 'Signed in — loading your account…' : 'Wallet linked to your account');
    return true;
  } catch {
    toastMsg('Wallet sign-in cancelled');
    return false;
  }
}

async function sendEmailLink(email, out) {
  const res = await fetch('/api/auth/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, token: state.token }) })
    .then((r) => r.json())
    .catch(() => null);
  if (!res || res.error) return toastMsg(res?.error === 'email' ? 'That email looks wrong' : res?.error === 'rate' ? 'Too many requests — try again in a minute' : 'Could not send the link');
  if (res.devLink) {
    // Local dev without an email provider: show the link instead of mailing it.
    out.replaceChildren(h('span', { class: 'dim' }, 'Dev mode (no email provider): '), h('a', { href: res.devLink }, 'open sign-in link'));
    return;
  }
  out.replaceChildren(h('span', {}, `Check ${email} — the link expires in 15 minutes.`));
}

/** "ACCOUNT" section of the profile: guest upgrade, linked methods, sign out. */
export function accountSection() {
  const a = net.account;
  if (!a) return null;
  const out = h('div', { class: 'account-out' });
  const email = h('input', { type: 'email', class: 'email-input', placeholder: 'you@example.com', autocomplete: 'email' });
  const sendLink = () => {
    if (!email.value.trim()) return;
    sfx.click();
    sendEmailLink(email.value.trim(), out);
  };
  email.onkeydown = (e) => e.key === 'Enter' && sendLink();
  const emailRow = !a.email && h('div', { class: 'account-row' }, email, h('button', { class: 'btn', onclick: sendLink }, 'Email me a link'));
  const walletRow = !a.wallet && h('button', { class: 'btn wallet-login', onclick: () => (sfx.click(), walletSignIn()) }, a.guest ? 'Sign in with Phantom' : 'Link Phantom wallet');
  const signOut = () => {
    if (a.guest && !confirm('You are a guest: signing out loses this progress unless you link an email or wallet first. Sign out anyway?')) return;
    state.id = crypto.randomUUID();
    state.token = null;
    state.wallet = null;
    save();
    location.reload();
  };
  return h(
    'div',
    { class: 'account-box inset' },
    h('div', { class: 'section-title' }, 'ACCOUNT'),
    a.guest
      ? h('p', { class: 'dim' }, 'Playing as a guest. Link an email or a Phantom wallet to keep your progress on any device.')
      : h('div', { class: 'account-linked' }, a.email && h('span', {}, '✉ ', h('b', {}, a.email)), a.wallet && h('span', {}, '◎ ', h('b', {}, shortKey(a.wallet)))),
    emailRow,
    walletRow,
    out,
    h('button', { class: 'btn small-btn', onclick: signOut }, 'Sign out'),
  );
}
