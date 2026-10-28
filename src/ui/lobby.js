import { h, img, icon } from './dom.js';
import { openCards } from './cards.js';
import { openDeck } from './deck.js';
import { openProfile } from './profile.js';
import { sfx } from '../audio.js';
import { net } from '../net.js';
import { state, save } from '../state.js';

const X_URL = 'https://x.com/';
const MAX_FEED = 9;

export function pingPill() {
  const text = h('span', {}, '— ms');
  const el = h('div', { class: 'ping interactive', title: 'Latency to the game server' }, h('span', { class: 'dot' }), text);
  const update = () => {
    const p = net.ping;
    el.classList.remove('good', 'ok', 'bad');
    if (!net.connected) {
      text.textContent = 'offline';
      el.classList.add('bad');
    } else if (p != null) {
      text.textContent = `${p}ms`;
      el.classList.add(p < 120 ? 'good' : p < 250 ? 'ok' : 'bad');
    }
  };
  net.on('status', update);
  update();
  return el;
}

function feedItem(item) {
  const name = h('b', {}, item.name);
  let text;
  let wifi = 'wifi';
  if (item.kind === 'join') text = [name, ' joined the arena'];
  else if (item.kind === 'back') text = [name, ' is back online'];
  else {
    const verb = item.result === 'win' ? 'won' : item.result === 'loss' ? 'lost' : 'drew';
    text = [name, ` ${verb} a battle · ${item.crowns} 👑`];
    wifi = null;
  }
  return h('div', { class: `feed-item ${item.kind}` }, wifi ? icon(wifi) : h('span', {}, '⚔️'), h('span', {}, text));
}

function feed() {
  const el = h('div', { class: 'feed' });
  const render = () => el.replaceChildren(...net.feed.slice(-MAX_FEED).reverse().map(feedItem));
  net.on('welcome', render);
  net.on('feed', (item) => {
    el.prepend(feedItem(item));
    while (el.children.length > MAX_FEED) el.lastChild.remove();
  });
  render();
  return el;
}

function leaderboard() {
  let tab = 'towers';
  const body = h('tbody', {});
  const head = h('th', {});
  const towersBtn = h('button', { class: 'btn gold', onclick: () => setTab('towers') }, img('/assets/ui/icon-crown.png'), 'TOWERS');
  const cardsBtn = h('button', { class: 'btn', onclick: () => setTab('cards') }, img('/assets/ui/icon-cards.png'), 'CARDS');
  const iconSrc = () => (tab === 'towers' ? '/assets/ui/icon-crown.png' : '/assets/ui/icon-cards.png');

  const render = () => {
    head.replaceChildren(img(iconSrc()), tab.toUpperCase());
    const rows = net.leaderboard[tab] ?? [];
    if (!rows.length) {
      body.replaceChildren(h('tr', {}, h('td', { colSpan: 3, class: 'lb-empty' }, 'No entries yet — be the first!')));
      return;
    }
    body.replaceChildren(
      ...rows.map((r, i) =>
        h('tr', { class: r.name === state.name ? 'me' : '' }, h('td', {}, i + 1), h('td', { class: 'name' }, r.name), h('td', {}, img(iconSrc()), r.value)),
      ),
    );
  };
  const setTab = (t) => {
    sfx.click();
    tab = t;
    towersBtn.classList.toggle('gold', t === 'towers');
    cardsBtn.classList.toggle('gold', t === 'cards');
    render();
  };
  net.on('leaderboard', render);
  render();

  return h(
    'div',
    { class: 'leaderboard wood panel' },
    h('div', { class: 'lb-head title' }, img('/assets/ui/icon-trophy.png'), 'LEADERBOARD', h('span', { class: 'live' }, 'LIVE')),
    h('div', { class: 'lb-tabs' }, towersBtn, cardsBtn),
    h('table', { class: 'lb-table' }, h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'PLAYER'), head)), body),
  );
}

function settingsPopover(arena) {
  const val = h('span', { class: 'val' }, `${Math.round(state.settings.volume * 100)}%`);
  const slider = h('input', {
    type: 'range',
    min: 0,
    max: 100,
    value: Math.round(state.settings.volume * 100),
    oninput: (e) => {
      state.settings.volume = e.target.value / 100;
      val.textContent = `${e.target.value}%`;
      save();
    },
    onchange: () => sfx.click(),
  });
  const high = h('button', { class: 'btn', onclick: () => setGfx('high') }, 'HIGH');
  const low = h('button', { class: 'btn', onclick: () => setGfx('low') }, 'LOW');
  const setGfx = (g) => {
    sfx.click();
    state.settings.graphics = g;
    save();
    arena.applyGraphics();
    high.classList.toggle('gold', g === 'high');
    low.classList.toggle('gold', g === 'low');
  };
  high.classList.toggle('gold', state.settings.graphics === 'high');
  low.classList.toggle('gold', state.settings.graphics === 'low');
  return [
    h('h3', {}, 'SETTINGS'),
    h('div', { class: 'setting-row' }, h('span', {}, 'Volume'), slider, val),
    h('div', { class: 'setting-row' }, h('span', {}, 'Graphics'), h('div', { class: 'seg' }, high, low)),
  ];
}

function howToPopover() {
  const row = (src, ...text) => h('div', { class: 'howto-row' }, img(src), h('span', {}, text));
  return [
    h('h3', {}, 'HOW TO PLAY'),
    row('/assets/ui/icon-cards.png', h('b', {}, 'Drag cards'), ' onto your side to deploy troops.'),
    row('/assets/ui/elixir.png', h('b', {}, 'Elixir'), ' fills over time — spend it wisely.'),
    row('/assets/ui/icon-crown.png', h('b', {}, 'Destroy towers'), ' for crowns; the King Tower wins.'),
    row('/assets/ui/icon-play.png', h('b', {}, 'vs AI'), ' — most crowns when the clock runs out wins.'),
  ];
}

function socialsPopover() {
  return [
    h('h3', {}, 'SOCIALS'),
    h('button', { class: 'btn social-btn', onclick: () => window.open(X_URL, '_blank', 'noopener') }, icon('x'), 'Follow on X'),
    h('button', { class: 'btn social-btn', disabled: true }, h('span', { class: 'ca' }, 'CA'), 'Coming soon'),
  ];
}

export function createLobby({ arena, chat, onPlay }) {
  const lb = leaderboard();

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
  };

  const sideBtn = (key, content, title, onclick) =>
    (sideButtons[key] = h('button', { class: 'btn side-btn', title, onclick: (e) => (e.stopPropagation(), onclick()) }, content));

  const side = h(
    'div',
    { class: 'side-col wood panel', onpointerdown: (e) => e.stopPropagation() },
    sideBtn('profile', img('/assets/ui/icon-profile.png'), 'Profile', () => (closePop(), openProfile())),
    sideBtn('settings', icon('gear'), 'Settings', () => togglePop('settings', () => settingsPopover(arena))),
    sideBtn('howto', icon('book'), 'How to play', () => togglePop('howto', howToPopover)),
    sideBtn('social', icon('share'), 'Socials', () => togglePop('social', socialsPopover)),
  );

  const menuBtn = (cls, src, label, onclick) =>
    h('button', { class: `btn ${cls}`, onclick: () => (sfx.click(), closePop(), onclick()) }, img(src), label);

  const root = h(
    'div',
    { class: 'hud lobby' },
    h('div', { class: 'ping-row' }, pingPill()),
    h(
      'div',
      { class: 'left-col' },
      img('/assets/ui/logo.png', 'lobby-logo', 'Pump Royale'),
      h('div', { class: 'live-label title' }, 'LIVE ARENA · JOINS, BATTLES & CROWNS'),
      feed(),
    ),
    chat.el,
    lb,
    side,
    h(
      'div',
      { class: 'menu-bar' },
      menuBtn('', '/assets/ui/icon-cards.png', 'CARDS', openCards),
      menuBtn('gold play', '/assets/ui/icon-play.png', 'PLAY', onPlay),
      menuBtn('', '/assets/ui/icon-deck.png', 'DECK', openDeck),
    ),
    h(
      'div',
      { class: 'corner-br' },
      h('button', { class: 'btn', title: 'Follow on X', onclick: () => window.open(X_URL, '_blank', 'noopener') }, icon('x')),
      h('button', { class: 'btn', disabled: true }, h('span', { class: 'ca' }, 'CA'), 'Coming soon'),
    ),
  );

  const placeSide = () => (side.style.top = `${lb.offsetTop + lb.offsetHeight + 12}px`);
  new ResizeObserver(placeSide).observe(lb);
  const onDocDown = () => closePop();
  window.addEventListener('pointerdown', onDocDown);

  return {
    el: root,
    mounted() {
      placeSide();
    },
    destroy() {
      closePop();
      window.removeEventListener('pointerdown', onDocDown);
      root.remove();
    },
  };
}
