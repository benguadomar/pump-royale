import { h, img, dateShort } from './dom.js';
import { openModal, closeModal } from './modal.js';
import { flag, rankTag, clanTag, toastMsg, solIcon } from './widgets.js';
import { net } from '../net.js';
import { sfx } from '../audio.js';
import { CARD_BY_ID, cardImg } from '../data/cards.js';
import { kingLevel, leagueFor } from '../data/economy.js';

/**
 * Any player's public profile (opened from the leaderboard): rank, clan, league, record, their
 * most played cards and their recent matches, each watchable as a replay.
 * `onReplay(id, isPublic, owner)` starts the replay.
 */
export async function openPlayer(name, { onReplay } = {}) {
  if (!net.connected) return toastMsg('Offline — profiles need the server');
  sfx.click();
  const msg = await net.request({ t: 'player-profile', name }, 'player-profile', { timeout: 5000 });
  const p = msg?.player;
  if (!p) return toastMsg('That player could not be found');

  const league = leagueFor(p.trophies);
  const played = p.wins + p.losses + p.draws;
  const box = (value, label) => h('div', { class: 'stat-box inset' }, h('b', {}, value), h('span', {}, label));

  const cards = Object.entries(p.cardStats ?? {})
    .filter(([id]) => CARD_BY_ID[id])
    .sort((a, b) => b[1].games - a[1].games)
    .slice(0, 8);

  const matches = p.replays.length
    ? p.replays.map((m) =>
        h(
          'div',
          { class: 'match-row inset' },
          h('span', { class: `res ${m.result}` }, m.result.toUpperCase()),
          h('span', { class: 'vs' }, h('b', { class: `mode ${m.mode === 'pvp' ? 'online' : 'ai'}` }, m.mode === 'pvp' ? '1V1' : 'AI'), ` VS ${m.opp}`),
          h('span', { class: 'when' }, dateShort(m.ts)),
          h('span', { class: 'score' }, `${m.crowns[0]}–${m.crowns[1]} · ${Math.floor(m.duration / 60)}:${String(m.duration % 60).padStart(2, '0')}`),
          onReplay && h('button', { class: 'btn replay-btn', title: 'Watch this match', onclick: () => (sfx.click(), closeModal(), onReplay(m.id, false, p.name)) }, '▶ Watch'),
        ),
      )
    : [h('div', { class: 'empty inset' }, 'No matches played yet.')];

  openModal({
    cls: 'profile-modal player-modal',
    body: [
      h(
        'div',
        { class: 'profile-head' },
        img('/assets/cards/princess-tower.png', 'profile-avatar'),
        h(
          'div',
          {},
          h('div', { class: 'profile-label' }, 'PLAYER PROFILE'),
          h('div', { class: 'profile-name' }, flag(p.country), rankTag(p.name), p.name, clanTag(p.clan)),
          h('div', { class: 'profile-note' }, p.rank ? `#${p.rank} on the trophy ladder` : 'Not in the top 100 yet'),
        ),
      ),
      h(
        'div',
        { class: 'wallet-row inset player-wallet' },
        h('span', { class: 'dim' }, solIcon(), 'Solana wallet'),
        p.wallet ? h('code', { class: 'wallet-addr', title: p.wallet }, p.wallet) : h('span', { class: 'wallet-missing' }, 'No wallet added'),
        p.wallet && h('button', { class: 'btn small-btn', title: 'Copy address', onclick: () => navigator.clipboard?.writeText(p.wallet).then(() => toastMsg('Wallet address copied')) }, 'Copy'),
      ),
      h(
        'div',
        { class: 'king-row inset' },
        h('span', { class: 'king-lvl' }, kingLevel(p.xp)),
        h('div', { class: 'king-xp' }, h('b', {}, `King Level ${kingLevel(p.xp)}`), h('span', { class: 'dim' }, `Playing since ${dateShort(p.joined)}`)),
        h('div', { class: 'king-league' }, h('span', { class: 'league-badge big', style: { background: league.color } }), h('b', {}, league.name), h('span', { class: 'dim' }, `${p.trophies} · best ${p.bestTrophies}`)),
      ),
      h('div', { class: 'stats-grid' }, box(p.wins, 'WINS'), box(p.losses, 'LOSSES'), box(`${played ? Math.round((p.wins / played) * 100) : 0}%`, 'WIN RATE'), box(p.bestTrophies, 'BEST TROPHIES')),
      cards.length && h('div', { class: 'section-title' }, 'MOST PLAYED CARDS'),
      cards.length &&
        h(
          'div',
          { class: 'card-rates' },
          cards.map(([id, st]) =>
            h('div', { class: 'card-rate inset' }, img(cardImg(id), 'icon'), h('b', {}, CARD_BY_ID[id].name), h('span', {}, `Lv ${p.levels[id] ?? 1} · ${Math.round((st.wins / st.games) * 100)}%`), h('small', { class: 'dim' }, `${st.games} games`)),
          ),
        ),
      h('div', { class: 'section-title' }, 'RECENT MATCHES — TAP ▶ TO WATCH'),
      h('div', { class: 'matches scroll' }, matches),
    ],
  });
}
