import { h, img } from './dom.js';
import { openModal } from './modal.js';
import { toastMsg } from './widgets.js';
import { sfx } from '../audio.js';
import { net } from '../net.js';
import { CARD_BY_ID, cardImg } from '../data/cards.js';
import { CHESTS, CHEST_GEMS, HOUR_MS, hourKey, upgradeCost, MAX_CARD_LEVEL } from '../data/economy.js';
import { econ, live, fmtSecs, showLoot } from './progress.js';

// Like every progression screen, the shop only shows server prices and asks the server to buy.

const CHEST_ORDER = ['wooden', 'silver', 'gold', 'magical'];
const CONFIRM_MS = 3000;

export function openShop(engine) {
  const body = h('div', { class: 'shop scroll' });
  let armed = null;
  let armedTimer = 0;
  let refreshing = 0;
  const timerEls = new Set();

  const buyChest = async (type) => {
    sfx.click();
    if (armed !== type) {
      armed = type;
      clearTimeout(armedTimer);
      armedTimer = setTimeout(() => ((armed = null), net.profile && rerender()), CONFIRM_MS);
      return rerender();
    }
    armed = null;
    const res = await econ({ t: 'chest-buy', type });
    if (!res) return;
    close();
    showLoot(engine, res.loot);
  };

  const buyOffer = async (slot, hour) => {
    sfx.click();
    const res = await econ({ t: 'shop-buy', slot, hour });
    if (res) toastMsg(`+${res.qty} ${CARD_BY_ID[res.card].name} card${res.qty > 1 ? 's' : ''} for ${res.cost} gold`);
  };

  const chestTile = (p, type) => {
    const def = CHESTS[type];
    const price = CHEST_GEMS[type];
    const poor = p.gems < price;
    return h(
      'div',
      { class: `shop-chest inset chest-${type}` },
      h('div', { class: 'chest-icon' }),
      h('b', {}, def.name),
      h('small', { class: 'dim' }, `${def.cards} cards · ${def.gold[0]}–${def.gold[1]} gold`),
      h(
        'button',
        { class: `btn gold buy${armed === type ? ' armed' : ''}`, disabled: poor, title: poor ? 'Not enough gems' : 'Opens right away', onclick: () => buyChest(type) },
        armed === type ? 'Confirm?' : [h('span', { class: 'gem' }), price],
      ),
    );
  };

  const offerTile = (p, o, slot) => {
    const card = CARD_BY_ID[o.card];
    if (!card) return null;
    const own = p.cards[o.card];
    const left = o.limit - (p.shop.bought[slot] ?? 0);
    const maxed = own.level >= MAX_CARD_LEVEL;
    const need = upgradeCost(card, own.level)?.shards;
    const poor = p.gold < o.price;
    return h(
      'div',
      { class: `card-tile shop-offer rarity-${o.rarity.toLowerCase()}${left <= 0 ? ' sold' : ''}` },
      h('span', { class: 'shop-qty' }, `x${o.qty}`),
      img(cardImg(o.card), 'art'),
      h('div', { class: 'name' }, card.name),
      h('small', { class: 'shop-rarity' }, o.rarity),
      h('small', { class: 'dim' }, maxed ? 'Max level' : `Lv ${own.level} · ${own.shards}/${need}`),
      h(
        'button',
        { class: 'btn gold buy', disabled: left <= 0 || poor || maxed, title: poor ? 'Not enough gold' : '', onclick: () => buyOffer(slot, p.shop.hour) },
        left <= 0 ? 'Sold out' : [h('span', { class: 'coin' }), o.price],
      ),
      h('small', { class: 'shop-left' }, `${Math.max(0, left)}/${o.limit} left`),
    );
  };

  const timerText = (p) => `New cards in ${fmtSecs(((p.shop?.hour ?? hourKey()) + 1) * HOUR_MS / 1000 - Date.now() / 1000)}`;

  const build = (p) => {
    timerEls.clear();
    if (!p) return h('p', {}, 'Connect to the server to use the shop.');
    const timer = h('span', { class: 'shop-timer' }, timerText(p));
    timerEls.add(timer);
    return [
      h('div', { class: 'shop-head' }, h('h3', { class: 'title' }, 'CHESTS'), h('span', { class: 'dim small' }, 'Paid with gems · opened instantly')),
      h('div', { class: 'shop-chests' }, CHEST_ORDER.map((t) => chestTile(p, t))),
      h('div', { class: 'shop-head' }, h('h3', { class: 'title' }, 'HOURLY CARDS'), timer),
      h('div', { class: 'shop-offers' }, (p.shop?.offers ?? []).map((o, i) => offerTile(p, o, i))),
    ];
  };

  const rerender = () => body.replaceChildren(...[build(net.profile)].flat().filter(Boolean));
  const off = live(body, build);
  const tick = setInterval(() => {
    const p = net.profile;
    if (!p) return;
    for (const el of timerEls) el.textContent = timerText(p);
    if (p.shop && hourKey() > p.shop.hour && Date.now() - refreshing > 5000) {
      refreshing = Date.now();
      econ({ t: 'shop' });
    }
  }, 1000);
  const close = openModal({
    cls: 'shop-modal',
    title: 'SHOP',
    headExtra: [h('div', { class: 'res-pill gold' }, h('span', { class: 'coin' }), h('b', { class: 'shop-gold' })), h('div', { class: 'res-pill gems' }, h('span', { class: 'gem' }), h('b', { class: 'shop-gems' }))],
    body,
    onClose: () => (off(), clearInterval(tick), clearTimeout(armedTimer), offWallet()),
  });
  const wallet = () => {
    const modal = body.closest('.modal');
    if (!modal || !net.profile) return;
    modal.querySelector('.shop-gold').textContent = net.profile.gold;
    modal.querySelector('.shop-gems').textContent = net.profile.gems;
  };
  const offWallet = net.on('profile', wallet);
  wallet();
}
