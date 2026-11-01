import * as THREE from 'three/webgpu';

const URLS = { barrel: '/assets/models/barrel.glb', arrow: '/assets/models/fire-arrow.glb', fireball: '/assets/models/fireball.glb' };
/** Barrel height, arrow length and fireball diameter in world tiles. */
const BARREL_SIZE = 1.15;
const ARROW_LENGTH = 1.25;
const FIREBALL_SIZE = 1.6;
/** Seconds an arrow takes to fall from the sky, and how far apart arrows of one volley land. */
export const ARROW_FALL = 0.55;
const LAND_SPREAD = 0.2;
const ARROWS_PER_VOLLEY = 26;
const STUCK_TIME = 1.4;

const models = { barrel: null, barrelMat: null, arrowParts: null, fireball: null, fireballClip: null };
let loading = null;

/** GLBs are quantized; transformed or merged geometry needs plain float attributes. */
function toFloat(geometry) {
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    const out = new Float32Array(attr.count * attr.itemSize);
    for (let i = 0; i < attr.count; i++) for (let c = 0; c < attr.itemSize; c++) out[i * attr.itemSize + c] = attr.getComponent(i, c);
    g.setAttribute(name, new THREE.BufferAttribute(out, attr.itemSize));
  }
  if (geometry.index) g.setIndex(geometry.index.clone());
  return g;
}

/** Loads the Barrel Bomb and Fire Arrows models once (spell art and battle visuals share them). */
export function loadSpellModels() {
  loading ??= (async () => {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    const [barrel, arrow, fireball] = await Promise.all([loader.loadAsync(URLS.barrel), loader.loadAsync(URLS.arrow), loader.loadAsync(URLS.fireball)]);

    // Barrel: centred on its middle so it tumbles around its own axis.
    const b = barrel.scene;
    b.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(b);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const holder = new THREE.Group();
    const s = BARREL_SIZE / size.y;
    b.scale.multiplyScalar(s);
    b.position.sub(center.multiplyScalar(s));
    holder.add(b);
    b.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      models.barrelMat ??= o.material;
    });
    models.barrel = holder;

    // Arrow: bake each part (shaft, fletching, iron head, burning rag) pointing its tip along +Z.
    const a = arrow.scene;
    a.updateMatrixWorld(true);
    const parts = [];
    a.traverse((o) => {
      if (!o.isMesh) return;
      const g = toFloat(o.geometry);
      g.applyMatrix4(o.matrixWorld);
      g.computeBoundingBox();
      const mat = o.material.clone();
      if (/fire/i.test(mat.name)) {
        mat.emissive = mat.color.clone();
        mat.emissiveIntensity = 2.2;
      }
      parts.push({ geometry: g, material: mat, iron: /ferro/i.test(mat.name) });
    });
    const len = new THREE.Box3().setFromObject(a).getSize(new THREE.Vector3()).z;
    const tipZ = parts.find((p) => p.iron)?.geometry.boundingBox.getCenter(new THREE.Vector3()).z ?? 1;
    for (const p of parts) {
      if (tipZ < 0) p.geometry.rotateY(Math.PI);
      p.geometry.scale(ARROW_LENGTH / len, ARROW_LENGTH / len, ARROW_LENGTH / len);
    }
    models.arrowParts = parts;

    // Fireball: a burst of flickering flame shards. Centred on the shard cloud, coloured gold at the
    // core to deep orange at the tips; the few far-flung strays are dropped so the silhouette stays round.
    const f = fireball.scene;
    f.updateMatrixWorld(true);
    const shards = [];
    f.traverse((o) => o.isMesh && shards.push({ o, box: new THREE.Box3().setFromObject(o) }));
    const core = shards.reduce((sum, x) => sum.add(x.box.getCenter(_p)), new THREE.Vector3()).divideScalar(shards.length);
    // How far each shard's tip reaches from the core; the ball is sized by the 90th percentile.
    for (const x of shards) x.tip = Math.max(x.box.min.distanceTo(core), x.box.max.distanceTo(core));
    const tips = shards.map((x) => x.tip).sort((p, q) => p - q);
    const reach = tips[Math.floor(tips.length * 0.9)];
    const flames = [0xffc020, 0xff8000, 0xf05000].map((c) => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
    const strays = new Set();
    for (const { o, tip } of shards) {
      const d = tip / reach;
      o.material = flames[d < 0.55 ? 0 : d < 0.85 ? 1 : 2];
      if (d < 1.25) continue;
      strays.add(o.name);
      o.removeFromParent();
    }
    const fs = FIREBALL_SIZE / (reach * 2);
    f.scale.multiplyScalar(fs);
    f.position.sub(core.multiplyScalar(fs));
    // A molten core fills the gaps between the shards: white-hot centre inside a softer orange halo.
    const coreBall = new THREE.Mesh(new THREE.SphereGeometry(FIREBALL_SIZE * 0.15, 20, 14), new THREE.MeshBasicMaterial({ color: 0xfff2c0 }));
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(FIREBALL_SIZE * 0.27, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xff9a10, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    models.fireball = new THREE.Group().add(f, coreBall, halo);
    const tracks = fireball.animations.flatMap((clip) => clip.tracks).filter((t) => !strays.has(t.name.slice(0, t.name.lastIndexOf('.'))));
    models.fireballClip = new THREE.AnimationClip('flicker', -1, tracks);
  })();
  return loading;
}

export const spellModelsReady = () => Boolean(models.barrel && models.arrowParts && models.fireball);

/** A fresh fireball with its own looping flame flicker; call `mixer.update(dt)` every frame. */
export function makeFireball() {
  if (!models.fireball) return null;
  const obj = models.fireball.clone();
  const mixer = new THREE.AnimationMixer(obj);
  mixer.clipAction(models.fireballClip).play();
  return { obj, mixer };
}

/** A fresh barrel (shared geometry/materials). */
export function makeBarrel() {
  return models.barrel?.clone() ?? null;
}

export const barrelMaterial = () => models.barrelMat;

/** A static arrow model (one mesh per part) for card art. */
export function makeArrow() {
  const g = new THREE.Group();
  for (const p of models.arrowParts ?? []) g.add(new THREE.Mesh(p.geometry, p.material));
  return g;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3(0, 0, 1);

/**
 * One volley of flaming arrows falling from the sky onto a circle, drawn as instanced meshes.
 * Arrows come in at a slant from the caster's side, stick in the ground, then sink away.
 * `onLand(pos)` fires for each arrow that hits the ground.
 */
export class ArrowVolley {
  constructor(group, center, radius, landAt, fromZ, rand = Math.random) {
    this.group = group;
    this.t = 0;
    this.arrows = [];
    for (let i = 0; i < ARROWS_PER_VOLLEY; i++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * radius;
      const end = new THREE.Vector3(center.x + Math.cos(a) * d, 0.25, center.z + Math.sin(a) * d);
      const start = end.clone().add(new THREE.Vector3((rand() - 0.5) * 2.5, 11 + rand() * 3, fromZ * (4 + rand() * 2)));
      this.arrows.push({ start, end, t0: landAt - ARROW_FALL + (rand() - 0.5) * LAND_SPREAD * 2, landed: false, trail: rand() * 0.05 });
    }
    this.meshes = models.arrowParts.map((p) => {
      const m = new THREE.InstancedMesh(p.geometry, p.material, ARROWS_PER_VOLLEY);
      m.frustumCulled = false;
      m.castShadow = true;
      group.add(m);
      return m;
    });
    this.end = Math.max(...this.arrows.map((x) => x.t0)) + ARROW_FALL + STUCK_TIME;
  }

  /** Returns false once the volley is finished and removed. */
  update(dt, fx, onLand) {
    this.t += dt;
    this.arrows.forEach((ar, i) => {
      const k = (this.t - ar.t0) / ARROW_FALL;
      let scale = 1;
      if (k < 0) scale = 0;
      else if (k < 1) {
        // Gravity-like ease: the arrows accelerate as they fall.
        _p.lerpVectors(ar.start, ar.end, k * k);
        _dir.subVectors(ar.end, ar.start).normalize();
        ar.trail -= dt;
        if (ar.trail <= 0) {
          ar.trail = 0.045;
          fx.spawn('fire', _p, { size: 0.55, life: 0.28, vel: [0, 0.8, 0], grow: 0.3, spin: 2 });
        }
      } else {
        _p.copy(ar.end);
        _dir.subVectors(ar.end, ar.start).normalize();
        if (!ar.landed) {
          ar.landed = true;
          onLand(ar.end);
        }
        // Stuck arrows sink into the ground before vanishing.
        const stuck = this.t - ar.t0 - ARROW_FALL;
        _p.y -= Math.max(0, stuck - STUCK_TIME * 0.6) * 1.2;
        if (stuck > STUCK_TIME) scale = 0;
      }
      _q.setFromUnitVectors(_fwd, _dir);
      _s.setScalar(scale);
      _m.compose(_p, _q, _s);
      for (const m of this.meshes) m.setMatrixAt(i, _m);
    });
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
    if (this.t < this.end) return true;
    this.dispose();
    return false;
  }

  dispose() {
    for (const m of this.meshes) {
      this.group.remove(m);
      m.dispose();
    }
  }
}
