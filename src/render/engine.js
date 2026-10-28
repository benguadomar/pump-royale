import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ARENA_W, ARENA_H } from '../sim/constants.js';
import { skyColor } from './shaders.js';
import { buildWorld } from './world.js';
import { Fx } from './fx.js';
import { state } from '../state.js';

export const tileToWorld = (x, y, h = 0) => new THREE.Vector3(x - ARENA_W / 2, h, ARENA_H / 2 - y);

const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const BATTLE_ELEVATION = THREE.MathUtils.degToRad(72);

/**
 * Owns the WebGPU renderer (WebGL2 fallback), the diorama scene and the camera rig.
 * The camera orbits in the lobby and eases into a fitted top-down view for battles.
 */
export class Engine {
  static async create(canvas) {
    const engine = new Engine(canvas);
    await engine.renderer.init();
    engine.applyGraphics();
    return engine;
  }

  constructor(canvas) {
    this.canvas = canvas;
    this.textures = new Map();
    this.updaters = new Set();
    this.mode = 'lobby';
    this.orbit = 0.7;
    this.insets = { top: 0, bottom: 0 };
    this.shakeAmt = 0;
    this.transition = null;

    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.backgroundNode = skyColor;
    this.scene.fog = new THREE.Fog(0xd8ebf7, 90, 190);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 400);
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.buildLights();
    this.world = buildWorld(this);
    this.fx = new Fx(this);

    const scenePass = pass(this.scene, this.camera);
    const color = scenePass.getTextureNode('output');
    this.bloomNode = bloom(color, 0.45, 0.25, 0.82);
    this.pipeline = new THREE.RenderPipeline(this.renderer);
    this.pipeline.outputNode = color.add(this.bloomNode);

    this.timer = new THREE.Timer();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop((ts) => this.frame(ts));
  }

  get backendName() {
    return this.renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  }

  async preload(urls, onProgress) {
    const loader = new THREE.TextureLoader();
    let done = 0;
    await Promise.all(
      urls.map(async (url) => {
        try {
          const tex = await loader.loadAsync(url);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          this.textures.set(url, tex);
        } catch (e) {
          console.warn('Failed to load', url, e);
        }
        onProgress?.(++done / urls.length);
      }),
    );
  }

  /** Billboard sprite standing on the ground, scaled to `height` world units. */
  makeSprite(url, height) {
    const tex = this.textures.get(url);
    const mat = new THREE.SpriteNodeMaterial({ map: tex, transparent: true, alphaTest: 0.1 });
    const sprite = new THREE.Sprite(mat);
    const aspect = tex?.image ? tex.image.width / tex.image.height : 1;
    sprite.scale.set(height * aspect, height, 1);
    sprite.center.set(0.5, 0.04);
    return sprite;
  }

  onUpdate(fn) {
    this.updaters.add(fn);
    return () => this.updaters.delete(fn);
  }

  applyGraphics() {
    const high = state.settings.graphics === 'high';
    this.renderer.setPixelRatio(high ? Math.min(window.devicePixelRatio, 2) : Math.min(window.devicePixelRatio, 1) * 0.85);
    this.renderer.shadowMap.enabled = high;
    this.sun.castShadow = high;
    this.useBloom = high;
    this.world.setDetail(high);
    this.fx.maxParticles = high ? this.fx.capacity : Math.floor(this.fx.capacity / 2);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    const from = this.pose();
    this.mode = mode;
    this.resize();
    this.transition = { from, t: 0, dur: mode === 'battle' ? 1.4 : 1.1 };
  }

  setInsets(insets) {
    this.insets = insets;
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    if (this.mode === 'battle') this.battlePose = this.fitBattle(w, h);
  }

  shake(amount) {
    this.shakeAmt = Math.min(1.5, this.shakeAmt + amount);
  }

  /** Current camera pose (position, look target, vertical image offset, roll). */
  pose() {
    return {
      pos: this.camera.position.clone(),
      look: this.lookAt?.clone() ?? new THREE.Vector3(),
      offset: this.camera.view?.enabled ? this.camera.view.offsetY : 0,
      fov: this.camera.fov,
    };
  }

  lobbyPose(t) {
    this.orbit += t * 0.04;
    const r = 52;
    return { pos: new THREE.Vector3(Math.sin(this.orbit) * r, 34, Math.cos(this.orbit) * r), look: new THREE.Vector3(0, -2, 0), offset: 0, fov: 42 };
  }

  /**
   * Pulls back until the whole arena (towers included) fits between the HUD insets,
   * then shifts the image so the arena is centred in the free band.
   */
  fitBattle(w, h) {
    const { top = 0, bottom = 0 } = this.insets;
    const cam = this.camera.clone();
    cam.clearViewOffset();
    cam.fov = 34;
    cam.aspect = w / h;
    const hx = ARENA_W / 2 + 0.4;
    const hz = ARENA_H / 2 + 0.4;
    const pts = [
      [-hx, 0, hz], [hx, 0, hz], [-hx, 0, -hz], [hx, 0, -hz],
      [0, 6.8, -(ARENA_H / 2 - 3)], [-5.5, 6.1, -(ARENA_H / 2 - 6.5)], [5.5, 6.1, -(ARENA_H / 2 - 6.5)],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const v = new THREE.Vector3();
    const availH = Math.max(80, h - top - bottom);
    let minY = 0;
    let maxY = 0;
    let dist = 30;
    for (; dist < 220; dist += 0.5) {
      cam.position.set(0, dist * Math.sin(BATTLE_ELEVATION), dist * Math.cos(BATTLE_ELEVATION));
      cam.lookAt(0, 0, 0);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      minY = Infinity;
      maxY = -Infinity;
      let maxX = 0;
      for (const p of pts) {
        v.copy(p).project(cam);
        minY = Math.min(minY, v.y);
        maxY = Math.max(maxY, v.y);
        maxX = Math.max(maxX, Math.abs(v.x));
      }
      if (((maxY - minY) / 2) * h <= availH && maxX * (w / 2) <= w / 2 - (this.insets.side ?? 12)) break;
    }
    const centerPx = ((1 - (maxY + minY) / 2) / 2) * h;
    return { pos: cam.position.clone(), look: new THREE.Vector3(0, 0, 0), offset: centerPx - (top + availH / 2), fov: 34 };
  }

  applyPose(p, w, h) {
    const cam = this.camera;
    cam.position.copy(p.pos);
    cam.fov = p.fov;
    this.lookAt = p.look.clone();
    cam.up.set(0, 1, 0);
    cam.lookAt(p.look);
    if (Math.abs(p.offset) > 0.5) cam.setViewOffset(w, h, 0, p.offset, w, h);
    else cam.clearViewOffset();
  }

  /** Converts a screen position into arena tile coordinates (or null if it misses the ground). */
  pickTile(clientX, clientY) {
    const ndc = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return null;
    return { x: hit.x + ARENA_W / 2, y: ARENA_H / 2 - hit.z };
  }

  frame(ts) {
    this.timer.update(ts);
    const dt = Math.min(this.timer.getDelta(), 0.05);
    const t = this.timer.getElapsed();
    const w = window.innerWidth;
    const h = window.innerHeight;

    const target = this.mode === 'battle' ? this.battlePose : this.lobbyPose(dt);
    let pose = target;
    if (this.transition) {
      const tr = this.transition;
      tr.t += dt;
      const k = ease(Math.min(1, tr.t / tr.dur));
      // Arc upward mid-transition so the camera swoops instead of clipping through houses.
      const lift = Math.sin(k * Math.PI) * 10;
      pose = {
        pos: tr.from.pos.clone().lerp(target.pos, k).add(new THREE.Vector3(0, lift, 0)),
        look: tr.from.look.clone().lerp(target.look, k),
        offset: tr.from.offset + (target.offset - tr.from.offset) * k,
        fov: tr.from.fov + (target.fov - tr.from.fov) * k,
      };
      if (k >= 1) this.transition = null;
    }
    this.applyPose(pose, w, h);

    if (this.shakeAmt > 0.001) {
      const s = this.shakeAmt;
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * s * 1.6, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s * 1.6));
      this.camera.rotateZ((Math.random() - 0.5) * s * 0.05);
      this.shakeAmt *= Math.pow(0.02, dt);
    }

    this.world.update(dt, t);
    for (const fn of this.updaters) fn(dt, t);
    this.fx.update(dt);
    if (this.useBloom) this.pipeline.render();
    else this.renderer.render(this.scene, this.camera);
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xdcefff, 0x6a7d4a, 1.35));
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
    sun.position.set(-22, 46, 18);
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 1, far: 120 });
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);
    this.sun = sun;
  }
}
