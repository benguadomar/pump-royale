import * as THREE from 'three/webgpu';
import * as t3 from '@typegpu/three';
import { d, std } from 'typegpu';
import { perlin3d } from '@typegpu/noise';
import { texture, vec3 } from 'three/tsl';
import { surfaceMetalness, rimLight } from './shaders.js';

/**
 * Character materials. Detail is sampled at each vertex's rest-pose position (`rest`, in
 * model units), so it sticks to the skin while limbs bend instead of swimming through it.
 */
const surfAttr = t3.attribute('surf', d.vec2f);
const restAttr = t3.attribute('rest', d.vec3f);

/**
 * Sculpted key light baked into the albedo: lit from above, darker underneath, and soft
 * contact occlusion around the feet so units sit on the ground.
 */
const formShade = (p, n) => {
  'use gpu';
  const top = std.mix(0.8, 1.06, n.y * 0.5 + 0.5);
  const foot = std.mix(0.6, 1.0, std.smoothstep(0.0, 0.17, p.y));
  return top * foot;
};

/** Procedural units: flat vertex colours plus per-material micro-detail and form shading. */
export const unitColor = t3.toTSL(() => {
  'use gpu';
  const base = t3.vertexColor(0).$.xyz;
  const id = surfAttr.$.x;
  const p = restAttr.$;
  const n = std.normalize(t3.normalWorld.$);
  const soft = perlin3d.sample(p * 9.0);
  let col = base * (0.97 + soft * 0.05);
  if (id > 8.5) {
    // Cloth: fine weave and slow folds.
    const weave = std.sin(p.x * 380 + p.z * 380) * std.sin(p.y * 380);
    const folds = perlin3d.sample(p * d.vec3f(7, 16, 7));
    col = base * (0.95 + weave * 0.035 + folds * 0.07);
  } else if (id > 2.5 && id < 3.5) {
    // Metal: brushed streaks; reflections come from the env map.
    col = base * (0.93 + perlin3d.sample(p * d.vec3f(5, 70, 5)) * 0.09);
  } else if (id > 1.5 && id < 2.5) {
    // Wood: stretched grain.
    col = base * (0.88 + perlin3d.sample(p * d.vec3f(8, 45, 8)) * 0.16);
  }
  return d.vec4f(col * formShade(p, n), 1);
});

/** Softer sheen on skin and leather, rough cloth, polished metal. */
export const unitRoughness = t3.toTSL(() => {
  'use gpu';
  const id = surfAttr.$.x;
  let r = d.f32(0.6);
  if (id > 8.5) r = 0.9;
  if (id > 2.5 && id < 3.5) r = 0.3;
  if (id > 1.5 && id < 2.5) r = 0.75;
  return r;
});

/** Form shading for textured sculpts (multiplies their albedo texture). */
const sculptShade = t3.toTSL(() => {
  'use gpu';
  return formShade(restAttr.$, std.normalize(t3.normalWorld.$));
});

/** Vertex-coloured unit material; `glow` adds a tint on top of the rim (hit flash, freeze, rage). */
export function makeUnitMaterial(glow) {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true });
  m.colorNode = unitColor;
  m.roughnessNode = unitRoughness;
  m.metalnessNode = surfaceMetalness;
  m.emissiveNode = glow ? rimLight.add(vec3(...glow)) : rimLight;
  return m;
}

/** Textured sculpt material (albedo + normal map) with the same form shading, rim and tints. */
export function makeSculptMaterial(src, glow) {
  const m = new THREE.MeshStandardNodeMaterial({ normalMap: src.normalMap ?? null, roughness: 0.68, metalness: 0 });
  m.colorNode = texture(src.map).mul(sculptShade);
  m.emissiveNode = glow ? rimLight.add(vec3(...glow)) : rimLight.mul(1.15);
  return m;
}
