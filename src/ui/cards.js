import { h, img } from './dom.js';
import { openModal } from './modal.js';
import { sfx } from '../audio.js';
import { CARDS, TOWERS, cardImg, isSpell, TOWER_SPELL_FACTOR } from '../data/cards.js';

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
  );
}

export const kindLabel = (card) => `${card.rarity ?? 'Common'} ${card.type}${card.air ? ' · Flying' : ''}${card.count > 1 ? ` · x${card.count}` : ''}`;

/** One-line description of a card's special mechanic, if it has one. */
function special(card) {
  const sp = card.spell;
  if (sp?.stun) return `Stuns for ${sp.stun}s`;
  if (sp?.freeze) return `Freezes for ${sp.freeze}s`;
  if (sp?.rage) return `+35% speed for ${sp.rage}s`;
  if (sp?.spawn) return `Spawns ${sp.spawnCount} Goblins`;
  if (sp?.knockback) return 'Knocks back light troops';
  if (card.spin) return '360° spin attack';
  if (card.charge) return `Charges after ${card.charge} tiles (x2 damage)`;
  if (card.hidden) return 'Hides underground until a target is in range';
  if (card.ramp) return `Ramps ${card.ramp.join(' → ')} damage`;
  if (card.deathDamage) return `Death bomb: ${card.deathDamage} damage`;
  return null;
}

function statRow(label, value, fraction) {
  return h(
    'div',
    { class: 'stat' },
    h('div', { class: 'stat-top' }, h('span', {}, label), h('span', {}, value)),
    h('div', { class: 'stat-bar' }, h('div', { style: { width: `${Math.round(Math.min(1, fraction ?? 0) * 100)}%` } })),
  );
}

function cardStats(card) {
  if (isSpell(card)) {
    const rows = [];
    if (card.damage) {
      rows.push(statRow('Damage', card.damage, card.damage / BAR_MAX.damage));
      rows.push(statRow('Crown Tower Damage', Math.round(card.damage * TOWER_SPELL_FACTOR), (card.damage * TOWER_SPELL_FACTOR) / BAR_MAX.damage));
    }
    rows.push(statRow('Radius', `${card.spell.radius} tiles`, card.spell.radius / 5));
    const fx = special(card);
    if (fx) rows.push(statRow('Effect', fx, 0));
    rows.push(statRow('Targets', card.targets, 0));
    return rows;
  }
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
  const fx = special(card);
  if (fx) rows.push(statRow('Special', fx, 0));
  return rows;
}

function detailPanel(card) {
  return [
    h('div', { class: 'portrait' }, img(cardImg(card.id), 'art', card.name), elixirBadge(card.cost)),
    h('div', { class: 'rule' }),
    h('h3', {}, card.name),
    h('div', { class: 'kind' }, kindLabel(card)),
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

export function openCards() {
  let selected = CARDS[0].id;
  const grid = h('div', { class: 'cards-grid scroll inset' });
  const detail = h('div', { class: 'card-detail inset scroll' });

  const render = () => {
    grid.replaceChildren(
      ...CARDS.map((c) =>
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
    detail.replaceChildren(...detailPanel(CARDS.find((c) => c.id === selected)).flat());
    detail.scrollTop = 0;
  };
  render();

  openModal({
    cls: 'cards-modal',
    title: 'CARDS',
    iconSrc: '/assets/ui/icon-cards.png',
    body: [
      h('div', { class: 'cards-body' }, grid, detail),
      h('div', { class: 'section-title' }, 'TOWERS'),
      h('div', { class: 'towers-row' }, towerPanel(TOWERS.princess), towerPanel(TOWERS.king)),
    ],
  });
}
