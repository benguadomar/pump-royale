import './styles.css';
import { Engine } from './render/engine.js';
import { BattleView } from './render/battleView.js';
import { LocalSession, OnlineSession, ReplaySession, DemoSession } from './game/session.js';
import { HAS_PNG } from './data/cards.js';
import { generateCardArt } from './render/cardArt.js';
import { loadTowerModels } from './render/models.js';
import { EMOTES, emoteImg } from './data/emotes.js';
import { state, save, recordMatch, currentArena } from './state.js';
import { ARENA_BY_ID } from './data/arenas.js';
import { net } from './net.js';
import { sfx, loadAudio, playMusic } from './audio.js';
import { h, img, app } from './ui/dom.js';
import { createChat } from './ui/chat.js';
import { createLobby } from './ui/lobby.js';
import { createBattleHud, showResult } from './ui/battleHud.js';
import { findMatch, showVersus, openBattleMenu } from './ui/matchmaking.js';
import { closeModal } from './ui/modal.js';
import { toastMsg } from './ui/widgets.js';
import { initLoginGate } from './ui/account.js';

const DESIGN_W = 1366;
const DESIGN_H = 768;
const MIN_LOADING_MS = 2200;
const RESULT_DELAY_MS = 1600;
/** Lobby towers are drawn a bit smaller than in battle. */
const LOBBY_TOWER_SCALE = 0.8;
const DEMO_REST_S = 4;
// Screen space (design px) the battle HUD occupies; the arena camera fits inside the rest.
const BATTLE_INSETS = { top: 12, bottom: 150, side: 300 };

const LOADING_LINES = ['Summoning champions...', 'Brewing elixir...', 'Compiling TypeGPU shaders...', 'Raising the towers...', 'Sharpening swords...'];

const UI_IMAGES = [
  '/assets/ui/logo.png',
  '/assets/ui/coin.png',
  '/assets/ui/gem.png',
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

// Browser errors go to the server, which forwards them to Sentry when configured.
let reported = 0;
function reportError(message, stack) {
  if (import.meta.env.DEV || reported++ > 10) return;
  fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, stack, url: location.href }) }).catch(() => {});
}
window.addEventListener('error', (e) => reportError(e.message, e.error?.stack));
window.addEventListener('unhandledrejection', (e) => reportError(String(e.reason?.message ?? e.reason), e.reason?.stack));

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
  const textureUrls = [...HAS_PNG].map((id) => `/assets/cards/${id}.png`);
  const total = textureUrls.length + UI_IMAGES.length + 5;
  let done = 0;
  const progress = () => (barFill.style.width = `${(++done / total) * 100}%`);

  net.connect();
  const engine = await Engine.create(document.getElementById('scene'));
  engineRef = engine;
  // Dev-only handle for driving matches from the browser console / automated checks.
  if (import.meta.env.DEV) window.__pump = { engine, battle: null };
  engine.setArena(currentArena());
  fitUi();
  progress();
  await Promise.all([
    ...textureUrls.map((src) => loadImage(src).then(progress)),
    loadTowerModels()
      .catch((e) => console.warn('tower models', e))
      .then(progress),
    generateCardArt(engine)
      .catch((e) => console.warn('card art', e))
      .then(progress),
    ...UI_IMAGES.map((src) => loadImage(src).then(progress)),
    document.fonts.ready.then(progress),
    loadAudio().then(progress),
  ]);
  const wait = MIN_LOADING_MS - (performance.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  const chat = createChat();
  let lobby = null;

  // Behind the lobby menus two AIs keep fighting; a new round starts a few seconds after one ends.
  let demo = null;
  let demoRound = Math.floor(Math.random() * 1e6);
  const startDemo = () => {
    if (demo) return;
    const newRound = () => ({ session: new DemoSession(++demoRound), view: new BattleView(engine, { quiet: true, towerScale: LOBBY_TOWER_SCALE }), overAt: null });
    let round = newRound();
    const unsub = engine.onUpdate((dt, t) => {
      round.session.update(dt);
      const v = round.session.view();
      round.view.update(v, round.session.drainEvents(), dt, t);
      if (v.over) round.overAt ??= t;
      if (round.overAt != null && t - round.overAt > DEMO_REST_S) {
        round.view.destroy();
        round = newRound();
      }
    });
    demo = {
      stop() {
        unsub();
        round.view.destroy();
        demo = null;
      },
    };
  };

  const enterLobby = () => {
    chat.setGame(null);
    startDemo();
    engine.setMode('lobby');
    playMusic('lobby');
    lobby = createLobby({ engine, chat, onPlay: startAi, onOnline: openOnline, onReplay: watchReplay });
    appEl.append(lobby.el);
    lobby.mounted();
  };

  const leaveLobby = () => {
    closeModal();
    lobby?.destroy();
    lobby = null;
  };

  // Trophies are cached locally so arenas/UI work offline; the server copy is the truth.
  const syncTrophies = (p) => {
    if (!p || state.trophies === p.trophies) return;
    state.trophies = p.trophies;
    save();
  };
  net.on('profile', syncTrophies);
  // The profile may have arrived while assets were still loading.
  syncTrophies(net.profile);

  let starting = false;
  /** Ranked vs AI: the server deals the seed, decks and levels so it can verify the result. */
  async function startAi() {
    if (starting) return;
    starting = true;
    const match = net.connected ? await net.request({ t: 'ai-start', deck: state.deck }, 'ai-match', { timeout: 4000 }) : null;
    starting = false;
    startBattle(new LocalSession(state.deck, match, currentArena().id));
  }

  async function watchReplay(id, isPublic = false) {
    const msg = await net.request({ t: 'replay', id, public: isPublic }, 'replay');
    if (msg?.replay) startBattle(new ReplaySession(msg.replay.players ? { ...msg.replay, opp: msg.replay.players[1].name } : msg.replay));
  }

  function openOnline() {
    openBattleMenu({
      onRanked: () => startOnline({ kind: 'ranked' }),
      onFriendlyCreate: () => startOnline({ kind: 'friendly-create' }),
      onFriendlyJoin: (code) => startOnline({ kind: 'friendly-join', code }),
      onSpectate: spectate,
      onPublicReplay: (id) => watchReplay(id, true),
    });
  }

  /** Ranked or friendly: waits for the server's match-found, then plays it. */
  async function startOnline(opts = { kind: 'ranked' }) {
    leaveLobby();
    engine.setMode('battle');
    const match = await findMatch(opts);
    if (!match) {
      enterLobby();
      return;
    }
    playOnline(match);
  }

  async function playOnline(match) {
    await showVersus(match);
    startBattle(new OnlineSession({ room: match.room, oppName: match.opp.name, oppFlag: match.opp.country, matchMode: match.mode }));
  }

  async function spectate(room) {
    const msg = await net.request({ t: 'spectate', room }, 'spectate-start', { timeout: 4000 });
    if (!msg) return toastMsg('That match just ended');
    startBattle(new OnlineSession({ room, oppName: msg.players[1].name, oppFlag: msg.players[1].country, matchMode: msg.mode, spectator: { players: msg.players } }));
  }

  /** Runs one match (either mode) from first frame to the results screen. */
  function startBattle(session) {
    leaveLobby();
    demo?.stop();
    engine.setMode('battle');
    const arena = ARENA_BY_ID[session.arenaId] ?? currentArena();
    engine.setArena(arena);
    playMusic(arena.music);

    const online = session.mode === 'online';
    const replay = session.mode === 'replay' || session.mode === 'spectate';
    const spectating = session.mode === 'spectate';
    const friendly = online && session.matchMode === 'friendly';
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
    // Online rewards are pushed by the server as soon as the room ends.
    const onlineReward = online
      ? new Promise((resolve) => {
          const off = net.on('reward', (m) => (off(), resolve(m)));
          offs.push(off);
        })
      : null;
    if (replay) {
      chat.setGame(null);
    } else if (online) {
      chat.setGame((text) => net.send({ t: 'gchat', room: session.room, text }), { localEcho: false });
      offs.push(net.on('gchat', (m) => chat.addGame({ ...m.msg, kind: m.msg.name === state.name ? '' : 'ai' })));
      offs.push(net.on('opp-status', (m) => hud?.setOppOnline(m.online)));
    } else {
      chat.setGame(() => {
        if (Math.random() < 0.7) setTimeout(() => chat.addGame({ name: session.oppName, kind: 'ai', text: say('reply') }), 900 + Math.random() * 1500);
      });
      setTimeout(() => !finished && chat.addGame({ name: session.oppName, kind: 'ai', text: say('start') }), 1200);
    }
    if (!replay) chat.addGame({ kind: 'system', text: online ? `${friendly ? 'Friendly battle' : 'Matched'} with ${session.oppName} — chat here during the battle.` : 'Match started — chat with your opponent here.' });

    const finish = (r) => {
      if (finished || !r) return;
      finished = true;
      if (!replay) recordMatch({ result: r.result, myCrowns: r.myCrowns, enemyCrowns: r.enemyCrowns, opponent: online ? session.oppName : 'AI', mode: session.mode });
      r.result === 'win' ? sfx.win() : r.result === 'loss' ? sfx.lose() : sfx.click();
      if (session.mode === 'ai') chat.addGame({ name: session.oppName, kind: 'ai', text: say(r.result === 'win' ? 'loss' : 'win') });
      const ranked = (online && !friendly) || (session.mode === 'ai' && session.match);
      const [blue, red] = session.spectator?.players ?? [];
      const note = spectating ? `Spectated · ${r.result === 'draw' ? 'Draw' : `${r.result === 'win' ? blue.name : red.name} wins`}` : friendly ? 'Friendly battle — no trophies at stake.' : undefined;
      const screen = showResult(r, {
        replay,
        ranked,
        note,
        onPlayAgain: friendly || spectating ? null : () => {
          teardown();
          if (online) startOnline({ kind: 'ranked' });
          else startAi();
        },
        onRematch: online ? () => net.request({ t: 'rematch', room: session.room, deck: state.deck }, 'econ', { op: 'rematch' }).then((m) => m?.error && screen.setRematch('expired')) : null,
        onMenu: () => {
          teardown();
          enterLobby();
        },
      });
      resultScreen = screen;
      if (rematchOffered) screen.setRematch('offered');
      if (online) {
        // Both rematch votes start a new friendly room.
        const offFound = net.on('match-found', (m) => {
          offFound();
          screen.close();
          teardown();
          playOnline(m);
        });
        offs.push(offFound);
      }
      // The server decides the rewards: a re-simulated AI match, or the online room's result.
      if (session.mode === 'ai' && session.match) {
        net.request({ t: 'ai-end', matchId: session.match.matchId, inputs: session.inputs }, 'reward', { timeout: 15000 }).then((m) => screen.setRewards(m?.summary ?? null));
      } else if (online && !friendly) onlineReward.then((m) => screen.setRewards(m?.summary ?? null));
    };

    let overAt = null;
    let resultScreen = null;
    let rematchOffered = false;
    // The opponent may vote for a rematch before our result screen is up.
    if (online) offs.push(net.on('rematch-offer', () => ((rematchOffered = true), resultScreen?.setRematch('offered'))));
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

    if (import.meta.env.DEV) window.__pump.battle = { session, view };
    hud = createBattleHud({
      engine,
      session,
      view,
      chat,
      onMenu: (forfeit) => {
        if (forfeit && !finished && !replay) {
          session.forfeit();
          if (!online) {
            const r = session.result();
            recordMatch({ result: 'loss', myCrowns: r.myCrowns, enemyCrowns: r.enemyCrowns, opponent: 'AI', mode: 'ai' });
            if (session.match) net.send({ t: 'ai-end', matchId: session.match.matchId, inputs: session.inputs });
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
  // Invite links: /?friend=CODE joins that friendly battle once logged in.
  const params = new URLSearchParams(location.search);
  const friendCode = params.get('friend');
  if (friendCode) {
    params.delete('friend');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
  }
  let invited = !friendCode;
  const loggedIn = () => net.account && !net.account.guest;
  const joinInvite = () => {
    if (invited || !loggedIn()) return;
    invited = true;
    startOnline({ kind: 'friendly-join', code: friendCode.toUpperCase().slice(0, 6) });
  };
  net.on('session', joinInvite);
  joinInvite();
  // Playing needs an account: the sign-up / log-in form sits over the lobby until then.
  initLoginGate(appEl, () => {
    toastMsg(`Welcome, ${state.name}!`);
    if (lobby) {
      leaveLobby();
      enterLobby();
    }
  });
  clearInterval(lineTimer);
  barFill.style.width = '100%';
  loading.classList.add('done');
  setTimeout(() => loading.remove(), 700);
}

boot().catch(fatal);
