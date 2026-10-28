import { h, img, app, icon } from './dom.js';
import { elixirBadge } from './cards.js';
import { pingPill, leaderboardPanel, mediaBox, settingsBody, muteButton, fullscreenButton, flag } from './widgets.js';
import { sfx } from '../audio.js';
import { state } from '../state.js';
import { CARD_BY_ID, cardImg } from '../data/cards.js';
import { MAX_ELIXIR } from '../sim/constants.js';

const DRAG_THRESHOLD = 8;
const PLAY_ERRORS = { elixir: 'Not enough elixir!', zone: "Can't deploy there", card: 'Card already played', over: 'Match is over' };

const fmtTime = (s) => {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/**
 * In-match overlay. `session` provides state and accepts card plays; `view` is the 3D
 * BattleView (used for deploy previews and tile picking via the engine).
 */
export function createBattleHud({ engine, session, view, chat, onMenu }) {
  let selected = null;
  let drag = null;
  let last = null;

  // ---------------------------------------------------------------- status (middle left)
  const oppCrowns = h('span', { class: 'n' }, '0');
  const myCrowns = h('span', { class: 'n' }, '0');
  const timeEl = h('div', { class: 't' }, '3:00');
  const timeLbl = h('div', { class: 'lbl' }, 'Time left:');
  const x2 = h('div', { class: 'x2 hidden' }, 'x2');
  const timeBox = h('div', { class: 'time-box' }, timeLbl, timeEl);
  const oppStatus = h('span', { class: 'opp-status hidden' }, 'reconnecting…');
  const status = h(
    'div',
    { class: 'match-status' },
    h('div', { class: 'who opp' }, h('span', { class: 'dot' }), flag(session.oppFlag), session.oppName, oppStatus),
    h('div', { class: 'crown-row opp' }, img('/assets/ui/icon-crown.png'), oppCrowns),
    h('div', { class: 'time-row' }, timeBox, x2),
    h('div', { class: 'crown-row me' }, img('/assets/ui/icon-crown.png'), myCrowns),
    h('div', { class: 'who me' }, h('span', { class: 'dot' }), flag(state.country), state.name),
  );

  // ---------------------------------------------------------------- deck bar (bottom centre)
  const nextSlot = h('div', { class: 'slot' });
  const cardEls = [0, 1, 2, 3].map((i) => h('div', { class: 'hand-card interactive', onpointerdown: (e) => startDrag(e, i) }));
  const elixirFill = h('div', { class: 'elixir-fill' });
  const elixirCount = h('span', { class: 'count' }, '5');
  const deckBar = h(
    'div',
    { class: 'hand wood panel' },
    h('div', { class: 'hand-cards' }, cardEls, h('div', { class: 'next-card' }, nextSlot, 'Next')),
    h(
      'div',
      { class: 'elixir-bar' },
      img('/assets/ui/elixir.png'),
      elixirCount,
      h('div', { class: 'elixir-track' }, elixirFill, h('div', { class: 'elixir-ticks' }, Array.from({ length: MAX_ELIXIR }, () => h('div')))),
      h('span', { class: 'max' }, `Max: ${MAX_ELIXIR}`),
    ),
  );

  // ---------------------------------------------------------------- side widgets
  let pop = null;
  const closePop = () => {
    pop?.remove();
    pop = null;
  };
  const gearBtn = h('button', { class: 'btn side-btn', title: 'Settings', onclick: (e) => (e.stopPropagation(), togglePop()) }, icon('gear'));
  const utility = h('div', { class: 'utility-col wood panel', onpointerdown: (e) => e.stopPropagation() }, gearBtn, muteButton(), fullscreenButton());
  const togglePop = () => {
    sfx.click();
    if (pop) return closePop();
    pop = h('div', { class: 'popover wood panel utility-pop', onpointerdown: (e) => e.stopPropagation() }, settingsBody(engine));
    root.append(pop);
  };

  const menuBtn = h('button', { class: 'btn menu-btn', onclick: () => (sfx.click(), confirmMenu()) }, 'Menu');
  const ping = pingPill();
  const lb = leaderboardPanel({ tabs: ['wins'], compact: true });

  const root = h(
    'div',
    { class: 'hud battle' },
    h('div', { class: 'ping-row' }, ping, menuBtn),
    status,
    lb,
    utility,
    chat.el,
    deckBar,
    mediaBox(),
  );

  function confirmMenu() {
    if (session.view()?.over) return onMenu();
    const box = h(
      'div',
      { class: 'backdrop' },
      h(
        'div',
        { class: 'modal wood confirm-modal' },
        h('h3', { class: 'title' }, 'Leave the match?'),
        h('p', {}, 'Leaving now counts as a forfeit and a loss.'),
        h(
          'div',
          { class: 'confirm-row' },
          h('button', { class: 'btn', onclick: () => (sfx.click(), box.remove()) }, 'Keep fighting'),
          h('button', { class: 'btn gold', onclick: () => (sfx.click(), box.remove(), onMenu(true)) }, 'Forfeit'),
        ),
      ),
    );
    app().append(box);
  }

  // ---------------------------------------------------------------- per-frame
  let handKey = '';
  let lastText = '';
  function tick() {
    const v = session.view();
    if (!v) return;
    last = v;
    const me = v.me;
    const key = me.hand.join() + me.next;
    if (key !== handKey) {
      handKey = key;
      me.hand.forEach((id, i) => {
        const card = CARD_BY_ID[id];
        cardEls[i].replaceChildren(img(cardImg(id), 'art', card.name), elixirBadge(card.cost));
        cardEls[i].title = card.name;
      });
      if (me.next) nextSlot.replaceChildren(img(cardImg(me.next)), elixirBadge(CARD_BY_ID[me.next].cost));
    }
    elixirFill.style.width = `${(me.elixir / MAX_ELIXIR) * 100}%`;
    elixirCount.textContent = Math.floor(me.elixir);
    me.hand.forEach((id, i) => {
      cardEls[i].classList.toggle('poor', CARD_BY_ID[id].cost > me.elixir);
      cardEls[i].classList.toggle('selected', selected === i);
    });
    myCrowns.textContent = me.crowns;
    oppCrowns.textContent = v.opp.crowns;
    const text = fmtTime(v.time);
    if (text !== lastText) {
      lastText = text;
      timeEl.textContent = text;
      timeLbl.textContent = v.overtime ? 'Overtime!' : 'Time left:';
      timeBox.classList.toggle('overtime', v.overtime);
      x2.classList.toggle('hidden', !v.doubleElixir);
    }
  }

  // ---------------------------------------------------------------- deploy input
  const overCanvas = (x, y) => document.elementFromPoint(x, y)?.id === 'scene';

  function tryDeploy(index, clientX, clientY) {
    const tile = engine.pickTile(clientX, clientY);
    if (!tile || !last) return false;
    const card = CARD_BY_ID[last.me.hand[index]];
    if (card.cost > last.me.elixir) {
      toast(PLAY_ERRORS.elixir, true);
      return false;
    }
    if (!view.canDeploy(tile.x, tile.y)) {
      toast(PLAY_ERRORS.zone, true);
      return false;
    }
    const err = session.play(index, tile.x, tile.y);
    if (err) toast(PLAY_ERRORS[err] ?? err, true);
    return !err;
  }
  session.onPlayError = (reason) => toast(PLAY_ERRORS[reason] ?? reason, true);

  function startDrag(e, i) {
    if (!last || last.over) return;
    e.preventDefault();
    drag = { i, id: last.me.hand[i], x0: e.clientX, y0: e.clientY, moved: false, ghost: null };
    view.showZones();
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
    const tile = onArena && engine.pickTile(e.clientX, e.clientY);
    if (tile) view.setPreview(drag.id, tile.x, tile.y);
    else view.setPreview(null);
  }

  function onDragEnd(e) {
    window.removeEventListener('pointermove', onDragMove);
    const d = drag;
    drag = null;
    if (!d) return;
    d.ghost?.remove();
    cardEls[d.i].classList.remove('dragging');
    view.setPreview(null);
    if (d.moved) {
      view.hideZones();
      selected = null;
      if (overCanvas(e.clientX, e.clientY)) tryDeploy(d.i, e.clientX, e.clientY);
      return;
    }
    // A tap selects the card; the next tap on the arena deploys it.
    sfx.click();
    selected = selected === d.i ? null : d.i;
    if (selected == null) view.hideZones();
  }

  function onCanvasDown(e) {
    closePop();
    if (selected == null || !last || last.over) return;
    if (tryDeploy(selected, e.clientX, e.clientY)) {
      selected = null;
      view.hideZones();
    }
  }
  function onCanvasMove(e) {
    if (selected == null || drag || !last) return;
    const tile = engine.pickTile(e.clientX, e.clientY);
    if (tile) view.setPreview(last.me.hand[selected], tile.x, tile.y);
  }
  const onKey = (e) => {
    if (document.activeElement?.tagName === 'INPUT') return;
    const n = Number(e.key);
    if (n >= 1 && n <= 4) {
      selected = selected === n - 1 ? null : n - 1;
      if (selected == null) view.hideZones();
      else view.showZones();
    }
    if (e.key === 'Escape') {
      selected = null;
      view.hideZones();
    }
  };
  engine.canvas.addEventListener('pointerdown', onCanvasDown);
  engine.canvas.addEventListener('pointermove', onCanvasMove);
  window.addEventListener('keydown', onKey);

  function toast(text, small = false) {
    const el = h('div', { class: `toast${small ? ' small' : ''}` }, text);
    root.append(el);
    setTimeout(() => el.remove(), 1600);
  }

  const unsub = engine.onUpdate(tick);
  tick();

  return {
    el: root,
    toast,
    setOppOnline(online) {
      oppStatus.classList.toggle('hidden', online);
    },
    destroy() {
      unsub();
      engine.canvas.removeEventListener('pointerdown', onCanvasDown);
      engine.canvas.removeEventListener('pointermove', onCanvasMove);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointermove', onDragMove);
      drag?.ghost?.remove();
      ping.destroy();
      lb.destroy();
      root.remove();
    },
  };
}

// ------------------------------------------------------------------ post-match

const fmtDuration = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function crownStrip(n, team) {
  return h('div', { class: `crown-strip ${team}` }, [0, 1, 2].map((i) => img('/assets/ui/icon-crown.png', i < n ? 'on' : 'off')));
}

function deployedList(title, counts, cls) {
  const rows = Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1]);
  return h(
    'div',
    { class: `deployed ${cls}` },
    h('div', { class: 'deployed-head' }, title),
    h(
      'div',
      { class: 'deployed-body scroll' },
      rows.length
        ? rows.map(([id, n]) => h('div', { class: 'deployed-row' }, img(cardImg(id), 'icon'), h('span', { class: 'nm' }, CARD_BY_ID[id].name), h('span', { class: 'ct' }, `x${n}`)))
        : h('div', { class: 'empty' }, 'Nothing deployed'),
    ),
  );
}

export function showResult(r, { onPlayAgain, onMenu }) {
  const title = { win: 'VICTORY', loss: 'DEFEAT', draw: 'DRAW' }[r.result];
  const close = (fn) => () => {
    sfx.click();
    backdrop.remove();
    fn();
  };
  const backdrop = h(
    'div',
    { class: 'backdrop' },
    h(
      'div',
      { class: 'modal result-modal wood' },
      h('h2', { class: r.result }, title),
      h('div', { class: 'score-row' }, crownStrip(r.myCrowns, 'blue'), h('span', { class: 'score' }, h('b', { class: 'blue' }, r.myCrowns), ' - ', h('b', { class: 'red' }, r.enemyCrowns)), crownStrip(r.enemyCrowns, 'red')),
      h(
        'div',
        { class: 'result-stats' },
        h('span', {}, 'Duration ', h('b', {}, fmtDuration(r.duration))),
        h('span', {}, 'Cards played ', h('b', {}, r.cardsPlayed)),
        h('span', {}, 'Total cost ', h('b', {}, r.totalCost)),
        h('span', {}, 'Tower dmg ', h('b', {}, r.towerDamage)),
      ),
      h('div', { class: 'deployed-cols' }, deployedList('YOU DEPLOYED', r.myDeployed, 'you'), deployedList('OPPONENT DEPLOYED', r.oppDeployed, 'opp')),
      h('div', { class: 'result-actions' }, h('button', { class: 'btn gold', onclick: close(onPlayAgain) }, 'PLAY AGAIN'), h('button', { class: 'btn', onclick: close(onMenu) }, 'MENU')),
    ),
  );
  app().append(backdrop);
}
