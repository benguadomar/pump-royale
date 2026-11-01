import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { vertexColor, time, sin } from 'three/tsl';
/**
 * Procedural treasure chests, one distinct design per rarity: a plank-and-iron wooden
 * chest with a padlock, a riveted steel chest, an ornate gem-studded golden chest and a
 * violet arcane chest with glowing runes and crystals. Each model is a body with a lid
 * hinged on its back edge (`groups.lid`), so rotating `lid.rotation.x` negative opens it.
 */

/** Chest footprint: width, depth, body height; the lid is a half-cylinder of radius R. */
const W = 1.3;
const D = 0.86;
const H = 0.72;
const R = D / 2;
const LID_PIVOT = [0, H, -R];

// ------------------------------------------------------------------ materials

const std = (opts) => new THREE.MeshStandardNodeMaterial({ vertexColors: true, ...opts });

const MATS = {
  wood: std({ roughness: 0.85, metalness: 0, flatShading: true }),
  iron: std({ roughness: 0.55, metalness: 0.6 }),
  metal: std({ roughness: 0.28, metalness: 0.85 }),
  crystal: std({ roughness: 0.2, metalness: 0.15 }),
  gem: (() => {
    const m = std({ roughness: 0.05, metalness: 0.1, flatShading: true });
    m.emissiveNode = vertexColor().mul(0.45);
    return m;
  })(),
  glow: (() => {
    const m = new THREE.MeshBasicNodeMaterial({ vertexColors: true });
    m.colorNode = vertexColor().mul(sin(time.mul(3)).mul(0.2).add(1.25));
    return m;
  })(),
};

// ------------------------------------------------------------------ geometry kit

const BASE = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(1, 12, 8),
  gem: new THREE.OctahedronGeometry(1, 0),
  /** Half-cylinder along x, flat side down: the lid arch. */
  arch: new THREE.CylinderGeometry(1, 1, 1, 20, 1, false, 0, Math.PI).rotateZ(Math.PI / 2),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 16),
  hex: new THREE.CylinderGeometry(1, 1, 1, 6),
  cone: new THREE.ConeGeometry(1, 1, 8),
  ring: new THREE.TorusGeometry(1, 0.22, 8, 20),
  halfRing: new THREE.TorusGeometry(1, 0.25, 8, 12, Math.PI),
};

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();

/** Collects transformed, vertex-coloured pieces per part and material, then merges them. */
class Kit {
  constructor() {
    this.parts = { body: new Map(), lid: new Map() };
  }

  add(part, mat, shape, color, pos = [0, 0, 0], scale = [1, 1, 1], rot = [0, 0, 0]) {
    const g = BASE[shape].clone();
    tmpQ.setFromEuler(tmpE.set(rot[0], rot[1], rot[2]));
    tmpM.compose(new THREE.Vector3(...pos), tmpQ, new THREE.Vector3(...(typeof scale === 'number' ? [scale, scale, scale] : scale)));
    g.applyMatrix4(tmpM);
    if (part === 'lid') g.translate(-LID_PIVOT[0], -LID_PIVOT[1], -LID_PIVOT[2]);
    const geo = g.index ? g.toNonIndexed() : g;
    geo.deleteAttribute('uv');
    const c = new THREE.Color(color);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.toArray(col, i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const list = this.parts[part];
    if (!list.has(mat)) list.set(mat, []);
    list.get(mat).push(geo);
  }

  build() {
    const root = new THREE.Group();
    const body = new THREE.Group();
    const lid = new THREE.Group();
    lid.position.set(...LID_PIVOT);
    root.add(body);
    body.add(lid);
    const meshes = [];
    for (const [name, group] of [['body', body], ['lid', lid]]) {
      for (const [mat, geos] of this.parts[name]) {
        const mesh = new THREE.Mesh(mergeGeometries(geos), MATS[mat]);
        mesh.castShadow = mat !== 'glow';
        mesh.userData.baseMat = mesh.material;
        group.add(mesh);
        meshes.push(mesh);
      }
    }
    return { root, groups: { root, body, lid }, meshes };
  }
}

/** Point on the lid arch at angle `a` (0 = front edge, PI/2 = top, PI = back) and radius `r`. */
const arc = (a, r, x = 0, sy = 1) => [x, H + Math.sin(a) * r * sy, Math.cos(a) * r];
/** Rotation that turns a piece's local +y to the arch normal at angle `a`. */
const arcRot = (a) => [Math.PI / 2 - a, 0, 0];

/** Pieces along the lid arch, e.g. rivets or gems, at `count` evenly spaced angles. */
function alongArc(count, fn, from = 0.25, to = Math.PI - 0.25) {
  for (let i = 0; i < count; i++) fn(from + ((to - from) * i) / Math.max(1, count - 1), i);
}

// ------------------------------------------------------------------ designs

/**
 * What shows once the lid flips: a dark lined floor with a glowing heap of loot. The heap
 * pokes above the rim but stays hidden inside the closed lid's dome.
 */
function loot(k, lining, shine) {
  k.add('body', 'wood', 'box', lining, [0, H - 0.004, 0], [W - 0.12, 0.012, D - 0.12]);
  k.add('body', 'glow', 'sphere', shine, [0, H - 0.02, -0.02], [0.46, 0.13, 0.27]);
  for (const [x, z, s] of [[-0.3, 0.12, 0.09], [0.28, -0.1, 0.1], [0.08, 0.17, 0.08], [-0.16, -0.16, 0.08], [0.4, 0.15, 0.07]]) {
    k.add('body', 'glow', 'cyl', shine, [x, H + 0.03, z], [s, 0.018, s], [0.35, 0, x]);
  }
}

function wooden(k) {
  const planks = [0x9a6436, 0x8a5730, 0xa56e3d, 0x93603a, 0x845229, 0x9e6a3b, 0x8e5b32];
  const dark = 0x4a2c15;
  const iron = 0x3a3e46;
  const ironHi = 0x5a606b;
  // Body: stacked horizontal planks around a dark core showing through the seams.
  k.add('body', 'wood', 'box', dark, [0, H / 2, 0], [W - 0.03, H, D - 0.03]);
  const rows = 3;
  for (let i = 0; i < rows; i++) {
    const h = H / rows;
    k.add('body', 'wood', 'box', planks[i * 2], [0, h * (i + 0.5), 0], [W, h - 0.025, D]);
  }
  k.add('body', 'wood', 'box', 0x5e3a1d, [0, 0.04, 0], [W + 0.06, 0.08, D + 0.06]);
  // Iron straps wrapping the body, studded with rivets.
  for (const x of [-0.4, 0.4]) {
    k.add('body', 'iron', 'box', iron, [x, H / 2, 0], [0.13, H + 0.01, D + 0.04]);
    for (const z of [-1, 1]) for (const y of [0.14, 0.36, 0.58]) k.add('body', 'iron', 'sphere', ironHi, [x, y, z * (D / 2 + 0.022)], 0.026);
  }
  // Corner brackets.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      k.add('body', 'iron', 'box', iron, [sx * (W / 2 - 0.02), H / 2, sz * (D / 2 - 0.02)], [0.1, H + 0.01, 0.1]);
      for (const y of [0.1, H - 0.1]) k.add('body', 'iron', 'sphere', ironHi, [sx * (W / 2 + 0.03), y, sz * (D / 2 - 0.02)], 0.022);
    }
  }
  // Rope handles on the sides.
  for (const sx of [-1, 1]) k.add('body', 'wood', 'halfRing', 0xc9a66b, [sx * (W / 2 + 0.03), H * 0.55, 0], [0.12, 0.12, 0.12], [Math.PI, Math.PI / 2, 0]);
  // Brass padlock hanging from the hasp.
  k.add('body', 'iron', 'box', iron, [0, H - 0.1, D / 2 + 0.02], [0.2, 0.2, 0.04]);
  k.add('body', 'metal', 'ring', 0x9aa0a8, [0, H - 0.17, D / 2 + 0.08], [0.06, 0.06, 0.06]);
  k.add('body', 'metal', 'box', 0xd4a646, [0, H - 0.27, D / 2 + 0.08], [0.17, 0.15, 0.07]);
  k.add('body', 'iron', 'cyl', 0x1c1c20, [0, H - 0.27, D / 2 + 0.116], [0.022, 0.01, 0.022], [Math.PI / 2, 0, 0]);
  k.add('body', 'iron', 'box', 0x1c1c20, [0, H - 0.3, D / 2 + 0.116], [0.014, 0.04, 0.01]);
  // Lid: curved staves over a dark core, with an underside plank.
  k.add('lid', 'wood', 'arch', dark, [0, H, 0], [W - 0.02, R - 0.04, R - 0.04]);
  k.add('lid', 'wood', 'box', 0x5e3a1d, [0, H + 0.015, 0], [W, 0.03, D]);
  const staves = 7;
  const step = Math.PI / staves;
  for (let i = 0; i < staves; i++) {
    const a = step * (i + 0.5);
    k.add('lid', 'wood', 'box', planks[(i + 3) % planks.length], arc(a, R - 0.035), [W, 0.07, 2 * R * Math.sin(step / 2) - 0.012], arcRot(a));
  }
  for (const x of [-0.4, 0.4]) {
    k.add('lid', 'iron', 'arch', iron, [x, H, 0], [0.13, R + 0.02, R + 0.02]);
    alongArc(4, (a) => k.add('lid', 'iron', 'sphere', ironHi, arc(a, R + 0.025, x), 0.026));
  }
  for (const sx of [-1, 1]) k.add('lid', 'iron', 'arch', iron, [sx * (W / 2 - 0.02), H, 0], [0.08, R + 0.015, R + 0.015]);
  k.add('lid', 'iron', 'box', iron, [0, H + 0.06, R + 0.02], [0.14, 0.14, 0.04]);
  // Coins glowing inside, seen once the lid flips.
  loot(k, 0x2a180b, 0xffc94a);
}

function silver(k) {
  const steel = 0xc7d0da;
  const trim = 0x6c7786;
  const polish = 0xeef3f8;
  const lidY = 0.72;
  k.add('body', 'metal', 'box', steel, [0, (H + 0.07) / 2, 0], [W, H - 0.07, D]);
  // Ball feet.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.add('body', 'metal', 'sphere', trim, [sx * (W / 2 - 0.08), 0.06, sz * (D / 2 - 0.08)], 0.075);
  // Edge frame: vertical posts plus top and bottom rims, all riveted.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.add('body', 'metal', 'box', trim, [sx * (W / 2 - 0.02), (H + 0.07) / 2, sz * (D / 2 - 0.02)], [0.1, H - 0.07, 0.1]);
  for (const y of [0.1, H - 0.035]) {
    k.add('body', 'metal', 'box', trim, [0, y, 0], [W + 0.04, 0.07, D + 0.04]);
    for (let i = 0; i < 9; i++) {
      const x = -W / 2 + 0.1 + ((W - 0.2) * i) / 8;
      for (const z of [-1, 1]) k.add('body', 'metal', 'sphere', polish, [x, y, z * (D / 2 + 0.025)], 0.019);
    }
  }
  // Raised panels with diamond studs on the front and back.
  for (const z of [-1, 1]) {
    for (const x of [-0.37, 0.37]) {
      k.add('body', 'metal', 'box', 0xa9b4c1, [x, 0.41, z * (D / 2 + 0.008)], [0.36, 0.38, 0.02]);
      k.add('body', 'metal', 'gem', polish, [x, 0.41, z * (D / 2 + 0.022)], [0.07, 0.09, 0.02]);
    }
  }
  // Side handles.
  for (const sx of [-1, 1]) {
    k.add('body', 'metal', 'box', trim, [sx * (W / 2 + 0.01), H * 0.62, 0], [0.03, 0.08, 0.3]);
    k.add('body', 'metal', 'halfRing', polish, [sx * (W / 2 + 0.04), H * 0.62, 0], [0.11, 0.11, 0.11], [Math.PI, Math.PI / 2, 0]);
  }
  // Front lock plate: a polished shield with a sapphire.
  k.add('body', 'metal', 'box', polish, [0, 0.42, D / 2 + 0.015], [0.26, 0.5, 0.03]);
  k.add('body', 'metal', 'hex', trim, [0, 0.5, D / 2 + 0.035], [0.12, 0.03, 0.12], [Math.PI / 2, 0, 0]);
  k.add('body', 'gem', 'gem', 0x3f9bff, [0, 0.5, D / 2 + 0.06], [0.07, 0.08, 0.04]);
  k.add('body', 'iron', 'box', 0x23262c, [0, 0.3, D / 2 + 0.032], [0.035, 0.08, 0.01]);
  // Lid: a flatter steel arch with a riveted frame, centre band and ridge.
  const sy = 0.72;
  k.add('lid', 'metal', 'arch', steel, [0, lidY, 0], [W - 0.02, R * sy, R]);
  k.add('lid', 'metal', 'box', trim, [0, H + 0.015, 0], [W, 0.03, D]);
  for (const sx of [-1, 1]) {
    k.add('lid', 'metal', 'arch', trim, [sx * (W / 2 - 0.03), lidY, 0], [0.1, R * sy + 0.02, R + 0.02]);
    alongArc(5, (a) => k.add('lid', 'metal', 'sphere', polish, arc(a, R + 0.02, sx * (W / 2 - 0.03), sy), 0.02));
  }
  k.add('lid', 'metal', 'arch', polish, [0, lidY, 0], [0.24, R * sy + 0.015, R + 0.015]);
  k.add('lid', 'metal', 'box', trim, [0, H + R * sy + 0.01, 0], [W - 0.1, 0.04, 0.06]);
  for (const x of [-0.37, 0.37]) k.add('lid', 'metal', 'gem', polish, arc(Math.PI / 2, R + 0.0, x, sy), [0.06, 0.03, 0.06]);
  k.add('lid', 'metal', 'box', polish, [0, H + 0.05, R + 0.02], [0.16, 0.12, 0.03]);
  loot(k, 0x2b3038, 0xffd76a);
}

function gold(k) {
  const bright = 0xffe27a;
  const panel = 0xc7851a;
  const deep = 0xa8700f;
  k.add('body', 'metal', 'box', panel, [0, (H + 0.08) / 2, 0], [W - 0.04, H - 0.08, D - 0.04]);
  // Lion-claw feet.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const p = [sx * (W / 2 - 0.06), 0.09, sz * (D / 2 - 0.06)];
      k.add('body', 'metal', 'sphere', bright, p, 0.085);
      k.add('body', 'metal', 'cone', deep, [p[0], 0.03, p[2]], [0.08, 0.07, 0.08], [Math.PI, 0, 0]);
    }
  }
  // Rounded corner columns topped with knobs, and thick moulded rims.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      k.add('body', 'metal', 'cyl', bright, [sx * (W / 2 - 0.03), (H + 0.08) / 2, sz * (D / 2 - 0.03)], [0.065, H - 0.08, 0.065]);
      k.add('body', 'metal', 'sphere', bright, [sx * (W / 2 - 0.03), H - 0.02, sz * (D / 2 - 0.03)], 0.06);
    }
  }
  for (const [y, t] of [[0.13, 0.09], [H - 0.04, 0.07]]) k.add('body', 'metal', 'box', bright, [0, y, 0], [W + 0.02, t, D + 0.02]);
  // Scrollwork and emeralds on the side panels.
  for (const z of [-1, 1]) {
    for (const x of [-0.36, 0.36]) {
      k.add('body', 'metal', 'ring', bright, [x, 0.42, z * (D / 2 - 0.01)], [0.1, 0.1, 0.06]);
      k.add('body', 'gem', 'gem', 0x1fd17a, [x, 0.42, z * (D / 2 + 0.01)], [0.045, 0.06, 0.03]);
    }
  }
  for (const sx of [-1, 1]) {
    k.add('body', 'metal', 'ring', bright, [sx * (W / 2 - 0.01), 0.42, 0], [0.1, 0.1, 0.06], [0, Math.PI / 2, 0]);
    k.add('body', 'gem', 'gem', 0x2f7bff, [sx * (W / 2 + 0.01), 0.42, 0], [0.03, 0.06, 0.045]);
  }
  // Big round lock medallion with a ruby.
  k.add('body', 'metal', 'cyl', bright, [0, 0.44, D / 2 + 0.01], [0.17, 0.04, 0.17], [Math.PI / 2, 0, 0]);
  k.add('body', 'metal', 'ring', deep, [0, 0.44, D / 2 + 0.035], [0.13, 0.13, 0.08]);
  k.add('body', 'gem', 'gem', 0xff2448, [0, 0.44, D / 2 + 0.06], [0.085, 0.1, 0.05]);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    k.add('body', 'metal', 'sphere', bright, [Math.cos(a) * 0.15, 0.44 + Math.sin(a) * 0.15, D / 2 + 0.03], 0.025);
  }
  // Lid: tall gold arch with bright bands studded with gems and a crown ornament.
  k.add('lid', 'metal', 'arch', panel, [0, H, 0], [W - 0.04, R, R]);
  k.add('lid', 'metal', 'box', deep, [0, H + 0.015, 0], [W, 0.03, D]);
  const gems = [0xff2448, 0x1fd17a, 0x2f7bff];
  for (const x of [-W / 2 + 0.03, -0.32, 0.32, W / 2 - 0.03]) {
    k.add('lid', 'metal', 'arch', bright, [x, H, 0], [0.09, R + 0.025, R + 0.025]);
  }
  for (const x of [-0.32, 0.32]) alongArc(5, (a) => k.add('lid', 'metal', 'sphere', 0xfff0b0, arc(a, R + 0.03, x), 0.022));
  k.add('lid', 'metal', 'arch', bright, [0, H, 0], [0.2, R + 0.03, R + 0.03]);
  alongArc(3, (a, i) => k.add('lid', 'gem', 'gem', gems[i % 3], arc(a, R + 0.045), [0.05, 0.03, 0.05], arcRot(a)), 0.5, Math.PI - 0.5);
  const top = H + R + 0.03;
  k.add('lid', 'metal', 'cyl', bright, [0, top, 0], [0.12, 0.05, 0.12]);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    k.add('lid', 'metal', 'cone', bright, [Math.cos(a) * 0.09, top + 0.07, Math.sin(a) * 0.09], [0.035, 0.1, 0.035]);
  }
  k.add('lid', 'gem', 'gem', 0xff2448, [0, top + 0.08, 0], [0.06, 0.08, 0.06]);
  k.add('lid', 'metal', 'box', bright, [0, H + 0.06, R + 0.025], [0.18, 0.14, 0.03]);
  loot(k, 0x5a1020, 0xffd24a);
}

function magical(k) {
  const shell = 0x3b1a72;
  const shellHi = 0x5a2ca6;
  const trim = 0xe2b44c;
  const rune = 0xd77bff;
  const cyan = 0x7af0ff;
  k.add('body', 'crystal', 'box', shell, [0, (H + 0.04) / 2, 0], [W, H - 0.04, D]);
  k.add('body', 'crystal', 'box', shellHi, [0, 0.05, 0], [W + 0.08, 0.1, D + 0.08]);
  // Gold edges.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.add('body', 'metal', 'box', trim, [sx * (W / 2), (H + 0.04) / 2, sz * (D / 2)], [0.06, H - 0.04, 0.06]);
  k.add('body', 'metal', 'box', trim, [0, H - 0.03, 0], [W + 0.04, 0.05, D + 0.04]);
  // Glowing runes etched into every face.
  const glyph = (x, y, z, ry) => {
    const off = (dx, dy) => [x + Math.cos(ry) * dx, y + dy, z - Math.sin(ry) * dx];
    k.add('body', 'glow', 'box', rune, off(0, 0), [0.025, 0.22, 0.025], [0, ry, 0]);
    k.add('body', 'glow', 'box', rune, off(0, 0.04), [0.14, 0.022, 0.025], [0, ry, 0.5]);
    k.add('body', 'glow', 'box', rune, off(0, -0.06), [0.12, 0.022, 0.025], [0, ry, -0.5]);
  };
  for (const z of [-1, 1]) for (const x of [-0.42, -0.2, 0.2, 0.42]) glyph(x, 0.38, z * (D / 2 + 0.005), 0);
  for (const sx of [-1, 1]) for (const z of [-0.18, 0.18]) glyph(sx * (W / 2 + 0.005), 0.38, z, Math.PI / 2);
  // Arcane eye lock: glowing ring around a cyan gem.
  k.add('body', 'glow', 'ring', cyan, [0, 0.42, D / 2 + 0.02], [0.12, 0.12, 0.1]);
  k.add('body', 'metal', 'cyl', trim, [0, 0.42, D / 2 + 0.01], [0.09, 0.03, 0.09], [Math.PI / 2, 0, 0]);
  k.add('body', 'gem', 'gem', cyan, [0, 0.42, D / 2 + 0.05], [0.06, 0.08, 0.04]);
  // Crystal clusters bursting out of the bottom corners.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const base = [sx * (W / 2 + 0.02), 0.12, sz * (D / 2 + 0.02)];
      for (const [dx, dz, h, lean, c] of [[0, 0, 0.26, 0.35, rune], [0.06, -0.05, 0.17, 0.7, cyan], [-0.05, 0.05, 0.15, 0.6, 0xff8af5]]) {
        k.add('body', 'gem', 'gem', c, [base[0] + sx * dx, base[1] + h * 0.4, base[2] + sz * dz], [0.05, h, 0.05], [sz * lean, 0, -sx * lean]);
      }
    }
  }
  // Lid: a taller violet dome with gold bands, rune lines and a floating crystal on top.
  const sy = 1.12;
  k.add('lid', 'crystal', 'arch', shell, [0, H, 0], [W - 0.02, R * sy, R]);
  k.add('lid', 'crystal', 'box', 0x24104a, [0, H + 0.015, 0], [W, 0.03, D]);
  for (const x of [-W / 2 + 0.03, W / 2 - 0.03]) k.add('lid', 'metal', 'arch', trim, [x, H, 0], [0.07, R * sy + 0.02, R + 0.02]);
  for (const x of [-0.3, 0.3]) k.add('lid', 'glow', 'arch', rune, [x, H, 0], [0.03, R * sy + 0.012, R + 0.012]);
  alongArc(5, (a) => k.add('lid', 'glow', 'gem', cyan, arc(a, R + 0.02, 0, sy), [0.035, 0.035, 0.035], arcRot(a)));
  const top = H + R * sy;
  k.add('lid', 'metal', 'cyl', trim, [0, top + 0.02, 0], [0.11, 0.05, 0.11]);
  k.add('lid', 'metal', 'ring', trim, [0, top + 0.06, 0], [0.09, 0.09, 0.09], [Math.PI / 2, 0, 0]);
  k.add('lid', 'gem', 'gem', 0xff8af5, [0, top + 0.27, 0], [0.11, 0.2, 0.11]);
  k.add('lid', 'glow', 'gem', 0xffd6fb, [0, top + 0.27, 0], [0.045, 0.1, 0.045]);
  k.add('lid', 'metal', 'box', trim, [0, H + 0.06, R + 0.02], [0.16, 0.13, 0.03]);
  loot(k, 0x1a0836, 0xe39bff);
}

const DESIGNS = { wooden, silver, gold, magical };

/** Builds the chest for a rarity: `{ root, groups: { root, body, lid }, meshes }`. */
export function makeChest(type) {
  const k = new Kit();
  (DESIGNS[type] ?? wooden)(k);
  return k.build();
}

// ------------------------------------------------------------------ lobby icons

const ICON_W = 128;
const ICON_H = 112;
const toSrgb = (v) => {
  const c = v / 255;
  return Math.round(255 * Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
};

/** PNG data URLs of each chest model, rendered once for the lobby chest slots. */
export const CHEST_ICONS = new Map();
let iconsPromise = null;

/** Renders a transparent 3/4 portrait of every chest type into CHEST_ICONS (once). */
export function renderChestIcons(engine) {
  iconsPromise ??= (async () => {
    const renderer = engine.renderer;
    const rt = new THREE.RenderTarget(ICON_W, ICON_H, { samples: 4 });
    const scene = new THREE.Scene();
    scene.environment = engine.scene.environment;
    scene.environmentIntensity = 0.8;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a7a, 1.4));
    const key = new THREE.DirectionalLight(0xfff2e0, 2.6);
    key.position.set(-2, 4, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd8ff, 1.2);
    rim.position.set(3, 2, -4);
    scene.add(rim);
    const cam = new THREE.PerspectiveCamera(24, ICON_W / ICON_H, 0.05, 60);
    cam.position.set(1.7, 2.3, 4.6);
    cam.lookAt(0, 0.55, 0);
    const canvas = document.createElement('canvas');
    canvas.width = ICON_W;
    canvas.height = ICON_H;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(ICON_W, ICON_H);
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const flip = !renderer.backend?.isWebGPUBackend;
    try {
      for (const type of Object.keys(DESIGNS)) {
        const chest = makeChest(type);
        chest.root.rotation.y = -0.35;
        scene.add(chest.root);
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(rt);
        renderer.clear();
        renderer.render(scene, cam);
        renderer.setRenderTarget(null);
        renderer.setClearColor(prevColor, prevAlpha);
        const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, ICON_W, ICON_H);
        for (let y = 0; y < ICON_H; y++) {
          const src = (flip ? ICON_H - 1 - y : y) * ICON_W * 4;
          const dst = y * ICON_W * 4;
          for (let x = 0; x < ICON_W * 4; x += 4) {
            const a = px[src + x + 3];
            const k = a > 0 ? 255 / a : 0;
            image.data[dst + x] = toSrgb(Math.min(255, px[src + x] * k));
            image.data[dst + x + 1] = toSrgb(Math.min(255, px[src + x + 1] * k));
            image.data[dst + x + 2] = toSrgb(Math.min(255, px[src + x + 2] * k));
            image.data[dst + x + 3] = a;
          }
        }
        ctx.putImageData(image, 0, 0);
        CHEST_ICONS.set(type, canvas.toDataURL('image/png'));
        scene.remove(chest.root);
        chest.meshes.forEach((m) => m.geometry.dispose());
      }
    } finally {
      renderer.setClearColor(prevColor, prevAlpha);
      rt.dispose();
    }
    return CHEST_ICONS;
  })().catch((e) => {
    console.warn('chest icons', e);
    return CHEST_ICONS;
  });
  return iconsPromise;
}
