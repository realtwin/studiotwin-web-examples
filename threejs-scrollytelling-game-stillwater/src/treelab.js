// Tree lab: isolated WebGPU/TSL test bench for the procedural swamp trees.
import * as THREE from 'three/webgpu';
import { pass, color } from 'three/tsl';
import { stillwaterFog } from './fogNode.js';
import { makeSkyNode, makeWaterNode } from './worldNodes.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { growTree, barkMaterial, leafMaterial, mossMaterial } from './trees.js';

const params = new URLSearchParams(location.search);
const BASE = import.meta.env.BASE_URL;
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.3, 2500);
const tl = new THREE.TextureLoader();
const load = (n, srgb) => tl.loadAsync(BASE + 'tex/' + n).then((t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; });
const [hdr, albedo, normal, rough, leafC, leafT, moss] = await Promise.all([
  new HDRLoader().loadAsync(BASE + 'env/sky.hdr'),
  load('cbark_albedo.jpg', true), load('cbark_normals.jpg'), load('cbark_roughness.jpg'),
  load('leaf_cypress.png', true), load('leaf_tupelo.png', true), load('moss.png', true),
]);
for (const t of [leafC, leafT, moss]) { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; }
hdr.mapping = THREE.EquirectangularReflectionMapping;
scene.environment = hdr; scene.environmentIntensity = 0.45; scene.environmentRotation.y = -2.35;
scene.background = new THREE.Color(0.05, 0.155, 0.155).multiplyScalar(1.25);
scene.fogNode = stillwaterFog();
const moon = new THREE.DirectionalLight(0xc9d4ff, 1.6); moon.position.set(-20, 18, -60); scene.add(moon);
const key = new THREE.DirectionalLight(0xffc9a8, 0.35); key.position.set(30, 40, 50); scene.add(key);
scene.add(new THREE.HemisphereLight(0x8a7a96, 0x0b1a16, 0.4));

const bark = barkMaterial({ albedo, normal, rough });
const mats = { cypress: leafMaterial(leafC, 0x86a868, 0x9fae6a), tupelo: leafMaterial(leafT, 0x7d9870, 0x96a870) };
const mossM = mossMaterial(moss);

const water = makeWaterNode({ size: 800 }); scene.add(water);
scene.add(makeSkyNode(hdr));

const layout = (params.get('trees') || 'cypress:1,cypress:2,tupelo:3,snag:4,cypress:5').split(',');
let x = -(layout.length - 1) * 7;
let tris = 0;
const t0 = performance.now();
for (const spec of layout) {
  const [sp, seed] = spec.split(':');
  const tr = growTree(sp, +seed, { lod: +(params.get('lod') || 0) });
  const g = new THREE.Group(); g.position.set(x, 0, (+seed % 2) * 6); x += 14;
  g.add(new THREE.Mesh(tr.bark, bark)); tris += tr.bark.index.count / 3;
  if (tr.leaves) { g.add(new THREE.Mesh(tr.leaves, mats[sp === 'tupelo' ? 'tupelo' : 'cypress'])); tris += tr.leaves.index.count / 3; }
  if (tr.moss) { g.add(new THREE.Mesh(tr.moss, mossM)); tris += tr.moss.index.count / 3; }
  scene.add(g);
}
console.info('[treelab] grown', layout.length, 'trees', Math.round(tris), 'tris in', Math.round(performance.now() - t0), 'ms');

const view = params.get('view') || 'wide';
if (view === 'wide') { camera.position.set(0, 9, 62); camera.lookAt(0, 11, 0); }
else if (view === 'close') { camera.position.set(-18, 5, 16); camera.lookAt(-28, 9, 0); }
else if (view === 'base') { camera.position.set(-22, 1.8, 11); camera.lookAt(-28, 1.2, 0); }
else if (view === 'crown') { camera.position.set(-20, 14, 14); camera.lookAt(-28, 19, 0); }

const post = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
const sc = scenePass.getTextureNode('output');
post.outputNode = sc.add(bloom(sc, 0.35, 0.4, 0.95));

const clock = new THREE.Clock();
const tFix = params.has('t') ? parseFloat(params.get('t')) : null;
renderer.setAnimationLoop(() => {
  post.render();
  window.__frames = (window.__frames || 0) + 1;
  if (window.__frames === 3) window.__ready = true;
});
// in-frame canvas readback: WebGPU swap-chain textures are only valid inside the task that rendered them
// backend-agnostic readback: render the scene into a target and read it asynchronously (no bloom)
window.__grab = async () => {
  const w = renderer.domElement.width, h = renderer.domElement.height;
  const rt = new THREE.RenderTarget(w, h, { colorSpace: THREE.SRGBColorSpace });
  renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.setRenderTarget(null);
  const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const img = new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, w * h * 4), w, h);
  c.getContext('2d').putImageData(img, 0, 0);
  const flip = document.createElement('canvas'); flip.width = w; flip.height = h; const fx = flip.getContext('2d');
  if (!renderer.backend.isWebGPUBackend) { fx.translate(0, h); fx.scale(1, -1); }
  fx.drawImage(c, 0, 0); return flip.toDataURL('image/png');
};
window.__info = () => ({ backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2', tris: Math.round(tris) });
