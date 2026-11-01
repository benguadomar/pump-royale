import { h, img, app } from './dom.js';
import { openModal } from './modal.js';
import { toastMsg } from './widgets.js';
import { sfx } from '../audio.js';
import { net } from '../net.js';
import { CARD_BY_ID, cardImg } from '../data/cards.js';
import { ARENA_BY_ID } from '../data/arenas.js';
import { CHEST_ICONS, renderChestIcons } from '../render/chests.js';
import {
  CHESTS, gemsToOpen, leagueFor, kingLevel, XP_LEVELS, TROPHY_ROAD, PASS_TIERS, PASS_XP_PER_TIER, passReward, passTier,
} from '../data/economy.js';

// Every screen here only *reads* net.profile (owned by the server) and *asks* the server
// to change it; the server replies with the updated profile.

const CHEST_LABEL = { wooden: 'Wooden', silver: 'Silver', gold: 'Golden', magical: 'Magical' };
const ERRORS = { busy: 'Another chest is already unlocking', gems: 'Not enough gems', gold: 'Not enough gold', shards: 'Not enough cards yet', locked: 'Still locked' };

export const fmtSecs = (s) => {
  s = Math.max(0, Math.ceil(s));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
};

export const rewardText = (r) =>
  [r.gold && `${r.gold} gold`, r.gems && `${r.gems} gems`, r.chest && `${CHEST_LABEL[r.chest]} Chest`, r.pass && `${r.pass} pass XP`].filter(Boolean).join(' + ');

/** Sends an economy request and shows the server's error (if any) as a toast. */
export async function econ(msg) {
  if (!net.connected) {
    toastMsg('Offline — progression needs the server');
    return null;
  }
  const res = await net.request(msg, 'econ', { op: msg.t });
  if (!res) toastMsg('No response from server');
  else if (res.error) toastMsg(ERRORS[res.error] ?? `Can't do that (${res.error})`);
  return res && !res.error ? res : null;
}

/**
 * Re-renders `build()` into `el` whenever the profile changes. Stops by itself once the
 * element has been removed from the page; also returns an explicit unsubscribe.
 */
function live(el, build) {
  let mounted = false;
  const render = () => {
    if (mounted && !el.isConnected) return off();
    el.replaceChildren(...[build(net.profile)].flat().filter(Boolean));
  };
  const off = net.on('profile', render);
  render();
  requestAnimationFrame(() => (mounted = true));
  return off;
}

// ------------------------------------------------------------------ resource bar

export function resourceBar() {
  const el = h('div', { class: 'resource-bar' });
  const off = live(el, (p) => {
    if (!p) return h('span', { class: 'dim' }, 'Connecting…');
    const league = leagueFor(p.trophies);
    const lvl = kingLevel(p.xp);
    const lo = XP_LEVELS[lvl - 1] ?? 0;
    const hi = XP_LEVELS[lvl] ?? lo;
    const frac = hi > lo ? (p.xp - lo) / (hi - lo) : 1;
    return [
      h('button', { class: 'res-pill trophies', title: `${league.name} — open Trophy Road`, onclick: () => (sfx.click(), openTrophyRoad()) }, h('span', { class: 'league-badge', style: { background: league.color } }), img('/assets/ui/icon-trophy.png'), h('b', {}, p.trophies)),
      h('div', { class: 'res-pill level', title: `King level ${lvl}` }, h('span', { class: 'lvl' }, lvl), h('div', { class: 'xp-track' }, h('div', { class: 'xp-fill', style: { width: `${Math.round(frac * 100)}%` } }))),
      h('div', { class: 'res-pill gold', title: 'Gold' }, h('span', { class: 'coin' }), h('b', {}, p.gold)),
      h('div', { class: 'res-pill gems', title: 'Gems' }, h('span', { class: 'gem' }), h('b', {}, p.gems)),
    ];
  });
  return { el, destroy: off };
}

// ------------------------------------------------------------------ chests

/** The rendered 3D chest replaces the CSS-drawn icon once it is ready. */
const chestIconStyle = (type) => {
  const src = CHEST_ICONS.get(type);
  return src ? { background: `url(${src}) center / contain no-repeat`, border: 'none', boxShadow: 'none', width: '58px', height: '50px', margin: '-6px 0 -2px' } : undefined;
};

export function chestSlots(engine) {
  const el = h('div', { class: 'chest-slots' });
  const build = (p) => {
    if (!p) return null;
    const now = Date.now();
    return p.chests.map((c, slot) => {
      if (!c) return h('div', { class: 'chest-slot empty' }, h('span', {}, 'Win to earn a chest'));
      const left = c.unlockAt ? (c.unlockAt - now) / 1000 : null;
      const ready = left != null && left <= 0;
      const status = ready ? 'OPEN!' : left != null ? fmtSecs(left) : `Unlock ${fmtSecs(CHESTS[c.type].unlock)}`;
      return h(
        'button',
        { class: `chest-slot chest-${c.type}${ready ? ' ready' : ''}${left > 0 ? ' unlocking' : ''}`, onclick: () => (sfx.click(), onChest(engine, slot)) },
        h('div', { class: 'chest-icon', style: chestIconStyle(c.type) }),
        h('b', {}, CHEST_LABEL[c.type]),
        h('span', {}, status),
        left > 0 && h('small', { class: 'gem-cost' }, h('span', { class: 'gem' }), gemsToOpen(left)),
      );
    });
  };
  const off = live(el, build);
  renderChestIcons(engine).then(() => el.replaceChildren(...(build(net.profile) ?? [])));
  // Countdowns tick every second without a server round trip.
  const timer = setInterval(() => el.replaceChildren(...(build(net.profile) ?? [])), 1000);
  return { el, destroy: () => (off(), clearInterval(timer)) };
}

async function onChest(engine, slot) {
  const c = net.profile?.chests[slot];
  if (!c) return;
  const left = c.unlockAt ? (c.unlockAt - Date.now()) / 1000 : null;
  if (left != null && left <= 0) return openChest(engine, slot, false);
  if (left == null && !net.profile.chests.some((o) => o?.unlockAt && o.unlockAt > Date.now())) {
    await econ({ t: 'chest-start', slot });
    return;
  }
  const secs = left ?? CHESTS[c.type].unlock;
  const cost = gemsToOpen(secs);
  const close = openModal({
    cls: 'confirm-modal',
    title: `${CHEST_LABEL[c.type]} Chest`,
    body: [
      h('p', {}, left == null ? 'Another chest is unlocking. Open this one right now?' : `Unlocks in ${fmtSecs(secs)}. Open it right now?`),
      h('div', { class: 'confirm-row' }, h('button', { class: 'btn', onclick: () => close() }, 'Wait'), h('button', { class: 'btn gold', onclick: () => (close(), openChest(engine, slot, true)) }, h('span', { class: 'gem' }), `${cost} — Open`)),
    ],
  });
}

/** The chest flies in, bursts open, and the loot cards fly out one by one. */
async function openChest(engine, slot, useGems) {
  const res = await econ({ t: 'chest-open', slot, gems: useGems });
  if (!res) return;
  const { loot } = res;
  const show = engine.showChest(loot.type);
  const stage = h('div', { class: 'loot-stage' });
  const hint = h('div', { class: 'loot-hint title' }, 'TAP TO OPEN');
  const overlay = h('div', { class: 'chest-overlay interactive' }, h('div', { class: 'loot-title title' }, `${CHEST_LABEL[loot.type]} Chest`), stage, hint);
  app().append(overlay);
  sfx.open();
  let step = 'closed';
  const items = [{ gold: loot.gold }, ...Object.entries(loot.cards).map(([id, n]) => ({ id, n }))];
  let i = 0;
  overlay.onclick = async () => {
    if (step === 'closed') {
      step = 'opening';
      hint.textContent = '';
      sfx.king();
      await show.open();
      sfx.win();
      step = 'loot';
      hint.textContent = 'TAP TO CONTINUE';
    }
    if (step !== 'loot') return;
    if (i < items.length) {
      const it = items[i++];
      sfx.cardReady();
      const card = it.id && CARD_BY_ID[it.id];
      stage.append(
        it.gold
          ? h('div', { class: 'loot-card gold-loot' }, h('span', { class: 'coin big' }), h('b', {}, `+${it.gold}`), h('span', {}, 'Gold'))
          : h('div', { class: `loot-card rarity-${(card.rarity ?? 'Common').toLowerCase()}` }, img(cardImg(it.id), 'art'), h('b', {}, `x${it.n}`), h('span', {}, card.name)),
      );
      if (i === items.length) hint.textContent = 'TAP TO COLLECT';
      return;
    }
    show.dispose();
    overlay.remove();
  };
}

// ------------------------------------------------------------------ trophy road

export function openTrophyRoad() {
  const body = h('div', { class: 'road scroll' });
  openModal({ cls: 'road-modal', title: 'TROPHY ROAD', iconSrc: '/assets/ui/icon-trophy.png', body, onClose: () => off() });
  const off = live(body, (p) => {
    if (!p) return h('p', {}, 'Connect to see your road.');
    const league = leagueFor(p.trophies);
    return [
      h('div', { class: 'road-head inset' }, h('span', { class: 'league-badge big', style: { background: league.color } }), h('div', {}, h('b', {}, league.name), h('span', {}, `${p.trophies} trophies · best ${p.bestTrophies}`))),
      ...TROPHY_ROAD.map((s) => {
        const reached = p.bestTrophies >= s.at;
        const claimed = p.road.includes(s.at);
        const arena = s.arena && ARENA_BY_ID[s.arena];
        return h(
          'div',
          { class: `road-step inset${reached ? ' reached' : ''}${claimed ? ' claimed' : ''}` },
          h('div', { class: 'road-at' }, img('/assets/ui/icon-trophy.png'), s.at),
          h('div', { class: 'road-reward' }, arena && h('b', { class: 'road-arena' }, `Arena: ${arena.name}`), h('span', {}, rewardText(s.reward))),
          claimed
            ? h('span', { class: 'dim' }, 'Claimed')
            : h('button', { class: 'btn gold', disabled: !reached, onclick: async () => {
                const r = await econ({ t: 'road-claim', at: s.at });
                if (r) toastMsg(`Claimed ${rewardText(r.reward)}`);
              } }, reached ? 'Claim' : 'Locked'),
        );
      }),
    ];
  });
}

// ------------------------------------------------------------------ quests & pass

export function questsBody() {
  const el = h('div', { class: 'quests' });
  live(el, (p) => {
    if (!p) return h('p', {}, 'Connect to get daily quests.');
    const resetIn = (Date.parse(`${p.quests.day}T00:00:00Z`) + 86400000 - Date.now()) / 1000;
    return [
      h('div', { class: 'popover-title title' }, 'DAILY QUESTS'),
      ...p.quests.list.map((q, i) =>
        h(
          'div',
          { class: `quest inset${q.claimed ? ' claimed' : ''}` },
          h('b', {}, q.text),
          h('div', { class: 'quest-track' }, h('div', { style: { width: `${Math.round((q.progress / q.target) * 100)}%` } }), h('span', {}, `${q.progress}/${q.target}`)),
          h('div', { class: 'quest-foot' }, h('span', { class: 'dim' }, rewardText(q.reward)), q.claimed ? h('span', { class: 'dim' }, 'Done') : h('button', { class: 'btn gold', disabled: q.progress < q.target, onclick: async () => {
            const r = await econ({ t: 'quest-claim', i });
            if (r) toastMsg(`Claimed ${rewardText(r.reward)}`);
          } }, 'Claim')),
        ),
      ),
      h('div', { class: 'dim small' }, `New quests in ${fmtSecs(resetIn)}`),
      h('button', { class: 'btn', onclick: () => (sfx.click(), openPass()) }, 'Season Pass'),
    ];
  });
  return el;
}

export function openPass() {
  const body = h('div', { class: 'pass' });
  openModal({ cls: 'pass-modal', title: 'SEASON PASS', body, onClose: () => off() });
  const off = live(body, (p) => {
    if (!p) return h('p', {}, 'Connect to see the pass.');
    const tier = passTier(p.pass.xp);
    const into = p.pass.xp - tier * PASS_XP_PER_TIER;
    return [
      h('div', { class: 'pass-head inset' }, h('b', {}, `Tier ${tier} / ${PASS_TIERS}`), h('div', { class: 'quest-track' }, h('div', { style: { width: `${tier >= PASS_TIERS ? 100 : Math.round((into / PASS_XP_PER_TIER) * 100)}%` } }), h('span', {}, tier >= PASS_TIERS ? 'MAX' : `${into}/${PASS_XP_PER_TIER} XP`)), h('span', { class: 'dim' }, 'Earn pass XP from crowns, wins and quests')),
      h(
        'div',
        { class: 'pass-grid scroll' },
        Array.from({ length: PASS_TIERS }, (_, i) => {
          const t = i + 1;
          const claimed = p.pass.claimed.includes(t);
          const open = tier >= t;
          return h(
            'button',
            { class: `pass-tier inset${open ? ' open' : ''}${claimed ? ' claimed' : ''}`, disabled: !open || claimed, onclick: async () => {
              const r = await econ({ t: 'pass-claim', tier: t });
              if (r) toastMsg(`Tier ${t}: ${rewardText(r.reward)}`);
            } },
            h('small', {}, `TIER ${t}`),
            h('b', {}, rewardText(passReward(t))),
            h('span', {}, claimed ? '✓' : open ? 'Claim' : '🔒'),
          );
        }),
      ),
    ];
  });
}
