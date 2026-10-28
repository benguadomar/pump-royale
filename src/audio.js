import { state } from './state.js';

// CC0 clips from github.com/7etsuo/anvil (Kenney UI audio, CC0 RPG/combat packs,
// "Battle Theme A" and "Town Theme" by cynicmusic) - see public/assets/audio/CREDITS.md.
const CLIPS = ['bell', 'chime', 'click', 'drop', 'explosion', 'falling', 'fireball', 'gong', 'hit1', 'hit2', 'magic', 'swing1', 'swing2', 'swing3'];
const MUSIC = { lobby: '/assets/audio/music-lobby.mp3', battle: '/assets/audio/music-battle.mp3' };
const MIN_GAP_MS = 45;

let ctx = null;
let sfxBus = null;
let musicBus = null;
const buffers = new Map();
const lastPlayed = new Map();
let musicEl = null;
let musicTrack = null;

function audio() {
  if (!ctx) {
    ctx = new AudioContext();
    sfxBus = ctx.createGain();
    sfxBus.connect(ctx.destination);
    musicBus = ctx.createGain();
    musicBus.connect(ctx.destination);
    applyVolume();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function applyVolume() {
  if (!ctx) return;
  const muted = state.settings.muted;
  sfxBus.gain.value = muted ? 0 : state.settings.volume * 1.6;
  musicBus.gain.value = muted ? 0 : state.settings.music;
}

/** Decodes every clip up front (called from the loading screen). */
export async function loadAudio() {
  const a = audio();
  await Promise.all(
    CLIPS.map(async (name) => {
      try {
        const res = await fetch(`/assets/audio/${name}.mp3`);
        buffers.set(name, await a.decodeAudioData(await res.arrayBuffer()));
      } catch (e) {
        console.warn('audio', name, e);
      }
    }),
  );
}

function clip(name, { gain = 1, rate = 1, jitter = 0.06, delay = 0 } = {}) {
  const buf = buffers.get(name);
  if (!buf || state.settings.muted) return;
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? 0) < MIN_GAP_MS) return;
  lastPlayed.set(name, now);
  const a = audio();
  const src = a.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * jitter);
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(g).connect(sfxBus);
  src.start(a.currentTime + delay);
}

function tone({ freq = 440, to = freq, dur = 0.12, type = 'sine', gain = 0.3, delay = 0 }) {
  if (state.settings.muted) return;
  const a = audio();
  const t = a.currentTime + delay;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(sfxBus);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

const pick = (...names) => names[Math.floor(Math.random() * names.length)];

export const sfx = {
  click: () => clip('click', { gain: 0.8, jitter: 0.02 }),
  open: () => clip('drop', { gain: 0.6, rate: 1.2 }),
  chat: () => clip('click', { gain: 0.5, rate: 1.6 }),
  deploy: () => {
    clip('chime', { gain: 0.8 });
    clip('drop', { gain: 0.7, rate: 0.8 });
  },
  deployEnemy: () => clip('drop', { gain: 0.45, rate: 0.7 }),
  sword: () => {
    clip(pick('swing1', 'swing2', 'swing3'), { gain: 0.55 });
    clip(pick('hit1', 'hit2'), { gain: 0.35, delay: 0.05 });
  },
  bow: () => clip(pick('swing2', 'swing3'), { gain: 0.4, rate: 1.7 }),
  fireball: () => clip('fireball', { gain: 0.45, rate: 1.1 }),
  bombThrow: () => clip('swing1', { gain: 0.35, rate: 0.7 }),
  cannon: () => clip('explosion', { gain: 0.45, rate: 1.5 }),
  boom: () => clip('explosion', { gain: 0.8, rate: 0.95 }),
  hit: () => clip(pick('hit1', 'hit2'), { gain: 0.3 }),
  shoot: () => clip('swing3', { gain: 0.2, rate: 2 }),
  tower: () => {
    clip('explosion', { gain: 1, rate: 0.6, jitter: 0 });
    clip('falling', { gain: 0.8, delay: 0.15 });
    tone({ freq: 90, to: 30, dur: 0.9, type: 'sawtooth', gain: 0.12 });
  },
  horn: () => {
    clip('gong', { gain: 0.9, rate: 0.85, jitter: 0 });
    [0, 0.45].forEach((d) => tone({ freq: 196, to: 200, dur: 0.6, type: 'sawtooth', gain: 0.09, delay: d }));
  },
  king: () => clip('bell', { gain: 0.6, rate: 0.8 }),
  land: () => {
    clip('drop', { gain: 0.5, rate: 0.55 });
    tone({ freq: 120, to: 50, dur: 0.18, type: 'sine', gain: 0.18 });
  },
  heavy: () => {
    clip('explosion', { gain: 0.35, rate: 1.9 });
    tone({ freq: 90, to: 40, dur: 0.22, type: 'triangle', gain: 0.22 });
  },
  crack: () => {
    clip(pick('hit1', 'hit2'), { gain: 0.6, rate: 0.45 });
    clip('falling', { gain: 0.25, rate: 1.4 });
  },
  crumble: () => clip('falling', { gain: 0.9, rate: 0.75 }),
  death: () => tone({ freq: 520, to: 160, dur: 0.16, type: 'triangle', gain: 0.12 }),
  bones: () => [0, 0.05, 0.11, 0.16].forEach((d) => clip('click', { gain: 0.45, rate: 2.2 + Math.random(), delay: d })),
  thud: () => {
    clip('explosion', { gain: 0.6, rate: 0.5 });
    tone({ freq: 70, to: 28, dur: 0.5, type: 'sine', gain: 0.3 });
  },
  elixirFull: () => tone({ freq: 880, to: 1320, dur: 0.18, type: 'sine', gain: 0.07 }),
  cardReady: () => tone({ freq: 1200, to: 1500, dur: 0.06, type: 'sine', gain: 0.04 }),
  select: () => clip('click', { gain: 0.6, rate: 1.25, jitter: 0.02 }),
  drain: () => tone({ freq: 660, to: 330, dur: 0.14, type: 'triangle', gain: 0.06 }),
  win: () => {
    clip('magic', { gain: 0.7 });
    [523, 659, 784, 1046].forEach((f, i) => tone({ freq: f, dur: 0.28, type: 'triangle', gain: 0.18, delay: i * 0.12 }));
  },
  lose: () => {
    clip('gong', { gain: 0.6, rate: 0.6 });
    [392, 330, 262].forEach((f, i) => tone({ freq: f, dur: 0.32, type: 'triangle', gain: 0.16, delay: i * 0.18 }));
  },
};

/** Crossfades to the lobby or battle loop (or stops with null). */
export function playMusic(track) {
  if (track === musicTrack) return;
  musicTrack = track;
  const a = audio();
  const old = musicEl;
  if (old) {
    old.fade?.gain.linearRampToValueAtTime(0, a.currentTime + 0.8);
    setTimeout(() => old.pause(), 900);
  }
  musicEl = null;
  if (!track) return;
  const el = new Audio(MUSIC[track]);
  el.loop = true;
  el.crossOrigin = 'anonymous';
  const node = a.createMediaElementSource(el);
  const fade = a.createGain();
  fade.gain.value = 0;
  fade.gain.linearRampToValueAtTime(1, a.currentTime + 1.2);
  node.connect(fade).connect(musicBus);
  el.fade = fade;
  musicEl = el;
  el.play().catch(() => {
    // Autoplay blocked until the first user gesture; retry then.
    const retry = () => el === musicEl && el.play().catch(() => {});
    window.addEventListener('pointerdown', retry, { once: true });
  });
}

/** Browsers start audio suspended; unlock on the first interaction. */
window.addEventListener('pointerdown', () => audio(), { once: true });
