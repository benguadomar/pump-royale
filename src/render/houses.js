import * as THREE from 'three/webgpu';

/**
 * Sculpted village buildings (round tower, blue-roof and red-roof houses) cut from one scene.
 * Each node in the GLB faces +Z with its origin at the centre of its footprint on the ground.
 * Loaded before the world is built; when missing, the world keeps its procedural houses.
 */
const URL = '/assets/models/houses.glb';
/** World units per model unit at builder scale 1 (puts a house about as wide as a procedural cottage). */
const SCALE = 4;
const templates = {};

export async function loadHouseModels() {
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/libs/meshopt_decoder.module.js'),
  ]);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(URL);
  gltf.scene.updateMatrixWorld(true);
  for (const kind of ['tower', 'blue', 'red']) {
    const node = gltf.scene.getObjectByName(kind);
    let mesh = null;
    node?.traverse((o) => o.isMesh && (mesh ??= o));
    if (!mesh) continue;
    // Bake the node transform (meshopt dequantisation scale) into the geometry so clones are plain meshes.
    const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    geo.computeBoundingSphere();
    if (mesh.material.map) mesh.material.map.anisotropy = 4;
    templates[kind] = { geo, mat: mesh.material };
  }
}

/**
 * A sculpted building of `kind` ('tower' | 'blue' | 'red') standing at (x, y, z) facing `ry`,
 * sized like the procedural builder at scale `s`; null when the models aren't loaded.
 */
export function placeHouse(kind, x, y, z, s, ry) {
  const t = templates[kind];
  if (!t) return null;
  const mesh = new THREE.Mesh(t.geo, t.mat);
  mesh.position.set(x, y - 0.03, z);
  mesh.rotation.y = ry;
  mesh.scale.setScalar(SCALE * s);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
