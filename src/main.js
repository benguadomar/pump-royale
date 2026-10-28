import './styles.css';
import { Engine } from './render/engine.js';
import { BattleView } from './render/battleView.js';
import { LocalSession, OnlineSession } from './game/session.js';
import { CARDS, TOWERS, cardImg } from './data/cards.js';
import { EMOTES, emoteImg } from './data/emotes.js';
import { state, recordMatch } from './state.js';
import { net } from './net.js';
import { sfx, loadAudio, playMusic } from './audio.js';
import { h, img, app } from './ui/dom.js';
import { createChat } from './ui/chat.js';
import { createLobby } from './ui/lobby.js';
import { createBattleHud, showResult } from './ui/battleHud.js';
import { findMatch, showVersus } from './ui/matchmaking.js';
import { closeModal } from './ui/modal.js';

const DESIGN_W = 1366;
const DESIGN_H = 768;
const MIN_LOADING_MS = 2200;
const RESULT_DELAY_MS = 1600;
// Screen space (design px) the battle HUD occupies; the arena camera fits inside the rest.
const BATTLE_INSETS = { top: 12, bottom: 150, side: 300 };

const LOADING_LINES = ['Summoning champions...', 'Brewing elixir...', 'Compiling TypeGPU shaders...', 'Raising the towers...', 'Sharpening swords...'];

const UI_IMAGES = [
  '/assets/ui/logo.png',
  '/assets/ui/elixir.png',
  '/assets/ui/icon-cards.png',
  '/assets/ui/icon-crown.png',
  '/assets/ui/icon-deck.png',
  '/assets/ui/icon-play.png',
  '/assets/ui/icon-profile.png',
  '/assets/ui/icon-trophy.png',
  ...EMOTES.map((e) => emoteImg(e.id)),
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

const appEl = app();
let engineRef = null;
function fitUi() {
  const s = Math.max(0.5, Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H, 1.35));
  appEl.style.width = `${window.innerWidth / s}px`;
  appEl.style.height = `${window.innerHeight / s}px`;
  appEl.style.transform = `scale(${s})`;
  const portrait = window.innerWidth < window.innerHeight;
  const side = portrait ? window.innerWidth * 0.1 : Math.min(BATTLE_INSETS.side * s, window.innerWidth * 0.22);
  engineRef?.setInsets({ top: BATTLE_INSETS.top * s, bottom: BATTLE_INSETS.bottom * s, side });
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

function fatal(err) {
  console.error(err);
  clearInterval(lineTimer);
  loadingText.textContent = 'Your browser could not start the 3D renderer (WebGPU / WebGL2 required).';
}

async function boot() {
  const started = performance.now();
  const textureUrls = [...CARDS.map((c) => cardImg(c.id)), cardImg(TOWERS.princess.id), cardImg(TOWERS.king.id)];
  const total = textureUrls.length + UI_IMAGES.length + 3;
  let done = 0;
  const progress = () => (barFill.style.width = `${(++done / total) * 100}%`);

  net.connect();
  const engine = await Engine.create(document.getElementById('scene'));
  engineRef = engine;
  fitUi();
  progress();
  await Promise.all([
    engine.preload(textureUrls, progress),
    ...UI_IMAGES.map((src) => loadImage(src).then(progress)),
    document.fonts.ready.then(progress),
    loadAudio().then(progress),
  ]);
  const wait = MIN_LOADING_MS - (performance.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  const chat = createChat();
  let lobby = null;

  const enterLobby = () => {
    chat.setGame(null);
    engine.world.showLobbyTowers(true);
    engine.setMode('lobby');
    playMusic('lobby');
    lobby = createLobby({ engine, chat, onPlay: () => startBattle(new LocalSession(state.deck)), onOnline: startOnline });
    appEl.append(lobby.el);
    lobby.mounted();
  };

  const leaveLobby = () => {
    closeModal();
    lobby?.destroy();
    lobby = null;
  };

  async function startOnline() {
    leaveLobby();
    engine.setMode('battle');
    const match = await findMatch();
    if (!match) {
      enterLobby();
      return;
    }
    await showVersus(match);
    startBattle(new OnlineSession({ room: match.room, oppName: match.opp.name, oppFlag: match.opp.country }));
  }

  /** Runs one match (either mode) from first frame to the results screen. */
  function startBattle(session) {
    leaveLobby();
    engine.world.showLobbyTowers(false);
    engine.setMode('battle');
    playMusic('battle');

    const online = session.mode === 'online';
    let finished = false;
    let hud = null;

    const view = new BattleView(engine, {
      onEvent: (ev) => {
        if (ev.e === 'tower') {
          const theirs = ev.team === 1;
          hud?.toast(theirs ? '👑 Tower destroyed!' : 'Tower lost!');
          if (!online && Math.random() < 0.8) setTimeout(() => chat.addGame({ name: session.oppName, kind: 'ai', text: say(theirs ? 'lostTower' : 'tookTower') }), 700);
        }
        if (ev.e === 'king') {
          sfx.king();
          hud?.toast(ev.team === 0 ? 'Your King wakes up!' : 'Enemy King awakens!', true);
        }
        if (ev.e === 'overtime') hud?.toast('SUDDEN DEATH!');
      },
    });

    const offs = [];
    if (online) {
      chat.setGame((text) => net.send({ t: 'gchat', room: session.room, text }), { localEcho: false });
      offs.push(net.on('gchat', (m) => chat.addGame({ ...m.msg, kind: m.msg.name === state.name ? '' : 'ai' })));
      offs.push(net.on('opp-status', (m) => hud?.setOppOnline(m.online)));
    } else {
      chat.setGame(() => {
        if (Math.random() < 0.7) setTimeout(() => chat.addGame({ name: session.oppName, kind: 'ai', text: say('reply') }), 900 + Math.random() * 1500);
      });
      setTimeout(() => !finished && chat.addGame({ name: session.oppName, kind: 'ai', text: say('start') }), 1200);
    }
    chat.addGame({ kind: 'system', text: online ? `Matched with ${session.oppName} — chat here during the battle.` : 'Match started — chat with your opponent here.' });

    const finish = (r) => {
      if (finished || !r) return;
      finished = true;
      recordMatch({ result: r.result, myCrowns: r.myCrowns, enemyCrowns: r.enemyCrowns, opponent: online ? session.oppName : 'AI', mode: session.mode });
      if (!online) net.send({ t: 'match', result: r.result, towers: r.myCrowns, cards: r.cardsPlayed });
      r.result === 'win' ? sfx.win() : r.result === 'loss' ? sfx.lose() : sfx.click();
      if (!online) chat.addGame({ name: session.oppName, kind: 'ai', text: say(r.result === 'win' ? 'loss' : 'win') });
      showResult(r, {
        onPlayAgain: () => {
          teardown();
          if (online) startOnline();
          else startBattle(new LocalSession(state.deck));
        },
        onMenu: () => {
          teardown();
          enterLobby();
        },
      });
    };

    let overAt = null;
    const unsub = engine.onUpdate((dt, t) => {
      session.update(dt);
      const v = session.view();
      if (!v) return;
      view.update(v, session.drainEvents(), dt, t);
      if (v.over && overAt == null) overAt = performance.now();
      if (overAt != null && !finished && performance.now() - overAt > RESULT_DELAY_MS) finish(session.result());
    });

    function teardown() {
      unsub();
      offs.forEach((o) => o());
      hud.destroy();
      view.destroy();
      session.destroy();
    }

    hud = createBattleHud({
      engine,
      session,
      view,
      chat,
      onMenu: (forfeit) => {
        if (forfeit && !finished) {
          session.forfeit();
          if (!online) {
            const r = session.result();
            recordMatch({ result: 'loss', myCrowns: r.myCrowns, enemyCrowns: r.enemyCrowns, opponent: 'AI', mode: 'ai' });
            net.send({ t: 'match', result: 'loss', towers: r.myCrowns, cards: r.cardsPlayed });
          } else recordMatch({ result: 'loss', myCrowns: 0, enemyCrowns: 3, opponent: session.oppName, mode: 'online' });
          finished = true;
          sfx.lose();
        }
        teardown();
        enterLobby();
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

boot().catch(fatal);
