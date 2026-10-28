import * as t3 from '@typegpu/three';
import { d, std } from 'typegpu';
import { perlin2d } from '@typegpu/noise';

// All shaders below are TypeGPU functions ('use gpu'), compiled to WGSL on WebGPU and to
// GLSL (via @typegpu/gl) when three falls back to its WebGL2 backend.

const W = 18;
const H = 32;

/** Palette values below are authored in sRGB; the renderer works in linear space. */
const toLinear = (c) => {
  'use gpu';
  return std.pow(std.max(c, d.vec3f(0)), d.vec3f(2.2));
};

// ------------------------------------------------------------------ sky

export const skyColor = t3.toTSL(() => {
  'use gpu';
  const uv = t3.screenUV.$;
  const top = d.vec3f(0.42, 0.66, 0.9);
  const horizon = d.vec3f(0.86, 0.93, 0.98);
  const k = std.smoothstep(0.0, 0.85, uv.y);
  const haze = perlin2d.sample(d.vec2f(uv.x * 3 + t3.time.$ * 0.01, uv.y * 6)) * 0.5 + 0.5;
  const col = std.mix(top, horizon, k) + d.vec3f(haze * 0.05 * k);
  return d.vec4f(toLinear(col), 1);
});

// ------------------------------------------------------------------ battlefield

/** Checkerboard grass with worn sand lanes, faint noise and a darker rim. */
export const fieldColor = t3.toTSL(() => {
  'use gpu';
  const uv = t3.uv().$;
  const tile = uv * d.vec2f(W, H);
  const cell = std.floor(tile);
  const checker = std.fract((cell.x + cell.y) * 0.5) * 2;
  const light = d.vec3f(0.62, 0.84, 0.36);
  const dark = d.vec3f(0.53, 0.77, 0.3);
  const grain = perlin2d.sample(tile * 0.45) * 0.5 + 0.5;
  let col = std.mix(dark, light, checker) * (0.93 + grain * 0.1);

  const laneDist = std.min(std.abs(tile.x - 3.5), std.abs(tile.x - 14.5));
  const laneMask = (1 - std.smoothstep(0.82, 1.02, laneDist)) * std.step(2.2, tile.y) * std.step(tile.y, H - 2.2);
  const crossDist = std.min(std.abs(tile.y - 3.6), std.abs(tile.y - (H - 3.6)));
  const crossMask = (1 - std.smoothstep(0.28, 0.4, crossDist)) * std.step(3.5, tile.x) * std.step(tile.x, W - 3.5);
  const sand = d.vec3f(0.93, 0.87, 0.67) * (0.92 + grain * 0.12);
  col = std.mix(col, sand, std.max(laneMask, crossMask));

  const edge = std.min(std.min(tile.x, W - tile.x), std.min(tile.y, H - tile.y));
  col = col * (0.82 + 0.18 * std.smoothstep(0.0, 0.6, edge));
  return d.vec4f(toLinear(col), 1);
});

// ------------------------------------------------------------------ river

/** Animated water: flowing ripples, glints and foam where it meets the banks and bridges. */
export const riverColor = t3.toTSL(() => {
  'use gpu';
  const uv = t3.uv().$;
  const t = t3.time.$;
  const p = d.vec2f(uv.x * 20, uv.y * 2.4);
  const flow = perlin2d.sample(p * d.vec2f(0.6, 1.4) + d.vec2f(t * 0.55, t * 0.08));
  const ripples = perlin2d.sample(p * 2.2 + d.vec2f(t * 1.1, -t * 0.3) + flow * 0.8);
  const across = std.abs(uv.y - 0.5) * 2;
  const deep = d.vec3f(0.13, 0.5, 0.86);
  const shallow = d.vec3f(0.32, 0.74, 0.96);
  let col = std.mix(deep, shallow, across * 0.7 + ripples * 0.25);
  const glint = std.smoothstep(0.55, 0.75, ripples) * (1 - across);
  col = col + d.vec3f(0.55, 0.65, 0.7) * glint * 0.6;
  const foamNoise = perlin2d.sample(p * 3 + d.vec2f(t * 0.9, 0)) * 0.5 + 0.5;
  const foam = std.smoothstep(0.72, 0.98, across + foamNoise * 0.25);
  col = std.mix(col, d.vec3f(0.95, 0.98, 1), foam * 0.85);
  return d.vec4f(toLinear(col), 1);
});

// ------------------------------------------------------------------ particles

const cornerAttr = t3.attribute('corner', d.vec2f);
const centerAttr = t3.attribute('center', d.vec3f);
const dataAttr = t3.attribute('pdata', d.vec4f); // size, life 0..1, type, seed
const tintAttr = t3.attribute('ptint', d.vec4f); // rgb tint, rotation

export const FX_TYPE = { smoke: 0, fire: 1, spark: 2, ring: 3, scorch: 4, crater: 5, glow: 6 };

/** Camera-facing quads, except ground decals (ring/scorch/crater) which lie flat. */
export const particlePosition = t3.toTSL(() => {
  'use gpu';
  const c = cornerAttr.$;
  const center = centerAttr.$;
  const data = dataAttr.$;
  const rot = tintAttr.$.w;
  const cs = std.cos(rot);
  const sn = std.sin(rot);
  const rc = d.vec2f(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * data.x;
  const V = t3.cameraViewMatrix.$;
  const right = d.vec3f(V.columns[0].x, V.columns[1].x, V.columns[2].x);
  const up = d.vec3f(V.columns[0].y, V.columns[1].y, V.columns[2].y);
  const billboard = center + right * rc.x + up * rc.y;
  const flat = center + d.vec3f(rc.x, 0, -rc.y);
  return std.select(billboard, flat, data.z > 2.5 && data.z < 5.5);
});

/** Premultiplied output: alpha near 0 means additive (fire/sparks), 1 means normal blending. */
export const particleColor = t3.toTSL(() => {
  'use gpu';
  const c = cornerAttr.$;
  const data = dataAttr.$;
  const tint = tintAttr.$.xyz;
  const life = data.y;
  const kind = data.z;
  const seed = data.w;
  const r = std.length(c) * 2;
  const n = perlin2d.sample(c * 3.2 + d.vec2f(seed * 17, seed * 31 + life * 1.5));
  const fade = 1 - life;
  let rgb = d.vec3f(0);
  let a = d.f32(0);

  if (kind < 0.5) {
    // Smoke: noise-eroded soft puff that lightens and thins as it rises.
    const soft = 1 - std.smoothstep(0.35, 1.0, r + n * 0.35);
    const grey = std.mix(0.28, 0.62, life);
    a = soft * fade * 0.7;
    rgb = d.vec3f(grey) * tint * a;
  } else if (kind < 1.5) {
    // Fire: white-hot core cooling through orange to deep red, added on top.
    const soft = 1 - std.smoothstep(0.2, 1.0, r + n * 0.45);
    const hot = std.mix(d.vec3f(1, 0.95, 0.6), d.vec3f(1, 0.45, 0.08), std.smoothstep(0.0, 0.5, life));
    const col = std.mix(hot, d.vec3f(0.6, 0.08, 0.02), std.smoothstep(0.5, 1.0, life));
    rgb = col * soft * fade * 1.8;
    a = soft * fade * 0.15;
  } else if (kind < 2.5) {
    // Spark: tight glowing dot.
    const g = 1 - std.smoothstep(0.0, 1.0, r);
    rgb = tint * g * g * fade * 2.2;
    a = d.f32(0);
  } else if (kind < 3.5) {
    // Shockwave ring expanding on the ground.
    const radius = 0.25 + life * 0.72;
    const ring = 1 - std.smoothstep(0.0, 0.09, std.abs(r - radius));
    rgb = tint * ring * fade * 1.6;
    a = ring * fade * 0.25;
  } else if (kind < 4.5) {
    // Scorch decal from splash hits.
    const mask = 1 - std.smoothstep(0.45, 1.0, r + n * 0.3);
    a = mask * (1 - life * life) * 0.55;
    rgb = d.vec3f(0.08, 0.06, 0.05) * a;
  } else if (kind < 5.5) {
    // Persistent rubble crater left by a fallen tower.
    const mask = 1 - std.smoothstep(0.6, 1.0, r + n * 0.25);
    const inner = std.smoothstep(0.75, 0.2, r);
    a = mask * 0.9;
    rgb = std.mix(d.vec3f(0.33, 0.3, 0.27), d.vec3f(0.1, 0.09, 0.08), inner) * a;
  } else {
    // Glow: soft tinted halo (projectile trails, magic).
    const g = 1 - std.smoothstep(0.0, 1.0, r);
    rgb = tint * g * g * fade * 1.4;
    a = d.f32(0);
  }
  return d.vec4f(rgb, a);
});
