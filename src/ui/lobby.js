import { h, img, icon } from './dom.js';
import { openCards } from './cards.js';
import { openDeck } from './deck.js';
import { openProfile } from './profile.js';
import { openModal } from './modal.js';
import { pingPill, leaderboardPanel, mediaBox, settingsBody, flag, toastMsg, rankTag } from './widgets.js';
import { sfx } from '../audio.js';
import { net } from '../net.js';
import { state, save, currentArena } from '../state.js';
import { ARENAS } from '../data/arenas.js';
import { aiDifficulty } from '../sim/aiDifficulty.js';
import { resourceBar, chestSlots, questsBody } from './progress.js';
import { openClan } from './clan.js';
import { openDaily, dailyClaimable, showNotices } from './daily.js';
import { openShop } from './shop.js';

const X_URL = 'https://x.com/';
/** The daily calendar opens by itself at most once per page load. */
let prompted = false;
const MAX_FEED = 9;

function feedText(item) {
  const name = h('b', {}, rankTag(item.name), item.name);
  if (item.kind === 'join') return [name, ' joined the arena'];
  if (item.kind === 'back') return [name, ' is back online'];
  if (item.kind === 'pvp') return [name, ` beat ${item.opp} in 1v1 · ${item.crowns}`];
  const verb = item.result === 'win' ? 'won' : item.result === 'loss' ? 'lost' : 'drew';
  return [name, ` ${verb} vs AI · ${item.crowns} 👑`];
}

function feedItem(item) {
  const sym = item.kind === 'join' || item.kind === 'back' ? icon('wifi') : h('span', { class: 'sym' }, item.kind === 'pvp' ? '⚔️' : '🤖');
  return h('div', { class: `feed-item ${item.kind}` }, flag(item.country), sym, h('span', {}, feedText(item)));
}

function feed() {
  const el = h('div', { class: 'feed' });
  const render = () => el.replaceChildren(...net.feed.slice(-MAX_FEED).reverse().map(feedItem));
  const offs = [
    net.on('welcome', render),
    net.on('feed', (item) => {
      el.prepend(feedItem(item));
      while (el.children.length > MAX_FEED) el.lastChild.remove();
    }),
  ];
  render();
  el.destroy = () => offs.forEach((o) => o());
  return el;
}

/** Scrolling top-centre ticker of the newest battles and joins. */
function liveTicker() {
  const track = h('div', { class: 'ticker-track' });
  const render = () => {
    const items = net.feed.slice(-6).reverse();
    track.replaceChildren(
      ...(items.length ? items : [{ kind: 'idle' }]).map((it) =>
        h('span', { class: 'ticker-item' }, it.kind === 'idle' ? 'Waiting for the first battle…' : [flag(it.country), feedText(it)]),
      ),
    );
  };
  const offs = [net.on('welcome', render), net.on('feed', render)];
  render();
  const el = h(
    'div',
    { class: 'live-ticker wood panel' },
    h('span', { class: 'ticker-label title' }, '⚔ LIVE FEED'),
    h('div', { class: 'ticker-window' }, track),
    h('span', { class: 'ticker-online' }),
  );
  const online = el.querySelector('.ticker-online');
  const updOnline = () => (online.textContent = net.connected ? `● ${net.online} online` : '● offline');
  offs.push(net.on('status', updOnline));
  updOnline();
  el.destroy = () => offs.forEach((o) => o());
  return el;
}

// ------------------------------------------------------------------ popovers

function howToBody() {
  const row = (src, ...text) => h('div', { class: 'howto-row' }, img(src), h('span', {}, text));
  return [
    h('h3', {}, 'HOW TO PLAY'),
    row('/assets/ui/icon-cards.png', h('b', {}, 'Drag cards'), ' onto your side to deploy troops (or tap a card, then tap the arena; keys 1-4).'),
    row('/assets/ui/elixir.png', h('b', {}, 'Elixir'), ' fills over time — x2 in the last minute.'),
    row('/assets/ui/icon-crown.png', h('b', {}, 'Destroy towers'), ' for crowns; the King Tower wins instantly.'),
    row('/assets/ui/icon-play.png', h('b', {}, '1v1 online'), ' or vs AI — most crowns wins, ties go to sudden death.'),
  ];
}

function socialsBody() {
  return [
    h('h3', {}, 'SOCIALS'),
    h('button', { class: 'btn social-btn', onclick: () => window.open(X_URL, '_blank', 'noopener') }, icon('x'), 'Follow on X'),
    h('button', { class: 'btn social-btn', disabled: true }, h('span', { class: 'ca' }, 'CA'), 'Coming soon'),
  ];
}

export function createLobby({ engine, chat, onPlay, onOnline, onReplay }) {
  const lb = leaderboardPanel();
  const destroyers = [lb.destroy];

  let openKey = null;
  let pop = null;
  const sideButtons = {};
  const closePop = () => {
    pop?.remove();
    pop = null;
    sideButtons[openKey]?.classList.remove('active');
    openKey = null;
  };
  const togglePop = (key, build) => {
    sfx.click();
    if (openKey === key) return closePop();
    closePop();
    openKey = key;
    const btn = sideButtons[key];
    btn.classList.add('active');
    pop = h('div', { class: 'popover wood panel', onpointerdown: (e) => e.stopPropagation() }, build());
    pop.style.top = `${side.offsetTop + btn.offsetTop - 4}px`;
    root.append(pop);
    const overflow = pop.getBoundingClientRect().bottom - (root.getBoundingClientRect().bottom - 12);
    if (overflow > 0) pop.style.top = `${Math.max(12, pop.offsetTop - overflow)}px`;
  };
  const sideBtn = (key, content, title, onclick) =>
    (sideButtons[key] = h('button', { class: 'btn side-btn', title, onclick: (e) => (e.stopPropagation(), onclick()) }, content));

  const side = h(
    'div',
    { class: 'side-col wood panel', onpointerdown: (e) => e.stopPropagation() },
    sideBtn('profile', img('/assets/ui/icon-profile.png'), 'Profile', () => (closePop(), openProfile({ onReplay }))),
    sideBtn('daily', [icon('gift'), h('span', { class: 'notify-dot' })], 'Daily reward', () => (closePop(), openDaily())),
    sideBtn('quests', icon('quest'), 'Quests & Season Pass', () => togglePop('quests', questsBody)),
    sideBtn('clan', icon('shield'), 'Clan', () => (closePop(), openClan())),
    sideBtn('settings', icon('gear'), 'Settings', () => togglePop('settings', () => settingsBody(engine))),
    sideBtn('howto', icon('book'), 'How to play', () => togglePop('howto', howToBody)),
    sideBtn('social', icon('share'), 'Socials', () => togglePop('social', socialsBody)),
  );

  const menuBtn = (cls, src, label, onclick, title) =>
    h('button', { class: `btn ${cls}`, title, onclick: () => (sfx.click(), closePop(), onclick()) }, src && img(src), label);

  // Arena picker: unlocked arenas can be chosen; locked ones show the trophies needed.
  const arenaLabel = h('span', {}, currentArena().name);
  const arenaChip = h('button', { class: 'arena-chip', title: 'Choose arena', onclick: () => (sfx.click(), closePop(), openArenas()) }, img('/assets/ui/icon-trophy.png'), arenaLabel);
  function openArenas() {
    const active = currentArena().id;
    const close = openModal({
      cls: 'arena-modal',
      title: 'ARENAS',
      iconSrc: '/assets/ui/icon-trophy.png',
      body: h(
        'div',
        { class: 'arena-list' },
        ARENAS.map((a) => {
          const locked = state.trophies < a.trophies;
          const swatch = h('div', { class: 'arena-swatch', style: { background: `linear-gradient(180deg, #${a.sky[0].toString(16).padStart(6, '0')}, #${a.grass[0].toString(16).padStart(6, '0')} 70%, #${a.path.toString(16).padStart(6, '0')})` } });
          return h(
            'button',
            {
              class: `arena-row inset${locked ? ' locked' : ''}${a.id === active ? ' active' : ''}`,
              disabled: locked,
              onclick: () => {
                sfx.click();
                state.arena = a.id;
                save();
                engine.setArena(a);
                arenaLabel.textContent = a.name;
                close();
              },
            },
            swatch,
            h(
              'div',
              { class: 'arena-info' },
              h('b', {}, a.name),
              h('span', {}, locked ? `🔒 Unlocks at ${a.trophies} trophies` : `${a.id === active ? 'Selected' : 'Tap to fight here'} · AI: ${aiDifficulty(a.id).name}`),
            ),
          );
        }),
      ),
    });
  }

  const ping = pingPill();
  const feedEl = feed();
  const ticker = liveTicker();
  const resources = resourceBar();
  const chests = chestSlots(engine);
  destroyers.push(ping.destroy, feedEl.destroy, ticker.destroy, resources.destroy, chests.destroy);

  const root = h(
    'div',
    { class: 'hud lobby' },
    h('div', { class: 'ping-row' }, ping),
    resources.el,
    ticker,
    chests.el,
    h('div', { class: 'left-col' }, img('/assets/ui/logo.png', 'lobby-logo', 'Pump Royale'), h('div', { class: 'live-label title' }, 'LIVE ARENA · JOINS, BATTLES & CROWNS'), feedEl),
    chat.el,
    lb,
    side,
    h(
      'div',
      { class: 'menu-bar' },
      arenaChip,
      menuBtn('shop-btn', null, [icon('shop'), 'SHOP'], () => openShop(engine), 'Chests for gems · hourly cards for gold'),
      menuBtn('', '/assets/ui/icon-cards.png', 'CARDS', openCards),
      menuBtn('gold play', '/assets/ui/icon-play.png', 'PLAY', onPlay, `Battle ${aiDifficulty(state.trophies).name} AI`),
      menuBtn('', '/assets/ui/icon-deck.png', 'DECK', openDeck),
      menuBtn('online', '/assets/ui/icon-play.png', '1V1 ONLINE', onOnline, 'Battle a real player'),
    ),
    mediaBox(),
  );

  const placeSide = () => (side.style.top = `${lb.offsetTop + lb.offsetHeight + 12}px`);
  const ro = new ResizeObserver(placeSide);
  ro.observe(lb);
  const onDocDown = () => closePop();
  window.addEventListener('pointerdown', onDocDown);

  // Daily reward dot; once per session the calendar (or a ladder payout notice) pops up by itself.
  const onProfile = () => {
    sideButtons.daily.classList.toggle('notify', dailyClaimable());
    if (prompted || !net.profile || document.querySelector('.login-gate, .backdrop')) return;
    prompted = true;
    if (!showNotices() && dailyClaimable()) openDaily();
  };
  destroyers.push(net.on('profile', onProfile));
  setTimeout(onProfile, 600);

  return {
    el: root,
    mounted() {
      placeSide();
    },
    destroy() {
      closePop();
      ro.disconnect();
      window.removeEventListener('pointerdown', onDocDown);
      destroyers.forEach((d) => d?.());
      root.remove();
    },
  };
}
