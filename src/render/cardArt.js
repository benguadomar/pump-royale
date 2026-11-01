import * as THREE from 'three/webgpu';
import { buildUnit } from './models.js';
import { loadSpellModels, makeBarrel, makeArrow, makeFireball, spellModelsReady } from './spells.js';
import { CARDS, HAS_PNG, GENERATED_ART, isSpell } from '../data/cards.js';

/** Spell cards show their model: a tilted powder barrel, a blazing fireball, or a fan of flaming arrows. */
function spellPortrait(id) {
  if (!spellModelsReady()) return null;
  const root = new THREE.Group();
  if (id === 'fireball') {
    const { obj, mixer } = makeFireball();
    mixer.update(0.4);
    obj.updateMatrixWorld(true);
    // The portrait is framed on the bounding box, so drop the longest flame tongues to keep the ball big.
    const box = new THREE.Box3();
    const long = [];
    obj.traverse((o) => o.isMesh && box.setFromObject(o) && Math.max(box.max.length(), box.min.length()) > 0.6 && long.push(o));
    for (const o of long) o.removeFromParent();
    obj.rotation.set(0.3, 0, 0.2);
    root.add(obj);
  } else if (id === 'barrel-bomb') {
    const b = makeBarrel();
    b.rotation.set(0.25, 0.6, -0.35);
    root.add(b);
    // A lit fuse on top.
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffc65a }));
    glow.position.set(0.1, 0.62, 0);
    root.add(glow);
  } else {
    for (let i = 0; i < 5; i++) {
      const a = makeArrow();
      // Tips down, fanned out like a volley.
      a.rotation.set(Math.PI / 2 - 0.35 + i * 0.04, 0, (i - 2) * 0.22);
      a.position.set((i - 2) * 0.22, Math.abs(i - 2) * -0.05, 0);
      root.add(a);
    }
  }
  return { root };
}

// WebGPU pads read-back rows to 256 bytes, so the width must be a multiple of 64 pixels.
const W = 256;
const H = 340;

const toSrgb = (v) => {
  const c = v / 255;
  return Math.round(255 * Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
};

/**
 * Renders a studio portrait of every card that has no PNG (its 3D model or spell icon)
 * into GENERATED_ART as transparent PNG data URLs, so UI and models always match.
 */
export async function generateCardArt(engine) {
  const renderer = engine.renderer;
  const rt = new THREE.RenderTarget(W, H, { samples: 4 });
  const scene = new THREE.Scene();
  scene.environment = engine.scene.environment;
  scene.environmentIntensity = 0.6;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a7a, 1.5));
  const key = new THREE.DirectionalLight(0xfff2e0, 2.6);
  key.position.set(-2, 4, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbfd8ff, 1.2);
  rim.position.set(3, 2, -4);
  scene.add(rim);
  const cam = new THREE.PerspectiveCamera(26, W / H, 0.05, 60);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(W, H);
  const prevColor = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);
  // WebGPU reads rows top-down; WebGL bottom-up.
  const flip = !renderer.backend?.isWebGPUBackend;
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();

  try {
    await loadSpellModels().catch((e) => console.warn('spell models', e));
    for (const card of CARDS) {
      if (HAS_PNG.has(card.id) || GENERATED_ART.has(card.id)) continue;
      const model = isSpell(card) ? spellPortrait(card.id) : buildUnit(card.id, 0);
      if (!model) continue;
      model.root.rotation.y = -0.45;
      model.root.updateMatrixWorld(true);
      scene.add(model.root);
      box.setFromObject(model.root);
      box.getSize(size);
      box.getCenter(center);
      const fit = Math.max(size.y / 2 / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)), size.x / 2 / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) / cam.aspect);
      const dist = fit * 1.2 + size.z / 2;
      cam.position.set(center.x + dist * 0.12, center.y + size.y * 0.12, center.z + dist);
      cam.lookAt(center);
      renderer.setRenderTarget(rt);
      renderer.clear();
      renderer.render(scene, cam);
      renderer.setRenderTarget(null);
      const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H);
      for (let y = 0; y < H; y++) {
        const src = (flip ? H - 1 - y : y) * W * 4;
        const dst = y * W * 4;
        for (let x = 0; x < W * 4; x += 4) {
          const a = px[src + x + 3];
          // Undo premultiplication on antialiased edges before the colour transform.
          const k = a > 0 ? 255 / a : 0;
          image.data[dst + x] = toSrgb(Math.min(255, px[src + x] * k));
          image.data[dst + x + 1] = toSrgb(Math.min(255, px[src + x + 1] * k));
          image.data[dst + x + 2] = toSrgb(Math.min(255, px[src + x + 2] * k));
          image.data[dst + x + 3] = a;
        }
      }
      ctx.putImageData(image, 0, 0);
      GENERATED_ART.set(card.id, canvas.toDataURL('image/png'));
      scene.remove(model.root);
    }
  } finally {
    renderer.setClearColor(prevColor, prevAlpha);
    rt.dispose();
  }
}
