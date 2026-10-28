import { h, img, icon } from './dom.js';
import { net } from '../net.js';
import { state, save } from '../state.js';
import { sfx, applyVolume } from '../audio.js';

export const CONTRACT_ADDRESS = 'SOON_0000';

/** Small country flag (or nothing when the country is unknown). */
export function flag(country) {
  if (!country) return null;
  const el = img(`https://flagcdn.com/w20/${country.toLowerCase()}.png`, 'flag', country);
  el.onerror = () => el.remove();
  el.title = country;
  return el;
}

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
  const off = net.on('status', update);
  update();
  el.destroy = off;
  return el;
}

export function toastMsg(text) {
  const el = h('div', { class: 'mini-toast' }, text);
  document.getElementById('app').append(el);
  setTimeout(() => el.remove(), 1800);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toastMsg('Copied!');
}

/** Picture-in-picture gameplay clip with a copyable contract address under it. */
export function mediaBox() {
  const video = h('video', { src: '/assets/video/gameplay.mp4', poster: '/assets/video/poster.jpg', muted: true, loop: true, playsInline: true, preload: 'metadata' });
  video.muted = true;
  const playBtn = h('button', { class: 'pip-play', title: 'Play / pause' }, '▶');
  const toggle = () => {
    sfx.click();
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };
  video.onplay = () => playBtn.classList.add('playing');
  video.onpause = () => playBtn.classList.remove('playing');
  playBtn.onclick = toggle;
  video.onclick = toggle;
  const expand = h('button', { class: 'pip-expand', title: 'Picture in picture', onclick: () => video.requestPictureInPicture?.().catch(() => {}) }, '⤢');
  return h(
    'div',
    { class: 'media-box' },
    h('div', { class: 'pip wood panel' }, video, playBtn, expand),
    h(
      'div',
      { class: 'ca-row' },
      h('button', { class: 'btn', title: 'Follow on X', onclick: () => window.open('https://x.com/', '_blank', 'noopener') }, icon('x')),
      h('button', { class: 'btn ca-btn', title: 'Copy contract address', onclick: () => copy(CONTRACT_ADDRESS) }, h('span', { class: 'ca' }, 'CA:'), CONTRACT_ADDRESS, icon('copy')),
    ),
  );
}

export function settingsBody(engine) {
  const row = (label, key) => {
    const val = h('span', { class: 'val' }, `${Math.round(state.settings[key] * 100)}%`);
    const slider = h('input', {
      type: 'range',
      min: 0,
      max: 100,
      value: Math.round(state.settings[key] * 100),
      oninput: (e) => {
        state.settings[key] = e.target.value / 100;
        val.textContent = `${e.target.value}%`;
        applyVolume();
        save();
      },
      onchange: () => sfx.click(),
    });
    return h('div', { class: 'setting-row' }, h('span', {}, label), slider, val);
  };
  const high = h('button', { class: 'btn', onclick: () => setGfx('high') }, 'HIGH');
  const low = h('button', { class: 'btn', onclick: () => setGfx('low') }, 'LOW');
  const setGfx = (g) => {
    sfx.click();
    state.settings.graphics = g;
    save();
    engine.applyGraphics();
    high.classList.toggle('gold', g === 'high');
    low.classList.toggle('gold', g === 'low');
  };
  high.classList.toggle('gold', state.settings.graphics === 'high');
  low.classList.toggle('gold', state.settings.graphics === 'low');
  return [
    h('h3', {}, 'SETTINGS'),
    row('Volume', 'volume'),
    row('Music', 'music'),
    h('div', { class: 'setting-row' }, h('span', {}, 'Graphics'), h('div', { class: 'seg' }, high, low)),
    h('div', { class: 'setting-note' }, `Renderer: ${engine.backendName}`),
  ];
}

export function muteButton() {
  const btn = h('button', { class: 'btn side-btn', title: 'Toggle audio' });
  const render = () => {
    btn.replaceChildren(icon(state.settings.muted ? 'mute' : 'sound'));
    btn.classList.toggle('active', state.settings.muted);
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    state.settings.muted = !state.settings.muted;
    applyVolume();
    save();
    render();
    sfx.click();
  };
  render();
  return btn;
}

export function fullscreenButton() {
  return h(
    'button',
    {
      class: 'btn side-btn',
      title: 'Fullscreen',
      onclick: (e) => {
        e.stopPropagation();
        sfx.click();
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.().catch(() => {});
      },
    },
    icon('fullscreen'),
  );
}

/**
 * Live leaderboard panel. `tabs` picks which boards are offered; the compact battle
 * version shows only the PvP wins board with streaks.
 */
export function leaderboardPanel({ tabs = ['towers', 'cards', 'wins'], compact = false } = {}) {
  let tab = tabs.includes('wins') && compact ? 'wins' : tabs[0];
  const ICON = { towers: '/assets/ui/icon-crown.png', cards: '/assets/ui/icon-cards.png', wins: '/assets/ui/icon-trophy.png' };
  const body = h('tbody', {});
  const head = h('tr', {});
  const buttons = {};
  const tabRow = h(
    'div',
    { class: 'lb-tabs' },
    tabs.map((t) => (buttons[t] = h('button', { class: 'btn', onclick: () => setTab(t) }, img(ICON[t]), t.toUpperCase()))),
  );
  tabRow.style.gridTemplateColumns = `repeat(${tabs.length}, 1fr)`;

  const render = () => {
    const wins = tab === 'wins';
    head.replaceChildren(...[h('th', {}, '#'), h('th', {}, 'PLAYER'), h('th', {}, wins ? 'WINS' : tab.toUpperCase()), wins && h('th', {}, 'STREAK')].filter(Boolean));
    const rows = net.leaderboard[tab] ?? [];
    if (!rows.length) {
      body.replaceChildren(h('tr', {}, h('td', { colSpan: 4, class: 'lb-empty' }, wins ? 'Win a 1v1 to get on the board!' : 'No entries yet — be the first!')));
      return;
    }
    body.replaceChildren(
      ...rows.map((r, i) =>
        h(
          'tr',
          { class: r.name === state.name ? 'me' : '' },
          h('td', {}, i + 1),
          h('td', { class: 'name' }, flag(r.country), r.name),
          h('td', {}, !wins && img(ICON[tab]), r.value),
          wins && h('td', { class: 'streak' }, `${r.streak ?? 0} 🔥`),
        ),
      ),
    );
  };
  const setTab = (t) => {
    if (t !== tab) sfx.click();
    tab = t;
    for (const [k, b] of Object.entries(buttons)) b.classList.toggle('gold', k === t);
    render();
  };
  const off = net.on('leaderboard', render);
  setTab(tab);

  const el = h(
    'div',
    { class: `leaderboard wood panel${compact ? ' compact' : ''}` },
    h('div', { class: 'lb-head title' }, img('/assets/ui/icon-trophy.png'), 'LEADERBOARD', h('span', { class: 'live' }, compact ? 'TOP 10' : 'LIVE')),
    tabs.length > 1 && tabRow,
    h('table', { class: 'lb-table' }, h('thead', {}, head), body),
  );
  el.destroy = off;
  return el;
}
