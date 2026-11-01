import { h, img } from './dom.js';
import { openModal } from './modal.js';
import { sfx } from '../audio.js';
import { CARDS, TOWERS, cardImg } from '../data/cards.js';
import { upgradeCost, MAX_CARD_LEVEL, START_LEVEL } from '../data/economy.js';
import { net } from '../net.js';
import { econ } from './progress.js';

const RARITY_ORDER = { Common: 0, Rare: 1, Epic: 2, Legendary: 3 };
const owned = (id) => net.profile?.cards[id] ?? { level: START_LEVEL, shards: 0 };

/** Level badge plus a shard bar toward the next level (green when an upgrade is ready). */
function levelBar(card) {
  const own = owned(card.id);
  const cost = upgradeCost(card, own.level);
  if (!cost) return h('div', { class: 'lvl-bar max' }, h('span', {}, `Lv ${own.level} · MAX`));
  const ready = own.shards >= cost.shards;
  return h('div', { class: `lvl-bar${ready ? ' ready' : ''}` }, h('div', { class: 'lvl-fill', style: { width: `${Math.min(100, Math.round((own.shards / cost.shards) * 100))}%` } }), h('span', {}, `Lv ${own.level} · ${own.shards}/${cost.shards}`));
}

const ELIXIR = '/assets/ui/elixir.png';
const BAR_MAX = { hp: 4200, damage: 820, dps: 460, hitSpeed: 2.0, range: 7.5 };

export function elixirBadge(cost) {
  return h('div', { class: 'elixir-badge' }, img(ELIXIR), String(cost));
}

export function cardTile(card, { selected, inDeck, onclick } = {}) {
  return h(
    'div',
    { class: `card-tile interactive rarity-${(card.rarity ?? 'Common').toLowerCase()}${selected ? ' selected' : ''}${inDeck ? ' in-deck' : ''}`, onclick },
    elixirBadge(card.cost),
    img(cardImg(card.id), 'art', card.name),
    inDeck && h('div', { class: 'in-deck-tag' }, 'IN DECK'),
    h('div', { class: 'name' }, card.name),
    net.profile && levelBar(card),
  );
}

export const kindLabel = (card) => `${card.rarity ?? 'Common'} ${card.type}${card.count > 1 ? ` · x${card.count}` : ''}`;

function statRow(label, value, fraction) {
  return h(
    'div',
    { class: 'stat' },
    h('div', { class: 'stat-top' }, h('span', {}, label), h('span', {}, value)),
    h('div', { class: 'stat-bar' }, h('div', { style: { width: `${Math.round(Math.min(1, fraction ?? 0) * 100)}%` } })),
  );
}

function cardStats(card) {
  const rangeVal = card.range === 'Melee' ? 'Melee' : card.range.toFixed(1);
  const rows = [
    statRow('Hitpoints', card.hp, card.hp / BAR_MAX.hp),
    statRow('Damage', card.damage, card.damage / BAR_MAX.damage),
    statRow('Damage / sec', card.dps, card.dps / BAR_MAX.dps),
    statRow('Hit Speed', `${card.hitSpeed.toFixed(1)}s`, card.hitSpeed / BAR_MAX.hitSpeed),
    statRow('Range', rangeVal, card.range === 'Melee' ? 0.1 : card.range / BAR_MAX.range),
    statRow('Move Speed', card.speed ?? '—', 0),
  ];
  if (card.count > 1) rows.push(statRow('Count', `x${card.count}`, 0));
  if (card.splash) rows.push(statRow('Splash', `${card.splash} radius`, 0));
  rows.push(statRow('Targets', card.targets, 0));
  return rows;
}

/** Upgrade button: server-validated; shows the gold price and what is still missing. */
function upgradeRow(card) {
  if (!net.profile) return null;
  const own = owned(card.id);
  const cost = upgradeCost(card, own.level);
  if (!cost || own.level >= MAX_CARD_LEVEL) return h('div', { class: 'upgrade-row' }, h('b', {}, `Level ${own.level} — maxed`));
  const canShards = own.shards >= cost.shards;
  const canGold = net.profile.gold >= cost.gold;
  return h(
    'div',
    { class: 'upgrade-row' },
    h('b', {}, `Level ${own.level}`),
    h('button', { class: 'btn gold', disabled: !canShards || !canGold, onclick: async () => {
      const r = await econ({ t: 'upgrade', card: card.id });
      if (r) sfx.win();
    } }, `Upgrade to ${own.level + 1}`, h('small', {}, h('span', { class: 'coin' }), cost.gold)),
    !canShards && h('span', { class: 'dim' }, `Need ${cost.shards - own.shards} more cards`),
    canShards && !canGold && h('span', { class: 'dim' }, 'Not enough gold'),
  );
}

function detailPanel(card) {
  return [
    h('div', { class: 'portrait' }, img(cardImg(card.id), 'art', card.name), elixirBadge(card.cost)),
    h('div', { class: 'rule' }),
    h('h3', {}, card.name),
    h('div', { class: 'kind' }, kindLabel(card)),
    upgradeRow(card),
    h('p', {}, card.description),
    cardStats(card),
  ];
}

function towerPanel(t) {
  return h(
    'div',
    { class: 'tower-panel inset' },
    img(cardImg(t.id), '', t.name),
    h(
      'div',
      {},
      h('h4', {}, t.name),
      h('p', {}, t.description),
      h(
        'div',
        { class: 'tower-stats' },
        h('div', {}, h('span', {}, 'Hitpoints'), h('b', {}, t.hp)),
        h('div', {}, h('span', {}, 'Damage'), h('b', {}, t.damage)),
        h('div', {}, h('span', {}, 'Damage / sec'), h('b', {}, t.dps)),
        h('div', {}, h('span', {}, 'Hit Speed'), h('b', {}, `${t.hitSpeed.toFixed(1)}s`)),
        h('div', {}, h('span', {}, 'Range'), h('b', {}, t.range.toFixed(1))),
      ),
    ),
  );
}

const SORTS = {
  elixir: (a, b) => a.cost - b.cost,
  rarity: (a, b) => RARITY_ORDER[b.rarity] - RARITY_ORDER[a.rarity] || a.cost - b.cost,
  level: (a, b) => owned(b.id).level - owned(a.id).level || b.cost - a.cost,
  name: (a, b) => a.name.localeCompare(b.name),
};
const FILTERS = {
  all: () => true,
  troops: (c) => c.type === 'Troop',
  buildings: (c) => c.type === 'Building',
};

export function openCards() {
  let selected = CARDS[0].id;
  let sort = 'elixir';
  let filter = 'all';
  const grid = h('div', { class: 'cards-grid scroll inset' });
  const detail = h('div', { class: 'card-detail inset scroll' });
  const chip = (key, label, get, set) =>
    h('button', { class: `btn chip${get() === key ? ' on' : ''}`, onclick: () => (sfx.click(), set(key), render()) }, label);
  const toolbar = h('div', { class: 'cards-toolbar' });

  const render = () => {
    toolbar.replaceChildren(
      h('span', { class: 'dim' }, 'Sort'),
      ...Object.keys(SORTS).map((k) => chip(k, k[0].toUpperCase() + k.slice(1), () => sort, (v) => (sort = v))),
      h('span', { class: 'dim sep' }, 'Show'),
      ...Object.keys(FILTERS).map((k) => chip(k, k[0].toUpperCase() + k.slice(1), () => filter, (v) => (filter = v))),
    );
    grid.replaceChildren(
      ...CARDS.filter(FILTERS[filter]).sort(SORTS[sort]).map((c) =>
        cardTile(c, {
          selected: c.id === selected,
          onclick: () => {
            sfx.click();
            selected = c.id;
            render();
          },
        }),
      ),
    );
    detail.replaceChildren(...detailPanel(CARDS.find((c) => c.id === selected)).flat().filter(Boolean));
  };
  render();
  const off = net.on('profile', render);

  openModal({
    cls: 'cards-modal',
    title: 'CARDS',
    iconSrc: '/assets/ui/icon-cards.png',
    body: [
      toolbar,
      h('div', { class: 'cards-body' }, grid, detail),
      h('div', { class: 'section-title' }, 'TOWERS'),
      h('div', { class: 'towers-row' }, towerPanel(TOWERS.princess), towerPanel(TOWERS.king)),
    ],
    onClose: () => off(),
  });
}
