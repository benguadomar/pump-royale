import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ARENA_W, ARENA_H, RIVER_Y, BRIDGES_X, TOWER_LAYOUT } from '../sim/constants.js';
import { fieldColor, riverColor } from './shaders.js';

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
  pine: [0x2f9e58, 0x3cb46a, 0x23875a, 0x48c07a],
  hedge: 0x3fae5c,
};

/** Paints a flat vertex colour onto a (non-indexed) geometry so pieces can be merged. */
function tint(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.toArray(arr, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g.deleteAttribute('uv');
  return g;
}

const at = (geo, x, y, z, ry = 0, s = 1) => geo.scale(s, s, s).rotateY(ry).translate(x, y, z);

function pine(r, x, y, z, s) {
  const color = PALETTE.pine[Math.floor(r() * PALETTE.pine.length)];
  return [
    tint(at(new THREE.CylinderGeometry(0.14, 0.2, 0.9, 5), x, y + 0.45 * s, z, 0, s), PALETTE.woodDark),
    tint(at(new THREE.ConeGeometry(1.0, 1.8, 6), x, y + 1.5 * s, z, r() * 3, s), color),
    tint(at(new THREE.ConeGeometry(0.75, 1.5, 6), x, y + 2.35 * s, z, r() * 3, s), color),
    tint(at(new THREE.ConeGeometry(0.45, 1.1, 6), x, y + 3.05 * s, z, r() * 3, s), color),
  ];
}

function house(r, x, y, z, s, ry) {
  const w = 2.2 + r() * 1.2;
  const d = 2.0 + r() * 1.0;
  const h = 1.6 + r() * 1.4;
  const wall = PALETTE.wall[Math.floor(r() * PALETTE.wall.length)];
  const roof = PALETTE.roof[Math.floor(r() * PALETTE.roof.length)];
  const parts = [];
  const body = new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);
  parts.push(tint(body, wall));
  for (const sx of [-w / 2, w / 2]) parts.push(tint(new THREE.BoxGeometry(0.16, h, d + 0.04).translate(sx, h / 2, 0), PALETTE.wood));
  parts.push(tint(new THREE.BoxGeometry(w + 0.04, 0.16, d + 0.04).translate(0, h * 0.55, 0), PALETTE.wood));
  // Triangular-prism roof with a little overhang.
  const roofGeo = new THREE.CylinderGeometry(d * 0.72, d * 0.72, w + 0.5, 3, 1).rotateZ(Math.PI / 2).rotateX(Math.PI / 6);
  roofGeo.scale(1, 0.9, 1).translate(0, h + d * 0.3, 0);
  parts.push(tint(roofGeo, roof));
  parts.push(tint(new THREE.BoxGeometry(0.5, 1.1, 0.5).translate(w * 0.25, h + d * 0.55, 0), PALETTE.stoneDark));
  parts.push(tint(new THREE.BoxGeometry(0.6, 0.9, 0.08).translate(0, 0.45, d / 2 + 0.03), PALETTE.woodDark));
  return parts.map((p) => at(p, x, y, z, ry, s));
}

function hexIsland(r, radius, height) {
  const top = PALETTE.islandTop[Math.floor(r() * PALETTE.islandTop.length)];
  const rock = PALETTE.rock[Math.floor(r() * PALETTE.rock.length)];
  return [
    tint(new THREE.CylinderGeometry(radius, radius * 0.97, 0.7, 6).translate(0, -0.35, 0), top),
    tint(new THREE.CylinderGeometry(radius * 0.97, radius * 0.82, height, 6).translate(0, -0.7 - height / 2, 0), rock),
    tint(new THREE.ConeGeometry(radius * 0.82, height * 1.4, 6).rotateX(Math.PI).translate(0, -0.7 - height - height * 0.7, 0), PALETTE.rockDark),
  ];
}

export function buildWorld(engine) {
  const scene = engine.scene;
  const r = rng(1337);
  const vcMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92 });
  const highOnly = [];
  const bobbers = [];

  const mergedMesh = (parts, { shadows = true } = {}) => {
    const mesh = new THREE.Mesh(mergeGeometries(parts), vcMat);
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    return mesh;
  };

  // ---------------------------------------------------------------- main island

  const field = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_W, ARENA_H).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial({ roughness: 1 }));
  field.material.colorNode = fieldColor;
  field.receiveShadow = true;
  scene.add(field);

  const islandParts = [];
  const IW = ARENA_W + 9;
  const IH = ARENA_H + 8;
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

  // River banks (the water itself is a separate shader plane).
  for (const zz of [-1.2, 1.2]) islandParts.push(tint(new THREE.BoxGeometry(ARENA_W, 0.16, 0.22).translate(0, 0.06, zz), PALETTE.stoneDark));

  // Hedge rows and pines along both long sides, banners on the walls.
  const decoParts = [];
  const extraParts = [];
  for (const side of [-1, 1]) {
    const x0 = side * (ARENA_W / 2 + 1.6);
    decoParts.push(tint(new THREE.BoxGeometry(1.1, 1.1, ARENA_H - 1).translate(x0, 0.55, 0), PALETTE.hedge));
    for (let i = 0; i < 22; i++) {
      const z = -ARENA_H / 2 + 0.8 + i * ((ARENA_H - 1.6) / 21) + (r() - 0.5) * 0.6;
      const x = x0 + side * (1.2 + r() * 2.6);
      (i % 2 ? extraParts : decoParts).push(...pine(r, x, 0, z, 0.85 + r() * 0.5));
    }
  }
  for (const side of [-1, 1]) {
    const z0 = side * (ARENA_H / 2 + 1.8);
    for (let i = 0; i < 9; i++) {
      const x = -ARENA_W / 2 - 2 + i * ((ARENA_W + 4) / 8) + (r() - 0.5);
      decoParts.push(...pine(r, x, 0, z0 + side * r() * 1.5, 0.8 + r() * 0.4));
    }
  }
  for (let i = 0; i < 8; i++) {
    const side = i % 2 ? 1 : -1;
    const z = -ARENA_H / 2 + 3 + Math.floor(i / 2) * ((ARENA_H - 6) / 3);
    const team = z > 0 ? 0 : 1;
    const x = side * (ARENA_W / 2 + 0.4);
    decoParts.push(tint(new THREE.CylinderGeometry(0.05, 0.05, 2.4, 4).translate(x, 1.6, z), PALETTE.woodDark));
    decoParts.push(tint(new THREE.BoxGeometry(0.06, 0.9, 0.6).translate(x, 2.3, z + 0.32), team === 0 ? 0x2f6fe0 : 0xd8383c));
  }

  const island = new THREE.Group();
  island.add(mergedMesh(islandParts), mergedMesh(decoParts));
  const extra = mergedMesh(extraParts);
  island.add(extra);
  highOnly.push(extra);
  scene.add(island);

  // River
  const river = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_W, 2.2, 1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicNodeMaterial());
  river.material.colorNode = riverColor;
  river.position.set(0, 0.03, 0);
  scene.add(river);
  // Notch the grass under the river so the water reads as sunken.
  field.position.y = 0;

  // Bridges
  const bridgeParts = [];
  for (const bx of BRIDGES_X) {
    const c = tileToWorld(bx, RIVER_Y);
    for (let i = 0; i < 7; i++) {
      bridgeParts.push(tint(new THREE.BoxGeometry(2.3, 0.18, 0.42).translate(c.x, 0.16, -1.5 + i * 0.5), i % 2 ? PALETTE.wood : PALETTE.woodDark));
    }
    for (const sx of [-1.15, 1.15]) {
      bridgeParts.push(tint(new THREE.BoxGeometry(0.15, 0.15, 3.4).translate(c.x + sx, 0.6, 0), PALETTE.woodDark));
      for (const pz of [-1.6, 0, 1.6]) bridgeParts.push(tint(new THREE.BoxGeometry(0.18, 0.6, 0.18).translate(c.x + sx, 0.36, pz), PALETTE.woodDark));
    }
  }
  scene.add(mergedMesh(bridgeParts));

  // ---------------------------------------------------------------- floating islands

  const islandSpots = [];
  const inField = (x, z, pad) => Math.abs(x) < IW / 2 + pad && Math.abs(z) < IH / 2 + pad;
  for (let tries = 0; tries < 500 && islandSpots.length < 26; tries++) {
    const x = (r() - 0.5) * 150;
    const z = (r() - 0.5) * 150;
    const rad = 3.5 + r() * 5.5;
    if (inField(x, z, rad + 2)) continue;
    if (islandSpots.some((s) => Math.hypot(s.x - x, s.z - z) < s.rad + rad + 3)) continue;
    islandSpots.push({ x, z, rad });
  }
  islandSpots.forEach((spot, idx) => {
    const parts = hexIsland(r, spot.rad, 2 + r() * 3);
    const houses = spot.rad > 5 ? 2 + Math.floor(r() * 2) : spot.rad > 4 ? 1 : 0;
    for (let i = 0; i < houses; i++) {
      const a = (i / Math.max(1, houses)) * Math.PI * 2 + r();
      const dist = houses === 1 ? 0 : spot.rad * 0.45;
      parts.push(...house(r, Math.cos(a) * dist, 0, Math.sin(a) * dist, 0.9 + r() * 0.3, r() * Math.PI * 2));
    }
    const pines = 1 + Math.floor(r() * 4);
    for (let i = 0; i < pines; i++) {
      const a = r() * Math.PI * 2;
      const dist = spot.rad * (0.55 + r() * 0.3);
      parts.push(...pine(r, Math.cos(a) * dist, 0, Math.sin(a) * dist, 0.7 + r() * 0.5));
    }
    const mesh = mergedMesh(parts);
    const baseY = -4 + r() * 8 - Math.max(0, Math.hypot(spot.x, spot.z) - 60) * 0.15;
    mesh.position.set(spot.x, baseY, spot.z);
    mesh.rotation.y = r() * Math.PI;
    scene.add(mesh);
    bobbers.push({ mesh, baseY, phase: r() * Math.PI * 2, speed: 0.3 + r() * 0.4 });
    if (idx % 3 === 2) highOnly.push(mesh);
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

  // ---------------------------------------------------------------- lobby towers

  const lobbyTowers = new THREE.Group();
  scene.add(lobbyTowers);

  return {
    river,
    update(dt, t) {
      for (const b of bobbers) b.mesh.position.y = b.baseY + Math.sin(t * b.speed + b.phase) * 0.6;
      pebbles.rotation.y = t * 0.01;
    },
    setDetail(high) {
      for (const m of highOnly) m.visible = high;
    },
    /** Decorative towers shown while the lobby camera orbits. */
    showLobbyTowers(visible) {
      if (visible && lobbyTowers.children.length === 0) {
        for (const tw of TOWER_LAYOUT) {
          const g = makeTowerObject(engine, tw.kind, tw.team);
          g.position.copy(tileToWorld(tw.x, tw.y));
          lobbyTowers.add(g);
        }
      }
      lobbyTowers.visible = visible;
    },
  };
}

/** Billboard tower art on a stone plinth, with an invisible box so it still casts a shadow. */
export function makeTowerObject(engine, kind, team) {
  const group = new THREE.Group();
  const king = kind === 'king';
  const sprite = engine.makeSprite(`/assets/cards/${kind}-tower.png`, king ? 5.6 : 4.9);
  if (team === 1) sprite.material.color.set(0xffd2cc);
  group.add(sprite);
  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(king ? 2.1 : 1.65, king ? 2.3 : 1.85, 0.3, 8),
    new THREE.MeshStandardMaterial({ color: team === 0 ? 0xc9c3b4 : 0xc9b4ae, roughness: 0.9, flatShading: true }),
  );
  plinth.position.y = 0.15;
  plinth.receiveShadow = true;
  plinth.castShadow = true;
  group.add(plinth);
  const caster = new THREE.Mesh(new THREE.BoxGeometry(king ? 2.6 : 2.1, king ? 4.6 : 4, king ? 2.6 : 2.1), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
  caster.position.y = king ? 2.3 : 2;
  caster.castShadow = true;
  group.add(caster);
  group.userData = { sprite, plinth };
  return group;
}
