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

const hash2 = (c) => {
  'use gpu';
  return std.fract(std.sin(std.dot(c, d.vec2f(127.1, 311.7))) * 43758.5453);
};

const lawnHeight = (p) => {
  'use gpu';
  return perlin2d.sample(p * d.vec2f(9.0, 2.2)) * 0.5 + perlin2d.sample(p * 3.3) * 0.5;
};

// ------------------------------------------------------------------ sky

export const skyColor = t3.toTSL(() => {
  'use gpu';
  const uv = t3.screenUV.$;
  const top = d.vec3f(0.42, 0.66, 0.9);
  const horizon = d.vec3f(0.86, 0.93, 0.98);
  const k = std.smoothstep(0.0, 0.85, uv.y);
  const t = t3.time.$;
  const haze = perlin2d.sample(d.vec2f(uv.x * 3 + t * 0.01, uv.y * 6)) * 0.5 + 0.5;
  let col = std.mix(top, horizon, k) + d.vec3f(haze * 0.05 * k);
  // Wispy high cirrus streaks.
  const cq = d.vec2f(uv.x * 2.2 + t * 0.004, uv.y * 9.0);
  const wisp = perlin2d.sample(cq) * 0.6 + perlin2d.sample(cq * 2.3 + d.vec2f(3.1, 0)) * 0.4;
  col = std.mix(col, d.vec3f(0.97, 0.98, 1.0), std.smoothstep(0.15, 0.6, wisp) * 0.35 * std.smoothstep(0.2, 0.9, 1 - uv.y));
  // Warm glow from the sun in the upper left.
  const sd = std.length((uv - d.vec2f(0.15, 0.08)) * d.vec2f(1.6, 1.0));
  col = col + d.vec3f(1.0, 0.86, 0.6) * (std.exp(-sd * 5.0) * 0.28 + std.exp(-sd * 40.0) * 0.6);
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
  const light = d.vec3f(0.5, 0.76, 0.28);
  const dark = d.vec3f(0.4, 0.66, 0.22);
  const grain = perlin2d.sample(tile * 0.45) * 0.5 + 0.5;
  // Fine blade streaks and clover clumps so the lawn reads as grass, not flat paint.
  const blades = perlin2d.sample(tile * d.vec2f(9.0, 2.2)) * 0.5 + 0.5;
  const clumps = perlin2d.sample(tile * 1.7 + d.vec2f(4.2, 1.1)) * 0.5 + 0.5;
  let col = std.mix(dark, light, checker) * (0.88 + grain * 0.1 + blades * 0.1) * (0.94 + clumps * 0.1);

  const laneDist = std.min(std.abs(tile.x - 3.5), std.abs(tile.x - 14.5));
  const laneNoise = perlin2d.sample(tile * 2.3) * 0.12;
  const laneMask = (1 - std.smoothstep(0.78, 1.04, laneDist + laneNoise)) * std.step(2.2, tile.y) * std.step(tile.y, H - 2.2);
  const crossDist = std.min(std.abs(tile.y - 3.6), std.abs(tile.y - (H - 3.6)));
  const crossMask = (1 - std.smoothstep(0.26, 0.42, crossDist + laneNoise * 0.5)) * std.step(3.5, tile.x) * std.step(tile.x, W - 3.5);
  // Packed dirt path: tyre-like ruts, pebbles and darker damp edges.
  const rut = 1 - std.smoothstep(0.05, 0.18, std.abs(std.abs(laneDist) - 0.42));
  const pebble = std.step(0.86, hash2(std.floor(tile * 7.0))) * (perlin2d.sample(tile * 7.0) * 0.5 + 0.5);
  let sand = d.vec3f(0.88, 0.8, 0.6) * (0.9 + grain * 0.12) * (1 - rut * 0.1 * laneMask);
  sand = std.mix(sand, d.vec3f(0.62, 0.56, 0.47), pebble * 0.6);
  const pathMask = std.max(laneMask, crossMask);
  const pathEdge = std.smoothstep(0.0, 0.35, pathMask) * (1 - std.smoothstep(0.35, 0.9, pathMask));
  col = std.mix(col, sand, pathMask);
  col = col * (1 - pathEdge * 0.12);

  const edge = std.min(std.min(tile.x, W - tile.x), std.min(tile.y, H - tile.y));
  col = col * (0.82 + 0.18 * std.smoothstep(0.0, 0.6, edge));
  return d.vec4f(toLinear(col), 1);
});

/** Bump-mapped lawn: tiny blade ridges tilt the normal so the grass catches the sun. */
export const fieldNormal = t3.toTSL(() => {
  'use gpu';
  const uv = t3.uv().$;
  const tile = uv * d.vec2f(W, H);
  const e = 0.03;
  const h0 = lawnHeight(tile);
  const hx = lawnHeight(tile + d.vec2f(e, 0)) - h0;
  const hz = lawnHeight(tile + d.vec2f(0, e)) - h0;
  const nw = std.normalize(d.vec3f(-hx * 0.9, 1, hz * 0.9));
  const V = t3.cameraViewMatrix.$;
  return std.normalize(
    d.vec3f(
      V.columns[0].x * nw.x + V.columns[1].x * nw.y + V.columns[2].x * nw.z,
      V.columns[0].y * nw.x + V.columns[1].y * nw.y + V.columns[2].y * nw.z,
      V.columns[0].z * nw.x + V.columns[1].z * nw.y + V.columns[2].z * nw.z,
    ),
  );
});

// ------------------------------------------------------------------ river

/** Animated water: flowing ripples, glints and foam where it meets the banks and bridges. */
export const riverColor = t3.toTSL(() => {
  'use gpu';
  const uv = t3.uv().$;
  const t = t3.time.$;
  const p = d.vec2f(uv.x * 18, uv.y * 2.2);
  const flow = perlin2d.sample(p * d.vec2f(0.6, 1.4) + d.vec2f(t * 0.55, t * 0.08));
  const ripples = perlin2d.sample(p * 2.2 + d.vec2f(t * 1.1, -t * 0.3) + flow * 0.8);
  const across = std.abs(uv.y - 0.5) * 2;
  // Bright pool blue, deepest along the middle of the channel.
  const deep = d.vec3f(0.12, 0.56, 0.92);
  const shallow = d.vec3f(0.36, 0.8, 0.98);
  let col = std.mix(deep, shallow, across * 0.55 + ripples * 0.15);
  // Two drifting layers of thin bright lines form the cellular caustic web.
  const c1 = 1 - std.abs(perlin2d.sample(p * 1.5 + d.vec2f(t * 0.35, t * 0.12) + flow * 0.6));
  const c2 = 1 - std.abs(perlin2d.sample(p * 2.3 + d.vec2f(-t * 0.25, t * 0.2) + d.vec2f(7.3, 2.1)));
  const web = std.pow(std.max(c1, c2), 9);
  col = col + d.vec3f(0.62, 0.9, 1.0) * web * 0.65;
  const glint = std.smoothstep(0.62, 0.82, ripples) * (1 - across);
  col = col + d.vec3f(0.6, 0.7, 0.75) * glint * 0.25;
  // The stone banks shade the water right next to them.
  col = col * (1 - std.smoothstep(0.72, 1.0, across) * 0.32);
  return d.vec4f(toLinear(col), 1);
});

/** Water ripple height field used to bend the surface normal (sun glints, sky reflections). */
const waterHeight = (p, t) => {
  'use gpu';
  const a = perlin2d.sample(p * d.vec2f(0.9, 2.2) + d.vec2f(t * 0.7, t * 0.1));
  const b = perlin2d.sample(p * d.vec2f(2.6, 4.0) + d.vec2f(t * 1.3, -t * 0.25));
  return a * 0.6 + b * 0.3;
};

/** View-space normal of the rippling river (three expects material normals in view space). */
export const riverNormal = t3.toTSL(() => {
  'use gpu';
  const uv = t3.uv().$;
  const t = t3.time.$;
  const p = d.vec2f(uv.x * 20, uv.y * 2.4);
  const e = 0.06;
  const h0 = waterHeight(p, t);
  const hx = waterHeight(p + d.vec2f(e, 0), t) - h0;
  const hz = waterHeight(p + d.vec2f(0, e), t) - h0;
  // Plane is rotated so uv.x -> +X and uv.y -> -Z in world space.
  const nw = std.normalize(d.vec3f(-hx * 2.2, 1, hz * 2.2));
  const V = t3.cameraViewMatrix.$;
  return std.normalize(
    d.vec3f(
      V.columns[0].x * nw.x + V.columns[1].x * nw.y + V.columns[2].x * nw.z,
      V.columns[0].y * nw.x + V.columns[1].y * nw.y + V.columns[2].y * nw.z,
      V.columns[0].z * nw.x + V.columns[1].z * nw.y + V.columns[2].z * nw.z,
    ),
  );
});

// ------------------------------------------------------------------ surfaces

/** Per-vertex [surface id, wind sway amplitude], written by the geometry builders. */
const surfAttr = t3.attribute('surf', d.vec2f);

export const SURF = { plain: 0, brick: 1, wood: 2, metal: 3, rock: 4, grass: 5, leaves: 6, plaster: 7, roof: 8, cloth: 9 };

/** Planar projection: vertical faces use (along-face, height), floors use (x, z). */
const planarUV = (p, n) => {
  'use gpu';
  const along = std.select(p.x, p.z, n.x > n.z);
  return std.select(d.vec2f(p.x, p.z), d.vec2f(along, p.y), n.y < 0.6);
};

/**
 * Procedural detail on top of the flat vertex colours: running-bond masonry, wood planks,
 * rock grain, grass patches, leaves, roof tiles and cloth, all in world space so nothing
 * needs UVs or textures.
 */
export const surfaceColor = t3.toTSL(() => {
  'use gpu';
  const base = t3.vertexColor(0).$.xyz;
  const id = surfAttr.$.x;
  const p = t3.positionWorld.$;
  const n = std.abs(std.normalize(t3.normalWorld.$));
  const q = planarUV(p, n);
  const grain = perlin2d.sample(q * 3.1) * 0.5 + 0.5;
  let col = base * (0.94 + grain * 0.1);

  if (id < 0.5) {
    col = base * (0.94 + grain * 0.1);
  } else if (id < 1.5) {
    // Masonry: offset rows, per-stone tint, recessed mortar, flagstones on top faces.
    const size = std.select(d.vec2f(0.62, 0.32), d.vec2f(0.7, 0.7), n.y > 0.6);
    let b = q / size;
    const row = std.floor(b.y);
    b = d.vec2f(b.x + std.fract(row * 0.5) * 1.0, b.y);
    const cell = std.floor(b);
    const f = std.fract(b);
    const edge = std.min(std.min(f.x, 1 - f.x) * size.x, std.min(f.y, 1 - f.y) * size.y);
    const mortar = 1 - std.smoothstep(0.012, 0.035, edge);
    const h = hash2(cell);
    const chip = perlin2d.sample(q * 9.0) * 0.5 + 0.5;
    const stone = base * (0.82 + h * 0.3) * (0.9 + chip * 0.16);
    col = std.mix(stone, base * 0.5, mortar * 0.85);
  } else if (id < 2.5) {
    // Planks with seams and stretched grain.
    const wq = std.select(q, d.vec2f(q.y, q.x), n.y > 0.6);
    const plank = std.floor(wq.y / 0.21);
    const fy = std.fract(wq.y / 0.21);
    const seam = 1 - std.smoothstep(0.0, 0.08, std.min(fy, 1 - fy));
    const streak = perlin2d.sample(d.vec2f(wq.x * 1.2 + plank * 7.3, wq.y * 22)) * 0.5 + 0.5;
    const tone = 0.86 + hash2(d.vec2f(plank, 3.1)) * 0.22;
    col = base * tone * (0.82 + streak * 0.3);
    col = std.mix(col, base * 0.45, seam * 0.8);
  } else if (id < 3.5) {
    // Polished metal: slight brushed variation (reflections come from the env map).
    col = base * (0.9 + perlin2d.sample(q * d.vec2f(1, 30)) * 0.08);
  } else if (id < 4.5) {
    // Rock: layered noise, darker cracks.
    const n1 = perlin2d.sample(q * 0.9);
    const n2 = perlin2d.sample(q * 3.7 + d.vec2f(5.1, 1.3));
    const crack = 1 - std.smoothstep(0.0, 0.05, std.abs(perlin2d.sample(q * 1.6 + d.vec2f(9.2, 4.4))));
    col = base * (0.86 + n1 * 0.18 + n2 * 0.1) * (1 - crack * 0.35);
  } else if (id < 5.5) {
    // Grass: soft clumps of lighter/darker green with speckles.
    const clump = perlin2d.sample(q * 0.35) * 0.5 + 0.5;
    const speck = std.step(0.82, hash2(std.floor(q * 9.0)));
    col = base * (0.84 + clump * 0.26) + d.vec3f(0.03, 0.05, 0.0) * speck;
  } else if (id < 6.5) {
    // Foliage: darker inside the canopy, sunlit tips.
    const tip = std.clamp(surfAttr.$.y * 4.0, 0, 1);
    const leaf = perlin2d.sample(q * 6.0) * 0.5 + 0.5;
    col = base * (0.72 + tip * 0.35) * (0.88 + leaf * 0.2);
  } else if (id < 7.5) {
    col = base * (0.93 + perlin2d.sample(q * 7.0) * 0.06);
  } else if (id < 8.5) {
    // Roof tiles: overlapping rows with a shadowed lower lip.
    const ty = q.y / 0.22;
    const fy = std.fract(ty);
    const tx = std.fract(q.x / 0.3 + std.floor(ty) * 0.5);
    const lip = std.smoothstep(0.65, 1.0, fy);
    const gap = 1 - std.smoothstep(0.0, 0.07, std.min(tx, 1 - tx));
    col = base * (1.0 - lip * 0.3 - gap * 0.25) * (0.92 + hash2(std.floor(d.vec2f(q.x / 0.3, ty))) * 0.14);
  } else {
    // Cloth weave.
    const w = std.sin(q.x * 160) * std.sin(q.y * 160);
    col = base * (0.95 + w * 0.04);
  }
  return d.vec4f(col, 1);
});

export const surfaceRoughness = t3.toTSL(() => {
  'use gpu';
  const id = surfAttr.$.x;
  let r = d.f32(0.86);
  if (id > 2.5 && id < 3.5) r = 0.28;
  if (id > 1.5 && id < 2.5) r = 0.78;
  if (id > 7.5 && id < 8.5) r = 0.62;
  if (id > 4.5 && id < 6.5) r = 0.96;
  return r;
});

export const surfaceMetalness = t3.toTSL(() => {
  'use gpu';
  const id = surfAttr.$.x;
  return std.select(d.f32(0), d.f32(0.85), id > 2.5 && id < 3.5);
});

/** Wind: vertices sway by their baked amplitude, with slow travelling gusts. */
export const windPosition = t3.toTSL(() => {
  'use gpu';
  const p = t3.positionLocal.$;
  const amp = surfAttr.$.y;
  const t = t3.time.$;
  const gust = perlin2d.sample(d.vec2f(p.x * 0.04 + t * 0.12, p.z * 0.04)) * 0.5 + 0.5;
  const sx = std.sin(t * 1.9 + p.x * 0.35 + p.z * 0.21) * (0.45 + gust);
  const sz = std.cos(t * 1.4 + p.z * 0.33 + p.x * 0.12) * (0.25 + gust * 0.5);
  return p + d.vec3f(sx, 0, sz) * amp;
});

/** Soft fresnel rim so characters separate from the busy battlefield. */
export const rimLight = t3.toTSL(() => {
  'use gpu';
  const nrm = std.normalize(t3.normalView.$);
  const v = std.normalize(t3.positionViewDirection.$);
  const f = std.pow(1 - std.clamp(std.dot(nrm, v), 0, 1), 3);
  return d.vec3f(1, 0.96, 0.88) * f * 0.32;
});

// ------------------------------------------------------------------ environment & sky

/** Outdoor light probe (rendered once into the PMREM env map): sky dome, sun, grassy ground. */
export const envSkyColor = t3.toTSL(() => {
  'use gpu';
  const dir = std.normalize(t3.positionWorld.$);
  const y = dir.y;
  const zenith = d.vec3f(0.28, 0.52, 0.86);
  const horizon = d.vec3f(0.86, 0.92, 0.97);
  const ground = d.vec3f(0.36, 0.45, 0.25);
  let col = std.mix(horizon, zenith, std.smoothstep(0.0, 0.7, y));
  col = std.mix(col, ground, std.smoothstep(0.02, -0.25, y));
  const sunDir = std.normalize(d.vec3f(-0.4, 0.82, 0.33));
  const s = std.max(std.dot(dir, sunDir), 0);
  col = col + d.vec3f(1, 0.92, 0.75) * (std.pow(s, 300) * 40 + std.pow(s, 8) * 0.5);
  return d.vec4f(col, 1);
});

const cloudCorner = t3.attribute('corner', d.vec2f);
const cloudCenter = t3.attribute('center', d.vec3f);
const cloudData = t3.attribute('cdata', d.vec4f); // size, seed, shade, stretch

/** Big camera-facing cloud puffs drifting slowly around the islands. */
export const cloudPosition = t3.toTSL(() => {
  'use gpu';
  const c = cloudCorner.$;
  const data = cloudData.$;
  const t = t3.time.$;
  const center = cloudCenter.$ + d.vec3f(std.sin(t * 0.03 + data.y * 6) * 4, std.sin(t * 0.11 + data.y * 3) * 0.4, 0);
  const V = t3.cameraViewMatrix.$;
  const right = d.vec3f(V.columns[0].x, V.columns[1].x, V.columns[2].x);
  const up = d.vec3f(V.columns[0].y, V.columns[1].y, V.columns[2].y);
  return center + right * c.x * data.x * data.w + up * c.y * data.x;
});

export const cloudColor = t3.toTSL(() => {
  'use gpu';
  const c = cloudCorner.$;
  const data = cloudData.$;
  const t = t3.time.$;
  const r = std.length(c * 2);
  const q = c * 2.4 + d.vec2f(data.y * 13 + t * 0.01, data.y * 7);
  const fbm = perlin2d.sample(q) * 0.55 + perlin2d.sample(q * 2.1) * 0.3 + perlin2d.sample(q * 4.3) * 0.15;
  const mask = 1 - std.smoothstep(0.35, 1.0, r - fbm * 0.45);
  const lit = std.mix(d.vec3f(0.72, 0.78, 0.88), d.vec3f(1.0, 0.99, 0.96), std.clamp(c.y + 0.6 + fbm * 0.5, 0, 1));
  return d.vec4f(lit * data.z, mask * 0.85);
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
