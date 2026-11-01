import * as THREE from 'three/webgpu';
import { uniform, uv, step, mix, color } from 'three/tsl';
import { ARENA_W, ARENA_H, zoneAllows } from '../sim/constants.js';
import { CARD_BY_ID, SPEEDS, TOWERS, isSpell } from '../data/cards.js';
import { buildUnit, makeTowerObject, Animator, ghostify, flashMat, frozenMat, rageMat } from './models.js';
import { tileToWorld } from './engine.js';
import { sfx } from '../audio.js';
import { ArrowVolley, makeBarrel, barrelMaterial, spellModelsReady } from './spells.js';

const TEAM_COLOR = [0x3d8ff0, 0xe2463c];
const TEAM_RGB = [[0.45, 0.75, 1], [1, 0.45, 0.4]];
const PROJECTILE_ARC = { arrow: 0.6, bomb: 2.4, fireball: 0.9, cannonball: 0.5, bullet: 0.05, bolt: 0.15, dragonfire: 0.3, spellFireball: 4, spellArrows: 5, spellBarrel: 5 };
const PROJECTILE_SIZE = { bomb: 0.28, cannonball: 0.26, fireball: 0.38, bullet: 0.07, bolt: 0.13, dragonfire: 0.22, spellFireball: 0.75, spellBarrel: 0.45 };
const BEAM_COLOR = { tesla: 0x9ff6ff, inferno: [0xff9a2a, 0xff4d14, 0xfff1c0] };
const TOWER_LEVEL = 11;
const DEATH_TIME = 0.5;
const HIT_STOP = 0.065;
/** Units whose blows freeze attacker and victim for a beat. */
const HEAVY = new Set(['pekka', 'giant', 'hog-rider']);
const DEATH_STYLE = { goblin: 'spin', giant: 'thud', pekka: 'thud', 'hog-rider': 'thud' };
/** Footfall dust size for heavy walkers, and the tiles walked between steps. */
const FOOTFALL = { giant: [1.5, 0.55], pekka: [1.5, 0.5], 'hog-rider': [1.1, 0.45], barbarian: [0.7, 0.4] };

const SILENT = new Proxy({}, { get: () => () => {} });

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const _v = new THREE.Vector3();

/**
 * Draws a battle from whatever feeds it view state: the local simulation (vs AI) or
 * server snapshots (1v1). It never decides outcomes - it only animates `ents` and
 * reacts to `events` with animations, effects and sounds.
 */
export class BattleView {
  /** `quiet`: no sounds, camera shake or damage numbers (the lobby background fight). */
  constructor(engine, { onEvent, quiet = false, towerScale = 1 } = {}) {
    this.engine = engine;
    this.fx = engine.fx;
    this.onEvent = onEvent ?? (() => {});
    this.quiet = quiet;
    this.sfx = quiet ? SILENT : sfx;
    this.towerScale = towerScale;
    this.group = new THREE.Group();
    engine.scene.add(this.group);
    this.visuals = new Map();
    this.projectiles = [];
    this.lastEnts = [];

    this.geo = {
      disc: new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2),
      ring: new THREE.RingGeometry(0.82, 1, 28).rotateX(-Math.PI / 2),
      sphere: new THREE.SphereGeometry(1, 12, 10),
      arrow: new THREE.CylinderGeometry(0.035, 0.035, 0.9, 5).rotateX(Math.PI / 2),
      rubble: new THREE.DodecahedronGeometry(0.5, 0),
      chunk: new THREE.BoxGeometry(1, 1, 1),
      bone: new THREE.CapsuleGeometry(0.035, 0.22, 3, 6),
      crack: new THREE.BoxGeometry(1, 1, 1),
      beam: new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2),
      barrel: new THREE.CylinderGeometry(0.4, 0.4, 0.8, 10),
      zone: new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2),
    };
    this.beams = new Map();
    this.volleys = [];
    this.zones = [];
    this.debris = [];
    this.numLayer = document.createElement('div');
    this.numLayer.className = 'dmg-layer';
    document.body.append(this.numLayer);
    this.numPool = [];
    this.lastTowerAt = -Infinity;
    this.mat = {
      blob: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false }),
      ring: TEAM_COLOR.map((c) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.8, depthWrite: false })),
      arrow: new THREE.MeshStandardMaterial({ color: 0xffe9b0, emissive: 0xffc860, emissiveIntensity: 0.6 }),
      bomb: new THREE.MeshStandardMaterial({ color: 0x1d1d1f, roughness: 0.4 }),
      cannonball: new THREE.MeshStandardMaterial({ color: 0x33363c, roughness: 0.35, metalness: 0.5 }),
      fireball: new THREE.MeshBasicMaterial({ color: 0xffb14a }),
      spellFireball: new THREE.MeshBasicMaterial({ color: 0xff8a2a }),
      dragonfire: new THREE.MeshBasicMaterial({ color: 0xff9c3a }),
      bullet: new THREE.MeshBasicMaterial({ color: 0x2a2a2e }),
      bolt: new THREE.MeshBasicMaterial({ color: 0x7fb8ff }),
      spellBarrel: new THREE.MeshStandardMaterial({ color: 0x8a5a33, roughness: 0.8 }),
      beam: { tesla: new THREE.MeshBasicMaterial({ color: BEAM_COLOR.tesla, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }), inferno: BEAM_COLOR.inferno.map((c) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending })) },
      freezeZone: new THREE.MeshBasicMaterial({ color: 0xbfeaff, transparent: true, opacity: 0.35, depthWrite: false }),
      rageZone: new THREE.MeshBasicMaterial({ color: 0xc040ff, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }),
      spellRing: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }),
      rubble: new THREE.MeshStandardMaterial({ color: 0x6f7178, roughness: 1, flatShading: true }),
      stone: [0xcdbf9f, 0x9a9ca3, 0xa39578].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95, flatShading: true })),
      bone: new THREE.MeshStandardMaterial({ color: 0xefebe1, roughness: 0.7 }),
      crack: new THREE.MeshBasicMaterial({ color: 0x241f1b }),
      ghost: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x606060, transparent: true, opacity: 0.55, depthWrite: false }),
    };
    this.buildZoneOverlay();
  }

  // ------------------------------------------------------------- visuals

  /**
   * Unit health bar: one sprite whose shader paints the dark frame and the team fill, so the two
   * can't drift apart (SpriteNodeMaterial mis-applies `Sprite.center`, which split the old two-sprite bar).
   */
  makeBar(width, y, team) {
    const w = width + 0.1;
    const frac = uniform(1);
    const inset = uniform(new THREE.Vector2(0.05 / w, 0.04 / 0.22));
    const p = uv();
    const fillEnd = inset.x.add(frac.mul(inset.x.mul(-2).add(1)));
    const inside = step(inset.x, p.x).mul(step(p.x, fillEnd)).mul(step(inset.y, p.y)).mul(step(p.y, inset.y.oneMinus()));
    const mat = new THREE.SpriteNodeMaterial({ depthTest: false });
    mat.colorNode = mix(color(0x1a0d05), color(TEAM_COLOR[team]), inside);
    const bar = new THREE.Sprite(mat);
    bar.scale.set(w, 0.22, 1);
    bar.renderOrder = 20;
    bar.position.y = y;
    bar.userData = { frac };
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
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.strokeText(String(v), 145, 34);
    g.fillText(String(v), 145, 34);
    plate.tex.needsUpdate = true;
  }

  createVisual(e) {
    const facing = e.team === 0 ? Math.PI : 0;
    if (e.kind === 'tower') {
      const obj = makeTowerObject(e.towerKind, e.team);
      obj.position.copy(tileToWorld(e.x, e.y));
      obj.scale.setScalar(this.towerScale);
      const plate = this.makeTowerPlate(e.team, e.maxHp);
      const sculptTop = obj.userData.crew?.style === 'sculpt' ? obj.userData.crew.height : null;
      plate.sprite.position.y = sculptTop ? sculptTop + 1.1 : e.towerKind === 'king' ? 6.3 : 5.5;
      obj.add(plate.sprite);
      this.group.add(obj);
      const crew = obj.userData.crew;
      const meshes = [];
      obj.traverse((o) => o.isMesh && o.userData.baseMat && meshes.push(o));
      return {
        kind: 'tower',
        towerKind: e.towerKind,
        obj,
        crew,
        anim: crew.animator ? Object.assign(crew.animator, { hitSpeed: TOWERS[e.towerKind].hitSpeed }) : new Animator(crew, { hitSpeed: TOWERS[e.towerKind].hitSpeed }),
        meshes,
        plate,
        flash: 0,
        dead: false,
        stage: 0,
        lastHp: e.hp,
        dmgAcc: 0,
        dmgT: 0,
        yaw: facing,
        wantYaw: facing,
        team: e.team,
      };
    }
    const card = CARD_BY_ID[e.card];
    const model = buildUnit(card.id, e.team);
    const obj = new THREE.Group();
    // Shadow disc and team ring hug the model's feet (never wider than its collision radius).
    const foot = Math.min(card.radius, Math.max(card.radius * 0.8, model.footprint ?? card.radius));
    const blob = new THREE.Mesh(this.geo.disc, this.mat.blob);
    blob.scale.setScalar(foot * 1.15);
    blob.position.y = 0.035;
    const ring = new THREE.Mesh(this.geo.ring, this.mat.ring[e.team]);
    ring.scale.setScalar(foot * 1.25);
    ring.position.y = 0.045;
    const bar = this.makeBar(Math.max(0.9, card.radius * 2.2), model.height + 0.35, e.team);
    bar.visible = false;
    model.root.rotation.y = facing;
    obj.add(blob, ring, model.root, bar);
    const blobSize = foot * 1.15;
    obj.position.copy(tileToWorld(e.x, e.y));
    this.group.add(obj);
    return {
      kind: e.kind,
      team: e.team,
      obj,
      model,
      anim: new Animator(model, { hitSpeed: card.hitSpeed, stride: 1.25 / model.scale }),
      meshes: model.meshes,
      ring,
      blob,
      blobSize,
      bar,
      card,
      flash: 0,
      stop: 0,
      landed: !(e.deploy > 0.72),
      lastHp: e.hp,
      dmgAcc: 0,
      dmgT: 0,
      deathT: null,
      yaw: facing,
      wantYaw: facing,
      team: e.team,
      fxT: Math.random() * 0.1,
    };
  }

  /** Material override by priority: hit flash, then frozen, then enraged. */
  setFlash(v, on) {
    const e = v.last;
    const mode = on ? 'flash' : e?.frozen ? 'frozen' : e?.raged ? 'rage' : null;
    if (v.tint === mode) return;
    v.tint = mode;
    const mat = mode === 'flash' ? flashMat : mode === 'frozen' ? frozenMat : mode === 'rage' ? rageMat : null;
    for (const m of v.meshes) m.material = mat ? (m.userData.tints?.[mode] ?? mat) : m.userData.baseMat;
  }

  /** Turns toward the current target while fighting, otherwise along the direction of travel. */
  steer(v, root, pos, dx, dz, dt) {
    const target = v.anim.engaged && v.targetId != null ? this.visuals.get(v.targetId)?.obj.position : null;
    if (target) v.wantYaw = Math.atan2(target.x - pos.x, target.z - pos.z);
    else if (v.aim) v.wantYaw = Math.atan2(v.aim.x - pos.x, v.aim.z - pos.z);
    else if (dx * dx + dz * dz > 1e-7) v.wantYaw = Math.atan2(dx, dz);
    v.yaw += wrapAngle(v.wantYaw - v.yaw) * Math.min(1, dt * 12);
    root.rotation.y = v.yaw;
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
      if (v.kind === 'tower') this.updateTower(v, e, dt, t);
      else this.updateUnit(v, e, dt, t);
    }
    for (const [id, v] of this.visuals) {
      if (seen.has(id) || v.kind === 'tower') continue;
      if (v.deathT == null) this.startDeath(v);
      v.deathT += dt;
      this.setFlash(v, v.deathT < 0.1);
      const style = DEATH_STYLE[v.card.id];
      v.anim.update(dt, t, { dying: Math.min(1, v.deathT / DEATH_TIME), deathStyle: style });
      if (style === 'thud' && !v.thudded && v.deathT > DEATH_TIME * 0.55) {
        v.thudded = true;
        const p = v.obj.position;
        this.fx.shockwave(p, [0.85, 0.75, 0.6], 2.6 + v.card.radius * 2);
        this.fx.smoke({ x: p.x, y: 0.3, z: p.z }, 8, 0.8, 1.1);
        this.shake(0.22);
        this.sfx.thud();
      }
      if (v.deathT > DEATH_TIME) {
        this.fx.smoke({ x: v.obj.position.x, y: 0.35, z: v.obj.position.z }, 4, 0.3, 0.7);
        this.group.remove(v.obj);
        v.bar?.material.dispose();
        this.visuals.delete(id);
      }
    }
    this.updateProjectiles(dt);
    this.updateVolleys(dt);
    this.updateDebris(dt);
    this.updateBeams(dt);
    this.updateZones(dt);
    this.updatePending(view.pending, t);
  }

  /** Predicted deploys (online): a pulsing ring where we tapped until the server's unit appears. */
  updatePending(list = [], t) {
    this.pendingRings ??= [];
    while (this.pendingRings.length < list.length) {
      const ring = new THREE.Mesh(this.geo.ring, new THREE.MeshBasicMaterial({ color: 0x7cc4ff, transparent: true, opacity: 0.9, depthWrite: false }));
      this.group.add(ring);
      this.pendingRings.push(ring);
    }
    this.pendingRings.forEach((ring, i) => {
      const p = list[i];
      ring.visible = Boolean(p);
      if (!p) return;
      ring.position.copy(tileToWorld(p.x, p.y));
      ring.position.y = 0.1;
      ring.scale.setScalar(0.9 + 0.25 * Math.sin(t * 12));
    });
  }

  /** Stun stars, rage sparkles and the Prince's charge dust. */
  statusFx(v, e, pos, dt) {
    v.statusT = (v.statusT ?? 0) - dt;
    if (v.statusT > 0) return;
    const top = v.model.height + 0.15;
    if (e.stunned) {
      v.statusT = 0.12;
      const a = Math.random() * Math.PI * 2;
      this.fx.spawn('spark', { x: pos.x + Math.cos(a) * 0.35, y: top, z: pos.z + Math.sin(a) * 0.35 }, { size: 0.16, life: 0.3, vel: [0, 0.3, 0], tint: [1, 0.95, 0.4] });
    } else if (e.frozen) {
      v.statusT = 0.2;
      this.fx.spawn('glow', { x: pos.x + (Math.random() - 0.5) * 0.6, y: top * Math.random(), z: pos.z + (Math.random() - 0.5) * 0.6 }, { size: 0.3, life: 0.5, tint: [0.7, 0.9, 1] });
    } else if (e.raged) {
      v.statusT = 0.15;
      this.fx.spawn('glow', { x: pos.x + (Math.random() - 0.5) * 0.7, y: 0.2 + Math.random() * top, z: pos.z + (Math.random() - 0.5) * 0.7 }, { size: 0.35, life: 0.45, vel: [0, 1.2, 0], tint: [0.85, 0.35, 1] });
    } else if (e.charging) {
      v.statusT = 0.05;
      this.fx.spawn('smoke', { x: pos.x, y: 0.15, z: pos.z }, { size: 0.5, life: 0.6, vel: [0, 0.4, 0], grow: 0.6, tint: [0.85, 0.75, 0.6] });
    } else v.statusT = 0.25;
  }

  /** First frame of a unit's death: last damage number, per-card death flavour. */
  startDeath(v) {
    v.deathT = 0;
    v.bar.visible = false;
    v.ring.visible = false;
    v.blob.visible = false;
    if (v.lastHp > 0) this.showNumber(v, v.lastHp + v.dmgAcc);
    const p = v.obj.position;
    if (v.card.id === 'skeleton') {
      // Skeletons burst into a scatter of bones and the skull.
      v.model.root.visible = false;
      for (let i = 0; i < 7; i++) {
        const mesh = new THREE.Mesh(i ? this.geo.bone : this.geo.sphere, this.mat.bone);
        if (!i) mesh.scale.setScalar(0.2);
        this.addDebris(mesh, { x: p.x, y: 0.6 + Math.random() * 0.4, z: p.z }, 2.5, 4, 1.6);
      }
      this.sfx.bones();
    } else if (DEATH_STYLE[v.card.id] !== 'thud') this.sfx.death();
  }

  updateTower(v, e, dt, t) {
    v.flash = Math.max(0, v.flash - dt);
    if (e.dead) {
      if (!v.dead) this.collapseTower(v, e);
      return;
    }
    this.trackDamage(v, e, dt);
    this.drawPlate(v.plate, e.hp);
    const f = e.hp / e.maxHp;
    const stage = f < 0.33 ? 2 : f < 0.66 ? 1 : 0;
    if (stage > v.stage) this.crackTower(v, stage);
    this.setFlash(v, v.flash > 0);
    const asleep = v.towerKind === 'king' && !e.active;
    if (!v.anim.engaged) v.aim = null;
    this.steer(v, v.crew.root, v.obj.position, 0, 0, dt);
    v.anim.update(dt, t, { asleep, frozen: !!(e.frozen || e.stunned) });
  }

  updateUnit(v, e, dt, t) {
    v.flash = Math.max(0, v.flash - dt);
    this.trackDamage(v, e, dt);
    const pos = tileToWorld(e.x, e.y);
    // Hit-stop: the attacker and its victim hold their pose for a few frames on heavy blows.
    if (v.stop > 0) {
      v.stop -= dt;
      this.setFlash(v, v.flash > 0);
      return;
    }
    const dx = pos.x - v.obj.position.x;
    const dz = pos.z - v.obj.position.z;
    v.obj.position.copy(pos);
    // Measured ground speed (tiles/s): animation cadence follows real motion, so heavy
    // troops visibly build up speed and knocked troops slide.
    const moved = v.px == null ? 0 : Math.hypot(e.x - v.px, e.y - v.py);
    if (dt > 0) v.spd = THREE.MathUtils.damp(v.spd ?? 0, moved / dt, 12, dt);
    v.px = e.x;
    v.py = e.y;
    const staggered = !!(e.staggered || e.stagger > 0);
    if (staggered && v.spd > 0.4) {
      v.skidT = (v.skidT ?? 0) - dt;
      if (v.skidT <= 0) {
        v.skidT = 0.045;
        this.fx.skid(pos, dx / Math.max(dt, 1e-3), dz / Math.max(dt, 1e-3), 0.6 + v.card.radius);
      }
    }
    const foot = FOOTFALL[v.card.id];
    if (foot && e.moving && !staggered) {
      v.stride = (v.stride ?? 0) + moved;
      if (v.stride > foot[1]) {
        v.stride = 0;
        v.foot = -(v.foot ?? 1);
        const side = v.foot * 0.3 * foot[0];
        const yaw = v.model.root.rotation.y;
        this.fx.footstep({ x: pos.x + side * Math.cos(yaw), y: 0, z: pos.z - side * Math.sin(yaw) }, foot[0]);
      }
    }
    if (!v.anim.engaged) v.aim = null;
    this.steer(v, v.model.root, pos, dx, dz, dt);
    v.sinkK = THREE.MathUtils.damp(v.sinkK ?? (e.hidden ? 1 : 0), e.hidden ? 1 : 0, 5, dt);
    const held = !!(e.frozen || e.stunned);
    v.anim.update(dt, t, { moving: e.moving && !held && v.spd > 0.08, speed: Math.min(v.spd, (SPEEDS[v.card.speed] ?? 1) * 2.2), deploy: e.deploy, frozen: held, sink: v.sinkK, stagger: staggered });
    this.setFlash(v, v.flash > 0);
    this.statusFx(v, e, pos, dt);

    // Drop-in: the shadow grows as the unit falls, then a puff of dust when it lands.
    if (e.deploy > 0) {
      const fall = Math.min(1, (1 - e.deploy) / 0.28);
      v.blob.scale.setScalar(v.blobSize * (0.25 + 0.75 * fall));
      if (!v.landed && fall >= 1) {
        v.landed = true;
        this.fx.shockwave(pos, [0.95, 0.9, 0.8], 1.2 + v.card.radius * 1.6);
        this.fx.smoke({ x: pos.x, y: 0.2, z: pos.z }, 4, 0.45, 0.6);
        this.sfx.land();
      }
    } else if (v.blob.scale.x !== v.blobSize) v.blob.scale.setScalar(v.blobSize);

    v.fxT -= dt;
    if (v.fxT <= 0 && e.deploy <= 0) {
      const g = v.model.groups;
      if (g.torch) {
        v.fxT = 0.06;
        g.torch.getWorldPosition(_v);
        _v.y += 0.12;
        this.fx.spawn('fire', _v, { size: 0.32, life: 0.32, vel: [0, 1.1, 0], grow: 0.3, spin: 3 });
      } else if (g.prop?.visible) {
        v.fxT = 0.1;
        g.prop.getWorldPosition(_v);
        _v.y += 0.22;
        this.fx.spawn('spark', _v, { size: 0.12, life: 0.2, vel: [0, 0.8, 0], tint: [1, 0.85, 0.35] });
      } else v.fxT = 0.5;
    }

    const f = Math.max(0, Math.min(1, e.hp / e.maxHp));
    v.bar.visible = (f < 0.999 || e.kind === 'building') && v.sinkK < 0.5;
    v.bar.userData.frac.value = f;
  }

  /** Damage stages: cracks spread over the walls and chunks fall off at 66 % and 33 % hp. */
  crackTower(v, stage) {
    v.stage = stage;
    const body = v.obj.userData.body;
    const wall = v.obj.userData.wall;
    const half = wall?.half ?? (v.towerKind === 'king' ? 1.56 : 1.18);
    const top = wall?.top ?? (v.towerKind === 'king' ? 3.8 : 3.2);
    for (let i = 0; i < 7 * stage; i++) {
      // Zig-zag crack: two or three short segments joined end to end on one wall face.
      const face = Math.floor(Math.random() * 4);
      let along = (Math.random() - 0.5) * half * 1.3;
      let y = 0.8 + Math.random() * (top - 1.2);
      const out = half + 0.03;
      const segs = 2 + Math.floor(Math.random() * 2);
      for (let s = 0; s < segs; s++) {
        const len = 0.3 + Math.random() * 0.35;
        const ang = (Math.random() - 0.5) * 1.6;
        const crack = new THREE.Mesh(this.geo.crack, this.mat.crack);
        const cx = along + Math.sin(ang) * len * 0.5;
        const cy = y - Math.cos(ang) * len * 0.5;
        const [x, z] = [[cx, out], [out, cx], [cx, -out], [-out, cx]][face];
        crack.position.set(x, cy, z);
        crack.rotation.set(0, face % 2 ? Math.PI / 2 : 0, ang);
        crack.scale.set(0.085, len, 0.04);
        body.add(crack);
        along += Math.sin(ang) * len;
        y -= Math.cos(ang) * len;
      }
    }
    const p = v.obj.position;
    for (let i = 0; i < 3 + stage * 2; i++) {
      const mesh = new THREE.Mesh(this.geo.chunk, this.mat.stone[i % 3]);
      mesh.scale.setScalar(0.18 + Math.random() * 0.22);
      this.addDebris(mesh, { x: p.x + (Math.random() - 0.5) * half * 2, y: top + 0.2, z: p.z + (Math.random() - 0.5) * half * 2 }, 2, 2.5, 2.5);
    }
    this.fx.smoke({ x: p.x, y: top, z: p.z }, 4 + stage * 2, 1.2, 1.0);
    this.shake(0.1 + stage * 0.05);
    this.sfx.crack();
    if (stage === 2) {
      // Badly damaged towers keep smouldering until they fall.
      const smoulder = () => !v.dead && this.fx.spawn('smoke', { x: p.x + (Math.random() - 0.5), y: top, z: p.z + (Math.random() - 0.5) }, { size: 0.8, life: 1.6, vel: [0.2, 1.1, 0], grow: 0.9, tint: [0.55, 0.55, 0.55] });
      this.fx.emit(600, (dt) => Math.random() < dt * 4 && smoulder());
    }
  }

  collapseTower(v, e) {
    v.dead = true;
    v.obj.userData.body.visible = false;
    v.crew.root.visible = false;
    v.plate.sprite.visible = false;
    const center = tileToWorld(e.x, e.y);
    const half = v.towerKind === 'king' ? 1.5 : 1.15;
    // The tower bursts into tumbling masonry that bounces and settles as permanent rubble.
    for (let i = 0; i < 22; i++) {
      const mesh = new THREE.Mesh(i % 4 ? this.geo.chunk : this.geo.rubble, i % 4 ? this.mat.stone[i % 3] : this.mat.rubble);
      mesh.scale.setScalar(0.3 + Math.random() * 0.45);
      const start = { x: center.x + (Math.random() - 0.5) * half * 2, y: 0.5 + Math.random() * 3.5, z: center.z + (Math.random() - 0.5) * half * 2 };
      this.addDebris(mesh, start, 4.5, 5, Infinity);
    }
    this.fx.towerCollapse(center);
    this.engine.hitStop(0.08);
  }

  /** Simple rigid-ish debris: gravity, ground bounce, friction; finite pieces shrink away. */
  addDebris(mesh, pos, spread, up, life) {
    mesh.castShadow = true;
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    this.group.add(mesh);
    const a = Math.random() * Math.PI * 2;
    const s = spread * (0.4 + Math.random() * 0.6);
    this.debris.push({
      mesh,
      vel: new THREE.Vector3(Math.cos(a) * s, up * (0.5 + Math.random() * 0.6), Math.sin(a) * s),
      spin: new THREE.Vector3((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12),
      life,
      max: life,
      size: mesh.scale.y * 0.5,
      rest: false,
    });
  }

  updateDebris(dt) {
    for (const d of this.debris) {
      d.life -= dt;
      if (!d.rest) {
        d.vel.y -= 16 * dt;
        d.mesh.position.addScaledVector(d.vel, dt);
        d.mesh.rotation.x += d.spin.x * dt;
        d.mesh.rotation.y += d.spin.y * dt;
        d.mesh.rotation.z += d.spin.z * dt;
        const floor = d.size * 0.6;
        if (d.mesh.position.y < floor) {
          d.mesh.position.y = floor;
          d.vel.y *= -0.32;
          d.vel.x *= 0.55;
          d.vel.z *= 0.55;
          d.spin.multiplyScalar(0.5);
          if (Math.abs(d.vel.y) < 0.6 && d.vel.lengthSq() < 0.5) d.rest = true;
        }
      }
      if (d.life < 0.4 && Number.isFinite(d.max)) d.mesh.scale.multiplyScalar(Math.max(0, 1 - dt * 5));
      if (d.life <= 0) {
        this.group.remove(d.mesh);
        d.dead = true;
      }
    }
    this.debris = this.debris.filter((d) => !d.dead);
  }

  /** Accumulates hp lost/gained and pops a floating number every few hits. */
  trackDamage(v, e, dt) {
    const raw = v.lastHp - e.hp;
    v.lastHp = e.hp;
    // Buildings lose hp steadily over their lifetime; that decay isn't a hit.
    const delta = v.card?.lifetime ? raw - (e.maxHp / v.card.lifetime) * dt * 1.5 : raw;
    if (delta > 0) v.dmgAcc += delta;
    else if (raw < -1) this.showNumber(v, raw);
    v.dmgT += dt;
    if (v.dmgAcc >= 8 && v.dmgT > 0.12) {
      this.showNumber(v, v.dmgAcc);
      v.dmgAcc = 0;
      v.dmgT = 0;
    } else if (v.dmgT > 0.4) {
      v.dmgAcc = 0;
      v.dmgT = 0;
    }
  }

  /** Pooled DOM number above an entity; negative values are heals. */
  showNumber(v, amount) {
    if (this.quiet || this.numLayer.childElementCount > 40) return;
    const p = v.obj.position;
    const h = v.kind === 'tower' ? (v.towerKind === 'king' ? 5.2 : 4.6) : (v.model?.height ?? 1.4) + 0.2;
    _v.set(p.x + (Math.random() - 0.5) * 0.5, h, p.z).project(this.engine.camera);
    const el = this.numPool.pop() ?? document.createElement('div');
    const heal = amount < 0;
    const value = Math.round(Math.abs(amount));
    el.className = `dmg-num${heal ? ' heal' : value >= 400 ? ' big' : ''}${v.team === 0 ? ' mine' : ''}`;
    el.textContent = heal ? `+${value}` : String(value);
    el.style.left = `${((_v.x + 1) / 2) * 100}%`;
    el.style.top = `${((1 - _v.y) / 2) * 100}%`;
    this.numLayer.append(el);
    setTimeout(() => {
      el.remove();
      this.numPool.push(el);
    }, 900);
  }

  shake(amount) {
    if (!this.quiet) this.engine.shake(amount);
  }

  /** Camera punch when a tower takes a hit; king towers kick harder. */
  impactCamera(v) {
    if (v.kind === 'tower') this.shake(v.towerKind === 'king' ? 0.12 : 0.05);
  }

  hitFlash(id) {
    const v = this.visuals.get(id);
    if (!v) return;
    v.flash = 0.12;
    if (v.kind !== 'tower') v.anim.flinch();
  }

  /** The shooter swings/draws and turns to face what it is attacking. */
  attackerAct(ev) {
    const v = this.visuals.get(ev.from);
    if (!v) return null;
    v.anim.attack();
    v.targetId = ev.to;
    if (ev.tx != null) v.aim = tileToWorld(ev.tx, ev.ty);
    return v;
  }

  handleEvent(ev) {
    switch (ev.e) {
      case 'deploy': {
        const p = tileToWorld(ev.x, ev.y);
        this.fx.shockwave(p, [1, 1, 1], 3.4);
        this.fx.sparks({ x: p.x, y: 0.3, z: p.z }, 8, TEAM_RGB[ev.team], 3);
        if (ev.team === 0) this.sfx.deploy();
        else this.sfx.deployEnemy();
        break;
      }
      case 'shot': {
        const src = this.attackerAct(ev);
        this.spawnProjectile(ev, src);
        if (ev.kind === 'arrow' || ev.kind === 'bolt') this.sfx.bow();
        else if (ev.kind === 'fireball' || ev.kind === 'dragonfire') this.sfx.fireball();
        else if (ev.kind === 'cannonball') this.sfx.cannon();
        else if (ev.kind === 'bullet') this.sfx.musket();
        else this.sfx.bombThrow();
        break;
      }
      case 'spell': {
        // Landing marker so both players can see where it will hit.
        this.addZone(ev.x, ev.y, ev.radius, this.mat.spellRing, Math.max(0.35, ev.flight + 0.1));
        this.zones.at(-1).mesh.material.color.setHex(ev.team === 0 ? 0x9fd0ff : 0xff9f9f);
        if (ev.card === 'fire-arrows') this.queueVolleys(ev);
        else if (ev.flight > 0) this.spawnSpellProjectile(ev);
        this.sfx.spellCast();
        break;
      }
      case 'spellHit':
        this.spellImpact(ev);
        break;
      case 'beam':
        this.showBeam(ev);
        break;
      case 'reveal':
        this.sfx.reveal(ev.up);
        break;
      case 'charge':
        this.sfx.charge();
        break;
      case 'melee': {
        const src = this.attackerAct(ev);
        this.hitFlash(ev.to);
        const v = this.visuals.get(ev.to);
        if (v) {
          const p = v.obj.position;
          const from = src?.obj.position ?? p;
          const power = Math.min(1, (src?.card?.damage ?? 120) / 700) * (ev.charged ? 1.4 : 1);
          this.fx.impact({ x: p.x, y: v.kind === 'tower' ? 2.2 : (v.model?.height ?? 1.4) * 0.55, z: p.z }, p.x - from.x, p.z - from.z, power, [1, 0.93, 0.78]);
          this.impactCamera(v);
        }
        if (src && HEAVY.has(src.card?.id)) {
          src.stop = HIT_STOP;
          if (v && v.kind !== 'tower') v.stop = HIT_STOP;
          this.shake(0.06);
          this.sfx.heavy();
        } else this.sfx.sword();
        break;
      }
      case 'hit': {
        const p = tileToWorld(ev.x, ev.y);
        if (ev.splash > 0) {
          this.fx.explosion(p, ev.splash, ev.kind);
          this.sfx.boom();
          this.shake(0.12);
        } else if (ev.kind === 'cannonball') {
          this.fx.smoke({ x: p.x, y: 0.6, z: p.z }, 3, 0.3, 0.7);
          this.fx.impact({ x: p.x, y: 0.8, z: p.z }, 0, 0, 0.6, [1, 0.85, 0.6]);
          this.fx.debris({ x: p.x, y: 0.3, z: p.z }, 5, 3);
        } else if (ev.kind === 'arrow') {
          this.fx.hitPuff({ x: p.x, y: 0.9, z: p.z }, [1, 0.95, 0.75]);
        }
        break;
      }
      case 'death': {
        if (ev.kind === 'tower') break;
        const p = tileToWorld(ev.x, ev.y);
        const dv = this.visuals.get(ev.id);
        this.fx.poof(p, 0.7 + (dv?.card?.radius ?? 0.5), dv?.team === 1 ? [1, 0.6, 0.55] : [0.6, 0.8, 1]);
        break;
      }
      case 'tower':
        this.shake(1.25);
        this.lastTowerAt = performance.now();
        // Knocking out a King Tower wins the match: savour it in slow motion.
        if (ev.kind === 'king') this.engine.slowMo(0.6, 0.3);
        this.sfx.tower();
        this.sfx.crumble();
        break;
      case 'end':
        if (performance.now() - this.lastTowerAt < 300) this.engine.slowMo(0.6, 0.3);
        break;
      case 'overtime':
        this.sfx.horn();
        break;
    }
    this.onEvent(ev);
  }

  spawnProjectile(ev, src) {
    const kind = ev.kind;
    const mesh = new THREE.Mesh(kind === 'arrow' ? this.geo.arrow : this.geo.sphere, this.mat[kind] ?? this.mat.bomb);
    if (kind !== 'arrow') mesh.scale.setScalar(PROJECTILE_SIZE[kind] ?? 0.25);
    mesh.castShadow = true;
    // Launch from the bow hand / throwing hand / torch / muzzle when the shooter has one.
    const launch = src?.model?.launch ?? src?.crew?.launch;
    const start = launch ? launch.getWorldPosition(new THREE.Vector3()) : tileToWorld(ev.fx, ev.fy, ev.fh);
    if (kind === 'cannonball' || kind === 'bullet') {
      this.fx.spawn('glow', start, { size: kind === 'bullet' ? 0.8 : 1.6, life: 0.1, tint: [1, 0.75, 0.35] });
      this.fx.smoke(start, kind === 'bullet' ? 1 : 4, 0.2, kind === 'bullet' ? 0.35 : 0.6);
    }
    mesh.position.copy(start);
    this.group.add(mesh);
    this.projectiles.push({ mesh, kind, ev, t: 0, start, tx: ev.tx, ty: ev.ty, trail: 0 });
  }

  /** Fire Arrows: one falling volley per sim wave, timed to land as that wave's damage hits. */
  queueVolleys(ev) {
    if (!spellModelsReady()) return;
    const center = tileToWorld(ev.x, ev.y);
    const from = tileToWorld(ev.fx, ev.fy);
    const fromZ = Math.sign(from.z - center.z) || 1;
    for (let w = 0; w < ev.waves; w++) this.volleys.push(new ArrowVolley(this.group, center, ev.radius, ev.flight + w * ev.waveGap, fromZ));
  }

  updateVolleys(dt) {
    this.volleys = this.volleys.filter((v) =>
      v.update(dt, this.fx, (pos) => {
        this.fx.spawn('glow', { x: pos.x, y: 0.3, z: pos.z }, { size: 0.9, life: 0.16, tint: [1, 0.55, 0.2] });
        this.fx.fire({ x: pos.x, y: 0.15, z: pos.z }, 2, 0.1, 0.45);
        if (Math.random() < 0.35) this.fx.debris({ x: pos.x, y: 0.15, z: pos.z }, 2, 1.8, [0.5, 0.42, 0.3], 0.08);
      }),
    );
  }

  /** Spells fly from the caster's King Tower; Arrows is a whole volley of shafts. */
  spawnSpellProjectile(ev) {
    const kind = ev.card === 'fireball' ? 'spellFireball' : ev.card === 'arrows' ? 'spellArrows' : 'spellBarrel';
    const start = tileToWorld(ev.fx, ev.fy, 6);
    let mesh;
    if (kind === 'spellArrows') {
      mesh = new THREE.Group();
      for (let i = 0; i < 14; i++) {
        const a = new THREE.Mesh(this.geo.arrow, this.mat.arrow);
        a.position.set((Math.random() - 0.5) * ev.radius * 1.4, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * ev.radius * 1.4);
        mesh.add(a);
      }
    } else {
      mesh = (kind === 'spellBarrel' && makeBarrel()) || new THREE.Mesh(kind === 'spellBarrel' ? this.geo.barrel : this.geo.sphere, this.mat[kind]);
      if (kind === 'spellFireball') mesh.scale.setScalar(PROJECTILE_SIZE.spellFireball);
    }
    mesh.position.copy(start);
    this.group.add(mesh);
    this.projectiles.push({ mesh, kind, ev: { ...ev, th: 0.3, tx: ev.x, ty: ev.y }, t: 0, start, tx: ev.x, ty: ev.y, trail: 0, spell: true });
  }

  updateProjectiles(dt) {
    for (const p of this.projectiles) {
      p.t += dt;
      const target = p.spell ? null : this.visuals.get(p.ev.to);
      if (target?.last && !target.last.dead) {
        p.tx = target.last.x;
        p.ty = target.last.y;
      }
      const k = Math.min(1, p.t / p.ev.flight);
      const end = tileToWorld(p.tx, p.ty, p.ev.th);
      const prev = p.mesh.position.clone();
      p.mesh.position.lerpVectors(p.start, end, k);
      p.mesh.position.y += Math.sin(Math.PI * k) * PROJECTILE_ARC[p.kind];
      const pos = p.mesh.position;
      const dir = pos.clone().add(pos.clone().sub(prev));
      if (p.kind === 'arrow' || p.kind === 'spellArrows') p.mesh.lookAt(dir);
      else if (p.kind === 'spellBarrel') {
        // End-over-end tumble, slightly off-axis so it reads as a thrown barrel.
        p.mesh.rotation.x += dt * 7;
        p.mesh.rotation.z += dt * 2.5;
      }
      else p.mesh.rotation.x += dt * 8;
      p.trail -= dt;
      if (p.trail <= 0) {
        p.trail = 0.016;
        if (p.kind === 'arrow') this.fx.spawn('glow', pos, { size: 0.35, life: 0.22, tint: [1, 0.85, 0.5] });
        else if (p.kind === 'fireball' || p.kind === 'dragonfire' || p.kind === 'spellFireball') {
          const big = p.kind === 'spellFireball' ? 2 : p.kind === 'dragonfire' ? 0.6 : 1;
          this.fx.spawn('fire', pos, { size: 0.9 * big, life: 0.35, vel: [0, 0.6, 0], grow: 0.4 * big, spin: 2 });
          this.fx.spawn('glow', pos, { size: 1.4 * big, life: 0.15, tint: [1, 0.55, 0.2] });
          if (p.kind === 'spellFireball') this.fx.spawn('smoke', pos, { size: 1.2, life: 0.8, grow: 1, tint: [0.5, 0.45, 0.42] });
        } else if (p.kind === 'bolt') this.fx.spawn('glow', pos, { size: 0.5, life: 0.2, tint: [0.5, 0.75, 1] });
        else if (p.kind === 'bullet') this.fx.spawn('glow', pos, { size: 0.25, life: 0.12, tint: [1, 0.95, 0.8] });
        else if (p.kind === 'spellArrows') {
          for (const c of p.mesh.children) {
            if (Math.random() < 0.3) this.fx.spawn('glow', c.getWorldPosition(_v), { size: 0.3, life: 0.18, tint: [1, 0.85, 0.5] });
          }
        } else if (p.kind === 'spellBarrel') {
          // Lit fuse: sparks and a thin smoke trail.
          this.fx.spawn('spark', pos, { size: 0.22, life: 0.3, vel: [(Math.random() - 0.5) * 2, 1.5, (Math.random() - 0.5) * 2], gravity: 9.8, tint: [1, 0.75, 0.3] });
          this.fx.spawn('glow', pos, { size: 0.6, life: 0.1, tint: [1, 0.6, 0.25] });
          if (Math.random() < 0.5) this.fx.spawn('smoke', pos, { size: 0.5, life: 0.7, grow: 0.6, tint: [0.6, 0.58, 0.55] });
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
        if (p.spell) continue;
        if (!p.ev.splash) this.hitFlash(p.ev.to);
        if (target) this.impactCamera(target);
      }
    }
    this.projectiles = this.projectiles.filter((p) => !p.done);
  }

  /** Tesla zaps and Inferno beams: stretched glowing tubes from emitter to target. */
  showBeam(ev) {
    const src = this.visuals.get(ev.from);
    const dst = this.visuals.get(ev.to);
    if (!src || !dst) return;
    let b = this.beams.get(ev.from);
    const mat = ev.kind === 'tesla' ? this.mat.beam.tesla : this.mat.beam.inferno[ev.stage];
    if (!b) {
      b = { mesh: new THREE.Mesh(this.geo.beam, mat), from: ev.from };
      b.mesh.renderOrder = 8;
      this.group.add(b.mesh);
      this.beams.set(ev.from, b);
    }
    b.mesh.material = mat;
    b.to = ev.to;
    b.kind = ev.kind;
    b.stage = ev.stage;
    b.life = ev.kind === 'tesla' ? 0.14 : 0.5;
    this.hitFlash(ev.to);
    const p = dst.obj.position;
    const h = dst.kind === 'tower' ? 2.4 : (dst.model?.height ?? 1.2) * 0.55;
    this.fx.sparks({ x: p.x, y: h, z: p.z }, ev.kind === 'tesla' ? 6 : 2, ev.kind === 'tesla' ? [0.6, 0.95, 1] : [1, 0.6, 0.2], 3);
    if (ev.kind === 'tesla') this.sfx.teslaZap();
    else this.sfx.beam(ev.stage);
  }

  updateBeams(dt) {
    for (const [id, b] of this.beams) {
      b.life -= dt;
      const src = this.visuals.get(b.from);
      const dst = this.visuals.get(b.to);
      if (b.life <= 0 || !src || !dst || dst.deathT != null) {
        this.group.remove(b.mesh);
        this.beams.delete(id);
        continue;
      }
      const launch = src.model?.launch;
      const start = launch ? launch.getWorldPosition(new THREE.Vector3()) : src.obj.position.clone().setY(1.5);
      const end = dst.obj.position.clone().setY(dst.kind === 'tower' ? 2.4 : (dst.model?.height ?? 1.2) * 0.55);
      const len = start.distanceTo(end);
      const width = b.kind === 'tesla' ? 0.05 + Math.random() * 0.05 : 0.07 + b.stage * 0.07 + Math.sin(performance.now() / 40) * 0.015;
      b.mesh.position.copy(start);
      b.mesh.lookAt(end);
      b.mesh.scale.set(width, width, len);
    }
  }

  /** Lingering ground decals for Freeze and Rage, plus landing markers for incoming spells. */
  addZone(x, y, radius, mat, duration, pulse = false) {
    const mesh = new THREE.Mesh(this.geo.zone, mat.clone());
    mesh.position.copy(tileToWorld(x, y, 0.06));
    mesh.scale.setScalar(radius);
    mesh.renderOrder = 6;
    this.group.add(mesh);
    this.zones.push({ mesh, t: 0, duration, pulse, base: mat.opacity });
  }

  updateZones(dt) {
    for (const z of this.zones) {
      z.t += dt;
      const fade = Math.min(1, (z.duration - z.t) / 0.4);
      z.mesh.material.opacity = z.base * Math.max(0, fade) * (z.pulse ? 0.75 + Math.sin(z.t * 6) * 0.25 : 1);
      if (z.t >= z.duration) {
        this.group.remove(z.mesh);
        z.mesh.material.dispose();
        z.done = true;
      }
    }
    this.zones = this.zones.filter((z) => !z.done);
  }

  spellImpact(ev) {
    const p = tileToWorld(ev.x, ev.y);
    const r = ev.radius;
    switch (ev.card) {
      case 'fireball':
        this.fx.explosion(p, r * 0.8, 'fireball');
        this.fx.shockwave(p, [1, 0.55, 0.2], r * 2.6);
        this.shake(0.35);
        this.sfx.boom();
        break;
      case 'arrows':
        for (let i = 0; i < 26; i++) {
          const a = Math.random() * Math.PI * 2;
          const d = Math.sqrt(Math.random()) * r;
          this.fx.hitPuff({ x: p.x + Math.cos(a) * d, y: 0.3, z: p.z + Math.sin(a) * d }, [1, 0.9, 0.7]);
        }
        this.sfx.arrows();
        break;
      case 'zap':
        for (let i = 0; i < 4; i++) {
          const a = Math.random() * Math.PI * 2;
          const d = Math.random() * r * 0.7;
          const bolt = new THREE.Mesh(this.geo.beam, this.mat.beam.tesla);
          bolt.position.set(p.x + Math.cos(a) * d, 9, p.z + Math.sin(a) * d);
          bolt.lookAt(bolt.position.x + (Math.random() - 0.5), 0, bolt.position.z + (Math.random() - 0.5));
          bolt.scale.set(0.12, 0.12, 9);
          this.group.add(bolt);
          setTimeout(() => this.group.remove(bolt), 140);
        }
        this.fx.shockwave(p, [0.6, 0.95, 1], r * 2.2);
        this.fx.sparks({ x: p.x, y: 0.5, z: p.z }, 20, [0.6, 0.95, 1], 6);
        this.shake(0.15);
        this.sfx.zap();
        break;
      case 'freeze':
        this.addZone(ev.x, ev.y, r, this.mat.freezeZone, ev.duration);
        this.fx.shockwave(p, [0.75, 0.92, 1], r * 2.2);
        for (let i = 0; i < 18; i++) {
          const a = Math.random() * Math.PI * 2;
          const d = Math.sqrt(Math.random()) * r;
          this.fx.spawn('glow', { x: p.x + Math.cos(a) * d, y: 0.2 + Math.random(), z: p.z + Math.sin(a) * d }, { size: 0.5, life: 1.2, vel: [0, 0.3, 0], tint: [0.75, 0.92, 1] });
        }
        this.sfx.freeze();
        break;
      case 'rage':
        this.addZone(ev.x, ev.y, r, this.mat.rageZone, ev.duration, true);
        this.fx.shockwave(p, [0.85, 0.35, 1], r * 2.2);
        this.sfx.rage();
        break;
      case 'barrel-bomb': {
        // Powder blast: fireball, shockwave, then the barrel's staves and hoops fly apart.
        this.fx.explosion(p, r * 0.9, 'fireball');
        this.fx.shockwave(p, [1, 0.6, 0.25], r * 2.8);
        this.fx.fire({ x: p.x, y: 0.6, z: p.z }, 14, r * 0.45, r * 0.8);
        const wood = barrelMaterial() ?? this.mat.spellBarrel;
        for (let i = 0; i < 10; i++) {
          const stave = new THREE.Mesh(this.geo.chunk, wood);
          stave.scale.set(0.12, 0.6, 0.26);
          this.addDebris(stave, { x: p.x, y: 0.7, z: p.z }, 5, 5.5, 1.8);
        }
        for (let i = 0; i < 2; i++) {
          const hoop = new THREE.Mesh(this.geo.chunk, this.mat.cannonball);
          hoop.scale.set(0.55, 0.05, 0.55);
          this.addDebris(hoop, { x: p.x, y: 0.8, z: p.z }, 3, 6, 1.6);
        }
        this.shake(0.4);
        this.sfx.boom();
        this.sfx.barrel();
        break;
      }
      case 'fire-arrows': {
        // Each volley: a flash ring and the whoosh; the last one leaves the ground smouldering.
        this.fx.shockwave(p, [1, 0.5, 0.15], r * 1.9);
        this.fx.spawn('glow', { x: p.x, y: 0.6, z: p.z }, { size: r * 2.2, life: 0.18, tint: [1, 0.5, 0.2] });
        this.sfx.arrows();
        if (ev.wave === CARD_BY_ID['fire-arrows'].spell.waves - 1) {
          this.fx.spawn('scorch', { x: p.x, y: 0.07, z: p.z }, { size: r * 2, life: 5 });
          this.fx.emit(1.6, (dt) => {
            if (Math.random() > dt * 14) return;
            const a = Math.random() * Math.PI * 2;
            const d = Math.sqrt(Math.random()) * r;
            this.fx.spawn('fire', { x: p.x + Math.cos(a) * d, y: 0.2, z: p.z + Math.sin(a) * d }, { size: 0.6, life: 0.6, vel: [0, 1.2, 0], grow: 0.3 });
          });
        }
        break;
      }
      case 'goblin-barrel':
        for (let i = 0; i < 8; i++) {
          const mesh = new THREE.Mesh(this.geo.chunk, this.mat.spellBarrel);
          mesh.scale.set(0.08, 0.5, 0.14);
          this.addDebris(mesh, { x: p.x, y: 0.6, z: p.z }, 3, 3.5, 1.5);
        }
        this.fx.smoke({ x: p.x, y: 0.3, z: p.z }, 6, 0.6, 0.9);
        this.sfx.barrel();
        break;
    }
  }


  // ------------------------------------------------------------- deploy UI

  princessAlive(team, left) {
    return this.lastEnts.some((e) => e.kind === 'tower' && e.team === team && e.towerKind === 'princess' && !e.dead && e.x < ARENA_W / 2 === left);
  }

  canDeploy(x, y, cardId) {
    if (cardId && isSpell(CARD_BY_ID[cardId])) return x >= 0 && x <= ARENA_W && y >= 0 && y <= ARENA_H;
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

  showZones(cardId) {
    // Spells may land anywhere, so they get no forbidden-zone overlay.
    if (cardId && isSpell(CARD_BY_ID[cardId])) {
      this.zoneMesh.visible = false;
      return;
    }
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
      const ring = new THREE.Mesh(this.geo.ring, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }));
      ring.position.y = 0.09;
      if (isSpell(card)) {
        // Spells preview their area of effect instead of a ghost unit.
        ring.scale.setScalar(card.spell.radius);
        const fill = new THREE.Mesh(this.geo.zone, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false }));
        fill.scale.setScalar(card.spell.radius);
        fill.position.y = 0.08;
        obj.add(fill);
      } else {
        const model = buildUnit(cardId, 0);
        ghostify(model, this.mat.ghost);
        model.root.rotation.y = Math.PI;
        obj.add(model.root);
        ring.scale.setScalar(card.count > 1 ? 1.3 : Math.max(0.7, card.radius * 1.3));
      }
      obj.add(ring);
      this.group.add(obj);
      this.preview = { cardId, obj, ring };
    }
    const ok = this.canDeploy(x, y, cardId);
    this.preview.obj.visible = true;
    this.preview.obj.position.copy(tileToWorld(x, y));
    this.preview.ring.material.color.setHex(ok ? 0xffffff : 0xff4a3a);
    this.mat.ghost.color.setHex(ok ? 0xffffff : 0xff7a70);
    return ok;
  }

  destroy() {
    this.volleys.forEach((v) => v.dispose());
    this.engine.scene.remove(this.group);
    this.fx.clearAll();
    this.group.traverse((o) => {
      if (o.isSprite && o.material.map instanceof THREE.CanvasTexture) {
        o.material.map.dispose();
        o.material.dispose();
      } else if (o.isSprite && o.userData.frac) o.material.dispose();
    });
    this.preview?.ring.material.dispose();
    this.pendingRings?.forEach((r) => r.material.dispose());
    this.numLayer.remove();
    Object.values(this.geo).forEach((g) => g.dispose());
    this.zoneTex.dispose();
  }
}
