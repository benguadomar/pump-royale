import { h, img, icon } from './dom.js';
import { net } from '../net.js';
import { state, save } from '../state.js';
import { sfx, applyVolume } from '../audio.js';
import { openModal } from './modal.js';
import { leaderboardReward, LEADERBOARD_SIZE, solPrize } from '../data/economy.js';

export const CONTRACT_ADDRESS = 'SOON_0000';
/** The Solana logo, sized to sit inline with text. */
export const solIcon = () => img('/assets/ui/solana.png', 'sol-icon', 'SOL');

export const BADGE_COLORS = ['#e8b021', '#3c8ce8', '#d8443a', '#3cbc5a', '#9b5ae0', '#2ec4c4', '#ee7a2e', '#6f7f95'];

/** Ladder title beside a name: "#12" for the trophy top 100 (gold for the top 10). */
export function rankTag(name) {
  const r = net.rankOf(name);
  if (!r) return null;
  return h('span', { class: `rank-tag${r <= 3 ? ' top3' : r <= 10 ? ' top10' : ''}`, title: `#${r} on the trophy ladder` }, `#${r}`);
}

/** A player's clan (guild): its badge colour and name. */
export function clanTag(clan) {
  if (!clan) return null;
  return h('span', { class: 'clan-tag', title: `Clan #${clan.tag}` }, h('span', { class: 'clan-dot', style: { background: BADGE_COLORS[clan.badge % BADGE_COLORS.length] } }), clan.name);
}

/** Clan of anyone on the trophy board, by (unique) username. */
export const clanOf = (name) => net.leaderboard.trophies?.find((r) => r.name === name)?.clan ?? null;

/** Seconds until the next 00:00 UTC (ladder payout and daily reset). */
export function secondsToUtcMidnight(now = Date.now()) {
  const d = new Date(now);
  return Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000);
}

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

/** Follow button and copyable contract address (bottom-right corner). */
export function mediaBox() {
  return h(
    'div',
    { class: 'media-box' },
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
export function leaderboardPanel({ tabs = ['trophies', 'towers', 'cards', 'wins'], compact = false } = {}) {
  let tab = tabs.includes('wins') && compact ? 'wins' : tabs[0];
  const ICON = { trophies: '/assets/ui/icon-trophy.png', towers: '/assets/ui/icon-crown.png', cards: '/assets/ui/icon-cards.png', wins: '/assets/ui/icon-trophy.png' };
  const LABEL = { trophies: 'TOP 100', towers: 'TOWERS', cards: 'CARDS', wins: 'WINS' };
  const footer = h('div', { class: 'lb-foot' });
  const renderFooter = () => {
    if (tab !== 'trophies') return footer.replaceChildren();
    const mine = net.rankOf(state.name);
    const s = secondsToUtcMidnight();
    footer.replaceChildren(
      h('span', {}, mine ? h('b', {}, `You: #${mine}`) : h('span', { class: 'dim' }, 'You: not in the top 100')),
      h('button', { class: 'lb-rewards', title: 'Daily top 10 rewards', onclick: (e) => (e.stopPropagation(), sfx.click(), openLadderRewards()) }, `🎁 Top 10 paid in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`),
    );
  };
  const footTimer = setInterval(renderFooter, 30_000);
  const body = h('tbody', {});
  const head = h('tr', {});
  const buttons = {};
  const tabRow = h(
    'div',
    { class: 'lb-tabs' },
    tabs.map((t) => (buttons[t] = h('button', { class: 'btn', title: t === 'trophies' ? 'Top 100 by trophies' : t, onclick: () => setTab(t) }, img(ICON[t]), t === 'trophies' ? 'TOP' : LABEL[t]))),
  );
  tabRow.style.gridTemplateColumns = `repeat(${Math.min(tabs.length, 2)}, minmax(0, 1fr))`;

  const render = () => {
    const wins = tab === 'wins';
    const ladder = tab === 'trophies';
    head.replaceChildren(...[h('th', {}, '#'), h('th', {}, ladder ? 'PLAYER · CLAN' : 'PLAYER'), h('th', {}, wins ? 'WINS' : tab.toUpperCase()), wins && h('th', {}, 'STREAK')].filter(Boolean));
    renderFooter();
    const rows = net.leaderboard[tab] ?? [];
    if (!rows.length) {
      body.replaceChildren(h('tr', {}, h('td', { colSpan: 4, class: 'lb-empty' }, wins ? 'Win a 1v1 to get on the board!' : ladder ? 'Win trophies to climb the ladder!' : 'No entries yet — be the first!')));
      return;
    }
    body.replaceChildren(
      ...rows.map((r, i) =>
        h(
          'tr',
          { class: `${r.name === state.name ? 'me' : ''}${ladder && i < 3 ? ` podium p${i + 1}` : ''}` },
          h('td', { class: ladder && i < 10 ? 'paid' : '' }, ladder && i < 10 ? h('span', { title: 'Paid daily at 00:00 UTC' }, i + 1) : i + 1),
          h('td', { class: 'name' }, h('div', { class: 'lb-name' }, flag(r.country), h('span', {}, r.name)), ladder && r.clan && h('div', { class: 'lb-clan' }, clanTag(r.clan))),
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
    h('div', { class: 'lb-head title' }, img('/assets/ui/icon-trophy.png'), 'LEADERBOARD', h('span', { class: 'live' }, compact ? 'TOP 100' : 'LIVE')),
    tabs.length > 1 && tabRow,
    h('div', { class: 'lb-scroll' }, h('table', { class: 'lb-table' }, h('thead', {}, head), body)),
    footer,
  );
  el.destroy = () => (off(), clearInterval(footTimer));
  return el;
}

/** What the trophy ladder's top 10 earn every day. */
export function openLadderRewards() {
  const rows = [[1, '🥇'], [2, '🥈'], [3, '🥉'], [4, '#4 – #10']].map(([rank, label]) => {
    const r = leaderboardReward(rank);
    const sol = solPrize(rank);
    return h(
      'div',
      { class: 'ladder-reward inset' },
      h('b', {}, label),
      h('span', {}, img('/assets/ui/gem.png', 'icon'), r.gems),
      h('span', {}, img('/assets/ui/coin.png', 'icon'), r.gold),
      h('span', { class: `sol-prize${sol ? '' : ' none'}` }, sol ? [solIcon(), `${sol} SOL`] : '—'),
    );
  });
  openModal({
    cls: 'ladder-modal',
    title: 'DAILY LADDER REWARDS',
    iconSrc: '/assets/ui/icon-trophy.png',
    body: [
      h('p', { class: 'dim' }, `The top 10 of the trophy ladder are paid every day at 00:00 UTC. Everyone in the top ${LEADERBOARD_SIZE} wears their rank (#1 … #${LEADERBOARD_SIZE}) beside their name.`),
      ...rows,
      h('p', { class: 'sol-note' }, solIcon(), 'The top 3 also win real Solana, sent to the wallet address in their profile — add yours to be eligible.'),
    ],
  });
}
