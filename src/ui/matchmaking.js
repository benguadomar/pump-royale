import { h, img, app } from './dom.js';
import { flag } from './widgets.js';
import { net } from '../net.js';
import { state } from '../state.js';
import { sfx } from '../audio.js';

/**
 * Queues for a 1v1 and shows a "finding opponent" panel. Resolves with the
 * match-found message, or null if the player cancels.
 */
export function findMatch() {
  return new Promise((resolve) => {
    const started = Date.now();
    const elapsed = h('span', { class: 'mm-time' }, '0:00');
    const queue = h('span', { class: 'mm-queue' }, '');
    const statusLine = h('div', { class: 'mm-status' }, net.connected ? 'Searching for a worthy opponent…' : 'Connecting to the server…');
    const cancel = h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel');
    const box = h(
      'div',
      { class: 'backdrop' },
      h(
        'div',
        { class: 'modal wood mm-modal' },
        h('h2', { class: 'title' }, '1V1 ONLINE'),
        h('div', { class: 'mm-spinner' }, img('/assets/ui/icon-play.png')),
        statusLine,
        h('div', { class: 'mm-meta' }, elapsed, queue),
        h('div', { class: 'mm-hint' }, 'Tip: open the game in a second browser window to test against yourself.'),
        cancel,
      ),
    );
    app().append(box);

    const join = () => net.send({ t: 'queue-join', deck: state.deck });
    if (net.connected) join();
    const offs = [
      net.on('status', () => {
        if (net.connected) {
          statusLine.textContent = 'Searching for a worthy opponent…';
          join();
        } else statusLine.textContent = 'Connection lost — reconnecting…';
      }),
      net.on('queue', (m) => (queue.textContent = m.size > 1 ? `${m.size} in queue` : 'You are first in queue')),
      net.on('match-found', (m) => finish(m)),
    ];
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      elapsed.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 500);

    function finish(result) {
      sfx.click();
      clearInterval(timer);
      offs.forEach((o) => o());
      box.remove();
      if (!result) net.send({ t: 'queue-leave' });
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
      h('div', { class: 'vs-mid title' }, 'VS'),
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
