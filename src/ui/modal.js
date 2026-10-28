import { h, icon, app } from './dom.js';
import { sfx } from '../audio.js';

let current = null;

/** Opens a centered wood modal; returns a function that closes it. */
export function openModal({ cls = '', title, iconSrc, headExtra = [], body, onClose }) {
  current?.();
  sfx.open();

  const close = () => {
    if (current !== close) return;
    current = null;
    backdrop.remove();
    window.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };

  const closeBtn = h('button', { class: 'btn close-btn', onclick: () => (sfx.click(), close()) }, icon('close'));
  const modal = h(
    'div',
    { class: `modal wood panel ${cls}`, onpointerdown: (e) => e.stopPropagation() },
    h('div', { class: 'modal-head' }, iconSrc && h('img', { src: iconSrc, alt: '' }), title && h('h2', {}, title), h('div', { class: 'spacer' }), headExtra, closeBtn),
    body,
  );
  const backdrop = h('div', { class: 'backdrop', onpointerdown: close }, modal);

  app().append(backdrop);
  window.addEventListener('keydown', onKey);
  current = close;
  return close;
}

export const closeModal = () => current?.();
