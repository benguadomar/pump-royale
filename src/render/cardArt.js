import * as THREE from 'three/webgpu';
import { buildUnit } from './models.js';
import { CARDS, HAS_PNG, GENERATED_ART } from '../data/cards.js';

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
    for (const card of CARDS) {
      if (HAS_PNG.has(card.id) || GENERATED_ART.has(card.id)) continue;
      const model = buildUnit(card.id, 0);
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
