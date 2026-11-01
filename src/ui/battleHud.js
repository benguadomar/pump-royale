import { h, img, app, icon } from './dom.js';
import { elixirBadge } from './cards.js';
import { pingPill, leaderboardPanel, mediaBox, settingsBody, muteButton, fullscreenButton, flag } from './widgets.js';
import { sfx } from '../audio.js';
import { state } from '../state.js';
import { CARD_BY_ID, cardImg } from '../data/cards.js';
import { MAX_ELIXIR } from '../sim/constants.js';
import { EMOTES, EMOTE_IDS, EMOTE_COOLDOWN_MS, emoteImg } from '../data/emotes.js';

const DRAG_THRESHOLD = 8;
const EMOTE_SHOW_MS = 2800;
const PLAY_ERRORS = { elixir: 'Not enough elixir!', zone: "Can't deploy there", card: 'Card already played', over: 'Match is over', replay: 'Watching a replay', spectate: 'You are spectating', rate: 'Slow down!' };

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
    h('div', { class: 'who me' }, h('span', { class: 'dot' }), flag(session.spectator?.players[0].country ?? state.country), session.spectator?.players[0].name ?? state.name),
  );

  // ---------------------------------------------------------------- deck bar (bottom centre)
  const nextSlot = h('div', { class: 'slot' });
  const cardEls = [0, 1, 2, 3].map((i) => h('div', { class: 'hand-card interactive', onpointerdown: (e) => startDrag(e, i) }));
  const elixirFill = h('div', { class: 'elixir-fill' });
  const elixirDrain = h('div', { class: 'elixir-drain' });
  const elixirCount = h('span', { class: 'count' }, '5');
  const emoteBtn = h(
    'button',
    { class: 'emote-btn', title: 'Emotes', onpointerdown: (e) => e.stopPropagation(), onclick: (e) => (e.stopPropagation(), toggleEmotes()) },
    icon('emote'),
  );
  const deckBar = h(
    'div',
    { class: 'hand wood panel' },
    h('div', { class: 'hand-cards' }, h('div', { class: 'emote-col' }, emoteBtn), cardEls, h('div', { class: 'next-card' }, nextSlot, 'Next')),
    h(
      'div',
      { class: 'elixir-bar' },
      img('/assets/ui/elixir.png'),
      elixirCount,
      h('div', { class: 'elixir-track' }, elixirFill, elixirDrain, h('div', { class: 'elixir-ticks' }, Array.from({ length: MAX_ELIXIR }, () => h('div')))),
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
    session.mode === 'replay' && replayBar(session),
    session.mode === 'spectate' && liveBar(session),
  );

  // ---------------------------------------------------------------- emotes
  let emotePop = null;
  let lastEmoteAt = -Infinity;
  const bubbles = { me: null, opp: null };
  const closeEmotes = () => {
    emotePop?.remove();
    emotePop = null;
  };
  function toggleEmotes() {
    sfx.click();
    if (emotePop) return closeEmotes();
    closePop();
    emotePop = h(
      'div',
      { class: 'emote-picker wood panel', onpointerdown: (e) => e.stopPropagation() },
      EMOTES.map((em) => h('button', { class: 'emote-tile', title: em.name, onclick: () => sendEmote(em.id) }, img(emoteImg(em.id), '', em.name))),
    );
    deckBar.append(emotePop);
  }
  function sendEmote(id) {
    closeEmotes();
    const now = performance.now();
    if (now - lastEmoteAt < EMOTE_COOLDOWN_MS) return toast('Wait a moment...', true);
    lastEmoteAt = now;
    showEmote(id, 'me');
    session.emote?.(id);
  }
  /** Pops the emote up above the sender's King Tower; a new one replaces the old. */
  function showEmote(id, side) {
    if (!EMOTE_IDS.has(id)) return;
    bubbles[side]?.el.remove();
    const el = h('div', { class: `emote-bubble ${side}` }, img(emoteImg(id)));
    root.append(el);
    bubbles[side] = { el, until: performance.now() + EMOTE_SHOW_MS };
    placeBubbles();
    if (side === 'me') sfx.open();
    else sfx.chat();
  }
  function placeBubbles() {
    const a = app();
    const scale = a.getBoundingClientRect().width / a.offsetWidth || 1;
    for (const side of ['me', 'opp']) {
      const b = bubbles[side];
      if (!b) continue;
      if (performance.now() > b.until) {
        b.el.remove();
        bubbles[side] = null;
        continue;
      }
      const p = engine.tileToScreen(9, side === 'me' ? 3 : 29, 7.2);
      b.el.style.left = `${p.x / scale}px`;
      b.el.style.top = `${p.y / scale}px`;
    }
  }
  session.onEmote = (id) => showEmote(id, 'opp');

  function confirmMenu() {
    if (session.view()?.over || session.mode === 'replay' || session.mode === 'spectate') return onMenu();
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
    placeBubbles();
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
    const full = me.elixir >= MAX_ELIXIR - 0.001;
    if (full && !deckBar.classList.contains('full')) sfx.elixirFull();
    deckBar.classList.toggle('full', full);
    let readied = false;
    me.hand.forEach((id, i) => {
      const poor = CARD_BY_ID[id].cost > me.elixir;
      const el = cardEls[i];
      if (!poor && el.classList.contains('poor')) {
        // Just became affordable: a little pop.
        el.classList.remove('ready-pop');
        void el.offsetWidth;
        el.classList.add('ready-pop');
        readied = true;
      }
      el.classList.toggle('poor', poor);
      el.classList.toggle('selected', selected === i);
    });
    if (readied) sfx.cardReady();
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

  /** Tile under the pointer, snapped to the centre of its grid cell. */
  function pickSnapped(clientX, clientY) {
    const tile = engine.pickTile(clientX, clientY);
    return tile && { x: Math.floor(tile.x) + 0.5, y: Math.floor(tile.y) + 0.5 };
  }

  function drainElixir(cost) {
    const after = last.me.elixir - cost;
    elixirDrain.classList.remove('go');
    elixirDrain.style.left = `${(Math.max(0, after) / MAX_ELIXIR) * 100}%`;
    elixirDrain.style.width = `${(cost / MAX_ELIXIR) * 100}%`;
    void elixirDrain.offsetWidth;
    elixirDrain.classList.add('go');
    sfx.drain();
  }

  function tryDeploy(index, clientX, clientY) {
    const tile = pickSnapped(clientX, clientY);
    if (!tile || !last) return false;
    const card = CARD_BY_ID[last.me.hand[index]];
    if (card.cost > last.me.elixir) {
      toast(PLAY_ERRORS.elixir, true);
      return false;
    }
    if (!view.canDeploy(tile.x, tile.y, card.id)) {
      toast(PLAY_ERRORS.zone, true);
      return false;
    }
    const err = session.play(index, tile.x, tile.y);
    if (err) toast(PLAY_ERRORS[err] ?? err, true);
    else drainElixir(card.cost);
    return !err;
  }
  session.onPlayError = (reason) => toast(PLAY_ERRORS[reason] ?? reason, true);

  function startDrag(e, i) {
    if (!last || last.over) return;
    e.preventDefault();
    drag = { i, id: last.me.hand[i], x0: e.clientX, y0: e.clientY, moved: false, ghost: null };
    view.showZones(drag.id);
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
    const tile = onArena && pickSnapped(e.clientX, e.clientY);
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
    sfx.select();
    selected = selected === d.i ? null : d.i;
    if (selected == null) view.hideZones();
  }

  function onCanvasDown(e) {
    closePop();
    closeEmotes();
    if (selected == null || !last || last.over) return;
    if (tryDeploy(selected, e.clientX, e.clientY)) {
      selected = null;
      view.hideZones();
    }
  }
  function onCanvasMove(e) {
    if (selected == null || drag || !last) return;
    const tile = pickSnapped(e.clientX, e.clientY);
    if (tile) view.setPreview(last.me.hand[selected], tile.x, tile.y);
  }
  const onKey = (e) => {
    if (document.activeElement?.tagName === 'INPUT') return;
    const n = Number(e.key);
    if (n >= 1 && n <= 4) {
      selected = selected === n - 1 ? null : n - 1;
      if (selected == null) view.hideZones();
      else view.showZones(last?.me.hand[selected]);
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

/** Replay controls: who it was against and playback speed. */
function replayBar(session) {
  const speeds = [1, 2, 4].map((n) =>
    h(
      'button',
      {
        class: `btn replay-speed${n === 1 ? ' on' : ''}`,
        onclick: (e) => {
          session.speed = n;
          for (const b of e.currentTarget.parentElement.querySelectorAll('.replay-speed')) b.classList.toggle('on', b === e.currentTarget);
        },
      },
      `${n}x`,
    ),
  );
  return h('div', { class: 'replay-bar wood panel interactive' }, h('span', { class: 'rec' }), h('b', {}, 'REPLAY'), h('span', {}, `vs ${session.oppName}`), speeds);
}

/** Spectator banner: both players (blue is player 0, whose side we watch from). */
function liveBar(session) {
  const [a, b] = session.spectator.players;
  return h('div', { class: 'replay-bar live-bar wood panel interactive' }, h('span', { class: 'rec' }), h('b', {}, 'LIVE'), h('span', { class: 'blue-name' }, `${a.name} (${a.trophies})`), h('span', { class: 'dim' }, 'vs'), h('span', { class: 'red-name' }, `${b.name} (${b.trophies})`));
}

const CHEST_LABEL = { wooden: 'Wooden', silver: 'Silver', gold: 'Golden', magical: 'Magical' };

/** Rewards row: trophies, XP, pass XP, chest, new arena — filled in once the server answers. */
function rewardsBody(summary) {
  if (!summary) return [h('span', { class: 'dim' }, 'Rewards unavailable — the server did not confirm this match.')];
  const sign = summary.delta > 0 ? '+' : '';
  return [
    h('span', { class: `trophy-delta ${summary.delta >= 0 ? 'up' : 'down'}` }, img('/assets/ui/icon-trophy.png'), `${sign}${summary.delta}`, h('small', {}, ` → ${summary.trophies}`)),
    h('span', {}, h('b', {}, `+${summary.xp}`), ' XP'),
    summary.passXp > 0 && h('span', {}, h('b', {}, `+${summary.passXp}`), ' Pass XP'),
    summary.chest && h('span', { class: `chest-won chest-${summary.chest}` }, `${CHEST_LABEL[summary.chest]} Chest!`),
    summary.chestLost && h('span', { class: 'dim' }, 'Chest slots full — no chest'),
    summary.newArena && h('span', { class: 'new-arena' }, 'New arena unlocked!'),
  ];
}

export function showResult(r, { onPlayAgain, onMenu, onRematch, replay = false, ranked = false, note: noteText }) {
  const title = { win: 'VICTORY', loss: 'DEFEAT', draw: 'DRAW' }[r.result];
  const close = (fn) => () => {
    sfx.click();
    backdrop.remove();
    fn();
  };
  const note = noteText ?? (ranked ? 'Calculating rewards…' : replay ? 'Replay — no rewards.' : 'Unranked match (offline) — no rewards.');
  const rematchBtn =
    onRematch &&
    h('button', {
      class: 'btn rematch-btn',
      onclick: () => {
        sfx.click();
        rematchBtn.disabled = true;
        rematchBtn.textContent = 'Waiting for opponent…';
        onRematch();
      },
    }, 'REMATCH');
  const rewards = h('div', { class: 'result-rewards inset' }, h('span', { class: 'dim' }, note));
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
      rewards,
      h('div', { class: 'deployed-cols' }, deployedList('YOU DEPLOYED', r.myDeployed, 'you'), deployedList('OPPONENT DEPLOYED', r.oppDeployed, 'opp')),
      h('div', { class: 'result-actions' }, !replay && onPlayAgain && h('button', { class: 'btn gold', onclick: close(onPlayAgain) }, 'PLAY AGAIN'), rematchBtn, h('button', { class: 'btn', onclick: close(onMenu) }, 'MENU')),
    ),
  );
  app().append(backdrop);
  return {
    setRewards(summary) {
      rewards.replaceChildren(...rewardsBody(summary).filter(Boolean));
    },
    /** 'offered' (opponent asked), 'expired' (window closed / opponent left). */
    setRematch(stateName) {
      if (!rematchBtn) return;
      if (stateName === 'offered' && !rematchBtn.disabled) rematchBtn.textContent = 'REMATCH? Opponent is in!';
      if (stateName === 'offered') rematchBtn.classList.add('gold');
      if (stateName === 'expired') {
        rematchBtn.disabled = true;
        rematchBtn.textContent = 'Rematch unavailable';
      }
    },
    close() {
      backdrop.remove();
    },
  };
}
