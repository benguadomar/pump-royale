import { h, img, app } from './dom.js';
import { flag, toastMsg } from './widgets.js';
import { openModal, closeModal } from './modal.js';
import { net } from '../net.js';
import { state } from '../state.js';
import { sfx } from '../audio.js';
import { leagueFor } from '../data/economy.js';

const JOIN_ERRORS = { code: 'No battle with that code (it may have expired)', self: "That's your own code", deck: 'Your deck is not valid' };
export const inviteLink = (code) => `${location.origin}/?friend=${code}`;

/**
 * The 1V1 menu: ranked matchmaking, friendly battles by code/link, and Pump TV (live top
 * matches + recent ranked replays). Each action calls back into main.
 */
export function openBattleMenu({ onRanked, onFriendlyCreate, onFriendlyJoin, onSpectate, onPublicReplay }) {
  const p = net.profile;
  const tab = (name, build) => ({ name, build });
  const body = h('div', { class: 'battle-menu-body' });
  const tabsEl = h('div', { class: 'battle-tabs' });
  let active = 'ranked';

  const ranked = () => {
    const league = p ? leagueFor(p.trophies) : null;
    return [
      h('div', { class: 'bm-card inset' }, h('b', { class: 'title' }, 'RANKED 1V1'), p && h('div', { class: 'bm-league' }, h('span', { class: 'league-badge big', style: { background: league.color } }), h('span', {}, `${league.name} · ${p.trophies} trophies`)), h('p', { class: 'dim' }, 'Matched by trophies — the search widens the longer you wait. Win trophies, chests and pass XP.')),
      h('button', { class: 'btn gold big-btn', onclick: () => (sfx.click(), closeModal(), onRanked()) }, img('/assets/ui/icon-play.png'), 'FIND MATCH'),
    ];
  };

  const friendly = () => {
    const input = h('input', { class: 'code-input', maxLength: 6, placeholder: 'CODE', autocomplete: 'off', oninput: (e) => (e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')) });
    const join = () => {
      if (input.value.length !== 6) return toastMsg('Codes are 6 characters');
      sfx.click();
      closeModal();
      onFriendlyJoin(input.value);
    };
    input.onkeydown = (e) => e.key === 'Enter' && join();
    return [
      h('div', { class: 'bm-card inset' }, h('b', { class: 'title' }, 'FRIENDLY BATTLE'), h('p', { class: 'dim' }, 'Play a friend — no trophies at stake. Create a battle and share the code or link, or join theirs.')),
      h('button', { class: 'btn gold big-btn', onclick: () => (sfx.click(), closeModal(), onFriendlyCreate()) }, 'CREATE BATTLE'),
      h('div', { class: 'join-row' }, input, h('button', { class: 'btn', onclick: join }, 'JOIN')),
    ];
  };

  const tv = () => {
    const list = h('div', { class: 'tv-list scroll' }, h('div', { class: 'dim' }, net.connected ? 'Loading…' : 'Offline'));
    net.request({ t: 'tv' }, 'tv').then((m) => {
      if (!m) return;
      const row = (players, right, onclick, live) =>
        h(
          'button',
          { class: `tv-row inset${live ? ' live' : ''}`, onclick: () => (sfx.click(), closeModal(), onclick()) },
          live ? h('span', { class: 'live-dot' }, 'LIVE') : h('span', { class: 'dim small' }, 'REPLAY'),
          h('span', { class: 'tv-names' }, flag(players[0].country), h('b', { class: 'blue-name' }, players[0].name), h('small', {}, players[0].trophies), ' vs ', flag(players[1].country), h('b', { class: 'red-name' }, players[1].name), h('small', {}, players[1].trophies)),
          h('span', { class: 'tv-right' }, right),
        );
      const live = m.live.map((r) => row(r.players, `${r.crowns[0]}–${r.crowns[1]} · ${Math.floor(r.time / 60)}:${String(r.time % 60).padStart(2, '0')}${r.spectators ? ` · 👁 ${r.spectators}` : ''}`, () => onSpectate(r.room), true));
      const reps = m.replays.map((r) => row(r.players, `${r.crowns[0]}–${r.crowns[1]}`, () => onPublicReplay(r.id), false));
      list.replaceChildren(
        h('div', { class: 'section-title' }, 'LIVE TOP MATCHES'),
        ...(live.length ? live : [h('div', { class: 'empty inset' }, 'No live matches right now.')]),
        h('div', { class: 'section-title' }, 'RECENT RANKED REPLAYS'),
        ...(reps.length ? reps : [h('div', { class: 'empty inset' }, 'No ranked replays yet.')]),
      );
    });
    return [list];
  };

  const tabs = [tab('ranked', ranked), tab('friendly', friendly), tab('tv', tv)];
  const labels = { ranked: 'RANKED', friendly: 'FRIENDLY', tv: '📺 PUMP TV' };
  const render = () => {
    tabsEl.replaceChildren(...tabs.map((t) => h('button', { class: `btn chip${t.name === active ? ' on' : ''}`, onclick: () => (sfx.click(), (active = t.name), render()) }, labels[t.name])));
    body.replaceChildren(...tabs.find((t) => t.name === active).build().filter(Boolean));
  };
  render();
  openModal({ cls: 'battle-menu', title: 'BATTLE', iconSrc: '/assets/ui/icon-play.png', body: [tabsEl, body] });
}

/**
 * Waits for an online match and shows a panel meanwhile. `opts.kind`: 'ranked' queues by
 * trophies; 'friendly-create' gets a code to share; 'friendly-join' joins `opts.code`.
 * Resolves with the match-found message, or null if cancelled / rejected.
 */
export function findMatch(opts = { kind: 'ranked' }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const elapsed = h('span', { class: 'mm-time' }, '0:00');
    const queue = h('span', { class: 'mm-queue' }, '');
    const title = { ranked: 'RANKED 1V1', 'friendly-create': 'FRIENDLY BATTLE', 'friendly-join': 'JOINING BATTLE' }[opts.kind];
    const statusLine = h('div', { class: 'mm-status' }, net.connected ? 'Searching for a worthy opponent…' : 'Connecting to the server…');
    const codeBox = h('div', { class: 'mm-code' });
    const cancel = h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel');
    const box = h(
      'div',
      { class: 'backdrop' },
      h('div', { class: 'modal wood mm-modal' }, h('h2', { class: 'title' }, title), h('div', { class: 'mm-spinner' }, img('/assets/ui/icon-play.png')), statusLine, codeBox, h('div', { class: 'mm-meta' }, elapsed, queue), cancel),
    );
    app().append(box);

    const showCode = (code) => {
      const link = inviteLink(code);
      statusLine.textContent = 'Share this code or link with your friend:';
      codeBox.replaceChildren(
        h('b', { class: 'code title' }, code),
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              sfx.click();
              try {
                if (navigator.share) await navigator.share({ title: 'Pump Royale', text: `Battle me in Pump Royale! Code ${code}`, url: link });
                else {
                  await navigator.clipboard.writeText(link);
                  toastMsg('Invite link copied');
                }
              } catch {}
            },
          },
          'Share link',
        ),
      );
    };

    const start = () => {
      if (opts.kind === 'ranked') return net.send({ t: 'queue-join', deck: state.deck });
      if (opts.kind === 'friendly-create') {
        net.request({ t: 'friendly-create', deck: state.deck }, 'econ', { op: 'friendly-create' }).then((m) => (m?.code ? showCode(m.code) : finish(null, 'Could not create the battle')));
        return;
      }
      statusLine.textContent = `Joining ${opts.code}…`;
      net.request({ t: 'friendly-join', code: opts.code, deck: state.deck }, 'econ', { op: 'friendly-join' }).then((m) => m?.error && finish(null, JOIN_ERRORS[m.error] ?? 'Could not join'));
    };
    let wasConnected = net.connected;
    if (wasConnected) start();
    const offs = [
      // 'status' also fires on every ping; only a real reconnect restarts the search.
      net.on('status', () => {
        if (net.connected === wasConnected) return;
        wasConnected = net.connected;
        if (net.connected) {
          statusLine.textContent = 'Searching for a worthy opponent…';
          start();
        } else statusLine.textContent = 'Connection lost — reconnecting…';
      }),
      net.on('queue', (m) => (queue.textContent = `${m.size > 1 ? `${m.size} in queue` : 'You are first in queue'} · ±${m.range} trophies`)),
      net.on('match-found', (m) => finish(m)),
    ];
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      elapsed.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 500);

    function finish(result, error) {
      sfx.click();
      clearInterval(timer);
      offs.forEach((o) => o());
      box.remove();
      if (error) toastMsg(error);
      if (!result) net.send({ t: opts.kind === 'ranked' ? 'queue-leave' : 'friendly-cancel' });
      resolve(result);
    }
  });
}

/** Brief VS splash while the server counts down to the start. */
export function showVersus(match) {
  return new Promise((resolve) => {
    const box = h(
      'div',
      { class: 'versus' },
      h('div', { class: 'vs-side blue' }, flag(state.country), h('span', {}, state.name)),
      h('div', { class: 'vs-mid title' }, match.mode === 'friendly' ? 'FRIENDLY' : 'VS'),
      h('div', { class: 'vs-side red' }, flag(match.opp.country), h('span', {}, match.opp.name)),
    );
    app().append(box);
    sfx.horn();
    setTimeout(() => {
      box.classList.add('out');
      setTimeout(() => box.remove(), 400);
      resolve();
    }, Math.max(600, match.startsIn - 300));
  });
}
