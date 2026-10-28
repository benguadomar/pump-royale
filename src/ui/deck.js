import { h, img } from './dom.js';
import { openModal } from './modal.js';
import { cardTile } from './cards.js';
import { sfx } from '../audio.js';
import { state, save } from '../state.js';
import { CARDS, CARD_BY_ID } from '../data/cards.js';

export const avgElixir = (deck) => (deck.reduce((s, id) => s + CARD_BY_ID[id].cost, 0) / deck.length).toFixed(1);

/**
 * Tap a deck slot then a collection card to swap it in (or the other way round).
 * Tapping two deck slots swaps their positions.
 */
export function openDeck() {
  let slot = null;
  let pick = null;

  const avg = h('span', {});
  const deckGrid = h('div', { class: 'deck-grid' });
  const collection = h('div', { class: 'collection-grid' });

  const apply = () => {
    if (slot == null || pick == null) return;
    const deck = state.deck;
    const existing = deck.indexOf(pick);
    if (existing >= 0) [deck[slot], deck[existing]] = [deck[existing], deck[slot]];
    else deck[slot] = pick;
    slot = pick = null;
    save();
  };

  const render = () => {
    avg.textContent = avgElixir(state.deck);
    deckGrid.replaceChildren(
      ...state.deck.map((id, i) =>
        cardTile(CARD_BY_ID[id], {
          selected: slot === i,
          onclick: () => {
            sfx.click();
            if (slot != null && slot !== i && pick == null) {
              pick = state.deck[i];
              apply();
            } else {
              slot = slot === i ? null : i;
              apply();
            }
            render();
          },
        }),
      ),
    );
    collection.replaceChildren(
      ...CARDS.map((c) =>
        cardTile(c, {
          inDeck: state.deck.includes(c.id),
          selected: pick === c.id,
          onclick: () => {
            sfx.click();
            pick = pick === c.id ? null : c.id;
            apply();
            render();
          },
        }),
      ),
    );
  };
  render();

  openModal({
    cls: 'deck-modal',
    title: 'BATTLE DECK',
    iconSrc: '/assets/ui/icon-deck.png',
    headExtra: h('div', { class: 'avg-elixir inset', title: 'Average elixir cost' }, img('/assets/ui/elixir.png'), avg),
    body: [
      h('div', { class: 'deck-area inset' }, deckGrid, h('div', { class: 'deck-hint' }, 'Tap a deck slot, then tap a card below to swap it in.')),
      h('div', { class: 'section-title' }, 'COLLECTION'),
      h('div', { class: 'collection-wrap scroll' }, collection),
    ],
  });
}
