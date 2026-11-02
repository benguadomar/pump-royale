import { h, img } from './dom.js';
import { openModal } from './modal.js';
import { toastMsg, BADGE_COLORS, rankTag } from './widgets.js';
import { fmtSecs } from './progress.js';
import { net } from '../net.js';
import { sfx } from '../audio.js';
import { CARDS, CARD_BY_ID, cardImg } from '../data/cards.js';

const REQUESTABLE = new Set(['Common', 'Rare', 'Epic']);
const ERRORS = { 'in-clan': 'Leave your clan first', name: 'Clan names need 3+ characters', taken: 'That name is taken', gold: 'Creating a clan costs 100 gold', full: 'That clan is full', cooldown: 'You can request again later', shards: "You don't have a spare copy", limit: 'Donation limit reached for this request', own: "That's your own request", busy: 'That clan has too many pending requests', leader: 'Only the leader can do that', player: 'No player with that username', 'player-in-clan': 'That player is already in a clan', request: 'That request is gone' };
const TYPE_LABEL = { open: 'Open · free to join', invite: 'Invite only' };
const typePill = (type = 'open') => h('span', { class: `clan-type ${type}` }, type === 'invite' ? '🔒 Invite only' : '🟢 Open');

const badge = (i, big) => h('span', { class: `clan-badge${big ? ' big' : ''}`, style: { background: BADGE_COLORS[i % BADGE_COLORS.length] } });
const timeAgo = (ts) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

function clanError(res) {
  if (res?.error) toastMsg(ERRORS[res.error] ?? 'Something went wrong');
}

export function openClan() {
  const body = h('div', { class: 'clan-body' });
  let tab = 'top';
  let query = '';
  /** Members can browse other clans too (without joining). */
  let browsing = false;

  const render = () => body.replaceChildren(...(net.clan && !browsing ? clanView(net.clan) : browseView()).filter(Boolean));

  // ---------------------------------------------------------------- not in a clan
  function browseView() {
    const names = { top: '🏆 TOP CLANS', find: 'SEARCH', create: 'CREATE' };
    const tabs = h(
      'div',
      { class: 'battle-tabs' },
      (net.clan ? ['top', 'find'] : ['top', 'find', 'create']).map((t) => h('button', { class: `btn chip${tab === t ? ' on' : ''}`, onclick: () => (sfx.click(), (tab = t), render()) }, names[t])),
      net.clan && h('button', { class: 'btn chip', onclick: () => (sfx.click(), (browsing = false), render()) }, `← ${net.clan.name}`),
    );
    if (tab === 'create' && !net.clan) return [tabs, createForm()];
    const invites = h('div', { class: 'clan-invites' });
    const list = h('div', { class: 'clan-list scroll' }, h('div', { class: 'dim' }, 'Loading…'));
    const search = h('input', { class: 'email-input', placeholder: 'Search by name or #TAG', value: query });
    const row = (c, i) =>
      h(
        'div',
        { class: `clan-row inset${c.invited ? ' invited' : ''}` },
        tab === 'top' && i != null && h('b', { class: 'rank' }, `#${i + 1}`),
        badge(c.badge),
        h('div', { class: 'clan-info' }, h('b', {}, c.name, ' ', typePill(c.type)), h('small', { class: 'dim' }, `#${c.tag} · ${c.members}/30 members`), c.desc && h('small', {}, c.desc)),
        h('span', { class: 'clan-troph' }, img('/assets/ui/icon-trophy.png'), c.trophies),
        !net.clan && joinButton(c),
      );
    const run = () => {
      query = tab === 'find' ? search.value : '';
      net.request({ t: 'clan-list', q: query }, 'clan-list').then((m) => {
        const rows = (m?.list ?? []).map((c, i) => row(c, i));
        list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'empty inset' }, tab === 'top' ? 'No clans yet — create the first one!' : 'No clans found.')]));
        const inv = net.clan ? [] : m?.invites ?? [];
        invites.replaceChildren(...(inv.length ? [h('div', { class: 'section-title' }, '✉ INVITATIONS'), ...inv.map((c) => row(c))] : []));
      });
    };
    search.onkeydown = (e) => e.key === 'Enter' && run();
    run();
    return [tabs, invites, tab === 'find' && h('div', { class: 'account-row' }, search, h('button', { class: 'btn', onclick: run }, 'Search')), list];
  }

  function joinButton(c) {
    if (c.members >= 30) return h('button', { class: 'btn', disabled: true }, 'Full');
    if (c.invited) return h('button', { class: 'btn gold', onclick: async () => clanError(await joinClan(c.id)) }, 'Accept invite');
    if (c.type === 'invite') {
      const btn = h('button', { class: 'btn', disabled: c.asked, onclick: async () => {
        const res = await joinClan(c.id);
        if (res?.pending) {
          btn.disabled = true;
          btn.textContent = 'Requested';
        } else clanError(res);
      } }, c.asked ? 'Requested' : 'Ask to join');
      return btn;
    }
    return h('button', { class: 'btn gold', onclick: async () => clanError(await joinClan(c.id)) }, 'Join');
  }

  async function joinClan(id) {
    sfx.click();
    const res = await net.request({ t: 'clan-join', id }, 'econ', { op: 'clan-join' });
    if (res?.clan) {
      net.clan = res.clan;
      render();
      toastMsg(`Welcome to ${res.clan.name}!`);
    } else if (res?.pending) toastMsg('Request sent — the leader will decide');
    return res;
  }

  function createForm() {
    let pick = 0;
    let type = 'open';
    const typeRow = h('div', { class: 'battle-tabs' });
    const drawType = () => typeRow.replaceChildren(...['open', 'invite'].map((t) => h('button', { class: `btn chip${type === t ? ' on' : ''}`, onclick: () => (sfx.click(), (type = t), drawType()) }, TYPE_LABEL[t])));
    drawType();
    const name = h('input', { class: 'email-input', maxLength: 20, placeholder: 'Clan name' });
    const desc = h('input', { class: 'email-input', maxLength: 120, placeholder: 'Description (optional)' });
    const badges = h('div', { class: 'badge-pick' });
    const drawBadges = () => badges.replaceChildren(...BADGE_COLORS.map((_, i) => h('button', { class: `badge-btn${i === pick ? ' on' : ''}`, onclick: () => ((pick = i), drawBadges()) }, badge(i, true))));
    drawBadges();
    return h(
      'div',
      { class: 'clan-create inset' },
      name,
      desc,
      h('div', { class: 'dim' }, 'Badge'),
      badges,
      h('div', { class: 'dim' }, 'Who can join'),
      typeRow,
      h('button', {
        class: 'btn gold',
        onclick: async () => {
          sfx.click();
          const res = await net.request({ t: 'clan-create', name: name.value, desc: desc.value, badge: pick, type }, 'econ', { op: 'clan-create' });
          if (res?.clan) {
            net.clan = res.clan;
            render();
          } else clanError(res);
        },
      }, 'Create clan · ', h('span', { class: 'coin' }), ' 100'),
    );
  }

  // ---------------------------------------------------------------- member view
  function clanView(c) {
    const members = h(
      'div',
      { class: 'clan-members scroll' },
      c.members.map((m, i) =>
        h('div', { class: `member-row${m.me ? ' me' : ''}` }, h('span', { class: 'dim' }, i + 1), h('span', { class: `dot ${m.online ? 'on' : ''}` }), h('b', {}, m.name), rankTag(m.name), m.role === 'leader' && h('small', { class: 'leader' }, 'Leader'), h('span', { class: 'member-troph' }, img('/assets/ui/icon-trophy.png'), m.trophies), h('small', { class: 'dim', title: 'Cards donated' }, `🎁 ${m.donated}`)),
      ),
    );

    const requestsById = new Map(c.requests.map((r) => [r.id, r]));
    const feed = h(
      'div',
      { class: 'clan-chat scroll' },
      [...c.chat.map((m) => ({ kind: 'chat', ts: m.ts, m })), ...c.requests.map((r) => ({ kind: 'req', ts: r.ts, r }))]
        .sort((a, b) => a.ts - b.ts)
        .map((it) => {
          if (it.kind === 'chat') return it.m.kind === 'system' ? h('div', { class: 'clan-sys' }, it.m.text) : h('div', { class: 'clan-msg' }, h('b', {}, it.m.name), ' ', it.m.text, h('small', { class: 'dim' }, ` ${timeAgo(it.m.ts)}`));
          const r = requestsById.get(it.r.id);
          const card = CARD_BY_ID[r.card];
          const have = net.profile?.cards[r.card]?.shards ?? 0;
          return h(
            'div',
            { class: `clan-req inset rarity-${card.rarity.toLowerCase()}` },
            img(cardImg(r.card), 'icon'),
            h('div', { class: 'req-info' }, h('b', {}, `${r.name} wants ${card.name}`), h('div', { class: 'quest-track' }, h('div', { style: { width: `${Math.round((r.got / r.need) * 100)}%` } }), h('span', {}, `${r.got}/${r.need}`))),
            r.mine
              ? h('small', { class: 'dim' }, 'Your request')
              : h('button', {
                  class: 'btn gold',
                  disabled: have < 1,
                  title: have < 1 ? 'You have no spare copy' : `You have ${have}`,
                  onclick: async () => {
                    sfx.click();
                    const res = await net.request({ t: 'clan-donate', request: r.id }, 'econ', { op: 'clan-donate' });
                    if (res?.reward) toastMsg(`Donated! +${res.reward.gold} gold, +${res.reward.xp} XP`);
                    else clanError(res);
                  },
                }, 'Donate'),
          );
        }),
    );
    requestAnimationFrame(() => (feed.scrollTop = feed.scrollHeight));
    const input = h('input', { class: 'email-input', maxLength: 160, placeholder: 'Message your clan…' });
    const sendMsg = () => {
      const text = input.value.trim();
      if (!text) return;
      net.send({ t: 'clan-chat', text });
      input.value = '';
    };
    input.onkeydown = (e) => e.key === 'Enter' && sendMsg();
    const wait = (c.nextRequestAt - Date.now()) / 1000;
    const requestBtn = h('button', { class: 'btn', disabled: wait > 0, onclick: () => (sfx.click(), openRequestPicker()) }, wait > 0 ? `Request in ${fmtSecs(wait)}` : 'Request cards');

    return [
      h(
        'div',
        { class: 'clan-head inset' },
        badge(c.badge, true),
        h('div', { class: 'clan-info' }, h('b', { class: 'title' }, c.name, ' ', typePill(c.type)), h('small', { class: 'dim' }, `#${c.tag} · ${c.members.length}/30 · ${c.desc || 'No description'}`)),
        h('span', { class: 'clan-troph' }, img('/assets/ui/icon-trophy.png'), c.trophies),
        h('button', { class: 'btn small-btn', onclick: () => (sfx.click(), (browsing = true), (tab = 'top'), render()) }, 'Browse clans'),
        h('button', {
          class: 'btn small-btn',
          onclick: async () => {
            if (!confirm(`Leave ${c.name}?`)) return;
            const res = await net.request({ t: 'clan-leave' }, 'econ', { op: 'clan-leave' });
            if (res && !res.error) {
              net.clan = null;
              render();
            }
          },
        }, 'Leave'),
      ),
      c.role === 'leader' && leaderPanel(c),
      h('div', { class: 'clan-cols' }, h('div', { class: 'clan-col' }, h('div', { class: 'section-title' }, 'MEMBERS'), members), h('div', { class: 'clan-col wide' }, h('div', { class: 'section-title' }, 'CLAN CHAT & REQUESTS'), feed, h('div', { class: 'account-row' }, input, h('button', { class: 'btn', onclick: sendMsg }, 'Send'), requestBtn))),
    ];
  }

  /** Leader tools: who may join, invitations by username, pending join requests. */
  function leaderPanel(c) {
    const send = async (msg) => {
      sfx.click();
      const res = await net.request(msg, 'econ', { op: msg.t });
      clanError(res);
      return res;
    };
    const types = ['open', 'invite'].map((t) => h('button', { class: `btn chip${(c.type ?? 'open') === t ? ' on' : ''}`, onclick: () => send({ t: 'clan-settings', type: t }) }, TYPE_LABEL[t]));
    const who = h('input', { class: 'email-input', maxLength: 16, placeholder: 'Invite by username', onkeydown: (e) => (e.stopPropagation(), e.key === 'Enter' && inviteBtn.click()) });
    const inviteBtn = h('button', { class: 'btn', onclick: async () => {
      if (!who.value.trim()) return;
      const res = await send({ t: 'clan-invite', name: who.value.trim() });
      if (res && !res.error) {
        toastMsg(`Invitation sent to ${who.value.trim()}`);
        who.value = '';
      }
    } }, 'Invite');
    const pending = (c.joinRequests ?? []).map((j) =>
      h('div', { class: 'join-req inset' }, h('b', {}, rankTag(j.name), j.name), h('span', { class: 'member-troph' }, img('/assets/ui/icon-trophy.png'), j.trophies), h('button', { class: 'btn gold', onclick: () => send({ t: 'clan-answer', player: j.id, accept: true }) }, 'Accept'), h('button', { class: 'btn', onclick: () => send({ t: 'clan-answer', player: j.id, accept: false }) }, 'Decline')),
    );
    return h(
      'div',
      { class: 'clan-leader inset' },
      h('div', { class: 'leader-row' }, h('span', { class: 'dim' }, 'Who can join:'), ...types),
      h('div', { class: 'account-row' }, who, inviteBtn),
      pending.length ? [h('div', { class: 'section-title' }, `JOIN REQUESTS (${pending.length})`), ...pending] : null,
    );
  }

  function openRequestPicker() {
    const grid = h(
      'div',
      { class: 'request-grid scroll' },
      CARDS.filter((c) => REQUESTABLE.has(c.rarity)).map((c) =>
        h('button', {
          class: `card-tile rarity-${c.rarity.toLowerCase()}`,
          onclick: async () => {
            sfx.click();
            const res = await net.request({ t: 'clan-request', card: c.id }, 'econ', { op: 'clan-request' });
            if (res && !res.error) {
              close();
              openClan();
            } else clanError(res);
          },
        }, img(cardImg(c.id), 'art'), h('div', { class: 'name' }, c.name), h('small', { class: 'dim' }, `${c.type} · ${c.rarity}`)),
      ),
    );
    const close = openModal({ cls: 'request-modal', title: 'REQUEST A CARD', body: [h('p', { class: 'dim' }, 'Clanmates can donate up to 10 Common, 3 Rare or 1 Epic. One request every 4 hours.'), grid] });
  }

  render();
  const offs = [net.on('clan', () => render()), net.on('clan-invite', () => !net.clan && render())];
  const off = () => offs.forEach((o) => o());
  openModal({ cls: 'clan-modal', title: 'CLAN', body, onClose: () => off() });
}
