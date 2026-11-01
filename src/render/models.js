import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { vec3 } from 'three/tsl';
import { surfaceColor, surfaceRoughness, surfaceMetalness, windPosition, rimLight, SURF } from './shaders.js';
/**
 * Procedural low-poly 3D models for every card and tower, built from primitives in the
 * style of the card art (a pale round-headed mascot in costumes), plus the animator that
 * poses their rigs every frame: walk cycles, attack wind-up/strike, flinch, drop-in, death.
 */

export const TEAM_CLOTH = [0x2f74e6, 0xd8392f];
const TEAM_CLOTH_DARK = [0x1f50a8, 0x9e2620];

const C = {
  skin: 0xedeae4,
  eye: 0x17171b,
  mouth: 0x4a3530,
  wood: 0x8a5a33,
  woodDark: 0x5e3b20,
  leather: 0x86522a,
  leatherDark: 0x5a3417,
  steel: 0xd3d9e0,
  steelDark: 0x868e98,
  gold: 0xf0b93a,
  goldDark: 0xc28a1e,
  iron: 0x2e3138,
  ironLight: 0x4a4f58,
  green: 0x4c9a36,
  greenDark: 0x356f25,
  goblinEar: 0x8fd14f,
  blond: 0xf6c844,
  ginger: 0xe8772a,
  pig: 0xf3a5b8,
  pigDark: 0xd97d97,
  hair: 0xe23d92,
  navy: 0x26385f,
  bone: 0xefebe1,
  rib: 0x3a3a42,
  flame: 0xffb23a,
  stone: 0xcdbf9f,
  stoneLight: 0xe2d6b8,
  stoneDark: 0xa39578,
  grey: 0x9a9ca3,
  greyLight: 0xb6b8be,
  greyDark: 0x74767d,
  grass: 0x6fae3c,
  dirt: 0x7a5a3a,
  hairBrown: 0x6b4a2b,
  armorDark: 0x3d4766,
  armorPlate: 0x6a78a6,
};

// ------------------------------------------------------------------ materials

/** Vertex-coloured material with the procedural surface shaders (masonry, planks, ...) and wind. */
export function makeSurfaceMaterial({ flat = true } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ flatShading: flat });
  m.colorNode = surfaceColor;
  m.roughnessNode = surfaceRoughness;
  m.metalnessNode = surfaceMetalness;
  m.positionNode = windPosition;
  return m;
}

function makeUnitMaterial(glow) {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true });
  m.roughnessNode = surfaceRoughness;
  m.metalnessNode = surfaceMetalness;
  m.emissiveNode = glow ? rimLight.add(vec3(...glow)) : rimLight;
  return m;
}

const unitMat = makeUnitMaterial(null);
const towerMat = makeSurfaceMaterial();
export const flashMat = makeUnitMaterial([0.55, 0.12, 0.08]);
/** Status tints: ice blue while frozen, purple while enraged. */
export const frozenMat = makeUnitMaterial([0.2, 0.45, 0.65]);
export const rageMat = makeUnitMaterial([0.4, 0.05, 0.48]);
const flameMat = new THREE.MeshBasicMaterial({ color: 0xffc35a });
const visorMat = new THREE.MeshBasicMaterial({ color: 0x8ff8ff });

// ------------------------------------------------------------------ geometry helpers

/** Which procedural surface each palette colour gets. */
const SURF_BY_COLOR = new Map([
  ...[C.stone, C.stoneLight, C.stoneDark, C.grey, C.greyLight, C.greyDark].map((c) => [c, SURF.brick]),
  ...[C.wood, C.woodDark].map((c) => [c, SURF.wood]),
  ...[C.gold, C.goldDark, C.iron, C.ironLight, C.steel, C.steelDark, C.armorPlate, 0xd9a441, 0xa7acb2].map((c) => [c, SURF.metal]),
  [C.grass, SURF.grass],
  [C.dirt, SURF.rock],
  ...[...TEAM_CLOTH, ...TEAM_CLOTH_DARK, C.navy].map((c) => [c, SURF.cloth]),
]);

const G = {
  sphere: new THREE.SphereGeometry(1, 16, 12),
  sphereLo: new THREE.SphereGeometry(1, 8, 6),
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 14),
  cylLo: new THREE.CylinderGeometry(1, 1, 1, 8),
  cone: new THREE.ConeGeometry(1, 1, 10),
  coneLo: new THREE.ConeGeometry(1, 1, 5),
  diamond: new THREE.OctahedronGeometry(1, 0),
  banner: (() => {
    const s = new THREE.Shape();
    s.moveTo(-0.5, 0.5);
    s.lineTo(0.5, 0.5);
    s.lineTo(0.5, -0.3);
    s.lineTo(0, -0.5);
    s.lineTo(-0.5, -0.3);
    s.closePath();
    return new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
  })(),
  // Head coverings: sphere shells with a round hole cut around the face (+Z).
  hood: shell({ faceAngle: 52, minY: -0.62 }),
  hair: shell({ faceAngle: 62, minY: -0.25 }),
  dome: new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
  // Band of hair around the back and sides of a bald head.
  fringe: shell({ faceAngle: 58, minY: -0.35, maxY: 0.42 }),
};

/**
 * Unit sphere keeping only triangles outside a cone of `faceAngle` degrees around the
 * face direction, and between `minY`/`maxY` (cuts the neck hole or a bald crown).
 */
function shell({ faceAngle, minY = -1, maxY = 1 }) {
  const src = new THREE.SphereGeometry(1, 28, 18).toNonIndexed();
  const pos = src.attributes.position;
  const face = new THREE.Vector3(0, -0.12, 1).normalize();
  const limit = Math.cos(THREE.MathUtils.degToRad(faceAngle));
  const keep = [];
  const c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    c.set(0, 0, 0);
    for (let k = 0; k < 3; k++) c.add(new THREE.Vector3().fromBufferAttribute(pos, i + k));
    c.divideScalar(3);
    if (c.y < minY || c.y > maxY) continue;
    if (c.clone().normalize().dot(face) > limit) continue;
    for (let k = 0; k < 3; k++) keep.push(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k));
  }
  src.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
  g.computeVertexNormals();
  // Sphere normals point straight out from the centre.
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, keep[i * 3], keep[i * 3 + 1], keep[i * 3 + 2]);
  return g;
}
const capsules = new Map();
const capsule = (r, len) => {
  const key = `${r}|${len}`;
  if (!capsules.has(key)) capsules.set(key, new THREE.CapsuleGeometry(r, len, 4, 10));
  return capsules.get(key);
};

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/** Copy of `geo`, transformed and painted a flat vertex colour so pieces merge into one mesh. */
function place(geo, color, pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1]) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  const s = typeof scale === 'number' ? [scale, scale, scale] : scale;
  const r = typeof rot === 'number' ? [rot, 0, 0] : rot;
  _m.compose(_p.set(...pos), _q.setFromEuler(_e.set(r[0], r[1], r[2])), _s.set(...s));
  g.applyMatrix4(_m);
  _c.set(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const surf = new Float32Array(n * 2);
  const id = SURF_BY_COLOR.get(color) ?? SURF.plain;
  for (let i = 0; i < n; i++) {
    _c.toArray(arr, i * 3);
    surf[i * 2] = id;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g.setAttribute('surf', new THREE.BufferAttribute(surf, 2));
  g.deleteAttribute('uv');
  return g;
}

/** A bow arc lying in the local Y/Z plane, bulging toward -Y, its grip at `hand`. */
function bowGeos(hand, color) {
  const R = 0.24;
  const arc = 2.2;
  const torus = new THREE.TorusGeometry(R, 0.018, 5, 14, arc).rotateZ(-arc / 2).rotateZ(-Math.PI / 2).rotateY(-Math.PI / 2);
  const center = [hand[0], hand[1] + R, hand[2]];
  const chord = 2 * R * Math.sin(arc / 2);
  const stringY = center[1] - R * Math.cos(arc / 2);
  return [
    place(torus, color, center),
    place(G.box, 0xf6efe0, [hand[0], stringY, hand[2]], 0, [0.008, 0.008, chord]),
    place(G.box, C.leatherDark, hand, 0, [0.05, 0.06, 0.07]),
  ];
}

/** Blade held in a fist at `hand`, pointing forward and slightly down. */
function swordGeos(hand, len, width, { blade = C.steel, guard = C.goldDark, tilt = -0.35 } = {}) {
  const dir = [0, -Math.sin(tilt), Math.cos(tilt)];
  const at = (d) => [hand[0] + dir[0] * d, hand[1] + dir[1] * d, hand[2] + dir[2] * d];
  return [
    place(G.box, blade, at(0.07 + len / 2), [tilt, 0, 0], [width, width * 0.35, len]),
    place(G.box, guard, at(0.06), [tilt, 0, 0], [width * 3.2, 0.03, 0.035]),
    place(G.box, C.leatherDark, at(-0.02), [tilt, 0, 0], [0.035, 0.035, 0.12]),
    place(G.sphereLo, guard, at(-0.09), 0, 0.03),
  ];
}

// ------------------------------------------------------------------ rig assembly

/**
 * A rig definition is an ordered map of parts: { parent, pivot (absolute), geos }.
 * Each part becomes a Group at its pivot holding one merged mesh, so it can rotate.
 */
function addPart(def, name, parent, pivot) {
  def[name] = { parent, pivot, geos: [], mat: unitMat };
  return def[name];
}

function compile(def, mat = unitMat) {
  const parts = [];
  for (const [name, p] of Object.entries(def)) {
    const pp = p.parent === 'root' ? [0, 0, 0] : def[p.parent].pivot;
    let geo = null;
    if (p.geos.length) {
      geo = mergeGeometries(p.geos);
      geo.translate(-p.pivot[0], -p.pivot[1], -p.pivot[2]);
      p.geos.forEach((g) => g.dispose());
    }
    parts.push({ name, parent: p.parent, offset: [p.pivot[0] - pp[0], p.pivot[1] - pp[1], p.pivot[2] - pp[2]], geo, mat: p.mat === unitMat ? mat : p.mat });
  }
  return parts;
}

// ------------------------------------------------------------------ skinning

/** Parts that stay separate rigid meshes on their bone (shown/hidden on their own). */
const RIGID_PARTS = new Set(['prop']);
/** Joints whose skin blends into the parent bone near the pivot (shoulder, elbow, hip, knee, neck). */
const SOFT_JOINTS = new Set(['head', 'armL', 'armR', 'foreL', 'foreR', 'legL', 'legR', 'shinL', 'shinR', 'pl0', 'pl1', 'pl2', 'pl3']);
/** Skin within this distance of a soft joint's pivot is shared with the parent bone (model units). */
const BLEND_RADIUS = 0.1;

/**
 * Builds (once per template) a single skinned geometry from every unit-material part:
 * vertices are moved into model space and weighted to their part's bone, with a smooth
 * falloff to the parent bone around soft joints so limbs bend instead of hinging.
 */
function skinGeometry(template) {
  if (template.skinGeo !== undefined) return template.skinGeo;
  const abs = { root: [0, 0, 0] };
  const index = { root: 0 };
  template.parts.forEach((p, i) => {
    const pp = abs[p.parent];
    abs[p.name] = [pp[0] + p.offset[0], pp[1] + p.offset[1], pp[2] + p.offset[2]];
    index[p.name] = i + 1;
  });
  const geos = [];
  for (const p of template.parts) {
    if (!p.geo || p.mat !== unitMat || RIGID_PARTS.has(p.name)) continue;
    const g = p.geo.clone();
    const [px, py, pz] = abs[p.name];
    g.translate(px, py, pz);
    const pos = g.attributes.position;
    const n = pos.count;
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    const soft = SOFT_JOINTS.has(p.name);
    for (let i = 0; i < n; i++) {
      si[i * 4] = index[p.name];
      let w = 1;
      if (soft) {
        const d = Math.hypot(pos.getX(i) - px, pos.getY(i) - py, pos.getZ(i) - pz);
        if (d < BLEND_RADIUS) {
          const share = 0.5 * (1 - d / BLEND_RADIUS) ** 2;
          w = 1 - share;
          si[i * 4 + 1] = index[p.parent];
          sw[i * 4 + 1] = share;
        }
      }
      sw[i * 4] = w;
    }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    geos.push(g);
  }
  template.skinGeo = geos.length ? mergeGeometries(geos) : null;
  geos.forEach((g) => g.dispose());
  if (template.skinGeo) {
    template.skinGeo.computeBoundingSphere();
    template.skinGeo.boundingSphere.radius *= 1.6;
  }
  return template.skinGeo;
}

/**
 * Creates a model from a template. With `skin`, the parts become a bone hierarchy driving
 * one SkinnedMesh (only props and glowing parts stay rigid); `groups` then holds the
 * bones, so the Animator poses joints the same way either way.
 */
function instantiate(template, { skin = false } = {}) {
  const root = new THREE.Group();
  root.rotation.order = 'YXZ';
  const groups = { root };
  const meshes = [];
  const skinGeo = skin ? skinGeometry(template) : null;
  const rootBone = skinGeo ? new THREE.Bone() : null;
  const bones = rootBone ? [rootBone] : [];
  const parentOf = (name) => (name === 'root' ? rootBone ?? root : groups[name]);
  for (const p of template.parts) {
    const g = skinGeo ? new THREE.Bone() : new THREE.Group();
    g.position.set(...p.offset);
    parentOf(p.parent).add(g);
    groups[p.name] = g;
    if (skinGeo) bones.push(g);
    const rigid = p.geo && (!skinGeo || p.mat !== unitMat || RIGID_PARTS.has(p.name));
    if (rigid) {
      const mesh = new THREE.Mesh(p.geo, p.mat);
      mesh.castShadow = true;
      mesh.receiveShadow = p.mat === towerMat;
      mesh.userData.baseMat = p.mat;
      g.add(mesh);
      if (p.mat !== flameMat && p.mat !== visorMat) meshes.push(mesh);
    }
  }
  if (skinGeo) {
    const mesh = new THREE.SkinnedMesh(skinGeo, unitMat);
    mesh.castShadow = true;
    mesh.userData.baseMat = unitMat;
    mesh.add(rootBone);
    root.add(mesh);
    root.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton(bones));
    meshes.push(mesh);
  }
  for (const [name, pose] of Object.entries(template.base ?? {})) groups[name]?.rotation.set(...pose);
  return { root, groups, meshes };
}

/** Slightly darker version of a colour (creases, soles). */
const shade = (hex, k) => new THREE.Color(hex).multiplyScalar(k).getHex();

/**
 * The card-art mascot: big round pale head with dot eyes, hooked nose and a smirk, a
 * chunky rounded body, stubby jointed arms with mitten hands and short legs. Pivots:
 * body at the hips, head at the neck, arm at the shoulder, fore at the elbow, leg at
 * the hip, shin at the knee. `o` picks outfit colours, build and an optional offset.
 */
function mascot(def, o = {}) {
  const ox = o.ox ?? 0;
  const oy = o.oy ?? 0;
  const oz = o.oz ?? 0;
  const P = (x, y, z) => [x + ox, y + oy, z + oz];
  const skin = o.skin ?? C.skin;
  const torso = o.torso ?? skin;
  const sleeve = o.sleeve ?? skin;
  const legs = o.legs ?? skin;
  const feet = o.feet ?? legs;
  const b = o.bulk ?? 1;
  const limb = o.limb ?? 1;
  const fist = o.fist ?? 1;
  const parent = o.parent ?? 'root';
  const legsParent = o.legsParent ?? parent;
  const sides = [['L', 1], ['R', -1]];
  const ax = 0.25 * b;

  addPart(def, 'body', parent, P(0, 0.26, 0));
  addPart(def, 'head', 'body', P(0, 0.58, 0));
  for (const [s, sx] of sides) {
    addPart(def, `arm${s}`, 'body', P(ax * sx, 0.52, 0));
    addPart(def, `fore${s}`, `arm${s}`, P(ax * sx, 0.4, 0));
  }
  for (const [s, sx] of sides) {
    addPart(def, `leg${s}`, legsParent, P(0.11 * sx * b, 0.26, 0));
    addPart(def, `shin${s}`, `leg${s}`, P(0.11 * sx * b, 0.13, 0));
  }
  const add = (name, ...g) => def[name].geos.push(...g);

  // Chunky pear-shaped torso.
  add('body', place(G.sphere, torso, P(0, 0.42, 0), 0, [0.245 * b, 0.21, 0.205 * b]));
  add('body', place(G.sphere, o.belly ?? torso, P(0, 0.33, 0.01), 0, [0.235 * b, 0.16, 0.205 * b]));
  for (const [, sx] of sides) add('body', place(G.sphere, sleeve, P(ax * 0.92 * sx, 0.52, 0), 0, 0.075 * limb));

  // Head and the card-art face.
  add('head', place(G.sphere, skin, P(0, 0.8, 0), 0, [0.28, 0.272, 0.27]));
  if (!o.noEyes) for (const [, sx] of sides) add('head', place(G.sphere, C.eye, P(0.078 * sx, 0.835, 0.252), 0, [0.026, 0.036, 0.012]));
  if (!o.noNose) {
    add('head', place(capsule(0.009, 0.035), C.eye, P(0.008, 0.79, 0.268), [0.15, 0, 0.12]));
    add('head', place(new THREE.TorusGeometry(1, 0.32, 5, 10, Math.PI), C.eye, P(-0.004, 0.768, 0.266), [0, 0, Math.PI * 1.05], 0.016));
  }
  if (!o.noMouth) add('head', place(new THREE.TorusGeometry(1, 0.2, 5, 12, Math.PI * 0.75), C.eye, P(0.035, 0.735, 0.252), [0.25, 0, Math.PI * 1.1], 0.045));

  // Stubby arms with mitten hands.
  for (const [s, sx] of sides) {
    const x = ax * sx;
    add(`arm${s}`, place(capsule(0.068 * limb, 0.05), sleeve, P(x, 0.46, 0)));
    add(`fore${s}`, place(capsule(0.064 * limb, 0.05), o.forearm ?? sleeve, P(x, 0.35, 0)));
    add(`fore${s}`, place(G.sphere, o.glove ?? skin, P(x, 0.28, 0.01), 0, [0.082 * fist, 0.078 * fist, 0.074 * fist]));
    add(`fore${s}`, place(G.sphere, o.glove ?? skin, P(x - 0.05 * sx * fist, 0.3, 0.045 * fist), 0, 0.03 * fist));
  }
  // Short legs and rounded feet.
  for (const [s, sx] of sides) {
    const x = 0.11 * sx * b;
    add(`leg${s}`, place(capsule(0.08 * limb, 0.04), legs, P(x, 0.2, 0)));
    add(`shin${s}`, place(capsule(0.074 * limb, 0.03), legs, P(x, 0.09, 0)));
    add(`shin${s}`, place(G.sphere, feet, P(x, 0.045, 0.025), 0, [0.085 * limb, 0.055, 0.11 * limb]));
  }
  return {
    P,
    add,
    hand: (s) => P((s === 'L' ? 1 : -1) * ax, 0.28, 0.01),
    headC: P(0, 0.8, 0),
  };
}

const belt = (m, color = C.leather, buckle = C.gold, y = 0.3, w = 1) => {
  m.add('body', place(G.cyl, color, m.P(0, y, 0.005), 0, [0.238 * w, 0.055, 0.21 * w]));
  m.add('body', place(G.box, buckle, m.P(0, y, 0.21 * w), 0, [0.075, 0.06, 0.018]));
  m.add('body', place(G.box, shade(color, 0.6), m.P(0, y, 0.218 * w), 0, [0.04, 0.03, 0.012]));
};

const crownGeos = (P, y, r) => {
  const out = [place(G.cyl, C.gold, P(0, y, 0), 0, [r, 0.09, r])];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    out.push(place(G.coneLo, C.gold, P(Math.sin(a) * r * 0.9, y + 0.09, Math.cos(a) * r * 0.9), 0, [0.045, 0.1, 0.045]));
  }
  out.push(place(G.sphereLo, 0xe23d3d, P(0, y, r), 0, 0.03));
  return out;
};

/** Little gun on a wooden carriage; `barrel` rotates/recoils, `muzzle` marks the tip. */
function cannonParts(def, { ox = 0, oz = 0, scale = 1, parent = 'root', ornate = false } = {}) {
  const S = (x, y, z) => [ox + x * scale, y * scale, oz + z * scale];
  const base = addPart(def, 'carriage', parent, S(0, 0, 0));
  base.geos.push(
    place(G.box, C.wood, S(0, 0.32, -0.05), 0, [0.62 * scale, 0.22 * scale, 0.95 * scale]),
    place(G.box, C.woodDark, S(0.3, 0.42, -0.05), 0, [0.08 * scale, 0.3 * scale, 0.9 * scale]),
    place(G.box, C.woodDark, S(-0.3, 0.42, -0.05), 0, [0.08 * scale, 0.3 * scale, 0.9 * scale]),
    place(G.box, C.iron, S(0, 0.08, -0.05), 0, [0.7 * scale, 0.08 * scale, 1.0 * scale]),
  );
  for (const sx of [1, -1]) {
    base.geos.push(
      place(G.cyl, C.woodDark, S(0.4 * sx, 0.27, 0.15), [0, 0, Math.PI / 2], [0.25 * scale, 0.1 * scale, 0.25 * scale]),
      place(G.cylLo, C.iron, S(0.46 * sx, 0.27, 0.15), [0, 0, Math.PI / 2], [0.08 * scale, 0.05 * scale, 0.08 * scale]),
      place(G.box, C.iron, S(0.34 * sx, 0.45, 0.3), 0, [0.1 * scale, 0.1 * scale, 0.1 * scale]),
    );
  }
  if (ornate) {
    base.geos.push(
      place(G.box, C.goldDark, S(0, 0.43, 0.42), 0, [0.72 * scale, 0.07 * scale, 0.08 * scale]),
      place(G.diamond, C.gold, S(0.32, 0.44, 0.49), 0, 0.065 * scale),
      place(G.diamond, C.gold, S(-0.32, 0.44, 0.49), 0, 0.065 * scale),
    );
  }
  const barrel = addPart(def, 'barrel', 'carriage', S(0, 0.58, 0));
  barrel.geos.push(
    place(G.cyl, C.iron, S(0, 0.6, 0.22), [Math.PI / 2, 0, 0], [0.15 * scale, 1.05 * scale, 0.15 * scale]),
    place(G.cyl, C.iron, S(0, 0.6, -0.12), [Math.PI / 2, 0, 0], [0.21 * scale, 0.4 * scale, 0.21 * scale]),
    place(G.cyl, C.ironLight, S(0, 0.6, 0.72), [Math.PI / 2, 0, 0], [0.19 * scale, 0.1 * scale, 0.19 * scale]),
    place(G.cyl, 0x0b0b0d, S(0, 0.6, 0.78), [Math.PI / 2, 0, 0], [0.11 * scale, 0.02 * scale, 0.11 * scale]),
    place(G.sphere, C.iron, S(0, 0.6, -0.36), 0, 0.15 * scale),
    place(G.cylLo, C.goldDark, S(0, 0.6, 0.02), [0, 0, Math.PI / 2], [0.05 * scale, 0.5 * scale, 0.05 * scale]),
  );
  if (ornate) {
    barrel.geos.push(
      place(G.cyl, C.goldDark, S(0, 0.6, 0.58), [Math.PI / 2, 0, 0], [0.205 * scale, 0.055 * scale, 0.205 * scale]),
      place(G.cyl, C.ironLight, S(0, 0.6, 0.69), [Math.PI / 2, 0, 0], [0.225 * scale, 0.055 * scale, 0.225 * scale]),
    );
  }
  addPart(def, 'muzzle', 'barrel', S(0, 0.6, 0.85));
}

// ------------------------------------------------------------------ card models

/** Attack styles: additive joint offsets at full wind-up (W), impact (I) and while engaged (hold). */
const STYLES = {
  swing: {
    windup: { 'armR.x': -2.6, 'foreR.x': -0.8, 'body.y': 0.35, 'body.x': -0.1 },
    impact: { 'armR.x': -1.0, 'foreR.x': 0.1, 'body.y': -0.3, 'body.x': 0.2 },
  },
  stab: { windup: { 'armR.x': 0.5, 'foreR.x': -1.3, 'body.y': 0.35 }, impact: { 'armR.x': -1.45, 'foreR.x': 0.15, 'body.y': -0.25, 'body.x': 0.18 } },
  heavy: {
    windup: { 'armR.x': -2.8, 'armL.x': -2.8, 'foreR.x': -0.6, 'foreL.x': -0.6, 'armL.z': -0.45, 'armR.z': 0.45, 'body.x': -0.2 },
    impact: { 'armR.x': -0.9, 'armL.x': -0.9, 'foreR.x': 0.1, 'foreL.x': 0.1, 'armL.z': -0.45, 'armR.z': 0.45, 'body.x': 0.35 },
  },
  punch: {
    windup: { 'armR.x': 0.6, 'foreR.x': -1.5, 'body.y': 0.45, 'body.x': -0.05 },
    impact: { 'armR.x': -1.55, 'foreR.x': 0.15, 'body.y': -0.35, 'body.x': 0.2 },
  },
  hammer: { windup: { 'armR.x': -2.6, 'foreR.x': -0.8, 'body.x': -0.12 }, impact: { 'armR.x': -0.8, 'foreR.x': 0.1, 'body.x': 0.22 } },
  bow: {
    hold: { 'armL.x': -1.45, 'foreL.x': 0.25, 'armR.x': -1.35, 'armR.y': -0.35, 'foreR.x': -1.0, 'body.y': 0.3 },
    windup: { 'foreR.x': -0.4, 'armR.y': -0.15 },
    impact: { 'armR.x': 0.6, 'foreR.x': 0.8 },
  },
  throw: {
    windup: { 'armR.x': -2.7, 'foreR.x': -1.1, 'body.x': -0.18, 'body.y': 0.3 },
    impact: { 'armR.x': -1.2, 'foreR.x': 0.2, 'body.x': 0.25, 'body.y': -0.2 },
  },
  cast: {
    hold: { 'armR.x': -0.4, 'foreR.x': -0.5 },
    windup: { 'armR.x': -0.3, 'armL.x': -0.9, 'foreL.x': -0.7, 'body.x': -0.12 },
    impact: { 'armR.x': -1.3, 'foreR.x': 0.3, 'armL.x': -0.5, 'body.x': 0.2 },
  },
  cannon: { windup: {}, impact: { 'barrel.recoil': 1 } },
  shoot: { hold: { 'armR.x': -1.45, 'armL.x': -1.3, 'armL.y': 0.5, 'foreL.x': -0.4, 'body.y': 0.15 }, windup: {}, impact: { 'body.x': -0.14, 'armR.x': 0.3 } },
  spin: { hold: { 'armR.z': -1.2, 'armL.z': 1.2 }, windup: { 'body.y': 0.6 }, impact: {} },
  lance: { hold: { 'armR.x': -1.35 }, windup: { 'armR.x': 0.35, 'body.x': -0.1 }, impact: { 'armR.x': -0.3, 'body.x': 0.25 } },
  breath: { windup: { 'head.x': -0.4 }, impact: { 'head.x': 0.35, 'body.x': 0.15 } },
  drop: { windup: {}, impact: { 'body.z': 0.08 } },
  none: { windup: {}, impact: {} },
  king: { hold: { 'armL.x': -1.0, 'armL.y': 0.6, 'foreL.x': -0.6 }, windup: { 'armR.x': -2.4, 'foreR.x': -0.4 }, impact: { 'armR.x': -1.4, 'barrel.recoil': 1 } },
};

const BUILDERS = {
  archer(def, team) {
    const cloth = TEAM_CLOTH[team];
    const m = mascot(def, { feet: C.leather });
    m.add('head', place(G.hood, cloth, m.headC, 0, [0.302, 0.296, 0.296]));
    m.add('head', place(G.coneLo, TEAM_CLOTH_DARK[team], m.P(0, 0.96, -0.24), [-0.9, 0, 0], [0.12, 0.26, 0.12]));
    // Capelet over the shoulders.
    m.add('body', place(G.cone, cloth, m.P(0, 0.5, -0.01), 0, [0.31, 0.3, 0.27]));
    m.add('body', place(G.box, C.leather, m.P(0, 0.42, 0.19), [0, 0, 0.75], [0.04, 0.4, 0.025]));
    belt(m);
    // Quiver with fletched arrows on the back.
    m.add('body', place(G.cyl, C.wood, m.P(0.1, 0.5, -0.22), [0.35, 0, -0.4], [0.06, 0.34, 0.06]));
    for (let i = 0; i < 3; i++) m.add('body', place(G.box, 0xf6efe0, m.P(0.04 + i * 0.05, 0.72, -0.3), [0.35, 0, -0.4], [0.03, 0.09, 0.008]));
    m.add('foreL', ...bowGeos(m.hand('L'), C.wood));
    return { style: 'bow', scale: 1.25, launch: 'foreL' };
  },
  barbarian(def) {
    const m = mascot(def, { bulk: 1.05 });
    m.add('head', place(G.dome, C.blond, m.P(0, 0.84, 0), 0, [0.292, 0.255, 0.292]));
    m.add('head', place(G.cyl, shade(C.blond, 0.85), m.P(0, 0.845, 0), 0, [0.296, 0.04, 0.296]));
    for (const sx of [1, -1]) {
      m.add('head', place(G.box, C.blond, m.P(0.255 * sx, 0.75, 0.03), [0, 0, 0.12 * sx], [0.07, 0.18, 0.17]));
      // Curled handlebar mustache.
      m.add('head', place(capsule(0.024, 0.07), C.blond, m.P(0.055 * sx, 0.742, 0.262), [0, 0, 1.2 * sx]));
      m.add('head', place(new THREE.TorusGeometry(1, 0.38, 6, 10, Math.PI * 1.4), C.blond, m.P(0.112 * sx, 0.752, 0.25), [0, 0, sx > 0 ? -0.4 : Math.PI + 0.4], 0.026));
    }
    belt(m);
    m.add('foreR', ...swordGeos(m.hand('R'), 0.34, 0.06));
    return { style: 'swing', scale: 1.3 };
  },
  bomber(def) {
    const m = mascot(def, { noEyes: true, bulk: 1.08, feet: shade(C.skin, 0.92) });
    m.add('head', place(G.hood, C.navy, m.headC, 0, [0.297, 0.292, 0.292]));
    m.add('head', place(G.cyl, shade(C.navy, 0.8), m.P(0, 0.9, 0), 0, [0.288, 0.03, 0.288]));
    for (const sx of [1, -1]) {
      m.add('head', place(new THREE.TorusGeometry(1, 0.26, 8, 18), C.gold, m.P(0.088 * sx, 0.835, 0.25), 0, 0.075));
      m.add('head', place(G.cyl, 0x2e3440, m.P(0.088 * sx, 0.835, 0.25), [Math.PI / 2, 0, 0], [0.068, 0.03, 0.068]));
      m.add('head', place(G.sphere, 0x8fb3c9, m.P(0.07 * sx, 0.855, 0.268), 0, [0.02, 0.015, 0.006]));
      m.add('head', place(G.sphere, C.navy, m.P(0.255 * sx, 0.72, 0.04), 0, [0.06, 0.1, 0.08]));
    }
    m.add('body', place(G.box, C.leather, m.P(0.07, 0.43, 0.19), [0, 0, 0.55], [0.04, 0.4, 0.025]));
    m.add('body', place(G.box, C.leather, m.P(-0.07, 0.43, 0.19), [0, 0, -0.55], [0.04, 0.4, 0.025]));
    belt(m, C.leatherDark, C.goldDark);
    const h = m.hand('R');
    const bomb = addPart(def, 'prop', 'foreR', h);
    bomb.geos.push(
      place(G.sphere, 0x1d1d22, [h[0], h[1] - 0.03, h[2] + 0.12], 0, 0.14),
      place(G.cylLo, 0x2a2a30, [h[0], h[1] + 0.11, h[2] + 0.12], 0, [0.04, 0.05, 0.04]),
      place(G.cylLo, C.leather, [h[0], h[1] + 0.16, h[2] + 0.12], [0, 0, 0.3], [0.012, 0.07, 0.012]),
      place(G.sphereLo, 0xffd35a, [h[0] - 0.02, h[1] + 0.2, h[2] + 0.12], 0, 0.028),
    );
    return { style: 'throw', scale: 1.2, launch: 'foreR' };
  },
  cannon(def) {
    cannonParts(def);
    mascot(def, { oz: -0.85, parent: 'carriage' });
    return { style: 'cannon', scale: 1.15, launch: 'muzzle', base: { armL: [-0.9, 0, 0], armR: [-0.9, 0, 0], foreL: [-0.5, 0, 0], foreR: [-0.5, 0, 0] } };
  },
  goblin(def) {
    const m = mascot(def, { torso: C.green, belly: C.green });
    for (const sx of [1, -1]) {
      m.add('head', place(G.cone, C.goblinEar, m.P(0.34 * sx, 0.87, -0.02), [0, 0.25 * sx, -1.15 * sx], [0.075, 0.32, 0.03]));
      m.add('head', place(G.cone, shade(C.goblinEar, 0.8), m.P(0.33 * sx, 0.868, -0.005), [0, 0.25 * sx, -1.15 * sx], [0.045, 0.24, 0.02]));
    }
    // Vest edges and an open collar.
    for (const sx of [1, -1]) m.add('body', place(G.box, C.greenDark, m.P(0.045 * sx, 0.42, 0.2), [0, 0, -0.1 * sx], [0.03, 0.26, 0.02]));
    m.add('body', place(G.box, C.skin, m.P(0, 0.48, 0.2), 0, [0.06, 0.12, 0.012]));
    belt(m, C.leather, C.steelDark);
    m.add('foreR', ...swordGeos(m.hand('R'), 0.22, 0.05));
    return { style: 'stab', scale: 1.1 };
  },
  skeleton(def) {
    const m = mascot(def, { skin: C.bone, limb: 0.5, fist: 0.8, torso: C.bone });
    // Hollow the chunky torso into a ribcage, spine and pelvis.
    def.body.geos.length = 0;
    const rib = new THREE.TorusGeometry(1, 0.11, 5, 14, Math.PI * 1.5).rotateZ(Math.PI * 0.75).rotateX(-Math.PI / 2);
    [[0.5, 0.75], [0.44, 0.9], [0.38, 0.92], [0.32, 0.8]].forEach(([y, f]) => m.add('body', place(rib, C.bone, m.P(0, y, 0), 0, [0.17 * f, 0.1, 0.14 * f])));
    m.add('body', place(G.cyl, C.bone, m.P(0, 0.38, -0.05), 0, [0.03, 0.32, 0.03]));
    m.add('body', place(G.sphere, C.bone, m.P(0, 0.25, 0), 0, [0.13, 0.06, 0.09]));
    for (const [, sx] of [['L', 1], ['R', -1]]) m.add('body', place(G.sphere, C.bone, m.P(0.2 * sx, 0.52, 0), 0, 0.05));
    m.add('foreR', ...swordGeos(m.hand('R'), 0.26, 0.05, { guard: C.goldDark, blade: 0xa7acb2 }));
    return { style: 'swing', scale: 1.05 };
  },
  giant(def) {
    const vest = C.leather;
    const m = mascot(def, { torso: vest, belly: vest, bulk: 1.2, limb: 1.35, fist: 1.5 });
    m.add('body', place(G.box, shade(vest, 0.7), m.P(0, 0.42, 0.205), 0, [0.03, 0.28, 0.012]));
    for (let i = 0; i < 3; i++) m.add('body', place(G.box, 0xd8b98a, m.P(0, 0.5 - i * 0.07, 0.215), 0, [0.08, 0.012, 0.01]));
    m.add('body', place(G.cone, shade(vest, 1.15), m.P(0, 0.52, 0), 0, [0.31, 0.12, 0.27]));
    belt(m, C.leatherDark, C.gold, 0.3, 1.2);
    // Bald on top, ginger fringe around the back and thick brows.
    m.add('head', place(G.fringe, C.ginger, m.headC, 0, [0.29, 0.282, 0.282]));
    for (const sx of [1, -1]) m.add('head', place(capsule(0.03, 0.09), C.ginger, m.P(0.085 * sx, 0.9, 0.245), [0, 0, (Math.PI / 2) * sx + 0.25 * sx]));
    return { style: 'punch', scale: 1.95 };
  },
  wizard(def, team) {
    const robe = TEAM_CLOTH[team];
    const m = mascot(def, { torso: robe, sleeve: robe, legs: robe, feet: C.leatherDark });
    m.add('head', place(G.hood, robe, m.headC, 0, [0.306, 0.3, 0.3]));
    m.add('body', place(G.cone, robe, m.P(0, 0.26, 0), 0, [0.3, 0.52, 0.27]));
    m.add('body', place(G.cone, TEAM_CLOTH_DARK[team], m.P(0, 0.5, -0.01), 0, [0.31, 0.24, 0.27]));
    belt(m, C.leather, C.gold, 0.32);
    const h = m.hand('R');
    m.add('foreR', place(G.cylLo, C.wood, [h[0], h[1] + 0.2, h[2] + 0.04], 0, [0.025, 0.9, 0.025]));
    m.add('foreR', place(G.cyl, C.leatherDark, [h[0], h[1] + 0.62, h[2] + 0.04], 0, [0.045, 0.07, 0.045]));
    const torch = addPart(def, 'torch', 'foreR', [h[0], h[1] + 0.7, h[2] + 0.04]);
    torch.mat = flameMat;
    torch.geos.push(place(G.cone, C.flame, [h[0], h[1] + 0.74, h[2] + 0.04], 0, [0.06, 0.16, 0.06]));
    return { style: 'cast', scale: 1.35, launch: 'torch' };
  },
  'hog-rider'(def) {
    const pig = addPart(def, 'pig', 'root', [0, 0.42, 0]);
    pig.geos.push(
      place(G.sphere, C.pig, [0, 0.5, -0.02], 0, [0.36, 0.3, 0.55]),
      place(G.sphere, C.pig, [0, 0.56, 0.5], 0, [0.26, 0.25, 0.25]),
      place(G.cyl, C.pigDark, [0, 0.52, 0.76], [Math.PI / 2, 0, 0], [0.13, 0.1, 0.1]),
      place(G.box, 0xf6f1e4, [0, 0.43, 0.66], 0, [0.2, 0.05, 0.08]),
      place(G.box, C.leather, [0, 0.79, -0.05], 0, [0.42, 0.08, 0.4]),
      place(G.box, C.leatherDark, [0, 0.62, -0.05], 0, [0.74, 0.06, 0.12]),
      place(new THREE.TorusGeometry(1, 0.3, 5, 10, Math.PI * 1.5), C.pigDark, [0, 0.62, -0.58], [0, Math.PI / 2, 0], 0.06),
    );
    for (const sx of [1, -1]) {
      pig.geos.push(
        place(G.sphere, C.eye, [0.11 * sx, 0.64, 0.7], 0, [0.025, 0.03, 0.015]),
        place(G.sphere, 0x6b3a46, [0.045 * sx, 0.52, 0.81], 0, [0.025, 0.035, 0.01]),
        place(G.cone, C.pigDark, [0.16 * sx, 0.8, 0.44], [-0.3, 0, -0.5 * sx], [0.08, 0.15, 0.05]),
        place(G.cone, 0xf6f1e4, [0.1 * sx, 0.47, 0.72], [0.4, 0, 0.25 * sx], [0.025, 0.08, 0.025]),
      );
    }
    [[0.2, 0.27], [-0.2, 0.27], [0.2, -0.3], [-0.2, -0.3]].forEach(([x, z], i) => {
      const leg = addPart(def, `pl${i}`, 'pig', [x, 0.32, z]);
      leg.geos.push(place(capsule(0.075, 0.12), C.pig, [x, 0.18, z]), place(G.cylLo, C.leatherDark, [x, 0.04, z], 0, [0.07, 0.07, 0.07]));
    });
    const m = mascot(def, { oy: 0.58, oz: -0.08, parent: 'pig', legsParent: 'body' });
    const h = m.hand('R');
    const dir = [0, -0.5, 0.866];
    const at = (k) => [h[0], h[1] + dir[1] * k, h[2] + dir[2] * k];
    m.add('foreR', place(G.cylLo, C.wood, at(0.18), [0.52 + Math.PI / 2, 0, 0], [0.03, 0.46, 0.03]));
    m.add('foreR', place(G.box, 0x6b5a48, at(0.42), [0.52, 0, 0], [0.26, 0.16, 0.16]));
    return {
      style: 'hammer',
      scale: 1.15,
      base: { legL: [-0.6, 0, 0.9], legR: [-0.6, 0, -0.9], shinL: [1.1, 0, 0], shinR: [1.1, 0, 0], armL: [-0.5, 0, 0] },
      mount: true,
    };
  },
  pekka(def) {
    const m = mascot(def, { bulk: 1.05 });
    m.add('foreR', ...swordGeos(m.hand('R'), 0.85, 0.09, { tilt: -0.95 }));
    return { style: 'heavy', scale: 1.8 };
  },
};


const templates = new Map();
function template(id, team) {
  const key = `${id}|${team}`;
  if (!templates.has(key)) {
    const def = {};
    const meta = BUILDERS[id](def, team);
    templates.set(key, { parts: compile(def), ...meta });
  }
  return templates.get(key);
}

/** World height flyers hover at (matches the sim's AIR_HEIGHT). */
const AIR_LIFT = 1.6;

/** Model height of the mascot rig before scaling (top of the head). */
const RIG_HEIGHT = 1.08;
/** Units read small under the steep battle camera, so all of them get this boost. */
const UNIT_SIZE = 1.25;

export function buildUnit(cardId, team) {
  const t = template(cardId, team);
  const rig = instantiate(t, { skin: true });
  const scale = t.scale * UNIT_SIZE;
  rig.root.scale.setScalar(scale);
  const height = (t.mount ? RIG_HEIGHT + 0.45 : RIG_HEIGHT) * scale + (t.air ? AIR_LIFT : 0);
  return { ...rig, style: t.style, scale, height, launch: t.launch ? rig.groups[t.launch] : null, base: t.base ?? {}, mount: !!t.mount, air: !!t.air };
}

const CHEST_LOOK = {
  wooden: { body: C.wood, band: C.iron, lock: C.ironLight },
  silver: { body: C.steel, band: C.steelDark, lock: C.ironLight },
  gold: { body: C.gold, band: C.goldDark, lock: C.iron },
  magical: { body: 0x7a3fd0, band: C.gold, lock: C.goldDark },
};

/** Treasure chest with a hinged lid (`groups.lid`), in the colours of its rarity. */
export function buildChest(type) {
  const look = CHEST_LOOK[type] ?? CHEST_LOOK.wooden;
  const def = {};
  const base = addPart(def, 'body', 'root', [0, 0, 0]);
  base.geos.push(place(G.box, look.body, [0, 0.36, 0], 0, [1.3, 0.72, 0.86]));
  for (const x of [-0.5, 0, 0.5]) base.geos.push(place(G.box, look.band, [x, 0.36, 0], 0, [0.1, 0.74, 0.9]));
  base.geos.push(place(G.box, look.lock, [0, 0.55, 0.45], 0, [0.22, 0.26, 0.06]));
  const lid = addPart(def, 'lid', 'body', [0, 0.72, -0.43]);
  const arch = new THREE.CylinderGeometry(0.43, 0.43, 1.3, 16, 1, false, 0, Math.PI).rotateZ(Math.PI / 2);
  lid.geos.push(place(arch, look.body, [0, 0.72, 0]));
  lid.geos.push(place(G.box, look.band, [0, 0.73, 0], 0, [1.3, 0.04, 0.86]));
  base.geos.push(place(G.box, C.gold, [0, 0.66, 0], 0, [1.2, 0.08, 0.76]));
  for (const x of [-0.5, 0, 0.5]) lid.geos.push(place(new THREE.CylinderGeometry(0.45, 0.45, 0.1, 16, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), look.band, [x, 0.72, 0]));
  if (type === 'magical') {
    const gem = addPart(def, 'gem', 'lid', [0, 1.2, 0]);
    gem.mat = visorMat;
    gem.geos.push(place(new THREE.OctahedronGeometry(0.16, 0), 0xff8af5, [0, 1.2, 0]));
  }
  return instantiate({ parts: compile(def) });
}

/** Renders a model as a translucent placement ghost. */
export function ghostify(model, mat) {
  model.root.traverse((o) => {
    if (o.isMesh) {
      o.material = mat;
      o.castShadow = false;
    }
  });
}

// ------------------------------------------------------------------ towers

function princessTowerDef(def, team) {
  const body = addPart(def, 'tower', 'root', [0, 0, 0]);
  body.mat = towerMat;
  const g = body.geos;
  const team1 = TEAM_CLOTH[team];
  g.push(place(G.box, C.stoneDark, [0, 0.18, 0], 0, [3.1, 0.36, 3.1]));
  g.push(place(G.box, C.stone, [0, 1.7, 0], 0, [2.3, 2.7, 2.3]));
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    g.push(place(G.box, C.stoneLight, [1.1 * sx, 1.85, 1.1 * sz], 0, [0.62, 3.0, 0.62]));
    g.push(place(G.box, C.gold, [1.1 * sx, 0.5, 1.1 * sz], 0, [0.7, 0.28, 0.7]));
    g.push(place(G.box, C.stoneLight, [1.05 * sx, 3.55, 1.05 * sz], 0, [0.62, 0.55, 0.62]));
  }
  g.push(place(G.box, C.wood, [0, 2.45, 0], 0, [2.45, 0.22, 2.45]));
  g.push(place(G.box, C.wood, [0, 3.1, 0], 0, [2.75, 0.24, 2.75]));
  for (const [x, z, ry] of [[0, 1.17, 0], [1.17, 0, Math.PI / 2], [-1.17, 0, Math.PI / 2], [0, -1.17, 0]]) {
    g.push(place(G.box, team1, [x, 1.75, z], [0, ry, 0], [0.95, 1.15, 0.05]));
    g.push(place(G.box, C.gold, [x * 1.02, 2.05, z * 1.02], [0, ry, 0], [0.42, 0.1, 0.05]));
    for (const dx of [-0.16, 0, 0.16]) {
      const off = ry ? [0, 0, dx] : [dx, 0, 0];
      g.push(place(G.coneLo, C.gold, [x * 1.02 + off[0], 2.17, z * 1.02 + off[2]], 0, [0.05, 0.14, 0.05]));
    }
  }
  g.push(place(G.box, C.woodDark, [0, 0.72, 1.16], 0, [0.6, 0.72, 0.06]));
  for (const [x, z] of [[0, 1.2], [0, -1.2], [1.2, 0], [-1.2, 0]]) g.push(place(G.box, C.stoneLight, [x, 3.42, z], 0, [0.42, 0.4, 0.42]));
  return 3.22;
}

function kingTowerDef(def, team) {
  const body = addPart(def, 'tower', 'root', [0, 0, 0]);
  body.mat = towerMat;
  const g = body.geos;
  const cloth = TEAM_CLOTH[team];
  const darkCloth = TEAM_CLOTH_DARK[team];

  // Turf display base and stepped keep.
  g.push(place(G.cylLo, C.dirt, [0, 0.1, 0], 0, [2.38, 0.2, 2.38]));
  g.push(place(G.cylLo, C.grass, [0, 0.25, 0], 0, [2.3, 0.13, 2.3]));
  g.push(place(G.box, C.stoneDark, [0, 0.42, 0], 0, [3.55, 0.38, 3.55]));
  g.push(place(G.box, C.grey, [0, 2.1, 0], 0, [3.02, 3.05, 3.02]));
  g.push(place(G.box, C.greyDark, [0, 0.66, 0], 0, [3.25, 0.26, 3.25]));

  // Four pale corner buttresses give the tower its chunky tapered silhouette.
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    g.push(place(G.box, C.greyLight, [1.43 * sx, 2.22, 1.43 * sz], 0, [0.78, 3.45, 0.78]));
    g.push(place(G.box, C.stone, [1.48 * sx, 0.78, 1.48 * sz], 0, [0.98, 0.75, 0.98]));
    g.push(place(G.box, C.greyLight, [1.43 * sx, 4.08, 1.43 * sz], 0, [0.88, 0.48, 0.88]));
    g.push(place(G.diamond, C.gold, [1.86 * sx, 2.76, 1.86 * sz], 0, [0.16, 0.21, 0.11]));
    g.push(place(G.diamond, C.goldDark, [1.7 * sx, 0.68, 1.7 * sz], 0, [0.11, 0.14, 0.09]));
  }

  // Arched oak entrance, stone voussoirs and a short path.
  g.push(place(G.box, 0x241a14, [0, 1.13, 1.535], 0, [0.86, 1.04, 0.07]));
  g.push(place(G.cyl, 0x241a14, [0, 1.65, 1.535], [Math.PI / 2, 0, 0], [0.43, 0.07, 0.43]));
  g.push(place(G.box, C.woodDark, [0, 1.12, 1.575], 0, [0.7, 0.98, 0.06]));
  g.push(place(G.cyl, C.woodDark, [0, 1.61, 1.575], [Math.PI / 2, 0, 0], [0.35, 0.06, 0.35]));
  g.push(place(new THREE.TorusGeometry(0.45, 0.09, 5, 18, Math.PI), C.stoneLight, [0, 1.65, 1.59], 0));
  for (const x of [-0.44, 0.44]) g.push(place(G.box, C.stoneLight, [x, 1.13, 1.59], 0, [0.16, 1.08, 0.16]));
  for (const x of [-0.22, 0, 0.22]) g.push(place(G.box, C.iron, [x, 1.23, 1.62], 0, [0.035, 0.72, 0.035]));
  g.push(place(G.box, C.iron, [0, 1.12, 1.625], 0, [0.72, 0.045, 0.035]));
  g.push(place(G.box, C.greyDark, [0, 0.54, 2.02], 0, [1.12, 0.12, 0.7]));
  g.push(place(G.box, C.stoneDark, [0, 0.44, 2.42], 0, [0.82, 0.1, 0.42]));

  // Main shield banner and smaller side standards.
  g.push(place(G.banner, cloth, [0, 2.75, 1.57], 0, [1.05, 1.45, 0.07]));
  g.push(place(G.box, C.goldDark, [0, 3.44, 1.625], 0, [1.2, 0.11, 0.08]));
  for (const [x, ry] of [[1.56, Math.PI / 2], [-1.56, Math.PI / 2]]) {
    g.push(place(G.banner, darkCloth, [x, 2.42, 0.18], [0, ry, 0], [0.62, 1.05, 0.07]));
    g.push(place(G.box, C.goldDark, [x * 1.01, 2.91, 0.18], [0, ry, 0], [0.72, 0.08, 0.08]));
  }

  // Blocky gold crown crest on the front banner.
  g.push(place(G.box, C.goldDark, [0, 2.65, 1.635], 0, [0.64, 0.13, 0.06]));
  for (const [x, h] of [[-0.24, 0.29], [0, 0.4], [0.24, 0.29]]) {
    g.push(place(G.box, C.gold, [x, 2.82 + (h - 0.29) / 2, 1.64], 0, [0.13, h, 0.065]));
    g.push(place(G.diamond, C.gold, [x, 2.99 + (h - 0.29), 1.64], 0, [0.09, 0.1, 0.055]));
  }

  // Heavy parapet and alternating crenellations around the roof.
  g.push(place(G.box, C.woodDark, [0, 3.56, 0], 0, [3.18, 0.18, 3.18]));
  g.push(place(G.box, C.greyDark, [0, 3.72, 0], 0, [3.28, 0.18, 3.28]));
  for (const [x, z] of [
    [-1.35, 1.5], [-0.45, 1.5], [0.45, 1.5], [1.35, 1.5],
    [-1.35, -1.5], [-0.45, -1.5], [0.45, -1.5], [1.35, -1.5],
    [-1.5, -0.5], [-1.5, 0.5], [1.5, -0.5], [1.5, 0.5],
  ]) g.push(place(G.box, C.greyLight, [x, 4.0, z], 0, [0.48, 0.48, 0.48]));
  return 3.76;
}

const towerTemplates = new Map();
function towerTemplate(kind, team) {
  const key = `${kind}|${team}`;
  if (!towerTemplates.has(key)) {
    const def = {};
    const king = kind === 'king';
    const top = king ? kingTowerDef(def, team) : princessTowerDef(def, team);
    const crewScale = king ? 1.45 : 1.4;
    // The crew is authored at unit scale, so its parts are pre-scaled into tower space.
    const crew = {};
    const cloth = TEAM_CLOTH[team];
    if (king) {
      const m = mascot(crew, { ox: -0.5, oz: -0.12, torso: cloth, sleeve: cloth, legs: TEAM_CLOTH_DARK[team], feet: C.leatherDark, bulk: 1.08 });
      m.add('head', ...crownGeos(m.P, 1.04, 0.17));
      for (const sx of [1, -1]) {
        m.add('head', place(capsule(0.032, 0.1), 0x1b1b1f, m.P(0.07 * sx, 0.748, 0.25), [0, 0, 1.25 * sx]));
        m.add('head', place(G.box, 0x1b1b1f, m.P(0.08 * sx, 0.9, 0.245), [0, 0, -0.2 * sx], [0.08, 0.025, 0.02]));
      }
      m.add('body', place(G.banner, cloth, m.P(0, 0.44, -0.2), [0, Math.PI, 0], [0.48, 0.65, 0.035]));
      m.add('body', place(G.sphere, 0xf4efe6, m.P(0, 0.56, -0.01), 0, [0.27, 0.06, 0.23]));
      m.add('body', place(G.box, C.gold, m.P(0, 0.42, 0.205), 0, [0.04, 0.24, 0.012]));
      belt(m, C.gold, C.goldDark, 0.3, 1.08);
      cannonParts(crew, { ox: 0.28, oz: 0.2, scale: 1.02, ornate: true });
    } else {
      const m = mascot(crew, { torso: cloth, sleeve: cloth, legs: TEAM_CLOTH_DARK[team], feet: C.leatherDark });
      // Pink bob: cap, fringe of bangs and side locks.
      m.add('head', place(G.hair, C.hair, m.P(0, 0.82, -0.01), 0, [0.3, 0.3, 0.3]));
      m.add('head', place(G.box, C.hair, m.P(0, 0.95, 0.2), [0.4, 0, 0], [0.46, 0.1, 0.12]));
      for (const sx of [1, -1]) m.add('head', place(G.box, C.hair, m.P(0.255 * sx, 0.72, 0.06), 0, [0.08, 0.3, 0.26]));
      belt(m);
      m.add('foreL', ...bowGeos(m.hand('L'), C.wood));
    }
    for (const p of Object.values(crew)) {
      p.pivot = p.pivot.map((v) => v * crewScale);
      p.geos.forEach((geo) => geo.scale(crewScale, crewScale, crewScale));
    }
    const crewParts = compile(crew);
    const towerParts = compile(def, towerMat);
    towerTemplates.set(key, {
      parts: towerParts,
      crew: { parts: crewParts },
      top,
      crewHeight: RIG_HEIGHT * crewScale,
      style: king ? 'king' : 'bow',
      launch: king ? 'muzzle' : 'foreL',
    });
  }
  return towerTemplates.get(key);
}

// ------------------------------------------------------------------ authored models

/** Sculpted tower models that replace the procedural ones once loaded (footprint in world units). */
const TOWER_MODELS = {
  king: { url: '/assets/models/king-tower.glb', width: 3.6 },
  princess: { url: '/assets/models/princess-tower.glb', width: 2.85 },
};
/** Per kind: { teams: [blue, red] Object3D, top, half } — `half` is the wall half-width (for crack decals). */
const towerModels = {};

/** Turns the model's blue cloth red for the enemy team (hue shift of saturated blues only). */
function recolorForRed(texture) {
  const img = texture.image;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const p = data.data;
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i];
    const g = p[i + 1];
    const b = p[i + 2];
    // Blue team cloth: blue clearly dominant and saturated.
    if (b > r + 40 && b > g + 20) {
      p[i] = Math.min(255, b * 0.95 + 20);
      p[i + 1] = Math.round(g * 0.45);
      p[i + 2] = Math.round(r * 0.55);
    }
  }
  ctx.putImageData(data, 0, 0);
  const t = new THREE.CanvasTexture(canvas);
  t.flipY = texture.flipY;
  t.colorSpace = texture.colorSpace;
  t.wrapS = texture.wrapS;
  t.wrapT = texture.wrapT;
  t.anisotropy = 8;
  return t;
}

/** Half-width of the walls between 25 % and 60 % of the model's height, in the holder's space. */
function wallHalfWidth(src, height) {
  src.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let half = 0;
  src.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 7) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      const k = v.y / (height * src.scale.y);
      if (k > 0.25 && k < 0.6) half = Math.max(half, Math.abs(v.x), Math.abs(v.z));
    }
  });
  return half * 0.92;
}

/**
 * Re-parents a mesh under a Group sitting at `pivot` (in the mesh's parent space) so rotations
 * happen around that point. Quantization moves a mesh's own origin, so pivots are found from
 * the geometry here: the king turns at his feet, the cannon on its axle.
 */
function pivotMesh(mesh, pivotOf) {
  const parent = mesh.parent;
  parent.updateMatrixWorld(true);
  const inParent = new THREE.Matrix4().copy(parent.matrixWorld).invert().multiply(mesh.matrixWorld);
  const pts = [];
  const pos = mesh.geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(inParent).clone());
  const pivot = pivotOf(pts);
  const group = new THREE.Group();
  group.name = `${mesh.name}-pivot`;
  group.position.copy(pivot);
  parent.add(group);
  group.attach(mesh);
  return { group, pts: pts.map((p) => p.sub(pivot)) };
}

const boxOf = (pts) => new THREE.Box3().setFromPoints(pts);

/** Skin weights for the sculpted king: root (feet) → spine (waist) → head (neck up), blended smoothly. */
function skinCrew(geometry, toPivot, height, rig) {
  // Skinning quantized (int16-normalized) vertex data corrupts other meshes under WebGPU: use floats.
  for (const name of ['position', 'normal', 'uv']) {
    const a = geometry.attributes[name];
    if (!a || a.array instanceof Float32Array) continue;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
    geometry.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
  const pos = geometry.attributes.position;
  const n = pos.count;
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  const v = new THREE.Vector3();
  const smoothstep = (a, b, x) => {
    const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(toPivot);
    const y = v.y / height;
    // The bow arm: everything held out in front of the body (hands, bow, arrow).
    const arm = rig.armZ ? smoothstep(rig.armZ[0], rig.armZ[1], v.z) * smoothstep(rig.waist, rig.waist + rig.blend * 2, y) : 0;
    const head = smoothstep(rig.neck - 0.06, rig.neck + 0.06, y) * (1 - arm);
    const spine = smoothstep(rig.waist - rig.blend, rig.waist + rig.blend, y) * (1 - head - arm);
    si.set([0, 1, 2, 3], i * 4);
    sw.set([1 - head - spine - arm, spine, head, arm], i * 4);
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
}
/** Bone heights as a fraction of the character's height, and the bow arm's depth band (measured on the sculpts). */
const CREW_RIGS = {
  king: { waist: 0.22, neck: 0.5, blend: 0.08, maxYaw: 0.85, yaw: [0.55, 0, 0.35], look: 0.55 },
  // Her waist bone sits on the battlements: everything inside the walls stays still, so turning never clips the stone.
  // Only her head (turning about the centre of her hair) and her bow arm aim.
  archer: { waist: 0.48, neck: 0.6, blend: 0.035, armZ: [0.09, 0.15], shoulder: 0.56, fixedBase: true, maxYaw: 0.55, yaw: [0, 0, 0.75], armYaw: 0.9, look: 0.25, headAtCentre: true },
};

/** Loads the sculpted towers (called during boot; procedural towers are the fallback). */
export async function loadTowerModels() {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  await Promise.all(
    Object.entries(TOWER_MODELS).map(async ([kind, def]) => {
      const gltf = await loader.loadAsync(def.url);
      const src = gltf.scene;
      const crew = {};
      const meshNamed = (name) => {
        const o = src.getObjectByName(name);
        return o?.isMesh ? o : o?.children.find((c) => c.isMesh);
      };
      const crewName = meshNamed('king') ? 'king' : meshNamed('archer') ? 'archer' : null;
      const king = crewName && meshNamed(crewName);
      const cannon = meshNamed('cannon');
      if (king) {
        const k = pivotMesh(king, (pts) => {
          const b = boxOf(pts);
          return new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2);
        });
        const height = boxOf(k.pts).max.y;
        const rig = CREW_RIGS[crewName];
        // Head pivot under the middle of the head/hair, so turning it does not sweep it sideways.
        const headBox = boxOf(k.pts.filter((p) => p.y > rig.neck * height && p.z < (rig.armZ?.[0] ?? Infinity)));
        const headXZ = rig.headAtCentre ? [(headBox.min.x + headBox.max.x) / 2, (headBox.min.z + headBox.max.z) / 2] : [0, 0];
        Object.assign(crew, { name: crewName, height, rig, headXZ });
        if (cannon) {
          const c = pivotMesh(cannon, (pts) => {
            const minY = boxOf(pts).min.y;
            const b = boxOf(pts.filter((p) => p.y < minY + 0.2));
            return b.getCenter(new THREE.Vector3());
          });
          // Barrel tip: the gun's most forward point; the recoil runs back along axle → tip.
          const tip = c.pts.reduce((a, p) => (p.z > a.z ? p : a), c.pts[0]).clone();
          Object.assign(crew, { tip, recoilDir: tip.clone().normalize() });
        } else {
          // Arrow tip: the archer's most forward point (fires from the bow arm).
          crew.tip = k.pts.reduce((a, p) => (p.z > a.z ? p : a), k.pts[0]).clone();
        }
        // After attach(), the mesh matrix maps the (quantized) geometry into the pivot's space.
        skinCrew(king.geometry, king.matrix, height, rig);
      }
      const box = new THREE.Box3().setFromObject(src);
      const size = box.getSize(new THREE.Vector3());
      const scale = def.width / Math.max(size.x, size.z);
      const center = box.getCenter(new THREE.Vector3());
      src.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
      src.scale.setScalar(scale);
      const holder = new THREE.Group();
      holder.add(src);
      src.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        o.material.map.anisotropy = 8;
      });
      const red = holder.clone(true);
      red.traverse((o) => {
        if (!o.isMesh) return;
        o.material = o.material.clone();
        o.material.map = recolorForRed(o.material.map);
      });
      towerModels[kind] = { teams: [holder, red], top: size.y * scale, half: wallHalfWidth(src, size.y), crew: crew.height ? crew : null };
    }),
  );
}

/** Swaps the sculpt's static king for a SkinnedMesh on three bones (feet, waist, neck) in its pivot. */
function rigSculptKing(model, info) {
  const found = model.getObjectByName(info.name);
  const king = found.isMesh ? found : found.children.find((o) => o.isMesh);
  const pivot = king.parent;
  const skinned = new THREE.SkinnedMesh(king.geometry, king.material);
  skinned.position.copy(king.position);
  skinned.quaternion.copy(king.quaternion);
  skinned.scale.copy(king.scale);
  skinned.castShadow = true;
  skinned.receiveShadow = true;
  skinned.userData.baseMat = king.material;
  const root = new THREE.Bone();
  const spine = new THREE.Bone();
  const head = new THREE.Bone();
  const arm = new THREE.Bone();
  const { waist, neck, shoulder = neck } = info.rig;
  spine.position.y = waist * info.height;
  head.position.set(info.headXZ[0], (neck - waist) * info.height, info.headXZ[1]);
  arm.position.y = (shoulder - waist) * info.height;
  root.add(spine);
  spine.add(head, arm);
  pivot.add(root);
  pivot.remove(king);
  pivot.add(skinned);
  model.updateMatrixWorld(true);
  skinned.bind(new THREE.Skeleton([root, spine, head, arm]));
  return { pivot, bones: { root, spine, head, arm } };
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Animates the sculpted king and his cannon: dozing while the King Tower sleeps, a hop when it
 * wakes, breathing and looking around, turning with the cannon toward the target (within the
 * parapet), and a recoil kick on every shot. Same interface as Animator for the battle view.
 */
export class SculptKingAnimator {
  constructor({ aim, facing, king, cannon, info, hitSpeed = 1 }) {
    this.aim = aim;
    this.facing = facing;
    this.king = king;
    this.cannon = cannon;
    this.info = info;
    this.hitSpeed = hitSpeed;
    this.rest = cannon ? { cannon: cannon.position.clone(), cannonRot: cannon.rotation.clone() } : null;
    this.since = 99;
    this.yaw = 0;
    this.wake = 0;
    this.wasAsleep = null;
    this.engaged = false;
    this.seed = Math.random() * 10;
  }

  attack() {
    this.since = 0;
  }

  flinch() {}

  update(dt, t, { asleep = false, frozen = false } = {}) {
    if (frozen) return;
    this.since += dt;
    this.engaged = this.since < this.hitSpeed + 0.8;
    if (this.wasAsleep && !asleep) this.wake = 1;
    this.wasAsleep = asleep;
    this.wake = Math.max(0, this.wake - dt * 1.6);

    // Turn toward the target the battle view steers `aim` at, clamped so nothing leaves the parapet.
    const rig = this.info.rig;
    const want = this.engaged && !asleep ? Math.max(-rig.maxYaw, Math.min(rig.maxYaw, wrapAngle(this.aim.rotation.y - this.facing))) : 0;
    this.yaw += (want - this.yaw) * Math.min(1, dt * 6);

    // Recoil: back along the barrel, nose up, then spring home.
    const k = this.since < 0.06 ? this.since / 0.06 : Math.max(0, 1 - (this.since - 0.06) / 0.35) ** 2;
    const c = this.cannon;
    if (c) {
      c.position.copy(this.rest.cannon).addScaledVector(this.info.recoilDir, -0.06 * k);
      c.rotation.set(this.rest.cannonRot.x - 0.16 * k, this.rest.cannonRot.y + this.yaw, this.rest.cannonRot.z);
    }

    const { root, spine, head, arm } = this.king.bones;
    if (!c) {
      // Bow: draw back while the next shot comes up, kick up on release.
      const H = this.hitSpeed;
      const draw = this.engaged && this.since > H * 0.45 ? Math.min(1, (this.since - H * 0.45) / (H * 0.5)) : 0;
      arm.rotation.set(-0.22 * k + draw * 0.12, draw * -0.1 + this.yaw * (this.info.rig.armYaw ?? 0), 0);
      arm.position.z = -draw * 0.02 * this.info.height;
    }
    const breathe = Math.sin(t * (asleep ? 1.3 : 2.4) + this.seed);
    const hop = Math.sin(this.wake * Math.PI) * 0.08;
    root.position.y = rig.fixedBase ? 0 : hop * this.info.height;
    root.rotation.set(0, this.yaw * rig.yaw[0], 0);
    root.scale.set(1, rig.fixedBase ? 1 : 1 + breathe * 0.015, 1);
    // Blast pushes him back; asleep he slumps forward.
    spine.rotation.set((asleep ? 0.18 : 0) - 0.14 * k + breathe * 0.02, Math.sin(t * 0.6 + this.seed) * 0.04 + this.yaw * rig.yaw[1], Math.sin(t * 0.9 + this.seed) * 0.03);
    const look = this.engaged || asleep ? 0 : Math.sin(t * 0.45 + this.seed) * rig.look;
    head.rotation.set(asleep ? 0.35 + breathe * 0.04 : -0.06 * k + Math.sin(t * 0.7 + this.seed) * 0.04, look + this.yaw * rig.yaw[2], 0);
  }
}

/** A 3D tower with a live crew (archer, or the king with his cannon) standing on top. */
export function makeTowerObject(kind, team) {
  const t = towerTemplate(kind, team);
  const tower = instantiate(t);
  const sculpt = towerModels[kind];
  if (sculpt) {
    const body = tower.groups.tower;
    body.clear();
    const model = sculpt.teams[team].clone(true);
    // clone() copies userData through JSON, which would turn the material reference into a plain object.
    model.traverse((o) => o.isMesh && (o.userData.baseMat = o.material));
    if (team === 0) model.rotation.y = Math.PI;
    body.add(model);
    if (sculpt.crew) {
      const king = rigSculptKing(model, sculpt.crew);
      const cannon = model.getObjectByName('cannon')?.parent ?? null;
      const muzzle = new THREE.Object3D();
      muzzle.position.copy(sculpt.crew.tip);
      if (cannon) cannon.add(muzzle);
      else {
        // Arrows leave from the arrow tip, carried by the bow arm.
        muzzle.position.y -= sculpt.crew.rig.shoulder * sculpt.crew.height;
        king.bones.arm.add(muzzle);
      }
      // The battle view steers `aim` toward targets; the animator turns king and cannon from it.
      const aim = new THREE.Group();
      aim.rotation.y = model.rotation.y;
      tower.root.add(aim);
      const animator = new SculptKingAnimator({ aim, facing: model.rotation.y, king, cannon, info: sculpt.crew, hitSpeed: kind === 'king' ? 1 : 0.8 });
      tower.root.userData = {
        body,
        wall: { half: sculpt.half, top: sculpt.top * 0.7 },
        crew: { root: aim, launch: muzzle, animator, groups: {}, meshes: [], style: 'sculpt', scale: 1, height: sculpt.top, base: {} },
      };
      return tower.root;
    }
  }
  const crew = instantiate(t.crew, { skin: true });
  crew.root.position.y = t.top;
  // The sculpt has its own king and cannon; the procedural crew stays (invisible) to aim and fire.
  if (sculpt) crew.root.visible = false;
  crew.root.rotation.y = team === 0 ? Math.PI : 0;
  tower.root.add(crew.root);
  tower.root.userData = {
    body: tower.groups.tower,
    wall: sculpt ? { half: sculpt.half, top: sculpt.top * 0.7 } : null,
    crew: { ...crew, style: t.style, scale: 1, height: t.crewHeight, launch: crew.groups[t.launch], base: {} },
  };
  return tower.root;
}

// ------------------------------------------------------------------ animation

const smooth = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
const parsePose = (o = {}) => Object.entries(o).map(([k, v]) => [...k.split('.'), v]);
const STYLE_POSES = Object.fromEntries(
  Object.entries(STYLES).map(([k, s]) => [k, { windup: parsePose(s.windup), impact: parsePose(s.impact), hold: parsePose(s.hold) }]),
);
const JOINTS = ['body', 'head', 'armL', 'armR', 'foreL', 'foreR', 'legL', 'legR', 'shinL', 'shinR', 'pig', 'pl0', 'pl1', 'pl2', 'pl3', 'barrel', 'wingL', 'wingR'];

/**
 * Poses a rig each frame. Attack events call `attack()` at the moment of impact; the
 * wind-up of the *next* swing is predicted from the hit speed so it lands on the beat.
 */
export class Animator {
  constructor(model, { hitSpeed = 1, stride = 1 } = {}) {
    this.m = model;
    this.g = model.groups;
    this.pose = STYLE_POSES[model.style];
    this.hitSpeed = hitSpeed;
    this.stride = stride;
    this.phase = Math.random() * Math.PI * 2;
    this.seed = Math.random() * 10;
    this.since = 99;
    this.walk = 0;
    this.hit = 0;
    this.barrelZ = this.g.barrel?.position.z ?? 0;
    this.bodyY = this.g.body?.position.y ?? 0;
    this.rootY = this.g.root.position.y + (model.air ? AIR_LIFT : 0);
  }

  attack() {
    this.since = 0;
  }

  flinch() {
    this.hit = 0.18;
  }

  /** opts: moving, speed (tiles/s), deploy (seconds left), dying (0..1), asleep */
  update(dt, t, { moving = false, speed = 1, deploy = 0, dying = null, deathStyle = null, asleep = false, frozen = false, sink = 0, stagger = false } = {}) {
    const g = this.g;
    // Frozen units hold whatever pose they were in.
    if (frozen && dying == null) return;
    this.since += dt;
    this.hit = Math.max(0, this.hit - dt);
    for (const j of JOINTS) if (g[j]) g[j].rotation.set(0, 0, 0);
    for (const [name, r] of Object.entries(this.m.base)) g[name]?.rotation.set(...r);
    if (g.body) {
      g.body.position.y = this.bodyY;
      g.body.scale.set(1, 1, 1);
    }
    const add = (name, axis, v) => {
      if (name === 'barrel' && axis === 'recoil') return;
      const o = g[name];
      if (o) o.rotation[axis] += v;
    };

    // Locomotion
    this.walk += ((moving ? 1 : 0) - this.walk) * Math.min(1, dt * 10);
    const w = this.walk;
    this.phase += dt * speed * 6.5 * this.stride;
    const s = Math.sin(this.phase);
    if (this.m.mount) {
      const gallop = this.phase * 1.25;
      ['pl0', 'pl1', 'pl2', 'pl3'].forEach((n, i) => add(n, 'x', Math.sin(gallop + (i < 2 ? 0 : 2.2) + (i % 2) * 0.5) * 0.9 * w));
      add('pig', 'x', Math.sin(gallop) * 0.08 * w);
      if (g.pig) g.pig.position.y = 0.42 + Math.abs(Math.sin(gallop)) * 0.08 * w;
      if (g.body) g.body.position.y = this.bodyY + Math.abs(Math.cos(gallop)) * 0.06 * w;
      add('armL', 'x', -0.6);
    } else {
      // Hips swing the thighs; the knee folds while that leg swings forward.
      const c = Math.cos(this.phase);
      add('legL', 'x', s * 0.75 * w);
      add('legR', 'x', -s * 0.75 * w);
      add('shinL', 'x', (Math.max(0, -c) * 1.15 + 0.1) * w);
      add('shinR', 'x', (Math.max(0, c) * 1.15 + 0.1) * w);
      add('armL', 'x', -s * 0.6 * w);
      add('armR', 'x', s * 0.6 * w);
      add('foreL', 'x', (-0.35 - Math.max(0, -s) * 0.4) * w);
      add('foreR', 'x', (-0.35 - Math.max(0, s) * 0.4) * w);
      if (g.body) g.body.position.y = this.bodyY + Math.abs(c) * 0.03 * w;
      add('body', 'x', 0.1 * w);
      add('body', 'y', s * 0.1 * w);
      add('head', 'y', -s * 0.06 * w);
    }

    // Idle life: breathing, relaxed elbows, weight shift, looking around.
    const idle = 1 - w;
    if (g.body) g.body.scale.y = 1 + Math.sin(t * 2.4 + this.seed) * 0.018 * idle;
    add('head', 'y', Math.sin(t * 0.7 + this.seed) * 0.3 * idle);
    add('head', 'x', Math.sin(t * 0.5 + this.seed * 2) * 0.05 * idle);
    add('armL', 'z', 0.12);
    add('armR', 'z', -0.12);
    add('foreL', 'x', -0.25 * idle);
    add('foreR', 'x', -0.25 * idle);
    add('body', 'z', Math.sin(t * 0.9 + this.seed) * 0.025 * idle);
    if (asleep) {
      add('head', 'x', 0.35 + Math.sin(t * 1.5) * 0.05);
      add('body', 'x', 0.1);
    }

    // Attack: impact → recover, then predicted wind-up for the next hit.
    const H = this.hitSpeed;
    const S = 0.09;
    const R = Math.min(0.3, H * 0.35);
    const Wd = Math.min(0.42, H * 0.45);
    const tau = this.since;
    let W = 0;
    let I = 0;
    if (tau < S) {
      W = 1 - tau / S;
      I = tau / S;
    } else if (tau < S + R) I = 1 - smooth((tau - S) / R);
    if (!moving && tau > H - Wd && tau < H + 0.5) W = Math.max(W, smooth((tau - (H - Wd)) / Wd));
    const engaged = !moving && tau < H + 0.8 ? 1 : 0;
    this.engaged = engaged;
    for (const [n, a, v] of this.pose.hold) add(n, a, v * engaged);
    for (const [n, a, v] of this.pose.windup) add(n, a, v * W);
    for (const [n, a, v] of this.pose.impact) add(n, a, v * I);
    if (g.barrel) g.barrel.position.z = this.barrelZ - I * 0.28;
    if (this.m.style === 'spin' && tau < 0.45 && g.body) g.body.rotation.y += smooth(tau / 0.45) * Math.PI * 2;
    if (g.wingL) {
      const flap = Math.sin(t * 13 + this.seed) * 0.65;
      g.wingL.rotation.z += 0.3 + flap;
      g.wingR.rotation.z -= 0.3 + flap;
    }
    if (g.prop) g.prop.visible = !(tau > S * 0.5 && tau < Math.max(0.5, H * 0.6));

    // Knocked back: lean away from the blow with the arms thrown out, easing back upright.
    this.st = (this.st ?? 0) + ((stagger ? 1 : 0) - (this.st ?? 0)) * Math.min(1, dt * (stagger ? 18 : 6));
    if (this.st > 0.01) {
      const k = this.st;
      add('body', 'x', -0.42 * k);
      add('head', 'x', -0.25 * k);
      add('armL', 'z', 0.75 * k);
      add('armR', 'z', -0.75 * k);
      add('armL', 'x', -0.6 * k);
      add('armR', 'x', -0.6 * k);
      add('legL', 'x', 0.35 * k);
      add('legR', 'x', -0.2 * k);
    }

    // Flinch on damage.
    if (this.hit > 0 && g.body) {
      const k = this.hit / 0.18;
      g.body.rotation.x -= 0.28 * k;
      g.body.scale.y *= 1 - 0.1 * k;
    }

    // Drop-in on deploy (deploy counts down from 1s), squash on landing.
    const root = g.root;
    root.position.y = this.rootY - sink * (this.m.height + 0.3);
    if (this.m.air) root.position.y += Math.sin(t * 2.6 + this.seed) * 0.12;
    let sc = this.m.scale;
    if (deploy > 0) {
      const k = 1 - deploy;
      if (k < 0.28) {
        const f = k / 0.28;
        root.position.y += (1 - f * f) * 4;
      } else if (k < 0.55 && g.body) {
        const f = (k - 0.28) / 0.27;
        g.body.scale.y *= 1 - Math.sin(f * Math.PI) * 0.3;
        g.body.scale.x *= 1 + Math.sin(f * Math.PI) * 0.15;
      }
    }
    if (dying != null) {
      const k = smooth(dying);
      if (deathStyle === 'spin') {
        // Spins on the spot while sinking and shrinking away.
        root.rotation.y += dying * dying * 14;
        root.position.y += Math.sin(dying * Math.PI) * 0.5 - dying * 0.4;
        sc *= 1 - dying * 0.8;
      } else if (deathStyle === 'thud') {
        // Heavyweights slam face-first into the ground.
        root.rotation.x = Math.min(1, dying * 1.6) ** 2 * 1.45;
        root.position.y -= dying * 0.15;
        sc *= 1 - Math.max(0, dying - 0.6) * 1.2;
      } else {
        root.rotation.x = -k * 1.35;
        root.position.y -= dying * 0.25;
        sc *= 1 - dying * 0.5;
      }
    } else root.rotation.x = 0;
    root.scale.setScalar(sc);
  }
}
