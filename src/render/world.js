import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ARENA_W, ARENA_H, RIVER_Y, RIVER_HALF, BRIDGES_X, TOWER_LAYOUT } from '../sim/constants.js';
import { fieldColor, fieldNormal, riverColor, riverNormal, surfaceColor, surfaceRoughness, surfaceMetalness, windPosition, cloudPosition, cloudColor, SURF } from './shaders.js';
import { makeTowerObject, makeSurfaceMaterial } from './models.js';

const tileToWorld = (x, y, h = 0) => new THREE.Vector3(x - ARENA_W / 2, h, ARENA_H / 2 - y);

/** Deterministic RNG so the diorama is identical on every load. */
function rng(seed) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

const PALETTE = {
  grass: 0x8cc84b,
  grassDark: 0x6fae3c,
  islandTop: [0xb8d548, 0x9fcb45, 0x86c24a],
  rock: [0x8f949c, 0x7d8189, 0xa3a6ab],
  rockDark: 0x5f6369,
  stone: 0xd9cfb4,
  stoneDark: 0xb9ad8f,
  wood: 0x8a5a33,
  woodDark: 0x5e3b20,
  wall: [0xf2e6cc, 0xe9d8b5, 0xf6efe0],
  roof: [0xe0484a, 0xd23b3f, 0x2fb5a6, 0x24a092, 0x3c8ee0],
  pine: [0x2c8f43, 0x35a24c, 0x26803c, 0x3daa55],
  boulder: 0x8c9891,
  roofRed: 0xd8383a,
  roofBlue: 0x3a86d8,
  earth: 0x8a5532,
  earthDark: 0x6b4126,
  bankStone: 0x9aa1a6,
  bankGrass: 0x72c23e,
  plank: 0xb47c45,
  plankDark: 0x9a6638,
  post: 0xc48d52,
  hedge: 0x3fae5c,
};

const SURF_BY_COLOR = new Map([
  ...[PALETTE.grass, PALETTE.grassDark, ...PALETTE.islandTop].map((c) => [c, SURF.grass]),
  ...[...PALETTE.rock, PALETTE.rockDark].map((c) => [c, SURF.rock]),
  ...[PALETTE.stone, PALETTE.stoneDark].map((c) => [c, SURF.brick]),
  ...[PALETTE.wood, PALETTE.woodDark].map((c) => [c, SURF.wood]),
  ...PALETTE.wall.map((c) => [c, SURF.plaster]),
  ...PALETTE.roof.map((c) => [c, SURF.roof]),
  ...[...PALETTE.pine, PALETTE.hedge].map((c) => [c, SURF.leaves]),
]);

/**
 * Paints a flat vertex colour onto a (non-indexed) geometry so pieces can be merged, plus
 * the `surf` attribute: [surface shader id, wind sway amplitude from `sway(y)`].
 */
function tint(geo, hex, sway = null, surf = SURF_BY_COLOR.get(hex) ?? SURF.plain) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const pos = g.attributes.position;
  const n = pos.count;
  const arr = new Float32Array(n * 3);
  const sa = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    c.toArray(arr, i * 3);
    sa[i * 2] = surf;
    sa[i * 2 + 1] = sway ? sway(pos.getY(i)) : 0;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g.setAttribute('surf', new THREE.BufferAttribute(sa, 2));
  g.deleteAttribute('uv');
  return g;
}

const at = (geo, x, y, z, ry = 0, s = 1) => geo.scale(s, s, s).rotateY(ry).translate(x, y, z);

/** Shades vertex colours from `bottom` to `top` (multipliers) over the y range of a geometry. */
function gradient(g, y0, y1, bottom, top) {
  const pos = g.attributes.position;
  const col = g.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    const k = THREE.MathUtils.clamp((pos.getY(i) - y0) / (y1 - y0), 0, 1);
    const m = bottom + (top - bottom) * k;
    col.setXYZ(i, col.getX(i) * m, col.getY(i) * m, col.getZ(i) * m);
  }
  return g;
}

/** Nudges shared vertices of an indexed geometry so low-poly shapes look hand-faceted. */
function jitter(g, r, amount, keepY = false) {
  const pos = g.attributes.position;
  const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    if (!seen.has(key)) seen.set(key, [(r() - 0.5) * amount, keepY ? 0 : (r() - 0.5) * amount, (r() - 0.5) * amount]);
    const [dx, dy, dz] = seen.get(key);
    pos.setXYZ(i, pos.getX(i) + dx, pos.getY(i) + dy, pos.getZ(i) + dz);
  }
  return g;
}

/** Faceted four-tier pine: dark undersides, sunlit tips, a little wobble in every tier. */
function pine(r, x, y, z, s) {
  const base = PALETTE.pine[Math.floor(r() * PALETTE.pine.length)];
  const h = 3.1 * s;
  const sway = (vy) => Math.pow(Math.max(0, (vy - y) / h), 2) * 0.2 * s;
  const lean = (r() - 0.5) * 0.12;
  const parts = [tint(at(new THREE.CylinderGeometry(0.13, 0.2, 0.75, 6), x, y + 0.37 * s, z, 0, s), PALETTE.woodDark, sway, SURF.wood)];
  const tiers = [
    [1.05, 1.25, 0.5],
    [0.84, 1.1, 1.05],
    [0.62, 0.98, 1.55],
    [0.38, 0.86, 2.02],
  ];
  tiers.forEach(([rad, th, by], i) => {
    const cone = jitter(new THREE.ConeGeometry(rad, th, 7, 1), r, 0.12 * rad);
    cone.rotateZ(lean).rotateX(lean * 0.6);
    const g = tint(at(cone, x + lean * by * s, y + (by + th / 2) * s, z, r() * Math.PI, s), base, sway, SURF.leaves);
    const c = new THREE.Color(base).offsetHSL((r() - 0.5) * 0.02, 0, (r() - 0.5) * 0.04 + i * 0.015);
    const col = g.attributes.color;
    for (let k = 0; k < col.count; k++) col.setXYZ(k, c.r, c.g, c.b);
    parts.push(gradient(g, y + by * s, y + (by + th) * s, 0.62, 1.12));
  });
  return parts;
}

/** Low-poly grey-green boulder; `n` extra pebbles huddle around it. */
function boulder(r, x, y, z, s, n = 2) {
  const parts = [];
  const one = (px, pz, ps) => {
    const g = jitter(new THREE.IcosahedronGeometry(1, 0), r, 0.35);
    g.scale(ps * (0.9 + r() * 0.3), ps * (0.6 + r() * 0.25), ps * (0.85 + r() * 0.3)).rotateY(r() * Math.PI);
    g.translate(px, y + ps * 0.35, pz);
    parts.push(gradient(tint(g, PALETTE.boulder, null, SURF.rock), y, y + ps * 1.1, 0.7, 1.08));
  };
  one(x, z, s);
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    one(x + Math.cos(a) * s * 1.35, z + Math.sin(a) * s * 1.35, s * (0.3 + r() * 0.2));
  }
  return parts;
}

/** A tuft of three crossed grass blades; tips carry the sway and a lighter colour. */
function grassTuft(r, x, y, z, s) {
  const pos = [];
  const col = [];
  const surf = [];
  const root = new THREE.Color(PALETTE.grassDark).multiplyScalar(0.7);
  const tipCol = new THREE.Color(0xb9e06a).lerp(new THREE.Color(0x8fd14f), r());
  for (let b = 0; b < 3; b++) {
    const a = r() * Math.PI;
    const dx = Math.cos(a) * 0.09 * s;
    const dz = Math.sin(a) * 0.09 * s;
    const h = (0.28 + r() * 0.3) * s;
    const lean = (r() - 0.5) * 0.2 * s;
    const ox = (r() - 0.5) * 0.18 * s;
    const oz = (r() - 0.5) * 0.18 * s;
    pos.push(x + ox - dx, y, z + oz - dz, x + ox + dx, y, z + oz + dz, x + ox + lean, y + h, z + oz + lean * 0.5);
    root.toArray(col, col.length);
    root.toArray(col, col.length);
    tipCol.toArray(col, col.length);
    surf.push(SURF.plain, 0, SURF.plain, 0, SURF.plain, 0.12 * s);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('surf', new THREE.Float32BufferAttribute(surf, 2));
  g.computeVertexNormals();
  // Blades lit as if facing up so both sides catch the sun.
  const nrm = g.attributes.normal;
  for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
  return g;
}

/** Pitched roof (two slabs meeting at a ridge along Z) with gable fill, for a w x d footprint at height h. */
function gableRoof(parts, w, d, h, roof, wall, pitch = 0.72) {
  const span = w / 2 + 0.18;
  const rise = span * Math.tan(pitch);
  const slab = span / Math.cos(pitch) + 0.06;
  for (const side of [-1, 1]) {
    const g = new THREE.BoxGeometry(slab, 0.12, d + 0.4).rotateZ(-side * pitch).translate((side * span) / 2, h + rise / 2 + 0.04, 0);
    parts.push(gradient(tint(g, roof, null, SURF.roof), h, h + rise, 0.78, 1.08));
  }
  parts.push(tint(new THREE.BoxGeometry(0.16, 0.14, d + 0.46).translate(0, h + rise + 0.07, 0), shadeHex(roof, 0.7), null, SURF.roof));
  // Gable ends: a triangular prism of wall under the slabs.
  const tri = new THREE.CylinderGeometry(1, 1, d, 3).rotateX(-Math.PI / 2);
  const gh = (w / 2) * Math.tan(pitch);
  tri.scale(w / 1.732, gh / 1.5, 1).translate(0, h + gh / 3, 0);
  parts.push(tint(tri, wall, null, SURF.plaster));
  return rise;
}

const shadeHex = (hex, k) => new THREE.Color(hex).multiplyScalar(k).getHex();

/**
 * Storybook cottage: stone foundation, white plaster walls in a dark timber frame,
 * steep coloured roof with ridge cap, chimney, windows, door, and an optional striped
 * awning (red houses) or wooden porch steps (blue houses).
 */
function cottage(r, x, y, z, s, ry, roof) {
  const parts = [];
  const w = 1.9 + r() * 0.7;
  const d = 1.7 + r() * 0.6;
  const h = 1.35 + r() * 0.45;
  const wall = PALETTE.wall[Math.floor(r() * PALETTE.wall.length)];
  const timber = PALETTE.woodDark;
  parts.push(gradient(tint(new THREE.BoxGeometry(w + 0.2, 0.42, d + 0.2).translate(0, 0.21, 0), PALETTE.rock[0], null, SURF.brick), 0, 0.42, 0.7, 1));
  parts.push(tint(new THREE.BoxGeometry(w, h, d).translate(0, 0.42 + h / 2, 0), wall, null, SURF.plaster));
  const top = 0.42 + h;
  // Timber frame: corner posts, mid and top beams, diagonal braces on the long sides.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push(tint(new THREE.BoxGeometry(0.13, h, 0.13).translate(sx * w / 2, 0.42 + h / 2, sz * d / 2), timber, null, SURF.wood));
  }
  for (const yy of [0.42 + h * 0.5, top - 0.05]) {
    parts.push(tint(new THREE.BoxGeometry(w + 0.08, 0.1, 0.08).translate(0, yy, d / 2 + 0.01), timber, null, SURF.wood));
    parts.push(tint(new THREE.BoxGeometry(w + 0.08, 0.1, 0.08).translate(0, yy, -d / 2 - 0.01), timber, null, SURF.wood));
    parts.push(tint(new THREE.BoxGeometry(0.08, 0.1, d + 0.08).translate(w / 2 + 0.01, yy, 0), timber, null, SURF.wood));
    parts.push(tint(new THREE.BoxGeometry(0.08, 0.1, d + 0.08).translate(-w / 2 - 0.01, yy, 0), timber, null, SURF.wood));
  }
  for (const sx of [-1, 1]) {
    const brace = new THREE.BoxGeometry(0.07, h * 0.62, 0.06).rotateZ(sx * 0.6).translate(sx * w * 0.32, 0.42 + h * 0.25, d / 2 + 0.03);
    parts.push(tint(brace, timber, null, SURF.wood));
  }
  // Windows (glass + frame) on the front and sides, door in the middle.
  const win = (wx, wy, wz, ry2) => {
    parts.push(tint(new THREE.BoxGeometry(0.4, 0.42, 0.05).rotateY(ry2).translate(wx, wy, wz), 0xf1ebdd, null, SURF.wood));
    parts.push(tint(new THREE.BoxGeometry(0.3, 0.32, 0.06).rotateY(ry2).translate(wx, wy, wz), 0x34506e, null, SURF.metal));
  };
  win(-w * 0.3, 0.42 + h * 0.72, d / 2 + 0.04, 0);
  win(w * 0.3, 0.42 + h * 0.72, d / 2 + 0.04, 0);
  win(w / 2 + 0.04, 0.42 + h * 0.62, 0, Math.PI / 2);
  win(-w / 2 - 0.04, 0.42 + h * 0.62, 0, Math.PI / 2);
  parts.push(tint(new THREE.BoxGeometry(0.46, 0.78, 0.07).translate(0, 0.42 + 0.39, d / 2 + 0.04), PALETTE.wood, null, SURF.wood));
  const rise = gableRoof(parts, w, d, top, roof, wall);
  // Chimney through one roof slab.
  const cx = w * 0.22;
  parts.push(gradient(tint(new THREE.BoxGeometry(0.32, rise + 0.7, 0.32).translate(cx, top + (rise + 0.7) / 2, -d * 0.18), PALETTE.rock[1], null, SURF.brick), top, top + rise + 0.7, 0.75, 1.05));
  parts.push(tint(new THREE.BoxGeometry(0.4, 0.1, 0.4).translate(cx, top + rise + 0.72, -d * 0.18), PALETTE.rockDark, null, SURF.rock));
  if (roof === PALETTE.roofRed) {
    // Red and white striped awning over the door.
    for (let i = 0; i < 6; i++) {
      const g = new THREE.BoxGeometry(0.16, 0.05, 0.5).rotateX(0.45).translate(-0.4 + i * 0.16, 0.42 + 0.95, d / 2 + 0.24);
      parts.push(tint(g, i % 2 ? 0xf6f1e8 : 0xd8383a, null, SURF.cloth));
    }
  } else {
    // Wooden porch steps.
    for (let i = 0; i < 3; i++) parts.push(tint(new THREE.BoxGeometry(0.8, 0.12, 0.22).translate(0, 0.06 + i * 0.12, d / 2 + 0.62 - i * 0.2), PALETTE.wood, null, SURF.wood));
  }
  return parts.map((p) => at(p, x, y, z, ry, s));
}

/** Round watchtower: stone base, plaster drum, timber ring and a tall cone roof with a pennant. */
function roundTower(r, x, y, z, s, roof) {
  const parts = [];
  parts.push(gradient(tint(new THREE.CylinderGeometry(0.95, 1.05, 1.0, 12).translate(0, 0.5, 0), PALETTE.rock[0], null, SURF.brick), 0, 1, 0.7, 1));
  parts.push(tint(new THREE.CylinderGeometry(0.82, 0.86, 1.7, 12).translate(0, 1.85, 0), PALETTE.wall[0], null, SURF.plaster));
  parts.push(tint(new THREE.CylinderGeometry(0.88, 0.88, 0.12, 12).translate(0, 2.7, 0), PALETTE.woodDark, null, SURF.wood));
  parts.push(gradient(tint(new THREE.ConeGeometry(1.15, 1.6, 12).translate(0, 3.55, 0), roof, null, SURF.roof), 2.75, 4.35, 0.78, 1.1));
  parts.push(tint(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 4).translate(0, 4.75, 0), PALETTE.woodDark));
  parts.push(tint(new THREE.BoxGeometry(0.42, 0.24, 0.03).translate(0.22, 5.0, 0), roof, null, SURF.cloth));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    parts.push(tint(new THREE.BoxGeometry(0.24, 0.32, 0.05).rotateY(-a).translate(Math.sin(a) * 0.85, 2.0, Math.cos(a) * 0.85), 0x34506e, null, SURF.metal));
  }
  return parts.map((p) => at(p, x, y, z, r() * Math.PI, s));
}

/** Irregular radius around an island blob so outlines look hand-sculpted rather than circular. */
const blobRadius = (rad, seed) => (a) => rad * (1 + 0.09 * Math.sin(3 * a + seed) + 0.05 * Math.sin(5 * a + seed * 2.3));

function shapeRing(g, cx, cz, f) {
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const pz = pos.getZ(i);
    const len = Math.hypot(px, pz);
    if (len < 1e-4) continue;
    const k = f(Math.atan2(pz, px));
    pos.setXYZ(i, cx + px * k, pos.getY(i), cz + pz * k);
  }
  return g;
}

/**
 * One chunk of floating island: thick bevelled grass cap, brown earth sides, a rocky
 * underside and grey boulders hugging the rim. Several overlapping blobs make one big island.
 */
function islandBlob(r, cx, cz, rad, depth, topY = 0) {
  const parts = [];
  const f = blobRadius(1, r() * 10);
  const grass = PALETTE.islandTop[Math.floor(r() * PALETTE.islandTop.length)];
  const cap = shapeRing(new THREE.CylinderGeometry(rad, rad * 0.97, 0.4, 14, 1), cx, cz, f).translate(0, topY - 0.2, 0);
  parts.push(gradient(tint(cap, grass, null, SURF.grass), topY - 0.4, topY, 0.78, 1.06));
  const lip = shapeRing(new THREE.CylinderGeometry(rad * 0.98, rad * 0.95, 0.18, 14, 1), cx, cz, f).translate(0, topY - 0.48, 0);
  parts.push(tint(lip, shadeHex(grass, 0.75), null, SURF.grass));
  const earth = shapeRing(new THREE.CylinderGeometry(rad * 0.95, rad * 0.72, depth, 14, 2), cx, cz, f).translate(0, topY - 0.57 - depth / 2, 0);
  parts.push(gradient(tint(earth, PALETTE.earth, null, SURF.rock), topY - 0.57 - depth, topY - 0.57, 0.6, 1.0));
  const under = shapeRing(new THREE.ConeGeometry(rad * 0.72, depth * 1.3, 14, 1).rotateX(Math.PI), cx, cz, f);
  under.translate(0, topY - 0.57 - depth - depth * 0.65, 0);
  parts.push(gradient(tint(under, PALETTE.earthDark, null, SURF.rock), topY - 0.57 - depth * 2.3, topY - 0.57 - depth, 0.55, 0.9));
  const rocks = Math.round(rad * 1.6);
  for (let i = 0; i < rocks; i++) {
    const a = (i / rocks) * Math.PI * 2 + r() * 0.5;
    const rr = rad * f(a) * (0.86 + r() * 0.08);
    parts.push(...boulder(r, cx + Math.cos(a) * rr, topY - 0.6 - depth * (0.45 + r() * 0.45), cz + Math.sin(a) * rr, 0.35 + r() * 0.45, r() < 0.4 ? 1 : 0));
  }
  return parts;
}

export function buildWorld(engine) {
  const scene = engine.scene;
  const r = rng(1337);
  const vcMat = makeSurfaceMaterial();
  const grassMat = makeSurfaceMaterial({ flat: false });
  grassMat.side = THREE.DoubleSide;
  const highOnly = [];
  const bobbers = [];

  const mergedMesh = (parts, { shadows = true } = {}) => {
    const mesh = new THREE.Mesh(mergeGeometries(parts), vcMat);
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    return mesh;
  };
  const grassMesh = (tufts) => {
    const mesh = new THREE.Mesh(mergeGeometries(tufts), grassMat);
    mesh.receiveShadow = true;
    return mesh;
  };

  // ---------------------------------------------------------------- main island

  const field = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_W, ARENA_H).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial({ roughness: 0.95 }));
  field.material.colorNode = fieldColor;
  field.material.normalNode = fieldNormal;
  field.receiveShadow = true;
  scene.add(field);

  const islandParts = [];
  const IW = ARENA_W + 12;
  const IH = ARENA_H + 10;
  islandParts.push(tint(new THREE.BoxGeometry(IW, 1.2, IH).translate(0, -0.62, 0), PALETTE.grass));
  islandParts.push(tint(new THREE.BoxGeometry(IW + 0.6, 3.5, IH + 0.6).translate(0, -2.9, 0), PALETTE.rock[0]));
  const underside = new THREE.ConeGeometry(IW * 0.72, 22, 7).rotateX(Math.PI).scale(1, 1, IH / IW).translate(0, -15.5, 0);
  islandParts.push(tint(underside, PALETTE.rockDark));
  for (let i = 0; i < 10; i++) {
    const a = r() * Math.PI * 2;
    const rock = new THREE.DodecahedronGeometry(2 + r() * 3, 0).translate(Math.cos(a) * IW * 0.4, -6 - r() * 8, Math.sin(a) * IH * 0.4);
    islandParts.push(tint(rock, PALETTE.rock[i % 3]));
  }

  // Low cream stone walls with battlements just outside the field.
  const wallH = 0.9;
  const addWall = (w, dd, x, z) => {
    islandParts.push(tint(new THREE.BoxGeometry(w, wallH, dd).translate(x, wallH / 2 - 0.05, z), PALETTE.stone));
    const along = w > dd;
    const len = along ? w : dd;
    for (let i = 0; i < len / 1.3; i++) {
      const off = -len / 2 + 0.65 + i * 1.3;
      islandParts.push(tint(new THREE.BoxGeometry(0.55, 0.4, 0.55).translate(along ? x + off : x, wallH + 0.15, along ? z : z + off), PALETTE.stoneDark));
    }
  };
  const hw = ARENA_W / 2 + 0.4;
  const hh = ARENA_H / 2 + 0.4;
  addWall(ARENA_W + 1.6, 0.8, 0, -hh);
  addWall(ARENA_W + 1.6, 0.8, 0, hh);
  addWall(0.8, ARENA_H, -hw, 0);
  addWall(0.8, ARENA_H, hw, 0);
  for (const [x, z] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) {
    islandParts.push(tint(new THREE.CylinderGeometry(0.9, 1, 1.9, 8).translate(x, 0.9, z), PALETTE.stone));
    islandParts.push(tint(new THREE.ConeGeometry(1.15, 1.3, 8).translate(x, 2.5, z), PALETTE.roof[4]));
  }

  // Forest: lots of pines scattered at random around the walls, and a few boulders.
  const decoParts = [];
  const extraParts = [];
  const planted = [];
  const free = (x, z, gap) => planted.every((p) => Math.hypot(p.x - x, p.z - z) > gap + p.gap);
  const inMargin = (x, z, pad) => (Math.abs(x) > hw + pad || Math.abs(z) > hh + pad) && Math.abs(x) < IW / 2 - 0.5 && Math.abs(z) < IH / 2 - 0.5;
  for (let tries = 0, rocks = 0; tries < 2600 && rocks < 7; tries++) {
    const x = (r() - 0.5) * IW;
    const z = (r() - 0.5) * IH;
    const s = 0.45 + r() * 0.4;
    if (!inMargin(x, z, 1.8) || !free(x, z, s * 1.6)) continue;
    planted.push({ x, z, gap: s * 1.6 });
    decoParts.push(...boulder(r, x, 0, z, s, 1 + Math.floor(r() * 2)));
    rocks++;
  }
  for (let tries = 0, trees = 0; tries < 9000 && trees < 170; tries++) {
    const x = (r() - 0.5) * IW;
    const z = (r() - 0.5) * IH;
    const s = 0.7 + r() * 0.55;
    if (!inMargin(x, z, 1.25) || !free(x, z, s * 0.62)) continue;
    planted.push({ x, z, gap: s * 0.62 });
    (trees % 3 === 2 ? extraParts : decoParts).push(...pine(r, x, 0, z, s));
    trees++;
  }
  for (let i = 0; i < 8; i++) {
    const side = i % 2 ? 1 : -1;
    const z = -ARENA_H / 2 + 3 + Math.floor(i / 2) * ((ARENA_H - 6) / 3);
    const team = z > 0 ? 0 : 1;
    const x = side * (ARENA_W / 2 + 0.4);
    decoParts.push(tint(new THREE.CylinderGeometry(0.05, 0.05, 2.4, 4).translate(x, 1.6, z), PALETTE.woodDark));
    decoParts.push(tint(new THREE.BoxGeometry(0.06, 0.9, 0.6).translate(x, 2.3, z + 0.32), team === 0 ? 0x2f6fe0 : 0xd8383c, null, SURF.cloth));
  }

  const island = new THREE.Group();
  island.add(mergedMesh(islandParts), mergedMesh(decoParts));
  const extra = mergedMesh(extraParts);
  island.add(extra);
  highOnly.push(extra);

  // Grass tufts on the island margin around the walls.
  const tufts = [];
  for (let i = 0; i < 1800; i++) {
    const x = (r() - 0.5) * (IW - 0.4);
    const z = (r() - 0.5) * (IH - 0.4);
    if (Math.abs(x) < hw + 0.6 && Math.abs(z) < hh + 0.6) continue;
    tufts.push(grassTuft(r, x, 0, z, 0.8 + r() * 0.6));
  }
  const tuftMesh = grassMesh(tufts);
  island.add(tuftMesh);
  highOnly.push(tuftMesh);
  scene.add(island);

  // River: lit, glossy water so it picks up sun glints and sky reflections.
  const river = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA_W, 2.2, 1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshStandardNodeMaterial({ roughness: 0.07, metalness: 0 }),
  );
  river.material.colorNode = riverColor;
  river.material.normalNode = riverNormal;
  river.position.set(0, 0.03, 0);
  scene.add(river);
  // Notch the grass under the river so the water reads as sunken.
  field.position.y = 0;

  // River banks: chunky grass-topped stone blocks, a few pebbles and lily pads.
  const bankParts = [];
  for (const side of [-1, 1]) {
    for (let x = -ARENA_W / 2; x < ARENA_W / 2 - 0.2; ) {
      const len = Math.min(0.85 + r() * 0.5, ARENA_W / 2 - x);
      const underBridge = BRIDGES_X.some((bx) => Math.abs(x + len / 2 - tileToWorld(bx, 0).x) < 1.05 + len / 2);
      if (underBridge) {
        x += len;
        continue;
      }
      const hgt = 0.3 + r() * 0.07;
      const cz = side * (RIVER_HALF + 0.14 + r() * 0.03);
      const ry = (r() - 0.5) * 0.06;
      const stone = new THREE.BoxGeometry(len - 0.04, hgt, 0.36).rotateY(ry).translate(x + len / 2, hgt / 2 - 0.02, cz);
      bankParts.push(gradient(tint(stone, PALETTE.bankStone, null, SURF.rock), 0, hgt, 0.72, 1.05));
      const grass = new THREE.BoxGeometry(len + 0.02, 0.08, 0.42).rotateY(ry).translate(x + len / 2, hgt + 0.03, cz + side * 0.02);
      bankParts.push(tint(grass, PALETTE.bankGrass, null, SURF.grass));
      if (r() < 0.18) bankParts.push(...boulder(r, x + r() * len, hgt, cz - side * 0.18, 0.09 + r() * 0.06, 0));
      x += len;
    }
  }
  const riverDeco = [];
  for (let i = 0; i < 6; i++) {
    const x = (r() - 0.5) * (ARENA_W - 2);
    if (BRIDGES_X.some((bx) => Math.abs(x - tileToWorld(bx, 0).x) < 1.6)) continue;
    const z = (r() - 0.5) * 1.3;
    const pad = new THREE.CylinderGeometry(0.16 + r() * 0.1, 0.16, 0.025, 10, 1, false, 0.5, Math.PI * 2 - 0.5).translate(x, 0.05, z);
    riverDeco.push(tint(pad, 0x58b63a, null, SURF.leaves));
    if (r() < 0.4) riverDeco.push(tint(new THREE.SphereGeometry(0.045, 6, 4).translate(x + 0.05, 0.08, z), 0xf4a6c8));
  }
  for (let i = 0; i < 4; i++) riverDeco.push(...boulder(r, (r() - 0.5) * (ARENA_W - 1), 0.02, (r() < 0.5 ? -1 : 1) * (0.75 + r() * 0.2), 0.1 + r() * 0.06, 0));
  scene.add(mergedMesh([...bankParts, ...riverDeco]));

  // Bridges: plank decks on beams, chunky corner posts, team-coloured end bumpers.
  const bridgeParts = [];
  for (const bx of BRIDGES_X) {
    const c = tileToWorld(bx, RIVER_Y);
    const L = 3.7;
    for (let i = 0; i < 8; i++) {
      const z = -L / 2 + 0.25 + i * ((L - 0.5) / 7);
      const plank = new THREE.BoxGeometry(2.18, 0.13, 0.4).rotateY((r() - 0.5) * 0.04).translate(c.x, 0.34 + (r() - 0.5) * 0.02, z);
      bridgeParts.push(gradient(tint(plank, i % 2 ? PALETTE.plank : PALETTE.plankDark, null, SURF.wood), 0.27, 0.4, 0.8, 1.05));
    }
    for (const sx of [-1, 1]) {
      bridgeParts.push(tint(new THREE.BoxGeometry(0.24, 0.24, L).translate(c.x + sx * 1.14, 0.3, 0), PALETTE.woodDark, null, SURF.wood));
      for (const ez of [-1, 1]) {
        const px = c.x + sx * 1.14;
        const pz = ez * (L / 2 - 0.2);
        bridgeParts.push(gradient(tint(new THREE.BoxGeometry(0.4, 0.78, 0.4).translate(px, 0.42, pz), PALETTE.post, null, SURF.wood), 0, 0.8, 0.75, 1.05));
        bridgeParts.push(tint(new THREE.BoxGeometry(0.46, 0.09, 0.46).translate(px, 0.85, pz), PALETTE.woodDark, null, SURF.wood));
        // Blue bumpers on the player's end of each bridge, red on the opponent's.
        const bumper = new THREE.BoxGeometry(0.26, 0.5, 0.46).translate(px + sx * 0.3, 0.3, pz);
        bridgeParts.push(gradient(tint(bumper, ez > 0 ? 0x2f74e6 : 0xd8392f), 0, 0.45, 0.7, 1.1));
      }
    }
    for (const sz of [-0.7, 0.7]) bridgeParts.push(tint(new THREE.BoxGeometry(2.3, 0.14, 0.22).translate(c.x, 0.2, sz), PALETTE.woodDark, null, SURF.wood));
  }
  scene.add(mergedMesh(bridgeParts));

  // ---------------------------------------------------------------- floating islands

  // Villages are several blobs fused into one big island; hamlets and groves are smaller.
  const KINDS = [
    ...Array(5).fill('village'),
    ...Array(8).fill('hamlet'),
    ...Array(10).fill('grove'),
  ];
  // Pack islands snugly around the arena: for each one, try many directions and keep the
  // spot closest to the arena's edge that doesn't overlap an island already placed.
  const ARENA_GAP = 1.4;
  const ISLAND_GAP = 0.7;
  const islandSpots = [];
  // Small house islets pressed right up against the arena, spaced evenly around its edge.
  const ISLETS = 18;
  const ISLET_RAD = 2.4;
  const ISLET_GAP = 0.35;
  {
    const hx = IW / 2 + ISLET_RAD + ISLET_GAP;
    const hz = IH / 2 + ISLET_RAD + ISLET_GAP;
    const perimeter = 4 * (hx + hz);
    for (let i = 0; i < ISLETS; i++) {
      let t = ((i + 0.3 + r() * 0.4) / ISLETS) * perimeter;
      let x;
      let z;
      if ((t -= 2 * hx) < 0) [x, z] = [hx + t, -hz];
      else if ((t -= 2 * hz) < 0) [x, z] = [hx, hz + t];
      else if ((t -= 2 * hx) < 0) [x, z] = [-hx - t, hz];
      else [x, z] = [-hx, -hz - (t - 2 * hz)];
      islandSpots.push({ x, z, rad: ISLET_RAD, kind: 'islet', score: 0 });
    }
  }
  for (const kind of KINDS) {
    const rad = kind === 'village' ? 9.5 : kind === 'hamlet' ? 4.8 : 2.9;
    let best = null;
    for (let tries = 0; tries < 160; tries++) {
      const a = r() * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const edge = Math.min(IW / 2 / Math.max(Math.abs(dx), 1e-3), IH / 2 / Math.max(Math.abs(dz), 1e-3));
      const dist = edge + rad + ARENA_GAP + r() * r() * 10;
      const x = dx * dist;
      const z = dz * dist;
      if (Math.abs(x) < IW / 2 + rad + ARENA_GAP && Math.abs(z) < IH / 2 + rad + ARENA_GAP) continue;
      if (islandSpots.some((s) => Math.hypot(s.x - x, s.z - z) < s.rad + rad + ISLAND_GAP)) continue;
      const score = dist - edge;
      if (!best || score < best.score) best = { x, z, rad, kind, score };
    }
    if (best) islandSpots.push(best);
  }

  islandSpots.forEach((spot, idx) => {
    const parts = [];
    const blobs = [];
    if (spot.kind === 'village') {
      blobs.push({ x: 0, z: 0, rad: 4.6 + r() * 0.8, top: 0 });
      const n = 2 + Math.floor(r() * 2);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + r() * 0.8;
        const rad = 2.6 + r() * 1.3;
        const off = blobs[0].rad * 0.62 + rad * 0.5;
        blobs.push({ x: Math.cos(a) * off, z: Math.sin(a) * off, rad, top: (r() - 0.5) * 0.5 });
      }
    } else if (spot.kind === 'hamlet') {
      blobs.push({ x: 0, z: 0, rad: 3.4 + r() * 0.9, top: 0 });
      if (r() < 0.6) {
        const a = r() * Math.PI * 2;
        blobs.push({ x: Math.cos(a) * 3.2, z: Math.sin(a) * 3.2, rad: 2.0 + r() * 0.8, top: (r() - 0.5) * 0.4 });
      }
    } else if (spot.kind === 'islet') blobs.push({ x: 0, z: 0, rad: 1.85 + r() * 0.4, top: 0 });
    else blobs.push({ x: 0, z: 0, rad: 1.7 + r() * 1.3, top: 0 });
    for (const b of blobs) parts.push(...islandBlob(r, b.x, b.z, b.rad, 1.6 + b.rad * 0.35, b.top));

    // Buildings on the biggest blob, trees and a rock scattered over the rest.
    const used = [];
    const spotOn = (b, minR, maxR, gap) => {
      for (let t = 0; t < 30; t++) {
        const a = r() * Math.PI * 2;
        const d = b.rad * (minR + r() * (maxR - minR));
        const p = { x: b.x + Math.cos(a) * d, z: b.z + Math.sin(a) * d, gap };
        if (used.every((u) => Math.hypot(u.x - p.x, u.z - p.z) > u.gap + gap)) {
          used.push(p);
          return p;
        }
      }
      return null;
    };
    const main = blobs[0];
    if (spot.kind === 'village') {
      const t = spotOn(main, 0.1, 0.35, 1.5);
      if (t) parts.push(...roundTower(r, t.x, main.top, t.z, 0.95, PALETTE.roofRed));
      for (const roof of [PALETTE.roofBlue, PALETTE.roofRed]) {
        const p = spotOn(main, 0.35, 0.6, 1.7);
        if (p) parts.push(...cottage(r, p.x, main.top, p.z, 0.85, Math.atan2(-p.x, -p.z) + Math.PI, roof));
      }
      const extra = blobs[1 + Math.floor(r() * (blobs.length - 1))];
      const p = spotOn(extra, 0, 0.3, 1.6);
      if (p) parts.push(...cottage(r, p.x, extra.top, p.z, 0.8, r() * Math.PI * 2, r() < 0.5 ? PALETTE.roofBlue : PALETTE.roofRed));
    } else if (spot.kind === 'hamlet') {
      const p = spotOn(main, 0, 0.25, 1.7);
      if (p) parts.push(...cottage(r, p.x, main.top, p.z, 0.8, r() * Math.PI * 2, r() < 0.5 ? PALETTE.roofBlue : PALETTE.roofRed));
    } else if (spot.kind === 'islet') {
      // One building per islet, facing the arena: mostly cottages, now and then a tower.
      const p = spotOn(main, 0, 0.12, 1.2);
      const face = Math.atan2(-spot.x, -spot.z);
      const roof = idx % 2 ? PALETTE.roofBlue : PALETTE.roofRed;
      if (p && idx % 5 === 3) parts.push(...roundTower(r, p.x, 0, p.z, 0.6, PALETTE.roofRed));
      else if (p) parts.push(...cottage(r, p.x, 0, p.z, 0.62, face, roof));
    }
    for (const b of blobs) {
      const trees = spot.kind === 'grove' ? 1 + Math.floor(r() * 3) : Math.round(b.rad * 0.9);
      for (let i = 0; i < trees; i++) {
        const p = spotOn(b, 0.3, 0.8, 0.6);
        if (p) parts.push(...pine(r, p.x, b.top, p.z, 0.75 + r() * 0.5));
      }
      if (r() < 0.6) {
        const p = spotOn(b, 0.2, 0.7, 0.6);
        if (p) parts.push(...boulder(r, p.x, b.top, p.z, 0.4 + r() * 0.3, 1));
      }
    }

    const mesh = mergedMesh(parts);
    const islandTufts = [];
    for (const b of blobs) {
      for (let i = 0; i < b.rad * 8; i++) {
        const a = r() * Math.PI * 2;
        const dd = Math.sqrt(r()) * b.rad * 0.85;
        const x = b.x + Math.cos(a) * dd;
        const z = b.z + Math.sin(a) * dd;
        if (used.some((u) => u.gap > 1 && Math.hypot(u.x - x, u.z - z) < u.gap)) continue;
        islandTufts.push(grassTuft(r, x, b.top, z, 0.9 + r() * 0.6));
      }
    }
    const islandGrass = grassMesh(islandTufts);
    mesh.add(islandGrass);
    highOnly.push(islandGrass);
    const islet = spot.kind === 'islet';
    const baseY = islet ? -0.75 + r() * 0.45 : -3 + r() * 4.5 - spot.score * 0.15;
    mesh.position.set(spot.x, baseY, spot.z);
    mesh.rotation.y = islet ? 0 : r() * Math.PI;
    scene.add(mesh);
    bobbers.push({ mesh, baseY, phase: r() * Math.PI * 2, speed: 0.3 + r() * 0.4, amp: islet ? 0.18 : 0.6 });
    if (spot.kind === 'grove' && idx % 2) highOnly.push(mesh);
  });

  // A few tiny rocks drifting in the sky for depth.
  const pebbleParts = [];
  for (let i = 0; i < 30; i++) {
    const a = r() * Math.PI * 2;
    const dd = 45 + r() * 50;
    pebbleParts.push(tint(new THREE.DodecahedronGeometry(0.6 + r() * 1.4, 0).translate(Math.cos(a) * dd, -14 + r() * 30, Math.sin(a) * dd), PALETTE.rock[i % 3]));
  }
  const pebbles = mergedMesh(pebbleParts, { shadows: false });
  scene.add(pebbles);
  highOnly.push(pebbles);

  // ---------------------------------------------------------------- clouds

  const puffs = [];
  for (let i = 0; i < 34; i++) {
    const a = r() * Math.PI * 2;
    const low = i < 22;
    const dist = low ? 30 + r() * 55 : 90 + r() * 60;
    const cy = low ? -16 + r() * 9 : 8 + r() * 22;
    const n = 3 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      puffs.push({
        x: Math.cos(a) * dist + (r() - 0.5) * 14,
        y: cy + (r() - 0.5) * 3,
        z: Math.sin(a) * dist + (r() - 0.5) * 14,
        size: (low ? 9 : 14) + r() * 10,
        seed: r(),
        shade: 0.9 + r() * 0.15,
        stretch: 1.3 + r() * 0.8,
      });
    }
  }
  const cloudGeo = new THREE.BufferGeometry();
  const corner = [];
  const center = [];
  const cdata = [];
  const index = [];
  puffs.forEach((p, i) => {
    for (const [cx, cy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
      corner.push(cx, cy);
      center.push(p.x, p.y, p.z);
      cdata.push(p.size, p.seed, p.shade, p.stretch);
    }
    const b = i * 4;
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  cloudGeo.setAttribute('position', new THREE.Float32BufferAttribute(center, 3));
  cloudGeo.setAttribute('corner', new THREE.Float32BufferAttribute(corner, 2));
  cloudGeo.setAttribute('center', new THREE.Float32BufferAttribute(center, 3));
  cloudGeo.setAttribute('cdata', new THREE.Float32BufferAttribute(cdata, 4));
  cloudGeo.setIndex(index);
  const cloudMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  cloudMat.positionNode = cloudPosition;
  cloudMat.colorNode = cloudColor;
  const clouds = new THREE.Mesh(cloudGeo, cloudMat);
  clouds.frustumCulled = false;
  clouds.renderOrder = -1;
  scene.add(clouds);

  // ---------------------------------------------------------------- lobby towers

  const lobbyTowers = new THREE.Group();
  scene.add(lobbyTowers);

  // ---------------------------------------------------------------- arena props

  /** Theme props scattered on the island margin around the walls (rebuilt on arena change). */
  const buildProps = (kind) => {
    const pr = rng(4242);
    const parts = [];
    const spot = (pad = 1.4) => {
      for (let t = 0; t < 60; t++) {
        const x = (pr() - 0.5) * (IW - 1);
        const z = (pr() - 0.5) * (IH - 1);
        if (Math.abs(x) < hw + pad && Math.abs(z) < hh + pad) continue;
        return [x, z];
      }
      return [IW / 2 - 1, 0];
    };
    if (kind === 'bones') {
      for (let i = 0; i < 16; i++) {
        const [x, z] = spot();
        // Skull: dome + jaw + dark sockets.
        const s = 0.3 + pr() * 0.2;
        parts.push(tint(new THREE.SphereGeometry(s, 10, 8).translate(x, s * 0.9, z), 0xefe9da));
        parts.push(tint(new THREE.BoxGeometry(s * 1.1, s * 0.45, s * 0.9).translate(x, s * 0.35, z + s * 0.2), 0xe3dccb));
        for (const sx of [-1, 1]) parts.push(tint(new THREE.SphereGeometry(s * 0.22, 6, 4).translate(x + sx * s * 0.35, s * 1.0, z + s * 0.82), 0x2a2622));
        for (let b = 0; b < 2; b++) {
          const bone = new THREE.CapsuleGeometry(0.06, 0.5, 3, 6).rotateZ(Math.PI / 2).rotateY(pr() * Math.PI).translate(x + (pr() - 0.5) * 1.4, 0.07, z + (pr() - 0.5) * 1.4);
          parts.push(tint(bone, 0xe9e2d0));
        }
      }
      for (let i = 0; i < 3; i++) {
        const [x, z] = spot(2.5);
        const ry = pr() * Math.PI;
        for (let k = 0; k < 5; k++) {
          const rib = new THREE.TorusGeometry(1.3 - k * 0.1, 0.09, 5, 12, Math.PI).rotateY(ry).translate(x + Math.cos(ry) * (k - 2) * 0.5, 0, z - Math.sin(ry) * (k - 2) * 0.5);
          parts.push(tint(rib, 0xe7e0cc));
        }
      }
    } else if (kind === 'fences') {
      for (let i = 0; i < 12; i++) {
        const [x, z] = spot();
        const ry = pr() * Math.PI;
        for (let k = 0; k < 5; k++) {
          const hgt = 1.0 + pr() * 0.4;
          const off = (k - 2) * 0.32;
          const px = x + Math.cos(ry) * off;
          const pz = z - Math.sin(ry) * off;
          parts.push(tint(new THREE.CylinderGeometry(0.13, 0.15, hgt, 6).translate(px, hgt / 2, pz), PALETTE.wood, null, SURF.wood));
          parts.push(tint(new THREE.ConeGeometry(0.13, 0.3, 6).translate(px, hgt + 0.15, pz), PALETTE.woodDark, null, SURF.wood));
        }
        parts.push(tint(new THREE.BoxGeometry(1.7, 0.12, 0.1).rotateY(ry).translate(x, 0.6, z), PALETTE.woodDark, null, SURF.wood));
      }
      for (let i = 0; i < 4; i++) {
        const [x, z] = spot(2);
        for (let k = 0; k < 3; k++) {
          parts.push(tint(new THREE.BoxGeometry(0.7, 0.62, 0.7).translate(x, 0.31 + k * 0.62, z), [0xb7743e, 0xc4502f, 0x3f8fd0][k], null, SURF.wood));
          for (const sx of [-1, 1]) parts.push(tint(new THREE.BoxGeometry(0.12, 0.12, 0.05).translate(x + sx * 0.15, 0.42 + k * 0.62, z + 0.36), 0x1c1c1c));
        }
      }
    } else if (kind === 'snow') {
      for (let i = 0; i < 5; i++) {
        const [x, z] = spot();
        parts.push(tint(new THREE.SphereGeometry(0.45, 12, 10).translate(x, 0.4, z), 0xf4f8fb));
        parts.push(tint(new THREE.SphereGeometry(0.32, 12, 10).translate(x, 1.0, z), 0xf4f8fb));
        parts.push(tint(new THREE.SphereGeometry(0.22, 12, 10).translate(x, 1.45, z), 0xf4f8fb));
        parts.push(tint(new THREE.ConeGeometry(0.05, 0.25, 6).rotateX(Math.PI / 2).translate(x, 1.45, z + 0.3), 0xf08a2a));
        for (const sx of [-1, 1]) parts.push(tint(new THREE.SphereGeometry(0.035, 6, 4).translate(x + sx * 0.08, 1.53, z + 0.19), 0x1c1c1c));
      }
      for (let i = 0; i < 8; i++) {
        const [x, z] = spot();
        for (let k = 0; k < 3; k++) {
          const g = jitter(new THREE.OctahedronGeometry(0.4 + pr() * 0.3, 0), pr, 0.1).scale(0.6, 1.6, 0.6).rotateZ((pr() - 0.5) * 0.8).translate(x + (pr() - 0.5), 0.45, z + (pr() - 0.5));
          parts.push(tint(g, 0xa8dcf2, null, SURF.metal));
        }
      }
      for (let i = 0; i < 14; i++) {
        const [x, z] = spot(1.2);
        parts.push(tint(new THREE.SphereGeometry(0.8 + pr() * 0.6, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.35, 1).translate(x, 0, z), 0xf2f7fb));
      }
    } else if (kind === 'gold') {
      for (let i = 0; i < 10; i++) {
        const [x, z] = spot();
        parts.push(tint(new THREE.BoxGeometry(0.9, 0.3, 0.9).translate(x, 0.15, z), 0xe9dcc0, null, SURF.brick));
        parts.push(gradient(tint(new THREE.CylinderGeometry(0.18, 0.32, 2.6, 4).translate(x, 1.6, z), 0xf0b93a, null, SURF.metal), 0.3, 2.9, 0.75, 1.1));
        parts.push(tint(new THREE.OctahedronGeometry(0.28, 0).translate(x, 3.15, z), 0xe04ad8, null, SURF.metal));
      }
    }
    if (!parts.length) return null;
    const mesh = mergedMesh(parts);
    island.add(mesh);
    return mesh;
  };
  let props = null;

  return {
    river,
    update(dt, t) {
      for (const b of bobbers) b.mesh.position.y = b.baseY + Math.sin(t * b.speed + b.phase) * b.amp;
      pebbles.rotation.y = t * 0.01;
    },
    setDetail(high) {
      for (const m of highOnly) m.visible = high;
    },
    /** Swaps the theme props for an arena (colours are applied via shader uniforms). */
    setProps(kind) {
      if (props) {
        island.remove(props);
        props.geometry.dispose();
      }
      props = buildProps(kind);
    },
    /** Decorative towers shown while the lobby camera orbits. */
    showLobbyTowers(visible) {
      if (visible && lobbyTowers.children.length === 0) {
        for (const tw of TOWER_LAYOUT) {
          const g = makeTowerObject(tw.kind, tw.team);
          g.position.copy(tileToWorld(tw.x, tw.y));
          lobbyTowers.add(g);
        }
      }
      lobbyTowers.visible = visible;
    },
  };
}