import { h, img, app } from './dom.js';
import { elixirBadge } from './cards.js';
import { pingPill } from './lobby.js';
import { sfx } from '../audio.js';
import { state } from '../state.js';
import { CARD_BY_ID, cardImg } from '../data/cards.js';

const DRAG_THRESHOLD = 8;

const fmtTime = (s) => {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

export function createBattleHud({ arena, battle, chat, onForfeit }) {
  const me = battle.sides[0];
  let selected = null;
  let drag = null;

  const myCrowns = h('span', {}, '0');
  const aiCrowns = h('span', {}, '0');
  const timeEl = h('div', { class: 't' }, fmtTime(battle.time));
  const timeLbl = h('div', { class: 'lbl' }, 'TIME LEFT');
  const timer = h('div', { class: 'timer wood' }, timeEl, timeLbl);

  const nextSlot = h('div', { class: 'slot' });
  const cardEls = [0, 1, 2, 3].map((i) => h('div', { class: 'hand-card interactive', onpointerdown: (e) => startDrag(e, i) }));
  const elixirFill = h('div', { class: 'elixir-fill' });
  const elixirCount = h('span', { class: 'count' }, '5');

  const root = h(
    'div',
    { class: 'hud battle' },
    h('div', { class: 'ping-row' }, pingPill()),
    h(
      'div',
      { class: 'battle-top' },
      h('div', { class: 'crowns blue wood' }, img('/assets/ui/icon-crown.png'), myCrowns, h('span', { class: 'who' }, state.name)),
      timer,
      h('div', { class: 'crowns red wood' }, h('span', { class: 'who' }, 'AI'), aiCrowns, img('/assets/ui/icon-crown.png')),
    ),
    h('div', { class: 'forfeit' }, h('button', { class: 'btn', onclick: () => (sfx.click(), onForfeit()) }, 'Leave')),
    chat.el,
    h(
      'div',
      { class: 'hand wood panel' },
      h('div', { class: 'hand-cards' }, h('div', { class: 'next-card' }, 'NEXT', nextSlot), cardEls),
      h(
        'div',
        { class: 'elixir-bar' },
        img('/assets/ui/elixir.png'),
        elixirCount,
        h('div', { class: 'elixir-track' }, elixirFill, h('div', { class: 'elixir-ticks' }, Array.from({ length: 10 }, () => h('div')))),
      ),
    ),
  );

  let handKey = '';
  function renderHand() {
    const key = me.hand.join() + me.next;
    if (key === handKey) return;
    handKey = key;
    me.hand.forEach((id, i) => {
      const card = CARD_BY_ID[id];
      cardEls[i].replaceChildren(elixirBadge(card.cost), img(cardImg(id), 'art', card.name));
      cardEls[i].title = card.name;
    });
    nextSlot.replaceChildren(img(cardImg(me.next)), elixirBadge(CARD_BY_ID[me.next].cost));
  }

  let lastText = '';
  function tick() {
    renderHand();
    const e = me.elixir;
    elixirFill.style.width = `${(e / 10) * 100}%`;
    elixirCount.textContent = Math.floor(e);
    me.hand.forEach((id, i) => {
      cardEls[i].classList.toggle('poor', CARD_BY_ID[id].cost > e);
      cardEls[i].classList.toggle('selected', selected === i);
    });
    myCrowns.textContent = me.crowns;
    aiCrowns.textContent = battle.sides[1].crowns;
    const text = fmtTime(battle.time);
    if (text !== lastText) {
      lastText = text;
      timeEl.textContent = text;
      timer.classList.toggle('double', battle.doubleElixir);
      timeLbl.textContent = battle.overtime ? 'OVERTIME · x2' : battle.doubleElixir ? 'x2 ELIXIR' : 'TIME LEFT';
    }
  }

  // ------------------------------------------------------------- deploy input

  const overCanvas = (x, y) => document.elementFromPoint(x, y)?.id === 'scene';

  function tryDeploy(index, clientX, clientY) {
    const tile = arena.pickTile(clientX, clientY);
    if (!tile) return false;
    const ok = battle.playCard(0, index, tile.x, tile.y);
    if (!ok) {
      const card = CARD_BY_ID[me.hand[index]];
      toast(card.cost > me.elixir ? 'Not enough elixir!' : "Can't deploy there", true);
    }
    return ok;
  }

  function startDrag(e, i) {
    if (battle.over) return;
    e.preventDefault();
    const id = me.hand[i];
    drag = { i, id, x0: e.clientX, y0: e.clientY, moved: false, ghost: null };
    battle.showZones();
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd, { once: true });
  }

  function onDragMove(e) {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > DRAG_THRESHOLD) {
      drag.moved = true;
      drag.ghost = h('div', { class: 'drag-ghost' }, img(cardImg(drag.id)));
      document.body.append(drag.ghost);
      cardEls[drag.i].classList.add('dragging');
    }
    if (!drag.moved) return;
    drag.ghost.style.left = `${e.clientX}px`;
    drag.ghost.style.top = `${e.clientY}px`;
    const onArena = overCanvas(e.clientX, e.clientY);
    drag.ghost.classList.toggle('over-arena', onArena);
    const tile = onArena && arena.pickTile(e.clientX, e.clientY);
    if (tile) battle.setPreview(drag.id, tile.x, tile.y);
    else battle.setPreview(null);
  }

  function onDragEnd(e) {
    window.removeEventListener('pointermove', onDragMove);
    const d = drag;
    drag = null;
    if (!d) return;
    d.ghost?.remove();
    cardEls[d.i].classList.remove('dragging');
    battle.setPreview(null);
    if (d.moved) {
      battle.hideZones();
      selected = null;
      if (overCanvas(e.clientX, e.clientY)) tryDeploy(d.i, e.clientX, e.clientY);
      return;
    }
    // A tap selects the card; the next tap on the arena deploys it.
    sfx.click();
    selected = selected === d.i ? null : d.i;
    if (selected == null) battle.hideZones();
  }

  function onCanvasDown(e) {
    if (selected == null || battle.over) return;
    if (tryDeploy(selected, e.clientX, e.clientY)) {
      selected = null;
      battle.hideZones();
    }
  }
  function onCanvasMove(e) {
    if (selected == null || drag) return;
    const tile = arena.pickTile(e.clientX, e.clientY);
    if (tile) battle.setPreview(me.hand[selected], tile.x, tile.y);
  }
  const onKey = (e) => {
    if (document.activeElement?.tagName === 'INPUT') return;
    const n = Number(e.key);
    if (n >= 1 && n <= 4) {
      selected = selected === n - 1 ? null : n - 1;
      if (selected == null) battle.hideZones();
      else battle.showZones();
    }
    if (e.key === 'Escape') {
      selected = null;
      battle.hideZones();
    }
  };
  arena.canvas.addEventListener('pointerdown', onCanvasDown);
  arena.canvas.addEventListener('pointermove', onCanvasMove);
  window.addEventListener('keydown', onKey);

  function toast(text, small = false) {
    const el = h('div', { class: `toast${small ? ' small' : ''}` }, text);
    root.append(el);
    setTimeout(() => el.remove(), 1600);
  }

  const unsub = arena.onUpdate(tick);
  tick();

  return {
    el: root,
    toast,
    destroy() {
      unsub();
      arena.canvas.removeEventListener('pointerdown', onCanvasDown);
      arena.canvas.removeEventListener('pointermove', onCanvasMove);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointermove', onDragMove);
      drag?.ghost?.remove();
      root.remove();
    },
  };
}

export function showResult({ result, myCrowns, enemyCrowns }, onContinue) {
  const title = { win: 'VICTORY!', loss: 'DEFEAT', draw: 'DRAW' }[result];
  const sub = {
    win: 'The AI king has fallen. Well fought!',
    loss: 'Your towers crumbled. Tweak your deck and try again!',
    draw: 'Evenly matched — nobody takes the crown.',
  }[result];
  const backdrop = h(
    'div',
    { class: 'backdrop' },
    h(
      'div',
      { class: 'modal result-modal wood' },
      h('h2', { class: result }, title),
      h(
        'div',
        { class: 'result-crowns' },
        h('div', { class: 'side' }, img('/assets/ui/icon-crown.png'), h('span', { class: 'n' }, myCrowns), state.name),
        h('span', {}, '–'),
        h('div', { class: 'side red' }, img('/assets/ui/icon-crown.png'), h('span', { class: 'n' }, enemyCrowns), 'AI'),
      ),
      h('div', { class: 'result-sub' }, sub),
      h('button', { class: 'btn gold', onclick: () => (sfx.click(), backdrop.remove(), onContinue()) }, 'Back to Lobby'),
    ),
  );
  app().append(backdrop);
}
