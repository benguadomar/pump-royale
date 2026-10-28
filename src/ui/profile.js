import { h, img, icon, dateShort } from './dom.js';
import { openModal } from './modal.js';
import { sfx } from '../audio.js';
import { state, renameOnce } from '../state.js';
import { net } from '../net.js';

export function openProfile() {
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

  const s = state.stats;
  const played = s.wins + s.losses + s.draws;
  const winRate = played ? Math.round((s.wins / played) * 100) : 0;
  const box = (value, label) => h('div', { class: 'stat-box inset' }, h('b', {}, value), h('span', {}, label));

  const matches = state.history.length
    ? state.history.map((m) =>
        h(
          'div',
          { class: 'match-row inset' },
          h('span', { class: `res ${m.result}` }, m.result.toUpperCase()),
          h('span', { class: 'vs' }, `VS ${m.opponent}`),
          h('span', { class: 'when' }, dateShort(m.ts)),
          h('span', { class: 'score' }, `vs ${m.opponent} · ${m.myCrowns}–${m.enemyCrowns}`),
        ),
      )
    : [h('div', { class: 'empty inset' }, 'No matches yet — hit PLAY to battle!')];

  openModal({
    cls: 'profile-modal',
    body: [
      h(
        'div',
        { class: 'profile-head' },
        img('/assets/cards/princess-tower.png', 'profile-avatar'),
        h('div', {}, h('div', { class: 'profile-label' }, 'YOUR PROFILE'), nameRow, note),
      ),
      h('div', { class: 'stats-grid' }, box(s.wins, 'WINS'), box(s.losses, 'LOSSES'), box(`${winRate}%`, 'WIN RATE'), box(s.bestStreak, 'BEST STREAK')),
      h('div', { class: 'section-title' }, 'RECENT MATCHES'),
      h('div', { class: 'matches scroll' }, matches),
    ],
  });
}
