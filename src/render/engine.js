import * as THREE from 'three/webgpu';
import { pass, vec4, mix, float, renderOutput } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import * as t3 from '@typegpu/three';
import { d, std } from 'typegpu';
import { ARENA_W, ARENA_H } from '../sim/constants.js';
import { skyColor, envSkyColor, applyTheme } from './shaders.js';
import { buildWorld } from './world.js';
import { Fx } from './fx.js';
import { buildChest } from './models.js';
import { state } from '../state.js';

export const tileToWorld = (x, y, h = 0) => new THREE.Vector3(x - ARENA_W / 2, h, ARENA_H / 2 - y);

/** Filmic grade in linear space: gentle S-curve, a touch more saturation, warm highlights, vignette. */
function colorGrade(input) {
  return t3.toTSL(() => {
    'use gpu';
    const c = input.$;
    const luma = std.dot(c, d.vec3f(0.2126, 0.7152, 0.0722));
    let g = std.mix(d.vec3f(luma), c, 1.12);
    g = g * std.mix(d.vec3f(0.98, 0.99, 1.03), d.vec3f(1.04, 1.0, 0.95), std.smoothstep(0.1, 0.9, luma));
    const uv = t3.screenUV.$ - d.vec2f(0.5);
    const vig = 1 - std.smoothstep(0.35, 0.95, std.length(uv * d.vec2f(1.1, 1.25))) * 0.32;
    return std.max(g, d.vec3f(0)) * vig;
  });
}

const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
/** Battle camera: behind the player's side, tilted ~50° down, moderate perspective. */
const BATTLE_ELEVATION = THREE.MathUtils.degToRad(50);
const BATTLE_FOV = 46;

/**
 * Owns the WebGPU renderer (WebGL2 fallback), the diorama scene and the camera rig.
 * The camera orbits in the lobby and eases into a fitted top-down view for battles.
 */
export class Engine {
  static async create(canvas) {
    const engine = new Engine(canvas);
    await engine.renderer.init();
    engine.buildEnvironment();
    engine.applyGraphics();
    return engine;
  }

  /** Bakes the outdoor sky into a prefiltered env map: soft sky fill + reflections on metal/water. */
  buildEnvironment() {
    const envScene = new THREE.Scene();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide }));
    dome.material.colorNode = envSkyColor;
    envScene.add(dome);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    dome.geometry.dispose();
    dome.material.dispose();
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
    this.renderer.toneMappingExposure = 0.92;

    this.scene = new THREE.Scene();
    this.scene.backgroundNode = skyColor;
    this.scene.fog = new THREE.Fog(0xd8ebf7, 90, 190);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 400);
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.buildLights();
    this.world = buildWorld(this);
    this.fx = new Fx(this);

    // HIGH graphics: scene -> ambient occlusion -> bloom -> colour grade + vignette -> SMAA.
    // GTAO cannot sample a multisampled depth buffer, so the pass renders without MSAA and
    // edges are smoothed by SMAA after tone mapping instead.
    const scenePass = pass(this.scene, this.camera, { samples: 0 });
    const color = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    this.aoNode = ao(depth, null, this.camera);
    this.aoNode.resolutionScale = 0.5;
    this.aoNode.radius.value = 0.9;
    this.aoNode.thickness.value = 1.2;
    this.aoNode.scale.value = 1.15;
    this.aoNode.samples.value = 12;
    const occlusion = mix(float(1), this.aoNode.getTextureNode().r, 0.9);
    const lit = color.rgb.mul(occlusion);
    this.bloomNode = bloom(color, 0.4, 0.3, 0.85);
    const graded = colorGrade(t3.fromTSL(lit.add(this.bloomNode.rgb), d.vec3f));
    this.pipeline = new THREE.RenderPipeline(this.renderer);
    this.pipeline.outputColorTransform = false;
    this.pipeline.outputNode = smaa(renderOutput(vec4(graded, 1)));

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
    // Battles only need the arena in the shadow map: a tighter frustum keeps small units' shadows crisp.
    const extent = mode === 'battle' ? 21 : 30;
    Object.assign(this.sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.resize();
    this.transition = { from, t: 0, dur: mode === 'battle' ? 1.4 : 1.1 };
  }

  /**
   * Shows a chest floating in front of the camera for the opening screen. It drops in and
   * wobbles; `open()` shakes it, flips the lid and bursts sparkles. `dispose()` removes it.
   */
  showChest(type) {
    const chest = buildChest(type);
    const holder = new THREE.Group();
    holder.add(chest.root);
    holder.scale.setScalar(0.8);
    this.scene.add(holder);
    const glow = { wooden: [1, 0.85, 0.5], silver: [0.85, 0.92, 1], gold: [1, 0.85, 0.3], magical: [0.9, 0.5, 1] }[type] ?? [1, 1, 1];
    let t = 0;
    let openT = null;
    const fwd = new THREE.Vector3();
    const off = this.onUpdate((dt) => {
      t += dt;
      // Unproject a screen point so the chest stays centred despite the view offset.
      fwd.set(0, 0.12, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
      holder.position.copy(this.camera.position).addScaledVector(fwd, 7);
      holder.position.y -= 0.9;
      holder.lookAt(this.camera.position.x, holder.position.y, this.camera.position.z);
      const drop = Math.max(0, 1 - t / 0.45);
      chest.root.position.y = drop * drop * 4 + (drop === 0 && t < 0.7 ? Math.sin((t - 0.45) * 25) * 0.08 * (0.7 - t) * 4 : 0);
      chest.root.rotation.z = openT == null ? Math.sin(t * 2.2) * 0.05 : 0;
      if (openT != null) {
        openT += dt;
        const shake = openT < 0.45 ? Math.sin(openT * 70) * 0.06 * (1 - openT / 0.45) : 0;
        chest.root.rotation.y = shake;
        const k = Math.min(1, Math.max(0, (openT - 0.45) / 0.25));
        chest.groups.lid.rotation.x = -k * 1.9;
      }
    });
    return {
      open: () =>
        new Promise((resolve) => {
          openT = 0;
          setTimeout(() => {
            const p = holder.getWorldPosition(new THREE.Vector3());
            p.y += 0.9;
            this.fx.sparks(p, 40, glow, 7);
            this.fx.spawn('glow', p, { size: 4, life: 0.5, tint: glow });
            resolve();
          }, 650);
        }),
      dispose: () => {
        off();
        this.scene.remove(holder);
      },
    };
  }

  /** Re-themes the whole diorama for an arena: palette uniforms, fog, sunlight and props. */
  setArena(arena) {
    if (this.arena === arena) return;
    this.arena = arena;
    applyTheme(arena);
    this.scene.fog.color.setHex(arena.fog);
    this.sun.color.setHex(arena.sun);
    this.world.setProps(arena.props);
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

  /** Near-freeze of everything for `seconds` of real time (impact frames). */
  hitStop(seconds) {
    this.freezeLeft = Math.max(this.freezeLeft ?? 0, seconds);
  }

  /** Slow motion at `scale` for `seconds` of real time (match-winning moments). */
  slowMo(seconds, scale = 0.3) {
    this.slowLeft = seconds;
    this.slowScale = scale;
  }

  /** Game-time multiplier for this frame; the camera and UI keep running in real time. */
  timeScale(dt) {
    if (this.freezeLeft > 0) {
      this.freezeLeft -= dt;
      return 0.04;
    }
    if (this.slowLeft > 0) {
      this.slowLeft -= dt;
      return this.slowScale;
    }
    return 1;
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
    cam.fov = BATTLE_FOV;
    cam.aspect = w / h;
    // Fit the playable field; the decorative outer walls may tuck under side HUD panels.
    const hx = ARENA_W / 2;
    const hz = ARENA_H / 2 + 0.4;
    const kingZ = ARENA_H / 2 - 3;
    const princessZ = ARENA_H / 2 - 6.5;
    // Field corners (with the wall tops), plus every tower's health plate at both ends.
    const pts = [
      [-hx, 1.2, hz], [hx, 1.2, hz], [-hx, 0, -hz], [hx, 0, -hz],
      [0, 6.8, -kingZ], [-5.5, 6.1, -princessZ], [5.5, 6.1, -princessZ],
      [0, 6.8, kingZ], [-5.5, 6.1, princessZ], [5.5, 6.1, princessZ],
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
    return { pos: cam.position.clone(), look: new THREE.Vector3(0, 0, 0), offset: centerPx - (top + availH / 2), fov: BATTLE_FOV };
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

  /** Screen position (client px) of arena tile (x, y) at height h, through the live camera. */
  tileToScreen(x, y, h = 0) {
    const v = tileToWorld(x, y, h).project(this.camera);
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
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

    const gdt = dt * this.timeScale(dt);
    this.gameTime = (this.gameTime ?? 0) + gdt;
    this.world.update(dt, t);
    for (const fn of this.updaters) fn(gdt, this.gameTime);
    this.fx.update(gdt);
    if (this.useBloom) this.pipeline.render();
    else this.renderer.render(this.scene, this.camera);
  }

  buildLights() {
    // Sky fill now mostly comes from the env map, so the hemisphere light is just a tint.
    this.scene.add(new THREE.HemisphereLight(0xdcefff, 0x6a7d4a, 0.75));
    const sun = new THREE.DirectionalLight(0xffecd0, 3.0);
    sun.position.set(-22, 46, 18);
    sun.shadow.mapSize.set(4096, 4096);
    Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 120 });
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 2.5;
    this.scene.add(sun);
    this.sun = sun;
  }
}
