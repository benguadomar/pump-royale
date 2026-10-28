import * as THREE from 'three';
import { state } from '../state.js';

export const ARENA_W = 18;
export const ARENA_H = 32;
export const RIVER_Y = 16;
export const BRIDGES_X = [3.5, 14.5];

export const tileToWorld = (x, y, h = 0) => new THREE.Vector3(x - ARENA_W / 2, h, ARENA_H / 2 - y);

/** Deterministic RNG so the village layout is identical every load. */
function rng(seed) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

const TOWER_LAYOUT = [
  { kind: 'princess', team: 0, x: 3.5, y: 6.5 },
  { kind: 'princess', team: 0, x: 14.5, y: 6.5 },
  { kind: 'king', team: 0, x: 9, y: 3 },
  { kind: 'princess', team: 1, x: 3.5, y: 25.5 },
  { kind: 'princess', team: 1, x: 14.5, y: 25.5 },
  { kind: 'king', team: 1, x: 9, y: 29 },
];
export { TOWER_LAYOUT };

export class Arena {
  constructor(canvas) {
    this.canvas = canvas;
    this.textures = new Map();
    this.updaters = new Set();
    this.mode = 'lobby';
    this.orbit = 0.6;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x2a3550);
    this.scene.fog = new THREE.Fog(0x2a3550, 55, 110);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 300);
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.lobbyGroup = new THREE.Group();
    this.scene.add(this.lobbyGroup);

    this.buildLights();
    this.buildArena();
    this.buildVillage();

    this.applyGraphics();
    window.addEventListener('resize', () => this.resize());
    this.resize();

    this.timer = new THREE.Timer();
    this.renderer.setAnimationLoop((ts) => this.frame(ts));
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
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.08 });
    const sprite = new THREE.Sprite(mat);
    const aspect = tex?.image ? tex.image.width / tex.image.height : 1;
    sprite.scale.set(height * aspect, height, 1);
    sprite.center.set(0.5, 0.02);
    return sprite;
  }

  makeTower(kind, team) {
    const group = new THREE.Group();
    const sprite = this.makeSprite(`/assets/cards/${kind}-tower.png`, kind === 'king' ? 5.4 : 4.8);
    if (team === 1) sprite.material.color.set(0xffc2c2);
    group.add(sprite);
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(kind === 'king' ? 2.2 : 1.7, kind === 'king' ? 2.4 : 1.9, 0.25, 8),
      new THREE.MeshStandardMaterial({ color: team === 0 ? 0x6f7f9c : 0x9c6f6f, roughness: 0.9 }),
    );
    base.position.y = 0.12;
    base.receiveShadow = true;
    group.add(base);
    group.userData.sprite = sprite;
    return group;
  }

  showLobbyTowers(visible) {
    if (visible && this.lobbyGroup.children.length === 0) {
      for (const t of TOWER_LAYOUT) {
        const tower = this.makeTower(t.kind, t.team);
        tower.position.copy(tileToWorld(t.x, t.y));
        this.lobbyGroup.add(tower);
      }
    }
    this.lobbyGroup.visible = visible;
  }

  setMode(mode) {
    this.mode = mode;
    this.showLobbyTowers(mode === 'lobby');
    this.resize();
  }

  onUpdate(fn) {
    this.updaters.add(fn);
    return () => this.updaters.delete(fn);
  }

  applyGraphics() {
    const high = state.settings.graphics === 'high';
    this.renderer.setPixelRatio(high ? Math.min(window.devicePixelRatio, 2) : 0.85);
    if (this.renderer.shadowMap.enabled !== high) {
      this.renderer.shadowMap.enabled = high;
      this.scene.traverse((o) => {
        if (o.material) o.material.needsUpdate = true;
      });
    }
    this.sun.castShadow = high;
    if (this.treeExtra) this.treeExtra.visible = high;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.clearViewOffset();
    if (this.mode === 'battle') this.fitBattleCamera(w, h);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Pulls the camera back until the whole arena (towers included) fits between the
   * top and bottom HUD insets, then shifts the image so it is centered in that gap.
   */
  fitBattleCamera(w, h) {
    const { top = 0, bottom = 0 } = this.insets ?? {};
    const cam = this.camera;
    const elev = THREE.MathUtils.degToRad(60);
    const hx = ARENA_W / 2 + 0.6;
    const hz = ARENA_H / 2 + 0.6;
    const pts = [
      [-hx, 0, hz], [hx, 0, hz], [-hx, 0, -hz], [hx, 0, -hz],
      [0, 6.2, -(ARENA_H / 2 - 3)], [-5.5, 5.4, -(ARENA_H / 2 - 6.5)], [5.5, 5.4, -(ARENA_H / 2 - 6.5)],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const v = new THREE.Vector3();
    const availH = Math.max(80, h - top - bottom);
    cam.fov = 40;
    let minY = 0;
    let maxY = 0;
    for (let d = 25; d < 200; d += 0.5) {
      cam.position.set(0, d * Math.sin(elev), d * Math.cos(elev));
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
      if (((maxY - minY) / 2) * h <= availH && maxX * (w / 2) <= w / 2 - 12) break;
    }
    const centerPx = ((1 - (maxY + minY) / 2) / 2) * h;
    const desired = top + availH / 2;
    cam.setViewOffset(w, h, 0, centerPx - desired, w, h);
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
    this.riverTex.offset.x = (t * 0.08) % 1;

    if (this.mode === 'lobby') {
      this.orbit += dt * 0.05;
      const r = 38;
      this.camera.position.set(Math.sin(this.orbit) * r, 30, Math.cos(this.orbit) * r);
      this.camera.lookAt(0, 0, 0);
    }
    for (const fn of this.updaters) fn(dt, t);
    this.renderer.render(this.scene, this.camera);
  }

  // ---------------------------------------------------------------- scene building

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x3a4a2a, 1.1));
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
    sun.position.set(-18, 40, 14);
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 100 });
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
    this.sun = sun;
  }

  buildArena() {
    const S = 16;
    const c = document.createElement('canvas');
    c.width = ARENA_W * S;
    c.height = ARENA_H * S;
    const g = c.getContext('2d');
    for (let y = 0; y < ARENA_H; y++) {
      for (let x = 0; x < ARENA_W; x++) {
        g.fillStyle = (x + y) % 2 ? '#7cc24f' : '#8dd35c';
        g.fillRect(x * S, (ARENA_H - 1 - y) * S, S, S);
      }
    }
    // Stone lanes from the king's side to each bridge.
    g.fillStyle = '#b4b2a6';
    for (const bx of BRIDGES_X) {
      g.fillRect((bx - 1) * S, 2 * S, 2 * S, (ARENA_H - 4) * S);
    }
    g.fillRect(3 * S, 3 * S, 12 * S, S * 0.6);
    g.fillRect(3 * S, (ARENA_H - 3.6) * S, 12 * S, S * 0.6);
    g.strokeStyle = 'rgba(0,0,0,0.12)';
    for (let i = 0; i <= ARENA_W; i++) g.strokeRect(i * S, 0, 0.01, c.height);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(ARENA_W, 0.4, ARENA_H),
      [
        new THREE.MeshStandardMaterial({ color: 0x5a4a35 }),
        new THREE.MeshStandardMaterial({ color: 0x5a4a35 }),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }),
        new THREE.MeshStandardMaterial({ color: 0x5a4a35 }),
        new THREE.MeshStandardMaterial({ color: 0x5a4a35 }),
        new THREE.MeshStandardMaterial({ color: 0x5a4a35 }),
      ],
    );
    floor.position.y = -0.2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // River
    const rc = document.createElement('canvas');
    rc.width = 256;
    rc.height = 64;
    const rg = rc.getContext('2d');
    const grad = rg.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, '#3fa7e0');
    grad.addColorStop(0.5, '#5ec4f2');
    grad.addColorStop(1, '#3fa7e0');
    rg.fillStyle = grad;
    rg.fillRect(0, 0, 256, 64);
    rg.strokeStyle = 'rgba(255,255,255,0.55)';
    rg.lineWidth = 2;
    const r = rng(7);
    for (let i = 0; i < 24; i++) {
      const x = r() * 256;
      const y = 6 + r() * 52;
      rg.beginPath();
      rg.moveTo(x, y);
      rg.quadraticCurveTo(x + 10, y - 3, x + 22, y);
      rg.stroke();
    }
    this.riverTex = new THREE.CanvasTexture(rc);
    this.riverTex.colorSpace = THREE.SRGBColorSpace;
    this.riverTex.wrapS = THREE.RepeatWrapping;
    this.riverTex.repeat.set(3, 1);
    const river = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_W + 0.4, 2.2),
      new THREE.MeshStandardMaterial({ map: this.riverTex, roughness: 0.2, metalness: 0.1 }),
    );
    river.rotation.x = -Math.PI / 2;
    river.position.set(0, 0.03, 0);
    this.scene.add(river);

    const edgeMat = new THREE.MeshStandardMaterial({ color: 0x8b8f96, roughness: 0.9 });
    for (const z of [-1.15, 1.15]) {
      const edge = new THREE.Mesh(new THREE.BoxGeometry(ARENA_W, 0.18, 0.2), edgeMat);
      edge.position.set(0, 0.08, z);
      edge.receiveShadow = true;
      this.scene.add(edge);
    }

    // Bridges
    const plank = new THREE.MeshStandardMaterial({ color: 0x9a6a3c, roughness: 0.85 });
    const plankDark = new THREE.MeshStandardMaterial({ color: 0x6f4724, roughness: 0.85 });
    for (const bx of BRIDGES_X) {
      const bridge = new THREE.Group();
      for (let i = 0; i < 7; i++) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.18, 0.42), i % 2 ? plank : plankDark);
        p.position.set(0, 0.16, -1.5 + i * 0.5);
        p.castShadow = p.receiveShadow = true;
        bridge.add(p);
      }
      for (const sx of [-1.15, 1.15]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 3.4), plankDark);
        rail.position.set(sx, 0.55, 0);
        rail.castShadow = true;
        bridge.add(rail);
        for (const pz of [-1.6, 0, 1.6]) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.55, 0.18), plankDark);
          post.position.set(sx, 0.35, pz);
          post.castShadow = true;
          bridge.add(post);
        }
      }
      bridge.position.copy(tileToWorld(bx, RIVER_Y));
      this.scene.add(bridge);
    }

    // Perimeter walls with battlements.
    const stone = new THREE.MeshStandardMaterial({ color: 0x8d929c, roughness: 0.95 });
    const stoneDark = new THREE.MeshStandardMaterial({ color: 0x6c717b, roughness: 0.95 });
    const wallH = 1.1;
    const addWall = (w, d, x, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), stone);
      m.position.set(x, wallH / 2 - 0.2, z);
      m.castShadow = m.receiveShadow = true;
      this.scene.add(m);
      const along = w > d;
      const len = along ? w : d;
      for (let i = 0; i < len / 1.4; i++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.45, 0.6), stoneDark);
        const off = -len / 2 + 0.7 + i * 1.4;
        b.position.set(along ? x + off : x, wallH + 0.0, along ? z : z + off);
        b.castShadow = true;
        this.scene.add(b);
      }
    };
    const hw = ARENA_W / 2 + 0.45;
    const hh = ARENA_H / 2 + 0.45;
    addWall(ARENA_W + 1.8, 0.9, 0, -hh);
    addWall(ARENA_W + 1.8, 0.9, 0, hh);
    addWall(0.9, ARENA_H, -hw, 0);
    addWall(0.9, ARENA_H, hw, 0);
    for (const [x, z] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) {
      const ct = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.1, 2.2, 8), stone);
      ct.position.set(x, 0.9, z);
      ct.castShadow = true;
      this.scene.add(ct);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.25, 1.3, 8), new THREE.MeshStandardMaterial({ color: 0x3c6fd1 }));
      roof.position.set(x, 2.65, z);
      roof.castShadow = true;
      this.scene.add(roof);
    }
  }

  buildVillage() {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(300, 300),
      new THREE.MeshStandardMaterial({ color: 0x3f6a3a, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.4;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const r = rng(42);
    const inArena = (x, z, pad) => Math.abs(x) < ARENA_W / 2 + pad && Math.abs(z) < ARENA_H / 2 + pad;
    const spots = [];
    const free = (x, z, rad) => spots.every((s) => Math.hypot(s.x - x, s.z - z) > s.rad + rad);

    // Houses
    const wallMats = [0xe8dcc0, 0xd9c9a3, 0xcfc2a8].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));
    const roofMats = [0x3c6fd1, 0x2f5bb5, 0xc0443a, 0xa8382f].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 }));
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x5e3d22 });
    let houses = 0;
    for (let tries = 0; tries < 600 && houses < 46; tries++) {
      const x = (r() - 0.5) * 80;
      const z = (r() - 0.5) * 84;
      if (inArena(x, z, 3.2) || !free(x, z, 2.6)) continue;
      spots.push({ x, z, rad: 2.6 });
      houses++;
      const w = 2.4 + r() * 1.6;
      const d = 2.2 + r() * 1.4;
      const h = 1.8 + r() * 1.8;
      const house = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMats[Math.floor(r() * 3)]);
      body.position.y = h / 2 - 0.4;
      body.castShadow = body.receiveShadow = true;
      house.add(body);
      for (const sx of [-w / 2, w / 2]) {
        const beam = new THREE.Mesh(new THREE.BoxGeometry(0.18, h, d + 0.05), woodMat);
        beam.position.set(sx, h / 2 - 0.4, 0);
        house.add(beam);
      }
      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.82, 1.6 + r(), 4), roofMats[Math.floor(r() * 4)]);
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(w / Math.max(w, d), 1, d / Math.max(w, d));
      roof.position.y = h - 0.4 + 0.75;
      roof.castShadow = true;
      house.add(roof);
      house.position.set(x, 0, z);
      house.rotation.y = Math.floor(r() * 4) * (Math.PI / 2) + (r() - 0.5) * 0.3;
      this.scene.add(house);
    }

    // Trees (instanced) – a core set plus an extra set hidden on LOW graphics.
    const makeTrees = (count) => {
      const pts = [];
      for (let tries = 0; tries < count * 12 && pts.length < count; tries++) {
        const x = (r() - 0.5) * 100;
        const z = (r() - 0.5) * 104;
        if (inArena(x, z, 2.2) || !free(x, z, 0.9)) continue;
        spots.push({ x, z, rad: 0.9 });
        pts.push({ x, z, s: 0.8 + r() * 0.8 });
      }
      const group = new THREE.Group();
      const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.15, 0.2, 1, 5), woodMat, pts.length);
      const leafGeo = new THREE.ConeGeometry(1, 2.2, 7);
      const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ color: 0x2f6e3c, roughness: 0.9 }), pts.length * 2);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      pts.forEach((p, i) => {
        m.compose(new THREE.Vector3(p.x, 0.1, p.z), q, new THREE.Vector3(p.s, p.s, p.s));
        trunk.setMatrixAt(i, m);
        m.compose(new THREE.Vector3(p.x, 0.1 + 1.4 * p.s, p.z), q, new THREE.Vector3(p.s, p.s, p.s));
        leaves.setMatrixAt(i * 2, m);
        m.compose(new THREE.Vector3(p.x, 0.1 + 2.4 * p.s, p.z), q, new THREE.Vector3(p.s * 0.7, p.s * 0.8, p.s * 0.7));
        leaves.setMatrixAt(i * 2 + 1, m);
      });
      trunk.castShadow = leaves.castShadow = true;
      group.add(trunk, leaves);
      this.scene.add(group);
      return group;
    };
    makeTrees(140);
    this.treeExtra = makeTrees(160);
  }
}
