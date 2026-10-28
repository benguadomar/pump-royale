import * as THREE from 'three/webgpu';
import { ARENA_W, ARENA_H, zoneAllows } from '../sim/constants.js';
import { CARD_BY_ID, cardImg } from '../data/cards.js';
import { makeTowerObject } from './world.js';
import { tileToWorld } from './engine.js';
import { sfx } from '../audio.js';

const TEAM_COLOR = [0x3d8ff0, 0xe2463c];
const TEAM_RGB = [[0.45, 0.75, 1], [1, 0.45, 0.4]];
const UNIT_SCALE = 1.3;
const PROJECTILE_ARC = { arrow: 0.6, bomb: 2.4, fireball: 0.9, cannonball: 0.5 };
const TOWER_LEVEL = 11;

/**
 * Draws a battle from whatever feeds it view state: the local simulation (vs AI) or
 * server snapshots (1v1). It never decides outcomes - it only animates `ents` and
 * reacts to `events` with effects and sounds.
 */
export class BattleView {
  constructor(engine, { onEvent } = {}) {
    this.engine = engine;
    this.fx = engine.fx;
    this.onEvent = onEvent ?? (() => {});
    this.group = new THREE.Group();
    engine.scene.add(this.group);
    this.visuals = new Map();
    this.projectiles = [];
    this.flipTex = new Map();
    this.lastEnts = [];

    this.geo = {
      disc: new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2),
      ring: new THREE.RingGeometry(0.82, 1, 28).rotateX(-Math.PI / 2),
      caster: new THREE.CylinderGeometry(0.35, 0.35, 1, 6).translate(0, 0.5, 0),
      sphere: new THREE.SphereGeometry(1, 12, 10),
      arrow: new THREE.CylinderGeometry(0.035, 0.035, 0.9, 5).rotateX(Math.PI / 2),
      rubble: new THREE.DodecahedronGeometry(0.5, 0),
    };
    this.mat = {
      blob: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false }),
      ring: TEAM_COLOR.map((c) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.8, depthWrite: false })),
      caster: new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
      barBg: new THREE.SpriteNodeMaterial({ color: 0x1a0d05, depthTest: false }),
      barFill: TEAM_COLOR.map((c) => new THREE.SpriteNodeMaterial({ color: c, depthTest: false })),
      arrow: new THREE.MeshStandardMaterial({ color: 0xffe9b0, emissive: 0xffc860, emissiveIntensity: 0.6 }),
      bomb: new THREE.MeshStandardMaterial({ color: 0x1d1d1f, roughness: 0.4 }),
      cannonball: new THREE.MeshStandardMaterial({ color: 0x33363c, roughness: 0.35, metalness: 0.5 }),
      fireball: new THREE.MeshBasicMaterial({ color: 0xffb14a }),
      rubble: new THREE.MeshStandardMaterial({ color: 0x6f7178, roughness: 1, flatShading: true }),
    };
    this.buildZoneOverlay();
  }

  // ------------------------------------------------------------- visuals

  textureFor(url, flipped) {
    const base = this.engine.textures.get(url);
    if (!flipped || !base) return base;
    if (!this.flipTex.has(url)) {
      const t = base.clone();
      t.wrapS = THREE.RepeatWrapping;
      t.repeat.x = -1;
      t.needsUpdate = true;
      this.flipTex.set(url, t);
    }
    return this.flipTex.get(url);
  }

  makeBar(width, y, team) {
    const bar = new THREE.Group();
    const bg = new THREE.Sprite(this.mat.barBg);
    bg.scale.set(width + 0.1, 0.22, 1);
    const fill = new THREE.Sprite(this.mat.barFill[team]);
    fill.center.set(0, 0.5);
    fill.position.x = -width / 2;
    fill.scale.set(width, 0.14, 1);
    bg.renderOrder = 20;
    fill.renderOrder = 21;
    bar.add(bg, fill);
    bar.position.y = y;
    bar.userData = { fill, width };
    return bar;
  }

  /** Tower health plate: level badge + team bar + exact hitpoints, redrawn on change. */
  makeTowerPlate(team, maxHp) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.scale.set(3.6, 0.9, 1);
    sprite.renderOrder = 22;
    const plate = { sprite, canvas, tex, team, maxHp, shown: -1 };
    this.drawPlate(plate, maxHp);
    return plate;
  }

  drawPlate(plate, hp) {
    const v = Math.max(0, Math.ceil(hp));
    if (v === plate.shown) return;
    plate.shown = v;
    const g = plate.canvas.getContext('2d');
    g.clearRect(0, 0, 256, 64);
    const blue = plate.team === 0;
    g.fillStyle = 'rgba(15,8,3,0.85)';
    g.beginPath();
    g.roundRect(30, 18, 220, 30, 8);
    g.fill();
    g.fillStyle = blue ? '#3d8ff0' : '#e2463c';
    g.beginPath();
    g.roundRect(34, 22, Math.max(0, 212 * (v / plate.maxHp)), 22, 6);
    g.fill();
    g.fillStyle = blue ? '#2a5fb8' : '#a8302b';
    g.beginPath();
    g.arc(28, 33, 22, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#f3c14a';
    g.lineWidth = 4;
    g.stroke();
    g.font = 'bold 22px Lilita One, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    g.fillText(String(TOWER_LEVEL), 28, 34);
    g.font = 'bold 22px Lilita One, sans-serif';
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.strokeText(String(v), 145, 34);
    g.fillText(String(v), 145, 34);
    plate.tex.needsUpdate = true;
  }

  createVisual(e) {
    if (e.kind === 'tower') {
      const obj = makeTowerObject(this.engine, e.towerKind, e.team);
      obj.position.copy(tileToWorld(e.x, e.y));
      const plate = this.makeTowerPlate(e.team, e.maxHp);
      plate.sprite.position.y = e.towerKind === 'king' ? 6.2 : 5.5;
      obj.add(plate.sprite);
      this.group.add(obj);
      return { kind: 'tower', obj, sprite: obj.userData.sprite, plate, flash: 0, dead: false, baseScaleY: obj.userData.sprite.scale.y };
    }
    const card = CARD_BY_ID[e.card];
    const url = cardImg(card.id);
    const obj = new THREE.Group();
    const height = card.size * UNIT_SCALE;
    const sprite = this.engine.makeSprite(url, height);
    const blob = new THREE.Mesh(this.geo.disc, this.mat.blob);
    blob.scale.setScalar(card.radius * 1.15);
    blob.position.y = 0.035;
    const ring = new THREE.Mesh(this.geo.ring, this.mat.ring[e.team]);
    ring.scale.setScalar(card.radius * 1.25);
    ring.position.y = 0.045;
    const caster = new THREE.Mesh(this.geo.caster, this.mat.caster);
    caster.scale.set(card.radius * 1.4, height * 0.8, card.radius * 1.4);
    caster.castShadow = true;
    const bar = this.makeBar(Math.max(0.9, card.radius * 2.2), height + 0.3, e.team);
    bar.visible = false;
    obj.add(blob, ring, caster, sprite, bar);
    obj.position.copy(tileToWorld(e.x, e.y));
    this.group.add(obj);
    return { kind: e.kind, obj, sprite, bar, url, card, flash: 0, lunge: 0, baseX: sprite.scale.x, baseY: sprite.scale.y, deathT: null, team: e.team };
  }

  // ------------------------------------------------------------- per-frame

  /** `view` = current state, `events` = new events since last frame (already in local perspective). */
  update(view, events, dt, t) {
    for (const ev of events) this.handleEvent(ev);
    this.lastEnts = view.ents;

    const seen = new Set();
    for (const e of view.ents) {
      seen.add(e.id);
      let v = this.visuals.get(e.id);
      if (!v) {
        v = this.createVisual(e);
        this.visuals.set(e.id, v);
      }
      v.last = e;
      if (v.kind === 'tower') this.updateTower(v, e, dt);
      else this.updateUnit(v, e, dt, t);
    }
    for (const [id, v] of this.visuals) {
      if (seen.has(id) || v.kind === 'tower') continue;
      // Gone from the state: play the death fade, then drop it.
      v.deathT = (v.deathT ?? 0) + dt;
      v.sprite.material.opacity = Math.max(0, 1 - v.deathT / 0.35);
      v.sprite.material.transparent = true;
      v.obj.position.y = -v.deathT * 0.6;
      v.bar.visible = false;
      if (v.deathT > 0.35) {
        this.group.remove(v.obj);
        v.sprite.material.dispose();
        this.visuals.delete(id);
      }
    }
    this.updateProjectiles(dt);
  }

  updateTower(v, e, dt) {
    v.flash = Math.max(0, v.flash - dt);
    if (e.dead) {
      if (!v.dead) this.collapseTower(v, e);
      return;
    }
    this.drawPlate(v.plate, e.hp);
    v.sprite.material.color.setHex(v.flash > 0 ? 0xffa898 : e.team === 1 ? 0xffd2cc : 0xffffff);
    v.sprite.scale.y = v.baseScaleY * (e.lunge ? 0.975 : 1);
  }

  updateUnit(v, e, dt, t) {
    v.flash = Math.max(0, v.flash - dt);
    v.obj.position.copy(tileToWorld(e.x, e.y));
    const mat = v.sprite.material;
    if (e.deploy > 0) {
      const k = 1 - e.deploy;
      v.sprite.position.y = Math.max(0, (1 - k * 3) * 3);
      mat.transparent = true;
      mat.opacity = 0.45 + 0.55 * Math.min(1, k * 3);
    } else {
      mat.opacity = 1;
      v.sprite.position.y = e.moving ? Math.abs(Math.sin(t * 11 + e.id)) * 0.16 : 0;
    }
    const tex = this.textureFor(v.url, e.facingLeft);
    if (mat.map !== tex) {
      mat.map = tex;
      mat.needsUpdate = true;
    }
    mat.color.setHex(v.flash > 0 ? 0xff8f80 : e.team === 1 ? 0xffd8d2 : 0xffffff);
    const s = e.lunge ? 1.1 : 1;
    v.sprite.scale.set(v.baseX * s, v.baseY * s, 1);
    const f = Math.max(0, Math.min(1, e.hp / e.maxHp));
    v.bar.visible = f < 0.999 || e.kind === 'building';
    v.bar.userData.fill.scale.x = v.bar.userData.width * f;
  }

  collapseTower(v, e) {
    v.dead = true;
    v.sprite.visible = false;
    v.plate.sprite.visible = false;
    v.obj.userData.plinth.visible = false;
    const center = tileToWorld(e.x, e.y);
    for (let i = 0; i < 9; i++) {
      const r = new THREE.Mesh(this.geo.rubble, this.mat.rubble);
      const a = Math.random() * Math.PI * 2;
      const d = 0.6 + Math.random() * 1.4;
      r.position.set(Math.cos(a) * d, 0.2, Math.sin(a) * d);
      r.rotation.set(Math.random() * 3, Math.random() * 3, 0);
      r.scale.setScalar(0.45 + Math.random() * 0.6);
      r.castShadow = true;
      v.obj.add(r);
    }
    this.fx.towerCollapse(center);
  }

  hitFlash(id) {
    const v = this.visuals.get(id);
    if (v) v.flash = 0.12;
  }

  handleEvent(ev) {
    switch (ev.e) {
      case 'deploy': {
        const p = tileToWorld(ev.x, ev.y);
        this.fx.shockwave(p, [1, 1, 1], 3.4);
        this.fx.sparks({ x: p.x, y: 0.3, z: p.z }, 8, TEAM_RGB[ev.team], 3);
        if (ev.team === 0) sfx.deploy();
        else sfx.deployEnemy();
        break;
      }
      case 'shot':
        this.spawnProjectile(ev);
        if (ev.kind === 'arrow') sfx.bow();
        else if (ev.kind === 'fireball') sfx.fireball();
        else if (ev.kind === 'cannonball') sfx.cannon();
        else sfx.bombThrow();
        break;
      case 'melee': {
        this.hitFlash(ev.to);
        const v = this.visuals.get(ev.to);
        if (v) {
          const p = v.obj.position;
          this.fx.hitPuff({ x: p.x, y: (v.card?.size ?? 2) * 0.6, z: p.z }, [1, 0.95, 0.8]);
        }
        sfx.sword();
        break;
      }
      case 'hit': {
        const p = tileToWorld(ev.x, ev.y);
        if (ev.splash > 0) {
          this.fx.explosion(p, ev.splash, ev.kind);
          sfx.boom();
          this.engine.shake(0.12);
        } else if (ev.kind === 'cannonball') {
          this.fx.smoke({ x: p.x, y: 0.6, z: p.z }, 3, 0.3, 0.7);
          this.fx.hitPuff({ x: p.x, y: 0.8, z: p.z }, [1, 0.85, 0.6]);
        } else if (ev.kind === 'arrow') {
          this.fx.hitPuff({ x: p.x, y: 0.9, z: p.z }, [1, 0.95, 0.75]);
        }
        break;
      }
      case 'death': {
        if (ev.kind === 'tower') break;
        const p = tileToWorld(ev.x, ev.y);
        this.fx.smoke({ x: p.x, y: 0.4, z: p.z }, 5, 0.35, 0.8);
        break;
      }
      case 'tower':
        this.engine.shake(1.25);
        sfx.tower();
        break;
      case 'overtime':
        sfx.horn();
        break;
    }
    this.onEvent(ev);
  }

  spawnProjectile(ev) {
    const kind = ev.kind;
    const mesh = new THREE.Mesh(kind === 'arrow' ? this.geo.arrow : this.geo.sphere, this.mat[kind]);
    if (kind !== 'arrow') mesh.scale.setScalar({ bomb: 0.28, cannonball: 0.26, fireball: 0.38 }[kind]);
    mesh.castShadow = true;
    mesh.position.copy(tileToWorld(ev.fx, ev.fy, ev.fh));
    this.group.add(mesh);
    this.projectiles.push({ mesh, kind, ev, t: 0, tx: ev.tx, ty: ev.ty, trail: 0 });
  }

  updateProjectiles(dt) {
    for (const p of this.projectiles) {
      p.t += dt;
      const target = this.visuals.get(p.ev.to);
      if (target?.last && !target.last.dead) {
        p.tx = target.last.x;
        p.ty = target.last.y;
      }
      const k = Math.min(1, p.t / p.ev.flight);
      const x = p.ev.fx + (p.tx - p.ev.fx) * k;
      const y = p.ev.fy + (p.ty - p.ev.fy) * k;
      const h = p.ev.fh + (p.ev.th - p.ev.fh) * k + Math.sin(Math.PI * k) * PROJECTILE_ARC[p.kind];
      const prev = p.mesh.position.clone();
      p.mesh.position.copy(tileToWorld(x, y, h));
      const pos = p.mesh.position;
      if (p.kind === 'arrow') p.mesh.lookAt(pos.clone().add(pos.clone().sub(prev)));
      p.trail -= dt;
      if (p.trail <= 0) {
        p.trail = 0.016;
        if (p.kind === 'arrow') this.fx.spawn('glow', pos, { size: 0.35, life: 0.22, tint: [1, 0.85, 0.5] });
        else if (p.kind === 'fireball') {
          this.fx.spawn('fire', pos, { size: 0.9, life: 0.35, vel: [0, 0.6, 0], grow: 0.4, spin: 2 });
          this.fx.spawn('glow', pos, { size: 1.4, life: 0.15, tint: [1, 0.55, 0.2] });
        } else if (p.kind === 'bomb') {
          this.fx.spawn('spark', { x: pos.x, y: pos.y + 0.3, z: pos.z }, { size: 0.16, life: 0.25, vel: [0, 1, 0], tint: [1, 0.8, 0.3] });
          this.fx.spawn('smoke', pos, { size: 0.35, life: 0.6, grow: 0.5, tint: [0.8, 0.8, 0.8] });
        } else {
          this.fx.spawn('smoke', pos, { size: 0.4, life: 0.5, grow: 0.6, tint: [0.85, 0.85, 0.85] });
        }
      }
      if (k >= 1) {
        p.done = true;
        this.group.remove(p.mesh);
      }
    }
    this.projectiles = this.projectiles.filter((p) => !p.done);
  }

  // ------------------------------------------------------------- deploy UI

  princessAlive(team, left) {
    return this.lastEnts.some((e) => e.kind === 'tower' && e.team === team && e.towerKind === 'princess' && !e.dead && e.x < ARENA_W / 2 === left);
  }

  canDeploy(x, y) {
    if (!zoneAllows(0, x, y, (left) => this.princessAlive(1, left))) return false;
    return !this.lastEnts.some((e) => (e.kind === 'tower' || e.kind === 'building') && !e.dead && Math.hypot(e.x - x, e.y - y) < (e.kind === 'tower' ? (e.towerKind === 'king' ? 2 : 1.5) : 0.9));
  }

  buildZoneOverlay() {
    const c = document.createElement('canvas');
    c.width = ARENA_W * 8;
    c.height = ARENA_H * 8;
    this.zoneCanvas = c;
    this.zoneTex = new THREE.CanvasTexture(c);
    this.zoneTex.magFilter = THREE.NearestFilter;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_W, ARENA_H).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: this.zoneTex, transparent: true, depthWrite: false }));
    mesh.position.y = 0.05;
    mesh.visible = false;
    mesh.renderOrder = 5;
    this.zoneMesh = mesh;
    this.group.add(mesh);
    this.zoneKey = '';
  }

  refreshZones() {
    const key = [true, false].map((l) => this.princessAlive(1, l)).join();
    if (key === this.zoneKey) return;
    this.zoneKey = key;
    const g = this.zoneCanvas.getContext('2d');
    g.clearRect(0, 0, this.zoneCanvas.width, this.zoneCanvas.height);
    g.fillStyle = 'rgba(230, 40, 40, 0.34)';
    for (let ty = 0; ty < ARENA_H; ty++) {
      for (let tx = 0; tx < ARENA_W; tx++) {
        if (!zoneAllows(0, tx + 0.5, ty + 0.5, (left) => this.princessAlive(1, left))) g.fillRect(tx * 8, (ARENA_H - 1 - ty) * 8, 8, 8);
      }
    }
    this.zoneTex.needsUpdate = true;
  }

  showZones() {
    this.refreshZones();
    this.zoneMesh.visible = true;
  }

  hideZones() {
    this.zoneMesh.visible = false;
    this.setPreview(null);
  }

  /** Ghost of `cardId` at tile (x, y); returns whether that spot is valid. Pass null to hide. */
  setPreview(cardId, x, y) {
    if (!cardId) {
      if (this.preview) this.preview.obj.visible = false;
      return false;
    }
    if (!this.preview || this.preview.cardId !== cardId) {
      if (this.preview) this.group.remove(this.preview.obj);
      const card = CARD_BY_ID[cardId];
      const obj = new THREE.Group();
      const sprite = this.engine.makeSprite(cardImg(cardId), card.size * UNIT_SCALE);
      sprite.material.transparent = true;
      sprite.material.opacity = 0.6;
      const ring = new THREE.Mesh(this.geo.ring, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }));
      ring.scale.setScalar(card.count > 1 ? 1.3 : Math.max(0.7, card.radius * 1.3));
      ring.position.y = 0.09;
      obj.add(sprite, ring);
      this.group.add(obj);
      this.preview = { cardId, obj, sprite, ring };
    }
    const ok = this.canDeploy(x, y);
    this.preview.obj.visible = true;
    this.preview.obj.position.copy(tileToWorld(x, y));
    this.preview.ring.material.color.setHex(ok ? 0xffffff : 0xff4a3a);
    this.preview.sprite.material.color.setHex(ok ? 0xffffff : 0xff7a70);
    return ok;
  }

  destroy() {
    this.engine.scene.remove(this.group);
    this.fx.clearAll();
    this.group.traverse((o) => {
      if (o.material && !Object.values(this.mat).flat().includes(o.material)) o.material.dispose?.();
      if (o.material?.map instanceof THREE.CanvasTexture) o.material.map.dispose();
    });
    Object.values(this.geo).forEach((g) => g.dispose());
    this.zoneTex.dispose();
    for (const t of this.flipTex.values()) t.dispose();
  }
}
