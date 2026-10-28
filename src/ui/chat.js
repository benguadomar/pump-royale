import { h, timeHM } from './dom.js';
import { net } from '../net.js';
import { state } from '../state.js';
import { sfx } from '../audio.js';
import { flag } from './widgets.js';

const MAX_LINES = 60;

/** Chat box with a GLOBAL tab (server-wide) and a GAME tab that only exists while in a match. */
export function createChat() {
  let tab = 'global';
  let gameSend = null;
  let localEcho = true;
  const gameLines = [];

  const globalTab = h('button', { class: 'chat-tab active', onclick: () => setTab('global') }, 'GLOBAL');
  const gameTab = h('button', { class: 'chat-tab hidden', onclick: () => setTab('game') }, 'GAME');
  const online = h('span', { class: 'chat-online' }, '');
  const log = h('div', { class: 'chat-log' });
  const input = h('input', {
    class: 'chat-input',
    placeholder: 'Say something...',
    maxLength: 160,
    onkeydown: (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') input.blur();
    },
  });
  const el = h(
    'div',
    { class: 'chat wood panel' },
    h('div', { class: 'chat-head' }, globalTab, gameTab, online, h('span', { class: 'chat-live' }, 'live')),
    log,
    input,
  );

  function line({ name, text, ts, kind, country }) {
    if (kind === 'system') return h('div', { class: 'chat-line system' }, text);
    const cls = kind === 'ai' ? 'ai' : name === state.name ? 'me' : '';
    return h(
      'div',
      { class: `chat-line ${cls}` },
      h('span', { class: 'who' }, flag(country), `${name}:`),
      h('span', { class: 'msg' }, text),
      h('span', { class: 'ts' }, timeHM(ts)),
    );
  }

  function render() {
    const items = tab === 'global' ? net.chat : gameLines;
    log.replaceChildren(...items.slice(-MAX_LINES).map(line));
    if (!items.length) log.append(h('div', { class: 'chat-line system placeholder' }, tab === 'global' ? 'No messages yet — say hi!' : 'Match chat — only you and your opponent see this.'));
    log.scrollTop = log.scrollHeight;
  }

  function append(entry, forTab) {
    if (forTab !== tab) {
      (forTab === 'global' ? globalTab : gameTab).textContent = `${forTab.toUpperCase()} •`;
      return;
    }
    log.querySelector('.placeholder')?.remove();
    log.append(line(entry));
    while (log.children.length > MAX_LINES) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  function setTab(next) {
    if (next !== tab) sfx.click();
    tab = next;
    globalTab.classList.toggle('active', tab === 'global');
    gameTab.classList.toggle('active', tab === 'game');
    (tab === 'global' ? globalTab : gameTab).textContent = tab.toUpperCase();
    input.placeholder = tab === 'global' ? 'Say something...' : 'Message your opponent...';
    render();
  }

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (tab === 'global') {
      if (!net.connected) return append({ kind: 'system', text: 'Offline — reconnecting…' }, 'global');
      net.sendChat(text);
    } else {
      if (localEcho) addGame({ name: state.name, country: state.country, text });
      gameSend?.(text);
    }
  }

  function addGame(entry) {
    const full = { ts: Date.now(), ...entry };
    gameLines.push(full);
    if (gameLines.length > MAX_LINES) gameLines.shift();
    append(full, 'game');
  }

  const updateOnline = () => {
    online.textContent = net.connected ? `● ${net.online} online` : '● offline';
    online.style.color = net.connected ? '' : '#ff8f86';
  };

  net.on('welcome', () => tab === 'global' && render());
  net.on('chat', (m) => {
    if (m.name !== state.name) sfx.chat();
    append(m, 'global');
  });
  net.on('status', updateOnline);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.activeElement !== input && el.isConnected && !document.querySelector('.backdrop')) {
      e.preventDefault();
      input.focus();
    }
  });

  updateOnline();
  render();

  return {
    el,
    addGame,
    /**
     * Turns the GAME tab on for a match (with a send handler), or off when it ends.
     * Online the server echoes our own lines back, so `localEcho` is false there.
     */
    setGame(onSend, { localEcho: echo = true } = {}) {
      gameSend = onSend;
      localEcho = echo;
      gameLines.length = 0;
      gameTab.classList.toggle('hidden', !onSend);
      setTab(onSend ? 'game' : 'global');
    },
  };
}
