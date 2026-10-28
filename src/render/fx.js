import * as THREE from 'three/webgpu';
import { particlePosition, particleColor, FX_TYPE } from './shaders.js';

const CAPACITY = 4000;
const rand = (a, b) => a + Math.random() * (b - a);

/**
 * GPU particle renderer: one draw call for every puff, flame, spark, shockwave and
 * decal. The CPU integrates simple motion and streams attributes; the TypeGPU shaders
 * do the billboarding and all of the shading.
 */
export class Fx {
  constructor(engine) {
    this.capacity = CAPACITY;
    this.maxParticles = CAPACITY;
    this.list = [];
    this.persistent = [];
    this.emitters = [];

    const g = new THREE.BufferGeometry();
    const corner = new Float32Array(CAPACITY * 4 * 2);
    const index = new Uint32Array(CAPACITY * 6);
    const quad = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5];
    for (let i = 0; i < CAPACITY; i++) {
      corner.set(quad, i * 8);
      index.set([0, 1, 2, 0, 2, 3].map((v) => v + i * 4), i * 6);
    }
    this.center = new Float32Array(CAPACITY * 4 * 3);
    this.data = new Float32Array(CAPACITY * 4 * 4);
    this.tint = new Float32Array(CAPACITY * 4 * 4);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CAPACITY * 4 * 3), 3));
    g.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    g.setAttribute('center', new THREE.BufferAttribute(this.center, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pdata', new THREE.BufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('ptint', new THREE.BufferAttribute(this.tint, 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.setDrawRange(0, 0);
    this.geometry = g;

    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    mat.positionNode = particlePosition;
    mat.colorNode = particleColor;
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    mat.toneMapped = false;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    engine.scene.add(this.mesh);
  }

  /** Adds one particle. Positions are world units; `life` is the duration in seconds. */
  spawn(type, pos, { size = 1, life = 1, vel = [0, 0, 0], grow = 0, drag = 0, gravity = 0, tint = [1, 1, 1], spin = 0, persistent = false } = {}) {
    const p = {
      type: FX_TYPE[type],
      x: pos.x,
      y: pos.y,
      z: pos.z,
      vx: vel[0],
      vy: vel[1],
      vz: vel[2],
      size,
      grow,
      drag,
      gravity,
      age: 0,
      dur: life,
      tint,
      rot: Math.random() * Math.PI * 2,
      spin,
      seed: Math.random(),
    };
    if (persistent) this.persistent.push(p);
    else if (this.list.length < this.maxParticles) this.list.push(p);
    return p;
  }

  /** Calls `fn(dt)` every frame for `duration` seconds (Infinity for permanent emitters). */
  emit(duration, fn) {
    const e = { t: 0, duration, fn };
    this.emitters.push(e);
    return e;
  }

  clearAll() {
    this.list.length = 0;
    this.persistent.length = 0;
    this.emitters.length = 0;
  }

  // -------------------------------------------------------------- presets

  shockwave(pos, color = [1, 1, 1], size = 3.2) {
    this.spawn('ring', { x: pos.x, y: pos.y + 0.08, z: pos.z }, { size, life: 0.55, tint: color });
    this.spawn('ring', { x: pos.x, y: pos.y + 0.08, z: pos.z }, { size: size * 0.6, life: 0.4, tint: color });
  }

  smoke(pos, n = 6, spread = 0.6, size = 1.2) {
    for (let i = 0; i < n; i++) {
      this.spawn('smoke', { x: pos.x + rand(-spread, spread), y: pos.y + rand(0, spread), z: pos.z + rand(-spread, spread) }, {
        size: size * rand(0.7, 1.3),
        life: rand(0.9, 1.8),
        vel: [rand(-0.4, 0.4), rand(0.6, 1.6), rand(-0.4, 0.4)],
        grow: size * 0.9,
        drag: 1.2,
        spin: rand(-0.6, 0.6),
      });
    }
  }

  fire(pos, n = 8, spread = 0.5, size = 1) {
    for (let i = 0; i < n; i++) {
      this.spawn('fire', { x: pos.x + rand(-spread, spread), y: pos.y + rand(0, spread), z: pos.z + rand(-spread, spread) }, {
        size: size * rand(0.6, 1.2),
        life: rand(0.35, 0.7),
        vel: [rand(-1, 1), rand(1, 3), rand(-1, 1)],
        grow: size * 0.6,
        drag: 2,
        spin: rand(-2, 2),
      });
    }
  }

  sparks(pos, n = 10, color = [1, 0.8, 0.4], speed = 6) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(0.4, 1) * speed;
      this.spawn('spark', pos, { size: rand(0.12, 0.25), life: rand(0.3, 0.7), vel: [Math.cos(a) * s, rand(1, 4), Math.sin(a) * s], drag: 1.5, gravity: 9, tint: color });
    }
  }

  /** Splash impact sized to the attack's splash radius (fireball / bomb). */
  explosion(pos, radius, kind) {
    const size = radius * 2;
    this.spawn('scorch', { x: pos.x, y: 0.07, z: pos.z }, { size: size * 1.1, life: 6 });
    this.shockwave({ x: pos.x, y: 0, z: pos.z }, kind === 'fireball' ? [1, 0.55, 0.2] : [1, 0.9, 0.7], size * 1.3);
    this.fire({ x: pos.x, y: 0.4, z: pos.z }, kind === 'fireball' ? 16 : 10, radius * 0.5, radius * 0.9);
    this.smoke({ x: pos.x, y: 0.5, z: pos.z }, 8, radius * 0.5, radius * 0.9);
    this.sparks({ x: pos.x, y: 0.6, z: pos.z }, 12);
  }

  hitPuff(pos, color = [1, 1, 1]) {
    this.spawn('glow', pos, { size: 0.9, life: 0.18, tint: color });
    this.sparks(pos, 4, color, 3);
  }

  /** The big one: tower collapse with a lasting smoking crater. */
  towerCollapse(pos) {
    this.shockwave({ x: pos.x, y: 0, z: pos.z }, [1, 0.85, 0.5], 9);
    this.fire({ x: pos.x, y: 1.2, z: pos.z }, 40, 1.4, 2.2);
    this.smoke({ x: pos.x, y: 1.5, z: pos.z }, 36, 1.6, 2.4);
    this.sparks({ x: pos.x, y: 2, z: pos.z }, 40, [1, 0.75, 0.35], 9);
    this.spawn('crater', { x: pos.x, y: 0.06, z: pos.z }, { size: 4.6, life: 1e9, persistent: true });
    let acc = 0;
    this.emit(Infinity, (dt) => {
      acc += dt;
      if (acc < 0.3) return;
      acc = 0;
      this.spawn('smoke', { x: pos.x + rand(-1, 1), y: 0.6, z: pos.z + rand(-1, 1) }, { size: rand(1, 1.8), life: rand(2, 3.2), vel: [rand(-0.2, 0.2), rand(0.5, 1), rand(-0.2, 0.2)], grow: 1.2, drag: 0.6, tint: [0.75, 0.75, 0.78] });
    });
  }

  // -------------------------------------------------------------- update

  update(dt) {
    for (const e of this.emitters) {
      e.t += dt;
      e.fn(dt);
    }
    this.emitters = this.emitters.filter((e) => e.t < e.duration);

    const step = (p) => {
      p.age += dt;
      if (p.drag) {
        const k = Math.exp(-p.drag * dt);
        p.vx *= k;
        p.vy *= k;
        p.vz *= k;
      }
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.gravity && p.y < 0.05) {
        p.y = 0.05;
        p.vy *= -0.3;
      }
      p.size += p.grow * dt;
      p.rot += p.spin * dt;
    };
    for (const p of this.list) step(p);
    this.list = this.list.filter((p) => p.age < p.dur);

    let n = 0;
    const write = (p) => {
      const life = Math.min(0.999, p.age / p.dur);
      for (let v = 0; v < 4; v++) {
        const i = n * 4 + v;
        this.center[i * 3] = p.x;
        this.center[i * 3 + 1] = p.y;
        this.center[i * 3 + 2] = p.z;
        this.data[i * 4] = p.size;
        this.data[i * 4 + 1] = life;
        this.data[i * 4 + 2] = p.type;
        this.data[i * 4 + 3] = p.seed;
        this.tint[i * 4] = p.tint[0];
        this.tint[i * 4 + 1] = p.tint[1];
        this.tint[i * 4 + 2] = p.tint[2];
        this.tint[i * 4 + 3] = p.rot;
      }
      n++;
    };
    // Decals first so smoke and fire draw over them.
    for (const p of this.persistent) if (n < CAPACITY) write(p);
    for (const p of this.list) if (p.type >= 3 && p.type <= 5 && n < CAPACITY) write(p);
    for (const p of this.list) if ((p.type < 3 || p.type > 5) && n < CAPACITY) write(p);

    const a = this.geometry.attributes;
    for (const key of ['center', 'pdata', 'ptint']) {
      a[key].clearUpdateRanges();
      a[key].addUpdateRange(0, n * 4 * a[key].itemSize);
      a[key].needsUpdate = true;
    }
    this.geometry.setDrawRange(0, n * 6);
  }
}
