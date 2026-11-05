import { h, img } from './dom.js';
import { net } from '../net.js';
import { state, save } from '../state.js';
import { sfx } from '../audio.js';
import { cleanSolanaAddress, shortAddress } from '../data/solana.js';
import { toastMsg, solIcon } from './widgets.js';

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const PASSWORD_MIN = 6;
const ERRORS = {
  username: 'Usernames are 3–16 letters, numbers or _',
  taken: 'That username is already taken',
  password: `Passwords need at least ${PASSWORD_MIN} characters`,
  'password-name': 'Your password cannot be your username',
  mismatch: 'The passwords do not match',
  credentials: 'Wrong username or password',
  locked: 'Too many wrong passwords — this account is locked for 15 minutes',
  rate: 'Too many attempts — wait a minute and try again',
  origin: 'Request blocked',
  network: 'Cannot reach the server — check your connection',
  wallet: 'That is not a valid Solana wallet address',
};

async function post(path, body) {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await res.json();
  } catch {
    return { error: 'network' };
  }
}

/** Typing in the form must not trigger game hotkeys. */
const field = (attrs) => h('input', { class: 'login-input', spellcheck: false, onkeydown: (e) => e.stopPropagation(), ...attrs });

let gate = null;

/**
 * Full-screen sign-up / log-in form shown after the loading screen until the server accepts a
 * username + password. `onLogin(switched)` runs once logged in (`switched`: a different account).
 */
function showGate(root, onLogin) {
  if (gate) return;
  // Guests hold a guest token; no token on a used device means someone logged out.
  let mode = !state.token && state.isReturning ? 'login' : 'register';
  const error = h('div', { class: 'login-error' });
  const hint = h('div', { class: 'login-hint' });
  const username = field({ name: 'username', autocomplete: 'username', maxLength: 16, placeholder: 'Username', value: mode === 'login' ? state.name : '' });
  const password = field({ name: 'password', type: 'password', maxLength: 128, placeholder: 'Password' });
  const confirm = field({ name: 'confirm', type: 'password', maxLength: 128, placeholder: 'Repeat password', autocomplete: 'new-password' });
  const wallet = field({ name: 'wallet', maxLength: 44, placeholder: 'Solana wallet address', autocomplete: 'off', class: 'login-input wallet-input' });
  const walletBox = h('div', { class: 'wallet-box' }, wallet, h('div', { class: 'wallet-note' }, solIcon(), 'Required to win Solana prizes'));
  wallet.oninput = () => {
    error.textContent = '';
    wallet.classList.toggle('bad', Boolean(wallet.value.trim()) && !cleanSolanaAddress(wallet.value));
  };
  const submit = h('button', { class: 'btn gold login-submit', type: 'submit' });
  const tabs = {
    register: h('button', { class: 'btn chip', type: 'button', onclick: () => setMode('register') }, 'CREATE ACCOUNT'),
    login: h('button', { class: 'btn chip', type: 'button', onclick: () => setMode('login') }, 'LOG IN'),
  };

  let checkTimer = 0;
  username.oninput = () => {
    error.textContent = '';
    clearTimeout(checkTimer);
    hint.textContent = '';
    hint.className = 'login-hint';
    const name = username.value.trim();
    if (mode !== 'register' || !name) return;
    if (!USERNAME_RE.test(name)) {
      hint.textContent = ERRORS.username;
      return;
    }
    checkTimer = setTimeout(async () => {
      const res = await fetch(`/api/auth/available?username=${encodeURIComponent(name)}`)
        .then((r) => r.json())
        .catch(() => null);
      if (!res || username.value.trim() !== name || mode !== 'register') return;
      hint.textContent = res.available ? '✓ Available' : ERRORS.taken;
      hint.className = `login-hint ${res.available ? 'ok' : 'bad'}`;
    }, 350);
  };
  password.oninput = confirm.oninput = () => (error.textContent = '');

  function setMode(m) {
    mode = m;
    tabs.register.classList.toggle('on', m === 'register');
    tabs.login.classList.toggle('on', m === 'login');
    confirm.hidden = m !== 'register';
    walletBox.hidden = m !== 'register';
    password.autocomplete = m === 'register' ? 'new-password' : 'current-password';
    submit.textContent = m === 'register' ? 'CREATE ACCOUNT' : 'LOG IN';
    error.textContent = '';
    username.oninput();
    username.focus();
  }

  const onSubmit = async (e) => {
    e.preventDefault();
    sfx.click();
    const name = username.value.trim();
    if (mode === 'register') {
      if (!USERNAME_RE.test(name)) return (error.textContent = ERRORS.username);
      if (password.value.length < PASSWORD_MIN) return (error.textContent = ERRORS.password);
      if (password.value !== confirm.value) return (error.textContent = ERRORS.mismatch);
      if (wallet.value.trim() && !cleanSolanaAddress(wallet.value)) return (error.textContent = ERRORS.wallet);
    } else if (!name || !password.value) return (error.textContent = ERRORS.credentials);
    submit.disabled = true;
    const res = await post(`/api/auth/${mode}`, { username: name, password: password.value, token: state.token, wallet: mode === 'register' ? wallet.value.trim() : undefined });
    submit.disabled = false;
    if (!res?.token) {
      error.textContent = ERRORS[res?.error] ?? 'Something went wrong — try again';
      return;
    }
    const switched = res.account.id !== state.id;
    state.token = res.token;
    state.id = res.account.id;
    state.name = res.account.username;
    save();
    net.account = res.account;
    hideGate();
    net.hello();
    onLogin?.(switched);
  };

  const form = h(
    'form',
    { class: 'modal wood login-modal', onsubmit: onSubmit, onpointerdown: (e) => e.stopPropagation() },
    img('/assets/ui/logo.png', 'login-logo', 'Pump Royale'),
    h('div', { class: 'login-tabs' }, tabs.register, tabs.login),
    username,
    hint,
    password,
    confirm,
    walletBox,
    error,
    submit,
    h('p', { class: 'dim login-note' }, 'Your username is unique and shown to other players. Passwords are stored encrypted (scrypt hash) — nobody, not even us, can read them.'),
  );
  gate = h('div', { class: 'backdrop login-gate' }, form);
  root.append(gate);
  setMode(mode);
}

function hideGate() {
  gate?.remove();
  gate = null;
}

/** Keeps the login form up whenever this device has no logged-in account. */
export function initLoginGate(root, onLogin) {
  const check = () => (!state.token || net.account?.guest ? showGate(root, onLogin) : hideGate());
  net.on('session', (m) => !m.error && check());
  if (!state.token || net.account) check();
}

/** "ACCOUNT" section of the profile: who is logged in, and sign out. */
export function accountSection() {
  const a = net.account;
  if (!a || a.guest) return null;
  const signOut = () => {
    state.id = crypto.randomUUID();
    state.token = null;
    save();
    location.reload();
  };
  const walletRow = h('div', { class: 'wallet-row' });
  const showWallet = () => {
    const addr = net.account?.wallet;
    walletRow.replaceChildren(
      h('span', { class: 'dim' }, solIcon(), 'Solana wallet'),
      addr ? h('code', { class: 'wallet-addr', title: addr }, addr) : h('span', { class: 'wallet-missing' }, 'Not set — required to win the top 3 Solana prizes'),
      h('button', { class: 'btn small-btn', onclick: () => (sfx.click(), editWallet()) }, addr ? 'Change' : 'Add wallet'),
      addr && h('button', { class: 'btn small-btn', title: 'Copy address', onclick: () => navigator.clipboard?.writeText(addr).then(() => toastMsg('Wallet address copied')) }, 'Copy'),
    );
  };
  const editWallet = () => {
    const input = field({ class: 'login-input wallet-input', maxLength: 44, placeholder: 'Solana wallet address', value: net.account?.wallet ?? '' });
    const save = async () => {
      const value = input.value.trim();
      if (value && !cleanSolanaAddress(value)) return toastMsg(ERRORS.wallet);
      const res = await net.request({ t: 'wallet-set', wallet: value }, 'econ', { op: 'wallet-set' });
      if (!res || res.error) return toastMsg(res?.error === 'wallet' ? ERRORS.wallet : 'Could not save the wallet');
      net.account = res.account;
      toastMsg(value ? `Wallet saved: ${shortAddress(value)}` : 'Wallet removed');
      showWallet();
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && save());
    walletRow.replaceChildren(input, h('button', { class: 'btn gold small-btn', onclick: () => (sfx.click(), save()) }, 'Save'), h('button', { class: 'btn small-btn', onclick: () => (sfx.click(), showWallet()) }, 'Cancel'));
    input.focus();
  };
  showWallet();
  return h(
    'div',
    { class: 'account-box inset' },
    h('div', { class: 'section-title' }, 'ACCOUNT'),
    h('div', { class: 'account-linked' }, h('span', {}, 'Logged in as ', h('b', {}, a.username))),
    walletRow,
    h('button', { class: 'btn small-btn', onclick: () => (sfx.click(), signOut()) }, 'Log out'),
  );
}
