import { state } from './state.js';

let ctx = null;
function audio() {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone({ freq = 440, to = freq, dur = 0.12, type = 'sine', gain = 0.3, delay = 0 }) {
  const vol = state.settings.volume;
  if (vol <= 0) return;
  const a = audio();
  const t = a.currentTime + delay;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
  g.gain.setValueAtTime(gain * vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sfx = {
  click: () => tone({ freq: 660, to: 880, dur: 0.06, type: 'triangle', gain: 0.25 }),
  open: () => tone({ freq: 420, to: 640, dur: 0.1, type: 'triangle', gain: 0.2 }),
  deploy: () => tone({ freq: 220, to: 110, dur: 0.18, type: 'square', gain: 0.12 }),
  hit: () => tone({ freq: 180, to: 60, dur: 0.08, type: 'sawtooth', gain: 0.06 }),
  shoot: () => tone({ freq: 900, to: 500, dur: 0.05, type: 'triangle', gain: 0.05 }),
  boom: () => tone({ freq: 120, to: 30, dur: 0.35, type: 'sawtooth', gain: 0.2 }),
  tower: () => {
    tone({ freq: 160, to: 40, dur: 0.6, type: 'sawtooth', gain: 0.3 });
    tone({ freq: 90, to: 30, dur: 0.8, type: 'square', gain: 0.15, delay: 0.05 });
  },
  chat: () => tone({ freq: 1200, to: 1500, dur: 0.05, type: 'sine', gain: 0.12 }),
  win: () => [523, 659, 784, 1046].forEach((f, i) => tone({ freq: f, dur: 0.25, type: 'triangle', gain: 0.25, delay: i * 0.12 })),
  lose: () => [392, 330, 262].forEach((f, i) => tone({ freq: f, dur: 0.3, type: 'triangle', gain: 0.25, delay: i * 0.18 })),
};
