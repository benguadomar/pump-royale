import { h, img, icon, dateShort } from './dom.js';
import { openModal, closeModal } from './modal.js';
import { sfx } from '../audio.js';
import { state, renameOnce } from '../state.js';
import { net } from '../net.js';
import { CARD_BY_ID, cardImg } from '../data/cards.js';
import { kingLevel, towerLevel, XP_LEVELS, leagueFor } from '../data/economy.js';
import { accountSection } from './account.js';

export function openProfile({ onReplay } = {}) {
  const nameRow = h('div', {});
  const note = h('div', { class: 'profile-note' });

  const renderName = (editing = false) => {
    note.textContent = state.nameLocked ? 'Saved on this device' : 'You can change your name once — choose wisely!';
    if (!editing) {
      nameRow.replaceChildren(
        h(
          'div',
          { class: 'profile-name' },
          state.name,
          !state.nameLocked && h('button', { class: 'btn', title: 'Change name (once)', onclick: () => (sfx.click(), renderName(true)) }, icon('pencil')),
        ),
      );
      return;
    }
    const input = h('input', { value: state.name, maxLength: 16, onkeydown: (e) => (e.stopPropagation(), e.key === 'Enter' && confirm()) });
    const confirm = () => {
      const prev = state.name;
      if (input.value.trim() && input.value.trim() !== prev && renameOnce(input.value)) {
        net.send({ t: 'rename', name: state.name });
      }
      renderName(false);
    };
    nameRow.replaceChildren(
      h('div', { class: 'name-edit' }, input, h('button', { class: 'btn gold', onclick: confirm }, 'Save'), h('button', { class: 'btn', onclick: () => renderName(false) }, 'Cancel')),
    );
    setTimeout(() => input.select());
  };
  renderName();

  // Server profile when connected (verified results); local stats as an offline fallback.
  const p = net.profile;
  const s = p ? { wins: p.wins, losses: p.losses, draws: p.draws } : state.stats;
  const played = s.wins + s.losses + s.draws;
  const winRate = played ? Math.round((s.wins / played) * 100) : 0;
  const box = (value, label) => h('div', { class: 'stat-box inset' }, h('b', {}, value), h('span', {}, label));

  const head = [];
  if (p) {
    const lvl = kingLevel(p.xp);
    const lo = XP_LEVELS[lvl - 1] ?? 0;
    const hi = XP_LEVELS[lvl] ?? lo;
    const league = leagueFor(p.trophies);
    head.push(
      h(
        'div',
        { class: 'king-row inset' },
        h('span', { class: 'king-lvl' }, lvl),
        h('div', { class: 'king-xp' }, h('b', {}, `King Level ${lvl}`), h('div', { class: 'xp-track' }, h('div', { class: 'xp-fill', style: { width: `${hi > lo ? Math.round(((p.xp - lo) / (hi - lo)) * 100) : 100}%` } })), h('span', { class: 'dim' }, hi > lo ? `${p.xp - lo} / ${hi - lo} XP · towers level ${towerLevel(p.xp)}` : 'Max level')),
        h('div', { class: 'king-league' }, h('span', { class: 'league-badge big', style: { background: league.color } }), h('b', {}, league.name), h('span', { class: 'dim' }, `${p.trophies} · best ${p.bestTrophies}`)),
      ),
    );
  }

  // Per-card win rates from verified matches, most played first.
  const cardRows = p
    ? Object.entries(p.cardStats)
        .filter(([id]) => CARD_BY_ID[id])
        .sort((a, b) => b[1].games - a[1].games)
        .slice(0, 8)
    : [];
  const favourite = cardRows[0]?.[0];
  const cardsSection = cardRows.length
    ? [
        h('div', { class: 'section-title' }, 'FAVOURITE CARD & WIN RATES'),
        h(
          'div',
          { class: 'card-rates' },
          cardRows.map(([id, st]) =>
            h('div', { class: `card-rate inset${id === favourite ? ' fav' : ''}` }, img(cardImg(id), 'icon'), h('b', {}, CARD_BY_ID[id].name), h('span', {}, `${Math.round((st.wins / st.games) * 100)}%`), h('small', { class: 'dim' }, `${st.games} games`)),
          ),
        ),
      ]
    : [];

  const matchesEl = h('div', { class: 'matches scroll' });
  const localRows = () =>
    state.history.length
      ? state.history.map((m) =>
          h(
            'div',
            { class: 'match-row inset' },
            h('span', { class: `res ${m.result}` }, m.result.toUpperCase()),
            h('span', { class: 'vs' }, h('b', { class: `mode ${m.mode ?? 'ai'}` }, m.mode === 'online' ? '1V1' : 'AI'), ` VS ${m.opponent}`),
            h('span', { class: 'when' }, dateShort(m.ts)),
            h('span', { class: 'score' }, `vs ${m.opponent} · ${m.myCrowns}–${m.enemyCrowns}`),
          ),
        )
      : [h('div', { class: 'empty inset' }, 'No matches yet — hit PLAY to battle!')];
  matchesEl.replaceChildren(...localRows());
  if (net.connected) {
    net.request({ t: 'replays' }, 'replays').then((msg) => {
      if (!msg?.list?.length) return;
      matchesEl.replaceChildren(
        ...msg.list.map((m) =>
          h(
            'div',
            { class: 'match-row inset' },
            h('span', { class: `res ${m.result}` }, m.result.toUpperCase()),
            h('span', { class: 'vs' }, h('b', { class: `mode ${m.mode === 'pvp' ? 'online' : 'ai'}` }, m.mode === 'pvp' ? '1V1' : 'AI'), ` VS ${m.opp}`),
            h('span', { class: 'when' }, dateShort(m.ts)),
            h('span', { class: 'score' }, `${m.crowns[0]}–${m.crowns[1]} · ${Math.floor(m.duration / 60)}:${String(m.duration % 60).padStart(2, '0')}`),
            onReplay && h('button', { class: 'btn replay-btn', title: 'Watch replay', onclick: () => (sfx.click(), closeModal(), onReplay(m.id)) }, '▶ Watch'),
          ),
        ),
      );
    });
  }

  openModal({
    cls: 'profile-modal',
    body: [
      h(
        'div',
        { class: 'profile-head' },
        img('/assets/cards/princess-tower.png', 'profile-avatar'),
        h('div', {}, h('div', { class: 'profile-label' }, 'YOUR PROFILE'), nameRow, note),
      ),
      ...head,
      accountSection(),
      h('div', { class: 'stats-grid' }, box(s.wins, 'WINS'), box(s.losses, 'LOSSES'), box(`${winRate}%`, 'WIN RATE'), box(p ? p.bestTrophies : state.stats.bestStreak, p ? 'BEST TROPHIES' : 'BEST STREAK')),
      ...cardsSection,
      h('div', { class: 'section-title' }, 'MATCH HISTORY & REPLAYS'),
      matchesEl,
    ],
  });
}
