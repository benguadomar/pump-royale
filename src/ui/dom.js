/** Tiny element factory: h('div', { class: 'x', onclick }, child, 'text', [moreChildren]) */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const img = (src, cls = '', alt = '') => h('img', { src, class: cls, alt, draggable: 'false' });

export const app = () => document.getElementById('app');

export function timeHM(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function dateShort(ts) {
  const d = new Date(ts);
  return `${d.getDate()} ${d.toLocaleString('en', { month: 'short' }).toLowerCase()}., ${timeHM(ts)}`;
}

export const ICONS = {
  gear: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19.4 13a7.8 7.8 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.8 7.8 0 0 0 0 2l-2.2 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>`,
  book: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M2 5c3-1.3 6.3-1.3 9.2.6v14c-2.9-1.8-6.2-1.8-9.2-.6zm20 0v14c-3-1.2-6.3-1.2-9.2.6v-14C15.7 3.7 19 3.7 22 5z"/></svg>`,
  share: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M18 16a3 3 0 0 0-2.2 1l-7-3.6a3 3 0 0 0 0-2.8l7-3.6A3 3 0 1 0 15 5l-7 3.6a3 3 0 1 0 0 6.8l7 3.6A3 3 0 1 0 18 16z"/></svg>`,
  x: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M17.8 3h3.1l-6.8 7.7 8 10.3h-6.2l-4.9-6.3L5.4 21H2.3l7.2-8.3L1.8 3h6.4l4.4 5.8zm-1.1 16.2h1.7L7.4 4.7H5.6z"/></svg>`,
  close: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z"/></svg>`,
  wifi: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 20.5 8.6 16.3a5.5 5.5 0 0 1 6.8 0zM5.2 12.6a11 11 0 0 1 13.6 0l-2.1 2.6a7.6 7.6 0 0 0-9.4 0zM1.6 8.2a16.6 16.6 0 0 1 20.8 0l-2.1 2.6a13.2 13.2 0 0 0-16.6 0z"/></svg>`,
  copy: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11z"/></svg>`,
  sound: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>`,
  mute: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9zm18.5 1.4-1.4-1.4-2.6 2.6-2.6-2.6-1.4 1.4 2.6 2.6-2.6 2.6 1.4 1.4 2.6-2.6 2.6 2.6 1.4-1.4-2.6-2.6z"/></svg>`,
  fullscreen: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M5 5h5v2H7v3H5zm9 0h5v5h-2V7h-3zM5 14h2v3h3v2H5zm12 0h2v5h-5v-2h3z"/></svg>`,
  quest: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 3h11a3 3 0 0 1 3 3v1h-3V6a1 1 0 0 0-2 0v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-2h3V6a3 3 0 0 1 1-2.2zm2 4v2h5V7zm0 4v2h5v-2zm0 4v2h4v-2z"/></svg>`,
  emote: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 3C6.5 3 2 6.6 2 11c0 2.4 1.3 4.5 3.4 6L4.5 21l4.3-2.4c1 .3 2.1.4 3.2.4 5.5 0 10-3.6 10-8s-4.5-8-10-8zm-4 9.3a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6zm4 0a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6zm4 0a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6z"/></svg>`,
  wallet: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M21 7.3V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2.3A2 2 0 0 0 22 15V9a2 2 0 0 0-1-1.7zM20 15h-7V9h7zm-4-1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/></svg>`,
  pencil: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 17.3V21h3.7l11-11-3.7-3.7zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7z"/></svg>`,
};

export function icon(name, cls = 'svg-icon') {
  const span = h('span', { class: cls });
  span.innerHTML = ICONS[name];
  return span;
}
