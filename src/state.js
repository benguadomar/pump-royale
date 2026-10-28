import { CARD_BY_ID, DEFAULT_DECK } from './data/cards.js';

const KEY = 'pump-royale:v1';
const MAX_HISTORY = 20;

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

const saved = load();
const isValidDeck = (d) => Array.isArray(d) && d.length === 8 && new Set(d).size === 8 && d.every((id) => CARD_BY_ID[id]);

export const state = {
  id: saved.id || crypto.randomUUID(),
  isReturning: Boolean(saved.id),
  name: saved.name || `Player${Math.floor(1000 + Math.random() * 9000)}`,
  nameLocked: Boolean(saved.nameLocked),
  deck: isValidDeck(saved.deck) ? saved.deck : [...DEFAULT_DECK],
  settings: { volume: 0.25, graphics: 'high', ...saved.settings },
  stats: { wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0, ...saved.stats },
  history: Array.isArray(saved.history) ? saved.history : [],
};

const listeners = new Set();
export function onStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function save() {
  const { id, name, nameLocked, deck, settings, stats, history } = state;
  localStorage.setItem(KEY, JSON.stringify({ id, name, nameLocked, deck, settings, stats, history }));
  for (const fn of listeners) fn(state);
}

/** The name can be changed exactly once; after that it stays locked on this device. */
export function renameOnce(name) {
  if (state.nameLocked) return false;
  const clean = name.replace(/[^\p{L}\p{N}_\- .]/gu, '').trim().slice(0, 16);
  if (!clean) return false;
  state.name = clean;
  state.nameLocked = true;
  save();
  return true;
}

export function recordMatch({ result, myCrowns, enemyCrowns, opponent = 'AI' }) {
  const s = state.stats;
  if (result === 'win') {
    s.wins++;
    s.streak++;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
  } else {
    if (result === 'loss') s.losses++;
    else s.draws++;
    s.streak = 0;
  }
  state.history.unshift({ result, myCrowns, enemyCrowns, opponent, ts: Date.now() });
  state.history.length = Math.min(state.history.length, MAX_HISTORY);
  save();
}
