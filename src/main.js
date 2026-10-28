import './styles.css';
import { Arena } from './game/arena.js';
import { Battle } from './game/battle.js';
import { CARDS, TOWERS, cardImg } from './data/cards.js';
import { state, recordMatch } from './state.js';
import { net } from './net.js';
import { sfx } from './audio.js';
import { h, img, app } from './ui/dom.js';
import { createChat } from './ui/chat.js';
import { createLobby } from './ui/lobby.js';
import { createBattleHud, showResult } from './ui/battleHud.js';
import { closeModal } from './ui/modal.js';

const DESIGN_W = 1366;
const DESIGN_H = 768;
const MIN_LOADING_MS = 2200;

const LOADING_LINES = ['Summoning champions...', 'Brewing elixir...', 'Polishing crowns...', 'Raising the towers...', 'Sharpening swords...'];

const UI_IMAGES = [
  '/assets/ui/logo.png',
  '/assets/ui/elixir.png',
  '/assets/ui/icon-cards.png',
  '/assets/ui/icon-crown.png',
  '/assets/ui/icon-deck.png',
  '/assets/ui/icon-play.png',
  '/assets/ui/icon-profile.png',
  '/assets/ui/icon-trophy.png',
];

const AI_LINES = {
  start: ['Good luck, have fun!', 'Ready when you are.', 'Prepare to lose a crown or three.'],
  reply: ['Focus on the battle 😄', 'Nice try.', 'Talk is cheap, elixir is not.', 'Hmm, interesting.', 'GG soon?', 'You wish!', 'Bring it on!'],
  lostTower: ['Ouch!', 'Lucky shot.', 'That was my favorite tower...', 'Okay, now I am angry.'],
  tookTower: ['Too easy.', 'Crown secured 👑', 'Oops, was that yours?'],
  win: ['GG! Better luck next time.'],
  loss: ['GG, well played!'],
};
const say = (key) => AI_LINES[key][Math.floor(Math.random() * AI_LINES[key].length)];

// ------------------------------------------------------------------ UI scaling

// Space (in design px) the battle HUD covers at the top and bottom; the arena camera fits between them.
const BATTLE_HUD_TOP = 78;
const BATTLE_HUD_BOTTOM = 178;

const appEl = app();
let arenaRef = null;
function fitUi() {
  const s = Math.max(0.5, Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H, 1.35));
  appEl.style.width = `${window.innerWidth / s}px`;
  appEl.style.height = `${window.innerHeight / s}px`;
  appEl.style.transform = `scale(${s})`;
  if (arenaRef) {
    arenaRef.insets = { top: BATTLE_HUD_TOP * s, bottom: BATTLE_HUD_BOTTOM * s };
    arenaRef.resize();
  }
}
window.addEventListener('resize', fitUi);
fitUi();

// ------------------------------------------------------------------ loading

const barFill = h('div');
const loadingText = h('div', { class: 'loading-text' }, LOADING_LINES[0]);
const loading = h('div', { class: 'loading' }, img('/assets/ui/logo.png', 'loading-logo', 'Pump Royale'), h('div', { class: 'loading-bar' }, barFill), loadingText);
document.body.append(loading);

let lineIdx = 0;
const lineTimer = setInterval(() => {
  lineIdx = (lineIdx + 1) % LOADING_LINES.length;
  loadingText.textContent = LOADING_LINES[lineIdx];
}, 900);

const loadImage = (src) =>
  new Promise((resolve) => {
    const i = new Image();
    i.onload = i.onerror = resolve;
    i.src = src;
  });

async function boot() {
  const started = performance.now();
  const arena = new Arena(document.getElementById('scene'));
  arenaRef = arena;
  fitUi();
  const textureUrls = [...CARDS.map((c) => cardImg(c.id)), cardImg(TOWERS.princess.id), cardImg(TOWERS.king.id)];
  const total = textureUrls.length + UI_IMAGES.length + 1;
  let done = 0;
  const progress = () => (barFill.style.width = `${(++done / total) * 100}%`);

  net.connect();
  await Promise.all([
    arena.preload(textureUrls, progress),
    ...UI_IMAGES.map((src) => loadImage(src).then(progress)),
    document.fonts.ready.then(progress),
  ]);
  const wait = MIN_LOADING_MS - (performance.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  arena.setMode('lobby');
  const chat = createChat();
  let lobby = null;
  let battle = null;
  let hud = null;

  const enterLobby = () => {
    chat.setGame(null);
    arena.setMode('lobby');
    lobby = createLobby({ arena, chat, onPlay: startBattle });
    appEl.append(lobby.el);
    lobby.mounted();
  };

  const endBattle = (res) => {
    const r = res ?? { ...battle.result(), result: 'loss' };
    recordMatch({ result: r.result, myCrowns: r.myCrowns, enemyCrowns: r.enemyCrowns, opponent: 'AI' });
    net.send({ t: 'match', result: r.result, towers: r.myCrowns, cards: r.cardsPlayed });
    return r;
  };

  const leaveBattle = () => {
    hud?.destroy();
    battle?.destroy();
    hud = battle = null;
    enterLobby();
  };

  function startBattle() {
    closeModal();
    lobby?.destroy();
    lobby = null;

    battle = new Battle(arena, state.deck, {
      onEvent: (ev) => {
        if (ev.type === 'tower') {
          const mine = ev.team === 1;
          hud?.toast(mine ? '👑 Tower destroyed!' : 'Tower lost!');
          if (Math.random() < 0.8) setTimeout(() => chat.addGame({ name: 'AI', kind: 'ai', text: say(mine ? 'lostTower' : 'tookTower') }), 700);
        }
        if (ev.type === 'overtime') hud?.toast('OVERTIME!');
      },
      onEnd: (res) => {
        const r = endBattle(res);
        r.result === 'win' ? sfx.win() : r.result === 'loss' ? sfx.lose() : sfx.click();
        chat.addGame({ name: 'AI', kind: 'ai', text: say(r.result === 'win' ? 'loss' : 'win') });
        showResult(r, leaveBattle);
      },
    });
    arena.setMode('battle');
    chat.setGame(() => {
      if (Math.random() < 0.7) setTimeout(() => chat.addGame({ name: 'AI', kind: 'ai', text: say('reply') }), 900 + Math.random() * 1500);
    });
    chat.addGame({ kind: 'system', text: 'Match started — chat with your opponent here.' });
    setTimeout(() => battle && chat.addGame({ name: 'AI', kind: 'ai', text: say('start') }), 1200);

    hud = createBattleHud({
      arena,
      battle,
      chat,
      onForfeit: () => {
        if (!battle || battle.over) return;
        battle.over = true;
        endBattle(null);
        sfx.lose();
        leaveBattle();
      },
    });
    appEl.append(hud.el);
    hud.toast('FIGHT!');
  }

  enterLobby();
  clearInterval(lineTimer);
  barFill.style.width = '100%';
  loading.classList.add('done');
  setTimeout(() => loading.remove(), 700);
}

boot();
