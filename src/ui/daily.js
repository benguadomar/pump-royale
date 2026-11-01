import { h, img } from './dom.js';
import { openModal } from './modal.js';
import { toastMsg, secondsToUtcMidnight } from './widgets.js';
import { econ, rewardText, fmtSecs } from './progress.js';
import { net } from '../net.js';
import { sfx } from '../audio.js';
import { DAILY_REWARDS, dailyStatus } from '../data/economy.js';

const CHEST_IMG = { silver: 'Silver', gold: 'Golden' };

function rewardIcon(r) {
  if (r.gold) return [img('/assets/ui/coin.png', 'daily-icon'), h('b', {}, r.gold)];
  if (r.gems) return [img('/assets/ui/gem.png', 'daily-icon'), h('b', {}, r.gems)];
  return [h('span', { class: `daily-chest ${r.chest}` }, '🎁'), h('b', {}, `${CHEST_IMG[r.chest]} Chest`)];
}

/** The 7-day login calendar: claimed days ticked, today's reward glowing until claimed. */
export function openDaily() {
  const body = h('div', { class: 'daily-body' });
  const render = () => {
    const p = net.profile;
    if (!p) return body.replaceChildren(h('p', { class: 'dim' }, 'Connecting…'));
    const st = dailyStatus(p);
    const claimedUpTo = st.claimable ? st.day - 1 : st.day;
    const tiles = DAILY_REWARDS.map((r, i) => {
      const day = i + 1;
      const done = day <= claimedUpTo;
      const today = st.claimable && day === st.day;
      return h('div', { class: `daily-tile inset${done ? ' done' : ''}${today ? ' today' : ''}` }, h('small', {}, `DAY ${day}`), ...rewardIcon(r), done && h('span', { class: 'daily-tick' }, '✓'));
    });
    const claim = st.claimable
      ? h('button', {
          class: 'btn gold daily-claim',
          onclick: async () => {
            claim.disabled = true;
            const res = await econ({ t: 'daily-claim' });
            if (!res) return (claim.disabled = false);
            sfx.win();
            toastMsg(`Day ${res.day} reward: ${rewardText(res.reward)}${res.reward.chestLost ? ' (chest slots full — chest lost)' : ''}`);
            render();
          },
        }, `CLAIM DAY ${st.day}`)
      : h('div', { class: 'daily-next dim' }, `Come back in ${fmtSecs(secondsToUtcMidnight())} for day ${(st.day % DAILY_REWARDS.length) + 1}`);
    body.replaceChildren(
      h('p', { class: 'dim' }, 'Log in every day: the rewards grow until a Golden Chest on day 7. Miss a day and the streak starts again.'),
      h('div', { class: 'daily-grid' }, tiles),
      claim,
    );
  };
  const off = net.on('profile', render);
  render();
  return openModal({ cls: 'daily-modal', title: 'DAILY REWARD', onClose: off, body });
}

export const dailyClaimable = () => Boolean(net.profile && dailyStatus(net.profile).claimable);

/** Ladder payouts the server credited while the player was away, shown once. */
export function showNotices() {
  const list = net.profile?.notices ?? [];
  if (!list.length) return false;
  const rows = list.map((n) => h('div', { class: 'ladder-reward inset' }, h('b', {}, `#${n.rank}`), h('span', {}, `on ${n.day}`), h('span', {}, rewardText(n.reward))));
  openModal({
    cls: 'ladder-modal',
    title: 'LADDER REWARD',
    iconSrc: '/assets/ui/icon-trophy.png',
    body: [h('p', {}, 'You finished in the top 10 of the trophy ladder! Your reward is already in your account:'), ...rows],
    onClose: () => econ({ t: 'notice-ack' }),
  });
  return true;
}
