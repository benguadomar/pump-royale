// Battle emotes, shared by the HUD, the AI and the server's whitelist.
export const EMOTES = [
  { id: 'laugh', name: 'Laugh' },
  { id: 'cry', name: 'Cry' },
  { id: 'angry', name: 'Angry' },
  { id: 'thumbs', name: 'Thumbs up' },
  { id: 'peace', name: 'Peace' },
  { id: 'question', name: 'Hmm?' },
];

export const EMOTE_IDS = new Set(EMOTES.map((e) => e.id));
export const emoteImg = (id) => `/assets/emotes/${id}.png`;
export const EMOTE_COOLDOWN_MS = 2500;
