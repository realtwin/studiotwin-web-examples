import { smaa } from 'three/examples/jsm/tsl/display/SMAANode.js';
import { traa } from 'three/examples/jsm/tsl/display/TRAANode.js';
import './style.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { time as tslTime, pass, uniform, vec3, vec2, float, dot, mix, smoothstep, clamp, select, length, screenUV, fract, sin, mrt, output, velocity, max, min, screenSize } from 'three/tsl';
import { bloom as bloomNode } from 'three/addons/tsl/display/BloomNode.js';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { stillwaterFog, FOG } from './fogNode.js';
import Lenis from 'lenis';
import { MOON_DIR, FOG_TEAL, HAZE_MAUVE } from './fog.js';
import {
  shared, makeSky, makeWater, makeTerrain, scatterTrees, TreeField, makeUndergrowth,
  makeLilies, makeMist, makeFireflies, makeBoat, makeHeron,
} from './world.js';
import { cx, dcx, halfWidth, terrainHeight, Z_START, Z_END } from './channel.js';
import { SHOTS, storyPose, boatFrame, heronSpot, storyAvoidPoints, STORY_TUNE } from './story.js';
import { Mixer } from './audio.js';
import { ProcForest } from './forest.js';
import { Props, propAvoidPoints } from './props.js';
import { Birds } from './birds.js';
import LEDGER from './ledger.json';

const BASE = import.meta.env.BASE_URL;
const params = new URLSearchParams(location.search);
// it12 scroll-liveliness knobs (story.js STORY_TUNE; ?easelin=0.1&preroll=0 = 11.3 camera)
if (params.has('easelin')) STORY_TUNE.easeLin = +params.get('easelin');
if (params.has('preroll')) STORY_TUNE.preroll = +params.get('preroll');
const $ = (s) => document.querySelector(s);
const DEBUG = new URLSearchParams(location.search).has('debug');   // it12 prod: load-time console logs only with ?debug
if (params.has('noui')) document.body.classList.add('noui');
if (params.has('debug')) document.body.classList.add('debug');

// ---------------------------------------------------------------------------
// renderer / scene
// ---------------------------------------------------------------------------
const canvas = $('#gl');
// three/webgpu: WebGPU where available, WebGL2 backend otherwise (?webgl forces it)
const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance', forceWebGL: params.has('webgl') });
await renderer.init();
// graphics tiers: High is the default; Max stretches quality for strong desktops.
// Frame rate is capped (60 default; ?fps=120 max) so we never push the GPU flat out.
const IS_MOBILE = matchMedia('(hover: none) and (pointer: coarse)').matches || window.innerWidth < 760;
// mobile: fewer + lighter trees (grown-detail band pulled in, every other far tree dropped, fog hides the gap),
// fewer fish and birds, lower render scale; the scene reads the same at phone size.
const GFX_TIERS = {
  mobile: { dprCap: 1.5, reflScale: 0.45, bloomScale: 1.0, far: 300, near: 48, treeDensity: 0.55, fish: 4, birds: 0.5, label: 'Mobile' },
  high: { dprCap: 1.75, reflScale: 0.8, bloomScale: 1.0, far: 520, near: 95, treeDensity: 1, fish: 9, birds: 1, label: 'High' },
  max: { dprCap: 2.25, reflScale: 1.0, bloomScale: 1.0, far: 760, near: 150, treeDensity: 1, fish: 9, birds: 1, label: 'Max' },
};
let gfxName = params.get('gfx') in GFX_TIERS ? params.get('gfx') : IS_MOBILE ? 'mobile' : localStorage.getItem('sw-gfx') === 'max' ? 'max' : 'high';
let GFX = GFX_TIERS[gfxName];
const FPS_CAP = Math.min(120, Math.max(30, parseInt(params.get('fps') || '60', 10) || 60));
let DPR = Math.min(window.devicePixelRatio, params.has('shot') ? 1 : GFX.dprCap);
renderer.setPixelRatio(DPR);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// §2.3.4: the clear colour shows through at the far horizon and in gaps -> mauve haze, not teal
const HORIZON = HAZE_MAUVE.clone().multiplyScalar(0.45);   // ~old clear-colour luminance (0.06–0.19 teal)
renderer.setClearColor(HORIZON, 1);
scene.background = HORIZON;
FOG.density.value = 0.0105;
scene.fogNode = stillwaterFog();
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.3, 2500);

// moonlight + fill
const moon = new THREE.DirectionalLight(0xc9d4ff, 0.45);
moon.position.copy(MOON_DIR).multiplyScalar(100);
scene.add(moon, moon.target);
const hemi = new THREE.HemisphereLight(0x8a7a96, 0x0b1a16, 0.25);
scene.add(hemi);

// ---------------------------------------------------------------------------
// post (TSL): scene pass (4x MSAA) → sanitise → bloom → grade (split tone, vignette, lift) → ACES output
// ---------------------------------------------------------------------------
const post = new THREE.RenderPipeline(renderer);
// TRAA (default): jittered single-sample pass + velocity MRT, history resolves sub-pixel foliage/moss alpha.
// ?notaa falls back to 4x MSAA + alpha-to-coverage + SMAA.
const USE_TAA = params.has('taa');
const scenePass = pass(scene, camera, { samples: USE_TAA ? 0 : IS_MOBILE ? 2 : 4 });   // P2: mobile 2x pays for DPR 1.5
if (USE_TAA) scenePass.setMRT(mrt({ output, velocity }));
const GRADE = { vig: uniform(1.0), fade: uniform(0.0), bloom: uniform(params.has('nobloom') ? 0 : 1), vigCol: uniform(new THREE.Vector3(0.03, 0.04, 0.045)) };
// debug: ?vigcol=r,g,b (0–1) — the corner vignette colour sits over the framing canopy
if (params.has('vigcol')) GRADE.vigCol.value.set(...params.get('vigcol').split(/[|;]/).map(Number));
// debug: ?shadowt=r|g|b shadow split-tone multiplier, ?midt=r|g|b midtone (bell) multiplier
GRADE.shadowT = uniform(new THREE.Vector3(0.95, 0.97, 1.0));
GRADE.midT = uniform(new THREE.Vector3(1.02, 1.0, 1.01));
// 11.1 blacks: R sat 6–8 and B<G on 11/12 final grabs -> more red and blue in the lift (?lift=r|g|b)
// phone keeps the v11 lift: 0.009 red pushed phone t6.2 blacks 12/15/16 (OK) -> 17/17/16 (B<G)
// 11.1 (frozen-time grabs): phone 0.003/0/0.006 passes t7.9, 0.002/0/0.004 passes t6.2; split the difference
GRADE.lift = uniform(IS_MOBILE ? new THREE.Vector3(0.0025, 0.0, 0.005) : new THREE.Vector3(0.009, 0.005, 0.012));
if (params.has('lift')) GRADE.lift.value.set(...params.get('lift').split(/[|;]/).map(Number));
if (params.has('shadowt')) GRADE.shadowT.value.set(...params.get('shadowt').split(/[|;]/).map(Number));
if (params.has('midt')) GRADE.midT.value.set(...params.get('midt').split(/[|;]/).map(Number));
{
  const rawTex = scenePass.getTextureNode('output');
  const raw = (USE_TAA ? traa(rawTex, scenePass.getTextureNode('depth'), scenePass.getTextureNode('velocity'), camera) : rawTex).rgb;
  // kill NaN/Inf and clamp HDR spikes before the bloom blur can smear them
  const sum = dot(raw, vec3(1));
  const clean = select(sum.equal(sum).and(sum.lessThan(1e6)), clamp(raw, 0, 24), vec3(0));
  // §2.4.6 bloom: lower threshold (0.9 -> 0.75), radius 0.6, slightly warm, so practicals and the horizon
  // afterglow halate instead of only the moon
  const bl = bloomNode(clean, 0.6, 0.6, 0.75);
  let c = clean.add(bl.rgb.mul(vec3(1.05, 0.97, 0.95)).mul(GRADE.bloom));
  // it12 ?lens: 'creamy anamorphic' lens, our own TSL port of the KinoStreak idea (no maintained three.js/TSL package
  // exists, see docs/IT12_NOTEPAD.md). All in scene-linear HDR, before the grade (threejs-bloom: composite pre-tonemap).
  //  1. de-speckle: pixels much brighter than their soft neighbourhood (sub-pixel glints, grain) are pulled toward it
  //  2. anamorphic streak: HDR highlights above a threshold, blurred along x only (quarter res), cool-tinted
  //  3. oval halation: a wide, x-stretched soft glow of the highlights (the 'creamy' veil)
  // ?lens=1 on; knobs ?lstreak ?lthr ?lhal ?lspeck; ?lensdbg=1 streak only, 2 halation only, 3 despeckle mask.
  if (!params.has('nolens')) {   // it12: on by default (medium look), ?nolens off
    const LN = { streak: uniform(+(params.get('lstreak') || 1.8)), thr: uniform(+(params.get('lthr') || 0.6)),
      hal: uniform(+(params.get('lhal') || 0.9)), speck: uniform(+(params.get('lspeck') || 1)) };
    const lum = (x) => dot(x, vec3(0.2126, 0.7152, 0.0722));
    // v3 despeckle = isolated-pixel test: a pixel is grain only if it lies outside the min..max luminance range of ALL
    // 4 neighbours by a margin (edges/rings have a neighbour on their side, so they are kept), and it is not bright
    // (fireflies, lamps kept). Replaced by the neighbour mean, so nothing else is blurred.
    const tx = scenePass.getTextureNode('output');
    const px = vec2(1).div(screenSize);
    const nb = [vec2(1, 0), vec2(-1, 0), vec2(0, 1), vec2(0, -1)].map((o) => tx.sample(screenUV.add(o.mul(px))).rgb);
    const nl = nb.map(lum);
    const nMax = max(max(nl[0], nl[1]), max(nl[2], nl[3])), nMin = min(min(nl[0], nl[1]), min(nl[2], nl[3]));
    const nMean = nb[0].add(nb[1]).add(nb[2]).add(nb[3]).mul(0.25);
    const L0 = lum(clean);
    const out = max(L0.sub(nMax.mul(1.35).add(0.004)), nMin.mul(0.7).sub(0.004).sub(L0));
    const spike = smoothstep(0.0, 0.02, out).mul(smoothstep(0.6, 0.3, L0)).mul(LN.speck);
    const soft = nMean;
    // it12 v5: soft-knee the highlight feed (x/(1+x)) so emissive windows (HDR >> 1) can't drive the glow to clip
    const hiRaw = max(clean.sub(LN.thr), vec3(0));
    const hi = hiRaw.div(hiRaw.add(1.0));
    // v3 streak: x-only pyramid, each level with a small y blur (sigma ~1 texel) so stacked lines merge into one band
    let streak = vec3(0);
    [[0.5, 1.0], [0.25, 0.8], [0.125, 0.6], [0.0625, 0.45], [0.03125, 0.3]].forEach(([rs, w]) => {
      const hx = gaussianBlur(hi, vec2(1.0, 0.0), 8, { resolutionScale: rs });
      streak = streak.add(gaussianBlur(hx, vec2(0.0, 1.0), 1.5, { resolutionScale: rs }).rgb.mul(w));
    });
    streak = streak.mul(0.33).mul(vec3(0.7, 0.88, 1.3));
    // v3 halation: highlights only (no whole-frame veil), oval, two scales, higher sigma to kill the comb
    // v4: a direction > 1 spaced the taps past neighbouring texels (the comb). Unit taps only; the oval comes from an
    // extra x-only pass on the blurred result.
    const ov = (rs) => gaussianBlur(gaussianBlur(hi, vec2(1.0, 1.0), 10, { resolutionScale: rs }), vec2(1.0, 0.0), 8, { resolutionScale: rs }).rgb;
    const halo = ov(0.25).mul(0.6).add(ov(0.125).mul(0.4)).mul(vec3(1.06, 0.98, 0.95));
    const dbg = params.get('lensdbg');
    c = mix(c, soft.add(bl.rgb.mul(vec3(1.05, 0.97, 0.95)).mul(GRADE.bloom)), spike).add(streak.mul(LN.streak)).add(halo.mul(LN.hal));
    if (dbg === '1') c = streak.mul(LN.streak).mul(4);
    if (dbg === '2') c = halo.mul(LN.hal).mul(4);
    if (dbg === '3') c = vec3(spike);
    window.__lens = LN;
  }
  const l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // §2.4.1 split tone: shadows -> indigo, highlights -> warm cream (was shadows -> green-teal); mauve in the mids
  // shadow blue 1.12 -> 1.05: blacks ran 3–5 over #12 in blue on every grab while R/G sat in range
  c = c.mul(mix(GRADE.shadowT, vec3(1.08, 1.0, 0.94), smoothstep(0.02, 0.45, l)));
  const bell = smoothstep(0.02, 0.12, l).mul(smoothstep(0.55, 0.35, l));
  c = c.mul(mix(vec3(1), GRADE.midT, bell));
  // §2.4.4 vibrance: +15 % chroma in lit atmosphere (l 0.08–0.5), surfaces and blacks untouched
  const l2 = dot(c, vec3(0.2126, 0.7152, 0.0722));
  const vib = smoothstep(0.05, 0.12, l2).mul(smoothstep(0.65, 0.45, l2)).mul(0.15);
  c = mix(vec3(l2), c, vib.add(1));
  // §2.4.2 lift toward indigo, not green
  c = c.add(GRADE.lift);
  // §2.4.5 coloured vignette: corners fall to dark indigo (the key art's framing arch), not black
  const d = screenUV.sub(0.5).mul(vec2(1.25, 1));
  const v = smoothstep(0.95, 0.25, length(d));
  c = mix(GRADE.vigCol.mul(l2.add(0.2).min(1)), c, mix(float(1), v, GRADE.vig.mul(0.62)));
  c = c.mul(float(1).sub(GRADE.fade));
  // triangular screen dither (±1 LSB) so dark fog/water gradients don't quantise into horizontal steps on 8-bit displays
  const dn = fract(sin(dot(screenUV.mul(vec2(1920.7, 1080.3)), vec2(12.9898, 78.233))).mul(43758.5453));
  const dn2 = fract(sin(dot(screenUV.mul(vec2(1377.1, 911.9)), vec2(39.346, 11.135))).mul(24634.6345));
  c = c.add(dn.add(dn2).sub(1).mul(1 / 255));
  // SMAA on the graded frame: cleans foliage/moss alpha edges that 4x MSAA + alpha-to-coverage leave stepped
  if (USE_TAA) {
    // resolve AA on the linear HDR scene before bloom/grade so bloom sees a stable image
    post.outputNode = c.toVec4(1);
  } else {
    post.outputNode = params.has('nosmaa') ? c.toVec4(1) : smaa(c.toVec4(1));
  }
}
// headless capture: WebGPU swap-chain pixels are not readable after the frame, so render the full
// pipeline into a target and read it back (?shot + tools/shots.mjs call window.__grab)
window.__backend = () => (renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2');
window.__grab = async () => {
  const w = renderer.domElement.width, h = renderer.domElement.height;
  // the post chain already writes display-encoded (sRGB) values; an SRGBColorSpace target encoded them a second
  // time and lifted every dark pixel (bottom-10 % blacks 74/91/104 vs 10/17/21 in a browser screenshot of the same
  // frame). Default is now the plain target; ?grabsrgb / window.__grabSRGB keeps the old path for comparison.
  const rt = new THREE.RenderTarget(w, h, window.__grabSRGB ? { colorSpace: THREE.SRGBColorSpace } : {});
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt); post.render(); renderer.setRenderTarget(prev);
  let px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h);
  // WebGPU pads readback rows to 256 B (390 px x 4 B = 1560 B is not aligned): de-stride, or the frame comes back
  // as an interlaced striped gradient (§4 mobile grabs at 390x844)
  // three sizes the buffer as (h-1)*alignedRow + w*4, so derive the row stride from that, not byteLength/h
  const stride = h > 1 ? Math.round((px.byteLength - w * 4) / (h - 1)) : w * 4;
  if (stride !== w * 4) {
    const tight = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) tight.set(new Uint8ClampedArray(px.buffer, px.byteOffset + y * stride, w * 4), y * w * 4);
    px = tight;
  }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, w * h * 4), w, h), 0, 0);
  const f = document.createElement('canvas'); f.width = w; f.height = h; const fx = f.getContext('2d');
  if (!renderer.backend.isWebGPUBackend) { fx.translate(0, h); fx.scale(1, -1); }
  fx.drawImage(c, 0, 0); rt.dispose(); return f.toDataURL('image/jpeg', 0.92);
};

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------
const manager = new THREE.LoadingManager();
const loadbar = $('#loadbar'), loadpct = $('#loadpct');
// it12 loader: the bar used to be files-done / files-queued, so it hit 100 % when the last file landed while the
// world build, shader compile and first frame were still to come. Now staged: downloads 0-70, build 70-80,
// compile 80-97 (slow creep so it never sits still), first light 100. ?oldloader restores files-only.
const loadlabel = $('#loadlabel');
const LOAD = { p: 0, lo: 0, hi: 70, creep: 0 };
const setLoad = (p) => { LOAD.p = Math.max(LOAD.p, Math.min(100, p)); loadbar.style.width = LOAD.p.toFixed(1) + '%'; loadpct.textContent = Math.floor(LOAD.p) + '%'; };
const stage = (label, lo, hi) => {
  if (params.has('oldloader')) return;
  if (loadlabel) loadlabel.textContent = label;
  LOAD.lo = lo; LOAD.hi = hi; setLoad(lo);
  clearInterval(LOAD.creep);
  // asymptotic creep toward hi: keeps the bar moving during long compiles without ever claiming done
  LOAD.creep = setInterval(() => setLoad(LOAD.p + (LOAD.hi - 0.5 - LOAD.p) * 0.06), 120);
};
manager.onProgress = (url, a, b) => {
  if (params.has('oldloader')) { setLoad((a / b) * 100); return; }
  setLoad((a / b) * 70);
};
const draco = new DRACOLoader(manager).setDecoderPath(BASE + 'draco/');
const gltfL = new GLTFLoader(manager).setDRACOLoader(draco);
const texL = new THREE.TextureLoader(manager);
const hdrL = new HDRLoader(manager);

const loadTex = (name, srgb) => new Promise((res) => texL.load(BASE + 'tex/' + name + '.jpg', (t) => {
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  res(t);
}));

const [skyHDR, skyTex, boatG, heronG, cypNear, cypFar, snagG, tupeloG, ridgeG, duckG, propGs, ...texs] = await Promise.all([
  hdrL.loadAsync(BASE + 'env/sky.hdr'),
  // sky: text-to-environment-map 360° + ConceptLab edit for the upper sky, upscaled to 16K; shown at 8K desktop / 4K mobile
  texL.loadAsync(BASE + (gfxName === 'mobile' ? 'env/sky_4k.jpg' : 'env/sky_8k.jpg')),
  gltfL.loadAsync(BASE + 'models/boat.glb'),
  gltfL.loadAsync(BASE + 'models/heron_rig.glb'),
  gltfL.loadAsync(BASE + 'models/cypress_lo.glb'),
  gltfL.loadAsync(BASE + 'models/cypress_lo2.glb'),
  gltfL.loadAsync(BASE + 'models/snag.glb'),
  gltfL.loadAsync(BASE + 'models/tupelo.glb'),
  gltfL.loadAsync(BASE + 'models/ridge.glb'),
  gltfL.loadAsync(BASE + 'models/duck.glb'),
  Promise.all(['cabin', 'shack', 'sign', 'lantern', 'fish'].map((n) => gltfL.loadAsync(BASE + 'models/' + n + '.glb'))),
  loadTex('mud_albedo', true), loadTex('mud_normal'), loadTex('mud_rough'),
  loadTex('bark_albedo', true), loadTex('bark_normal'),
  loadTex('lily_albedo', true), loadTex('lilypad_albedo', true), loadTex('lilypad_normal'), loadTex('lilypad_rough'),
  loadTex('cbark_albedo', true), loadTex('cbark_normals'), loadTex('cbark_roughness'),
  ...['leaf_cypress', 'leaf_tupelo', params.has('oldmoss') ? 'moss' : 'moss_wet'].map((n) =>   // it12: wet slimy moss card (ConceptLab edit), ?oldmoss
   texL.loadAsync(BASE + 'tex/' + n + '.png').then((t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; })),
]);
stage('building the world', 70, 80);
const [mud_albedo, mud_normal, mud_rough, bark_albedo, bark_normal, lily_albedo, lp_alb, lp_nrm, lp_rgh, cb_alb, cb_nrm, cb_rgh, leafC, leafT, mossT] = texs;
// 11.3: lily pads use a per-pad PBR set mapped to the pad mesh UVs (UV guide -> img2img -> image-to-material), clamped
for (const x of [lp_alb, lp_nrm, lp_rgh]) { x.wrapS = x.wrapT = THREE.ClampToEdgeWrapping; x.needsUpdate = true; }
const TEX = { mud_albedo, mud_normal, mud_rough, bark_albedo, bark_normal, lily_albedo, lilypad: { albedo: lp_alb, normal: lp_nrm, rough: lp_rgh } };

// environment lighting from the StudioTwin panorama
skyHDR.mapping = THREE.EquirectangularReflectionMapping;
skyHDR.minFilter = THREE.LinearFilter; skyHDR.magFilter = THREE.LinearFilter; skyHDR.generateMipmaps = false;
scene.environment = skyHDR;   // node renderer prefilters (PMREM) on demand
scene.environmentIntensity = 0.42;
scene.environmentRotation.y = -2.35;

// sky dome: the 16K StudioTwin upscale, downsampled to 8K (desktop) / 4K (mobile) for display; the 2K HDR
// stays as the lighting environment
skyTex.colorSpace = THREE.SRGBColorSpace; skyTex.mapping = THREE.EquirectangularReflectionMapping;
skyTex.anisotropy = 8; skyTex.generateMipmaps = true; skyTex.minFilter = THREE.LinearMipmapLinearFilter;
const sky = makeSky(skyTex);
scene.add(sky);
// 11.1: the resize handler reset the reflector to GFX.reflScale, so ?refls was silently overridden after the first resize
const REFL_S = () => params.has('refls') ? parseFloat(params.get('refls')) : GFX.reflScale;
const water = makeWater(renderer, REFL_S(), sky);
scene.add(water);
scene.add(makeTerrain(TEX));

const heronPos = heronSpot();
// 11.2: the heron's close-up (t7.5) framed a lily pad under the bird that the rim light turned into a flat white
// disc; keep a ~2.8 m ring around the bird clear of pads (avoid radius is 2 m, so three points around it)
const avoid = storyAvoidPoints().concat(propAvoidPoints(), [[0, 0], [1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]].map(([dx, dz]) => ({ x: heronPos.x + dx, z: heronPos.z + dz })));
const trees = scatterTrees(avoid);
// constructed trees: grown in code from StudioTwin bark + scanned foliage/moss cards (see forest.js)
const treeField = new ProcForest(trees, { albedo: cb_alb, normal: cb_nrm, rough: cb_rgh, leafC, leafT, moss: mossT }, cypFar, avoid.filter((p) => p.r === undefined), [2.5, 3.5].map((T) => {
  const c = storyPose(T, 0, heronPos).camPos, d = MOON_DIR.clone().setY(0).normalize();
  return { o: c, d, len: 320, spread: 0.12 };
}));
if (DEBUG) console.info('[stillwater] forest pool', treeField.poolTris, 'tris grown in', treeField.growMs, 'ms');
scene.add(treeField.group);
scene.add(makeUndergrowth(trees, TEX, avoid.filter((p) => p.r === undefined)));
const lilies = makeLilies(TEX, avoid);
scene.add(lilies);
// P3/P4: overdraw budget by tier (mobile: half the mist sheets, 1.3x wider; 350 fireflies)
const nTall = params.has('mistall') ? parseInt(params.get('mistall')) : 0;   // 11.1: veils weren't visible as veils and took stripe ratio 1.15->1.35; off by default
// it12 final: the low mist sheets caused the flashing 'puffs' over the water (a phone test with ?hide=mist cleared
// them), so the layer is not built by default - no 90 transparent sheets, no shader compile, no overdraw. ?mist=1 restores.
const WANT_MIST = params.has('mist');
const mist = WANT_MIST ? (IS_MOBILE ? makeMist(45, 1.3, nTall) : makeMist(90, 1, nTall)) : new THREE.Group();
mist.name = 'mist'; if (WANT_MIST) scene.add(mist);
// Deterministic mist regression pairs can toggle only this layer without reloading (and advancing water/boat time).
if (params.has('shot')) window.__setMistVisible = (visible) => { mist.visible = Boolean(visible); };
const flies = makeFireflies(IS_MOBILE ? 350 : 900); scene.add(flies);

const boat = makeBoat(boatG);
scene.add(boat);
const heron = new THREE.Group();
heronG.scene.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; if (o.material) o.material.envMapIntensity = 0.9; } });
heron.add(heronG.scene); heron.scale.setScalar(1.35); heron.name = 'heron';
heron.position.copy(heronPos);
water.userData.U.heron.value.copy(heronPos);   // §3.4 leg rings + glitter calm
heron.rotation.y = heronPos.yaw;
scene.add(heron);
const heronMixer = new THREE.AnimationMixer(heronG.scene);
const clip = (n) => heronG.animations.find((a) => a.name === n) || heronG.animations[0];
const heronIdle = heronMixer.clipAction(clip('idle')); heronIdle.play();
const heronStrike = clip('strike') ? heronMixer.clipAction(clip('strike')) : null;
if (heronStrike) { heronStrike.setLoop(THREE.LoopOnce, 1); heronStrike.clampWhenFinished = false; }
let nextStrike = 9;
function strike() {
  if (!heronStrike || heronStrike.isRunning()) return;
  heronIdle.fadeOut(0.25); heronStrike.reset().fadeIn(0.25).play();
  setTimeout(() => { heronStrike.fadeOut(0.4); heronIdle.reset().fadeIn(0.4).play(); }, 3100);
}
{ // cool moon-side rim + faint warm fill so the heron separates from the trunks
  // §3.4: 90 blew the lily pad under the bird to a 60 %-clipped white disc on the phone frame (t7.5); 20 keeps the edge light
  const rim = new THREE.SpotLight(0xbfd2ff, 20, 18, 0.55, 0.5, 1.3);
  rim.position.copy(heronPos).add(new THREE.Vector3(0, 4.5, 0)).addScaledVector(boatFrame(heronPos.z).s, 3.5).addScaledVector(boatFrame(heronPos.z).f, 4);
  rim.target.position.copy(heronPos).setY(1.1); scene.add(rim, rim.target);
  if (params.has('norim')) rim.visible = false;
  if (params.has('rimk')) rim.intensity = parseFloat(params.get('rimk'));
  const fill = new THREE.PointLight(0xffb070, 1.2, 9, 1.6); fill.position.copy(heronPos).addScaledVector(boatFrame(heronPos.z).s, -3).setY(1.4); scene.add(fill);
}

// variety: StudioTwin snags + tupelos mixed into the bank forest, far ridges carry the skyline
function propInstances(gltf, list, tint) {
  let src; gltf.scene.traverse((o) => { if (o.isMesh && !src) src = o; });
  const mat = src.material; mat.envMapIntensity = 0.35; if (tint) mat.color.setRGB(...tint);
  const im = new THREE.InstancedMesh(src.geometry, mat, list.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  list.forEach((p, i) => { q.setFromAxisAngle(up, p.rot); im.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(p.s, p.s * (p.sy || 1), p.s))); });
  im.frustumCulled = false; return im;
}
{
  const rr = (() => { let a = 1234; return () => ((a = (a * 16807) % 2147483647) / 2147483647); })();
  const snags = [], tups = [];
  trees.forEach((t) => {
    const d = Math.abs(t.x - cx(t.z)) - halfWidth(t.z);
    if (d < 1.5 || d > 70) return;
    const roll = rr();
    if (roll < 0.05) snags.push({ x: t.x + 5, z: t.z + 3, y: Math.min(terrainHeight(t.x + 5, t.z + 3), 0) - 0.4, s: 0.9 + rr() * 0.5, rot: rr() * 6.28 });
    else if (roll < 0.12) tups.push({ x: t.x - 4, z: t.z - 3, y: Math.min(terrainHeight(t.x - 4, t.z - 3), 0) - 0.3, s: 0.7 + rr() * 0.5, rot: rr() * 6.28 });
  });
  const ok = (p) => !avoid.some((a) => (a.x - p.x) ** 2 + (a.z - p.z) ** 2 < 49);
  const ridges = [];
  for (let z = Z_START; z < Z_END + 200; z += 330) for (const side of [-1, 1]) {
    ridges.push({ x: cx(z) + side * (260 + rr() * 120), z: z + rr() * 120, y: -6, s: 1.1 + rr() * 0.6, sy: 0.9 + rr() * 0.6, rot: (side > 0 ? 0 : Math.PI) + (rr() - 0.5) * 0.5 });
  }
  { const rg = propInstances(ridgeG, ridges, [0.42, 0.44, 0.48]); rg.name = 'ridges'; scene.add(rg); }
  if (DEBUG) console.info('[stillwater] snags', snags.length, 'tupelos', tups.length, 'ridges', ridges.length);
}
// Captain Quack: bobbing in the open water just past where the helm is taken
const DUCK_Z = 925;
const duck = duckG.scene; duck.scale.setScalar(2.2);
duck.position.set(cx(DUCK_Z) + 3, 0, DUCK_Z);
duck.traverse((o) => { if (o.isMesh) { o.material.envMapIntensity = 1.2; if (o.material.emissive) { o.material.emissive.setRGB(0.25, 0.2, 0.02); } } });
duck.name = duck.name || 'duck'; scene.add(duck);
const duckLight = new THREE.PointLight(0xffe08a, 6, 14, 1.6); duckLight.position.set(duck.position.x, 3, DUCK_Z); scene.add(duckLight);
let eggFound = false;

if (DEBUG) console.info('[stillwater] trees', trees.length, 'lilies', lilies.userData.count);

// ---------------------------------------------------------------------------
// UI: ledger, rail, sound
// ---------------------------------------------------------------------------
$('#n-calls').textContent = LEDGER.generations;
$('#n-credits').textContent = LEDGER.credits.toLocaleString();
$('#n-usd').textContent = '$' + (LEDGER.usd ?? LEDGER.credits / 50).toFixed(2);
$('#n-iter').textContent = LEDGER.conceptIterations;

const chapters = [...document.querySelectorAll('.chapter')];
const panels = chapters.map((c) => c.querySelector('.panel'));
const rail = $('#rail');
chapters.forEach((c, i) => {
  const b = document.createElement('button'); b.title = c.querySelector('.kicker')?.textContent || '';
  b.onclick = () => lenis.scrollTo(c.offsetTop + c.offsetHeight * 0.45, { duration: 2.2 });
  rail.appendChild(b);
});
const railBtns = [...rail.children];

const mixer = new Mixer(BASE);
const [cabinG, shackG, signG, lanternG, fishG] = propGs;
const props = new Props({ cabin: cabinG, shack: shackG, sign: signG, lantern: lanternG, fish: fishG }, mixer);
scene.add(props.group);
const birds = new Birds(); scene.add(birds.group); window.__birds = birds; window.__cam = camera;
function applyTier() {
  props.setFishCount(GFX.fish); birds.setDensity(GFX.birds);
  treeField.density = GFX.treeDensity;
}
applyTier();
// debug layer toggles: ?hide=mist,under,terrain,lilies,trees,flies
// '|' is accepted too: tools/shots.mjs splits its t-list on ',' so a comma hide-list got cut after the first item
for (const h of (params.get('hide') || '').split(/[,|]/)) {
  const m = { mist, lilies, flies, trees: treeField.group, under: scene.children.find((o) => o.isGroup && o.children.length === 2 && o.children[0].isInstancedMesh && o !== lilies), terrain: scene.getObjectByName('terrain'), props: props.group, fish: props.fish.group, birds: birds.group, boat: boat, ridges: scene.children.find((o) => o.name === 'ridges') }[h];
  if (m) m.visible = false;
}
if (params.has('wdbg')) water.userData.U.dbg.value = parseFloat(params.get('wdbg')) || 1;
if (params.has('noglit')) water.userData.U.glitter.value = 0;
// debug: ?reflgain=0 isolates the water's mirror term, ?nofog the fog, for black-level bisection
if (params.has('reflgain')) water.userData.U.reflGain.value = parseFloat(params.get('reflgain'));
if (params.has('nofog')) FOG.density.value = 0;
if (WANT_MIST && params.has('mistsoft')) mist.material.userData.dbg.soft.value = parseFloat(params.get('mistsoft'));
if (WANT_MIST && params.has('mistdbg')) mist.material.userData.dbg.view.value = 1;
if (WANT_MIST && params.has('mistnoise')) mist.material.userData.dbg.noise.value = parseFloat(params.get('mistnoise'));
// debug: ?lampk= water lamp-streak gain, ?winw= boat window emissive gain
if (params.has('lampk')) water.userData.U.lampK.value = parseFloat(params.get('lampk'));
if (params.has('lampw')) water.userData.U.lampW.value = parseFloat(params.get('lampw'));
if (params.has('lampd')) water.userData.U.lampD.value = parseFloat(params.get('lampd'));
if (params.has('lampbar')) water.userData.U.lampBar.value = parseFloat(params.get('lampbar'));
if (params.has('lampl')) water.userData.U.lampL.value = parseFloat(params.get('lampl'));
if (params.has('lampbarf')) water.userData.U.lampBarF.value = parseFloat(params.get('lampbarf'));
if (params.has('biok')) water.userData.U.bioK.value = parseFloat(params.get('biok'));
if (params.has('boatrefl')) water.userData.U.boatRefl.value = parseFloat(params.get('boatrefl'));
// it12 final: 12 m hard-mirror radius by default (chosen on a phone test); ?boatreflr=N overrides
water.userData.U.boatReflR.value = params.has('boatreflr') ? parseFloat(params.get('boatreflr')) : 12;
if (params.has('winw')) boat.userData.win.value = parseFloat(params.get('winw'));
if (params.has('hazenear')) FOG.hazeNear.value = parseFloat(params.get('hazenear'));
if (params.has('hemisky')) hemi.color.set('#' + params.get('hemisky'));
// debug: the reflector's mirrored camera flips triangle winding, so a BackSide dome may be culled in the mirror
if (params.has('skyds')) { sky.material.side = THREE.DoubleSide; sky.material.needsUpdate = true; }
// debug: paint the dome flat magenta — if the mirror turns magenta the sky IS in the reflection (issue is sampling)
// debug: shrink the dome (radius 900 * k) — the reflector's oblique clip skews its far plane
if (params.has('skyr')) sky.scale.setScalar(parseFloat(params.get('skyr')) / 900);
if (params.has('skymag')) { sky.material.colorNode = vec3(1, 0, 1); sky.material.needsUpdate = true; }
if (params.has('reflgraz')) water.userData.U.reflGrazing.value = parseFloat(params.get('reflgraz'));
if (params.has('skyrefl')) water.userData.U.skyRefl.value = parseFloat(params.get('skyrefl'));
if (params.has('skybend')) water.userData.U.skyBend.value = parseFloat(params.get('skybend'));
if (params.has('skynear')) water.userData.U.skyNear.value = parseFloat(params.get('skynear'));
if (params.has('skyfar')) water.userData.U.skyFar.value = parseFloat(params.get('skyfar'));
if (params.has('skynearw')) water.userData.U.skyNearW.value = parseFloat(params.get('skynearw'));
for (const [q, k] of [['skyint', 'intensity'], ['skysat', 'sat'], ['moondisc', 'moonDisc'], ['moonhalo', 'moonHalo'], ['underm', 'underM']]) if (params.has(q)) sky.userData.U[k].value = parseFloat(params.get(q));
if (params.has('ripamp')) water.userData.U.ripAmp.value = parseFloat(params.get('ripamp'));
if (params.has('aapx')) water.userData.U.aaPx.value = parseFloat(params.get('aapx'));
if (params.has('reflv')) water.userData.U.reflV.value = parseFloat(params.get('reflv'));
if (params.has('sunglit')) water.userData.U.sunGlitter.value = parseFloat(params.get('sunglit'));

const soundBtn = $('#btn-sound');
async function toggleSound(force) {
  const v = force ?? !mixer.on;
  await mixer.setOn(v);
  soundBtn.classList.toggle('on', v);
  $('#story-sound').textContent = v ? 'Sound on — listen' : 'Turn the sound on';
}
soundBtn.onclick = () => toggleSound();
const unlockAudio = () => { mixer.unlock(); window.removeEventListener('pointerdown', unlockAudio, true); window.removeEventListener('touchend', unlockAudio, true); window.removeEventListener('keydown', unlockAudio, true); };
window.addEventListener('pointerdown', unlockAudio, true); window.addEventListener('touchend', unlockAudio, true); window.addEventListener('keydown', unlockAudio, true);
$('#story-sound').onclick = () => toggleSound(true);

// ---------------------------------------------------------------------------
// scroll
// ---------------------------------------------------------------------------
const lenis = new Lenis({ lerp: 0.075, wheelMultiplier: 0.9, smoothWheel: true });
let T = 0, Tvel = 0;
function computeT() {
  const y = window.scrollY, vh = window.innerHeight;
  let t = 0;
  for (let i = 0; i < chapters.length; i++) {
    // it12: the chapter's T used to reach i+1 at (height - 0.5 vh) and then clamp, so the last 50 vh of every chapter
    // scrolled with the camera frozen mid-move (tools/scroll_life.mjs: 32 % of the page dead). Now T spans the full
    // chapter height, so every scrolled pixel moves the story. ?oldscroll restores the clamped mapping.
    const c = chapters[i], top = c.offsetTop, h = c.offsetHeight - (params.has('oldscroll') ? vh * 0.5 : 0);
    if (y >= top) t = i + Math.min(1, (y - top) / h);
  }
  return Math.min(t, chapters.length - 0.001);
}
let heronCroaked = false, revealed = false;
function updatePanels() {
  const n = chapters.length;
  panels.forEach((p, i) => {
    const local = T - i;
    // it12 prod: panels far from T are fully hidden and already written; skip their style writes
    if ((local < -0.2 || local > 1.2) && p._o === 0) return;
    let o;
    if (i === 0) o = 1 - THREE.MathUtils.smoothstep(local, 0.35, 0.7);
    else if (i === n - 1) o = THREE.MathUtils.smoothstep(local, 0.12, 0.42);
    else o = THREE.MathUtils.smoothstep(local, 0.08, 0.3) * (1 - THREE.MathUtils.smoothstep(local, 0.72, 0.94));
    const os = o.toFixed(3); if (os === p._os) return; p._os = os; p._o = o < 0.01 ? 0 : o;
    p.style.opacity = os;
    p.style.transform = `translate3d(0, ${((1 - o) * (local < 0.5 ? 24 : -24)).toFixed(1)}px, 0)`;
    p.style.visibility = o < 0.01 ? 'hidden' : 'visible';
  });
  const cur = Math.min(n - 1, Math.floor(T));
  if (cur !== updatePanels.cur) { updatePanels.cur = cur; railBtns.forEach((b, i) => b.classList.toggle('on', i === cur)); }
  if (cur === 6 && !heronCroaked) { heronCroaked = true; setTimeout(() => mixer.oneShot('heron', 0.8), 500); }
  if (cur === n - 1 && !revealed) { revealed = true; mixer.oneShot('reveal', 0.7); }
}

// ---------------------------------------------------------------------------
// play mode
// ---------------------------------------------------------------------------
const play = { on: false, x: 0, z: 0, yaw: 0, speed: 0, steer: 0, thr: 0, blend: 0, lookYaw: 0, lookPitch: 0, dragging: false };
const keys = new Set();
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (!play.on) return;
  if (e.code === 'Escape') exitPlay();
  if (e.code === 'KeyP') document.body.classList.toggle('photo');
  if (e.code === 'KeyM') toggleSound();
  if (e.code === 'KeyG') setGfx(gfxName === 'max' ? 'high' : 'max');
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
let lastPtr = null;
canvas.addEventListener('pointerdown', (e) => { if (!play.on) return; play.dragging = true; lastPtr = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!play.dragging) return;
  play.lookYaw -= (e.clientX - lastPtr[0]) * 0.005; play.lookPitch = THREE.MathUtils.clamp(play.lookPitch + (e.clientY - lastPtr[1]) * 0.003, -0.25, 0.6);
  lastPtr = [e.clientX, e.clientY];
});
canvas.addEventListener('pointerup', () => { play.dragging = false; });
// touch stick
const stick = $('#stick'); const stickKnob = stick.querySelector('i'); let stickV = [0, 0];
stick.addEventListener('pointerdown', (e) => { stick.setPointerCapture(e.pointerId); moveStick(e); });
stick.addEventListener('pointermove', (e) => { if (e.buttons) moveStick(e); });
stick.addEventListener('pointerup', () => { stickV = [0, 0]; stickKnob.style.transform = ''; });
function moveStick(e) {
  const r = stick.getBoundingClientRect(); let x = (e.clientX - r.left) / r.width * 2 - 1, y = (e.clientY - r.top) / r.height * 2 - 1;
  const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
  stickV = [x, -y]; stickKnob.style.transform = `translate(${x * 37}px, ${-(-y) * 37}px)`;
}

function enterPlay() {
  const fr = boatFrame(boat.position.z);
  play.on = true; play.x = boat.position.x; play.z = boat.position.z; play.yaw = Math.atan2(fr.f.x, fr.f.z);
  play.speed = 1.2; play.blend = 0; play.lookYaw = 0; play.lookPitch = 0; play.startT = clock.elapsedTime; play.lastInput = 0;
  document.body.classList.add('playing');
  lenis.stop();
  toggleSound(true);
  toast('Take the helm · No. 86');
}
function exitPlay() {
  play.on = false; document.body.classList.remove('playing', 'photo');
  lenis.start(); mixer.motorOff();
  storyBlend = 0;
}
$('#btn-play').onclick = enterPlay;
function setGfx(n) {
  gfxName = n; GFX = GFX_TIERS[n]; if (!IS_MOBILE) localStorage.setItem('sw-gfx', n);
  DPR = Math.min(window.devicePixelRatio, GFX.dprCap); lowFrames = 0; resize(); applyTier();
  treeField.update(camera.position, true);
  $('#gfx-label').textContent = GFX.label; $('#btn-gfx').classList.toggle('max', n === 'max');
}
const GFX_CYCLE = IS_MOBILE ? { mobile: 'high', high: 'mobile', max: 'mobile' } : { high: 'max', max: 'high', mobile: 'high' };
$('#btn-gfx').onclick = () => setGfx(GFX_CYCLE[gfxName]);
window.addEventListener('keydown', (e) => { if (!play.on && e.code === 'KeyG' && e.target === document.body) setGfx(GFX_CYCLE[gfxName]); });
if (params.has('play')) setTimeout(enterPlay, 50);
if (params.has('egg')) setTimeout(() => { play.x = duck.position.x - 1.5; play.z = DUCK_Z - 6.5; play.yaw = Math.atan2(duck.position.x - play.x, duck.position.z - play.z); play.startT = -20; play.blend = 0.9; }, 400);
window.__dbg = () => ({ boat: boat.position.toArray().map((v) => +v.toFixed(1)), duck: duck.position.toArray().map((v) => +v.toFixed(1)), cam: camera.position.toArray().map((v) => +v.toFixed(1)), egg: eggFound, play: play.on });
document.querySelectorAll('[data-top]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); if (play.on) exitPlay(); lenis.scrollTo(0, { duration: 2.5 }); }));

const REGIONS = [
  { z0: -200, z1: 150, name: 'The Moon Pool', sub: 'Where the story begins.' },
  { z0: 150, z1: 330, name: 'Cypress Narrows', sub: 'Mind the knees.' },
  { z0: 330, z1: 560, name: 'Lantern Reach', sub: 'Fireflies keep the hours here.' },
  { z0: 560, z1: 740, name: 'Heron bend', sub: 'Leave a little room for the wild.' },
  { z0: 740, z1: 1000, name: 'The Deep Swamp', sub: 'The fog is thickest after dark.' },
  { z0: 1000, z1: 2000, name: 'Far Reach', sub: 'Nobody paddles this far. Almost.' },
];
let curRegion = null, toastTimer = 0;
function toast(msg) {
  $('#toast-text').textContent = msg; $('#toast').classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3600);
}

// compass ticks
{
  const strip = document.createElement('div');
  for (let d = -360; d <= 720; d += 5) {
    const s = document.createElement('span'); const dd = ((d % 360) + 360) % 360;
    if (dd % 45 === 0) { s.className = 'maj'; const lab = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }[dd]; s.innerHTML = `<b>${lab}</b>`; }
    strip.appendChild(s);
  }
  $('#ticks').appendChild(strip);
}

function stepPlay(dt, t) {
  const up = keys.has('KeyW') || keys.has('ArrowUp'), dn = keys.has('KeyS') || keys.has('ArrowDown');
  const lf = keys.has('KeyA') || keys.has('ArrowLeft'), rt = keys.has('KeyD') || keys.has('ArrowRight');
  const thrIn = (up ? 1 : 0) - (dn ? 1 : 0) + stickV[1];
  const steerIn = (lf ? 1 : 0) - (rt ? 1 : 0) - stickV[0];
  play.thr += (THREE.MathUtils.clamp(thrIn, -1, 1) - play.thr) * Math.min(1, dt * 3);
  play.steer += (THREE.MathUtils.clamp(steerIn, -1, 1) - play.steer) * Math.min(1, dt * 4);
  play.speed += play.thr * (play.thr > 0 ? 3.2 : 4.0) * dt;
  play.speed *= Math.exp(-0.45 * dt);
  play.speed = THREE.MathUtils.clamp(play.speed, -2.5, 8.5);
  const turn = play.steer * 0.75 * THREE.MathUtils.clamp(Math.abs(play.speed) / 2.5, 0.3, 1) * Math.sign(play.speed || 1);
  play.yaw += turn * dt;
  const fx = Math.sin(play.yaw), fz = Math.cos(play.yaw);
  let nx = play.x + fx * play.speed * dt, nz = play.z + fz * play.speed * dt;
  // collisions: sample hull points against banks
  const probes = [[0, 2.7], [0.9, 1.6], [-0.9, 1.6], [0.95, -1.8], [-0.95, -1.8], [0, -2.7]];
  let hit = false;
  for (const [sx, sz] of probes) {
    const px = nx + fz * sx + fx * sz, pz = nz - fx * sx + fz * sz;
    if (terrainHeight(px, pz) > -0.5) { hit = true; break; }
  }
  if (!hit) {
    for (const tr of treeField.trees) {
      const dx = tr.x - nx, dz = tr.z - nz; if (Math.abs(dx) > 6 || Math.abs(dz) > 6) continue;
      const r = 1.2 * tr.s + 1.4; if (dx * dx + dz * dz < r * r) { hit = true; break; }
    }
  }
  if (hit) {
    // slide back toward the channel centreline
    const c = cx(nz); play.x += (c - play.x) * 0.02; play.speed *= -0.35;
  } else { play.x = nx; play.z = nz; }
  play.z = THREE.MathUtils.clamp(play.z, Z_START + 70, Z_END - 70);
  // boat transform
  boat.position.set(play.x, Math.sin(t * 1.3) * 0.035, play.z);
  boat.rotation.set(-play.thr * 0.025 + Math.sin(t * 1.1) * 0.012, play.yaw, -play.steer * play.speed * 0.012 + Math.sin(t * 0.9) * 0.015, 'YXZ');
  // chase camera with drag-to-look
  if (!play.dragging) { play.lookYaw *= Math.exp(-1.2 * dt); play.lookPitch += (0.12 - play.lookPitch) * Math.min(1, dt * 1.2); }
  const cy = play.yaw + Math.PI + play.lookYaw;
  const dist = 8.6 + play.speed * 0.3, h = 2.7 + play.lookPitch * 8;
  const want = new THREE.Vector3(play.x + Math.sin(cy) * dist, h, play.z + Math.cos(cy) * dist);
  want.y = Math.max(want.y, Math.max(terrainHeight(want.x, want.z), 0) + 0.8);
  const look = new THREE.Vector3(play.x + fx * 6, 2.3, play.z + fz * 6);
  play.blend = Math.min(1, play.blend + dt / 2.2);
  const k = 1 - Math.exp(-3.2 * dt);
  const b = THREE.MathUtils.smoothstep(play.blend, 0, 1);
  chase.pos.lerp(want, play.blend >= 1 ? k : 1);
  chase.look.lerp(look, play.blend >= 1 ? k : 1);
  camera.position.lerpVectors(storyCam.pos, chase.pos, b);
  tmpLook.lerpVectors(storyCam.look, chase.look, b);
  camera.lookAt(tmpLook);
  camera.fov += ((1 - b) * storyCam.fov + b * 55 - camera.fov) * 0.2; camera.updateProjectionMatrix();
  // HUD
  const kn = Math.abs(play.speed) * 1.944;
  $('#kn').textContent = kn.toFixed(1);
  $('#mode').textContent = Math.abs(play.thr) > 0.1 ? (play.thr > 0 ? 'Under way' : 'Astern') : (kn < 0.3 ? 'Holding' : 'Drifting');
  $('#mode-dot').classList.toggle('go', Math.abs(play.thr) > 0.1);
  $('#thr').style.width = (Math.min(1, Math.abs(play.speed) / 8.5) * 100).toFixed(1) + '%';
  if (Math.abs(play.thr) > 0.1 || Math.abs(play.steer) > 0.1) play.lastInput = t;
  document.body.classList.toggle('keys-faded', t - (play.startT || 0) > 9 && t - (play.lastInput || 0) < 6);
  const reg = REGIONS.find((r) => play.z >= r.z0 && play.z < r.z1);
  if (reg && reg !== curRegion) {
    curRegion = reg; $('#loc-title').textContent = reg.name; $('#loc-sub').textContent = reg.sub; toast('Discovered · ' + reg.name);
  }
  if (boat.position.distanceTo(heron.position) < 22 && !play.heronNear) { play.heronNear = true; mixer.oneShot('heron', 0.9); strike(); }
  if (!eggFound && t - (play.startT || 0) > 12 && !play.eggHinted) { play.eggHinted = true; toast('Something yellow is bobbing ahead…'); }
  if (!eggFound && Math.hypot(boat.position.x - duck.position.x, boat.position.z - duck.position.z) < 7) {
    eggFound = true; mixer.oneShot('squeak', 1.0); mixer.oneShot('reveal', 0.5);
    $('#egg').classList.add('show'); setTimeout(() => $('#egg').classList.remove('show'), 9000);
    duck.userData.spin = 1;
  }
  if (boat.position.distanceTo(heron.position) > 40) play.heronNear = false;
  if (mixer.on) mixer.motor(play.thr, Math.abs(play.speed));
  return { speed: Math.abs(play.speed), fwd: [fx, fz] };
}

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
const storyCam = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 42 };
const chase = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
const tmpLook = new THREE.Vector3();
let storyBlend = 1;
let fpsAcc = 0, fpsN = 0, fpsT = 0, lowFrames = 0, dprSteps = 0;
const fixedT = params.has('t') ? parseFloat(params.get('t')) : null;
// 11.1: shot mode freezes shader time too; wall-clock `time` made repeat grabs of one pose differ by up to 16/255
// in the lower frame (fireflies, lamp bars, ripples), which swamped every blacks A/B. ?st= picks the frozen time.
// ?live keeps TSL time running in shot mode (flicker probes of animated layers: mist, water, fish)
if (fixedT !== null && !params.has('live')) { const st = params.has('st') ? parseFloat(params.get('st')) : 12.0; tslTime.onRenderUpdate(() => st); }

// 11.3: ?prof keeps an EMA + max of CPU ms per subsystem and the renderer's draw/tri counts in
// window.__prof, so the shot harness can log them with each grab. No cost without the flag.
const PROF = (() => {
  if (!params.has('prof')) return { begin() {}, mark() {}, end() {} };
  const s = {}; let t0 = 0; window.__prof = s;
  return {
    begin() { t0 = performance.now(); },
    mark(k) { const n = performance.now(), d = n - t0; t0 = n; const o = s[k] || (s[k] = { ema: d, max: 0 }); o.ema = o.ema * 0.95 + d * 0.05; o.max = Math.max(o.max * 0.999, d); },
    end() {
      const i = renderer.info.render; s.info = { calls: i.drawCalls ?? i.calls, tris: i.triangles };
      // 11.3 (threejs-visual-validation: record triangles/instances per system): static triangle inventory by
      // top-level object name, visible meshes only, instanced count applied
      if (!s.inv) {
        const inv = {};
        scene.traverseVisible((o) => {
          if (!o.isMesh && !o.isPoints) return;
          const g = o.geometry; if (!g) return;
          const tri = (g.index ? g.index.count : (g.attributes.position?.count || 0)) / 3;
          const n = o.isInstancedMesh ? o.count : (g.isInstancedBufferGeometry ? g.instanceCount : 1);
          let top = o; while (top.parent && top.parent !== scene) top = top.parent;
          const k = (top.name || top.type) + (o.name && o.name !== top.name ? '/' + o.name : '');
          inv[k] = (inv[k] || 0) + Math.round(tri * n);
        });
        s.inv = Object.fromEntries(Object.entries(inv).sort((a, b) => b[1] - a[1]).slice(0, 14));
      }
    },
  };
})();
let lastFrameMs = 0;
// it12 prod: URL params are fixed for the page's life; resolve them once instead of on every frame
const P_EXPDAMP = params.has('expdamp'), P_NOPOST = params.has('nopost'), P_SHOT = params.has('shot');
const P_HERONAIM = params.has('heronaim') ? parseFloat(params.get('heronaim')) : undefined;
const P_AT = params.has('at') ? params.get('at').split(',').map(Number) : null;
const P_BIRDCAM = params.get('birdcam');
// it12 prod: HUD/DOM writes only when the value changes (each write forced style work every frame)
const HUD = { hdg: '', tick: '', clock: '', solo: null, fps: '' };
// ?fps: fixed corner widget (fps, frame ms, render scale, draw calls), updated twice a second; nothing built without it
const FPSW = params.has('fps') ? Object.assign(document.createElement('div'), { id: 'fpsw' }) : null;
if (FPSW) { FPSW.style.cssText = 'position:fixed;top:8px;left:8px;z-index:9999;pointer-events:none;font:11px/1.35 ui-monospace,Menlo,monospace;color:#cfe;background:rgba(0,0,0,.55);padding:5px 8px;border-radius:6px;white-space:pre'; FPSW.textContent = '— fps'; document.body.appendChild(FPSW); }
const hdgEl = $('#hdg'), ticksEl = $('#ticks').firstChild, clockEl = $('#clock'), fpsEl = $('#fps');
const MIN_FRAME_MS = (1000 / FPS_CAP) * 0.75;   // only thins >1.3x-refresh displays; never drops frames at 60 Hz
function frame(nowMs) {
  requestAnimationFrame(frame);
  // 11.3 perf: nothing to show in a background tab (rAF is throttled there, but each tick still ran a full frame)
  if (document.hidden) { clock.getDelta(); return; }
  if (nowMs !== undefined && nowMs - lastFrameMs < MIN_FRAME_MS) return;   // frame-rate cap
  lastFrameMs = nowMs ?? performance.now();
  PROF.begin();
  const dt = Math.min(clock.getDelta(), 1 / 20);
  const t = clock.elapsedTime;
  shared.time.value = t;
  lenis.raf(t * 1000);
  if (!play.on) {
    if (fixedT !== null) T = fixedT;
    else if (P_EXPDAMP) { const tgt = computeT(); const k = 1 - Math.exp(-dt * 6); T += (tgt - T) * k; if (Math.abs(tgt - T) < 1e-4) T = tgt; }
    else {
      // 11.3: critically damped SmoothDamp, position AND velocity
      // continuous. The old exp damp was C0 only: every wheel tick re-targeted it with a velocity kink, which reads
      // as judder on the camera. smoothTime 0.28 s ~ the old k=6 settle. ?expdamp reverts. NaN -> snap to target.
      const tgt = computeT();
      const x = (2 / 0.28) * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
      const ch = T - tgt, tmp = (Tvel + (2 / 0.28) * ch) * dt;
      Tvel = (Tvel - (2 / 0.28) * tmp) * e;
      T = tgt + (ch + tmp) * e;
      if ((tgt - T) * ch < 0 || Math.abs(tgt - T) < 1e-5) { T = tgt; Tvel = 0; }   // no overshoot
      if (!Number.isFinite(T) || !Number.isFinite(Tvel)) { T = tgt; Tvel = 0; }
    }
  }
  updatePanels();

  // story pose is always computed (it is the play-mode blend origin)
  const sp = storyPose(T, fixedT !== null ? 0 : t, heronPos, { aspect: VW / VH, mobile: window.innerWidth <= 820, heronAim: P_HERONAIM });
  storyCam.pos.copy(sp.camPos); storyCam.look.copy(sp.lookAt); storyCam.fov = sp.fov;
  let wake;
  if (play.on) {
    camera.filmOffset *= Math.exp(-4 * dt);
    wake = stepPlay(dt, t);
  } else {
    const fr = boatFrame(sp.bz);
    boat.position.set(fr.pos.x, Math.sin(t * 1.3) * 0.035, fr.pos.z);
    boat.rotation.set(Math.sin(t * 1.1) * 0.012, Math.atan2(fr.f.x, fr.f.z), Math.sin(t * 0.9) * 0.015, 'YXZ');
    // (mobile heron-shot tilt now lives in storyPose so the subject guard sees the final framing)
    camera.position.copy(sp.camPos); camera.lookAt(sp.lookAt);
    camera.fov = sp.fov;
    const vw = VW, vh = VH;
    // lens shift as film offset, NOT setViewOffset: TRAA re-sets the view offset every frame for its sub-pixel
    // jitter (dropping ours) while its velocity pass kept the shifted matrix -> history misaligned -> tremor.
    // filmOffset lives inside updateProjectionMatrix, so jitter, velocity and reflection all agree.
    camera.clearViewOffset();
    const shift = vw > 820 ? sp.shift : 0;
    // setViewOffset shifted the frustum by -shift*width; the equivalent film offset (mm on the film back):
    camera.aspect = vw / vh;
    camera.filmOffset = -shift * 2 * Math.tan(THREE.MathUtils.degToRad(sp.fov) / 2) * camera.aspect * camera.getFilmWidth();
    if (P_AT) { const v = P_AT; camera.position.set(v[0], v[1], v[2]); camera.lookAt(v[3], v[4], v[5]); camera.filmOffset = 0; }
    camera.updateProjectionMatrix();
    chase.pos.copy(sp.camPos); chase.look.copy(sp.lookAt);
    wake = { speed: 1.4, fwd: [fr.f.x, fr.f.z] };
  }
  PROF.mark('camera');
  const wu = water.userData.U;
  wu.boat.value.copy(boat.position); wu.boatFwd.value.set(wake.fwd[0], wake.fwd[1]); wu.speed.value = Math.min(1, wake.speed / 6);
  heronMixer.update(fixedT !== null ? 0 : dt);
  _bf.set(wake.fwd[0], 0, wake.fwd[1]).normalize();
  props.update(t, dt, boat.position, _bf, camera.position, mixer.on);
  camera.getWorldDirection(_cd); birds.update(t, dt, camera.position, _cd);
  if (P_BIRDCAM !== null) {   // debug: frame a bird (?birdcam=side|wader)
    const bc = P_BIRDCAM, ps = birds.pose(bc === 'wader' ? 'wader' : 'swift', 0); const bp = ps.p, fw = ps.f;
    { const k = bc === 'wader' ? 6 : 2.2; camera.position.copy(bp).add(new THREE.Vector3(fw.z * k * 0.6 - fw.x * k * 0.5, -k, -fw.x * k * 0.6 - fw.z * k * 0.5)); } camera.lookAt(bp); camera.filmOffset = 0; camera.updateProjectionMatrix();
  }
  if (!play.on && fixedT === null && T > 6.4 && T < 8.6 && t > nextStrike) { strike(); nextStrike = t + 11; }
  duck.position.y = 0.05 + Math.sin(t * 1.7) * 0.06;
  duck.rotation.set(Math.sin(t * 1.3) * 0.08, t * 0.25 + (duck.userData.spin ? (duck.userData.spin += dt * 4) : 0), Math.sin(t * 1.1) * 0.06);
  { const so = !play.on && T > 7.1 && T < 7.95; if (so !== HUD.solo) { HUD.solo = so; document.body.classList.toggle('solo-on', so); } }
  treeField.R2 = GFX.near * GFX.near * 1.6; treeField.NEAR2 = (GFX.near * 0.6) ** 2; treeField.FAR2 = GFX.far * GFX.far;
  PROF.mark('sim');
  treeField.update(camera.position);
  PROF.mark('forest');
  // HUD compass + clock
  camera.getWorldDirection(_cd);
  const hdg = (THREE.MathUtils.radToDeg(Math.atan2(_cd.x, _cd.z)) + 360 + 351 - 0) % 360;
  const hs = Math.round(hdg) + '°'; if (hs !== HUD.hdg) { HUD.hdg = hs; hdgEl.textContent = hs; }
  const tk = `translateX(${(120 - (hdg + 360) / 5 * 12).toFixed(0)}px)`; if (tk !== HUD.tick) { HUD.tick = tk; ticksEl.style.transform = tk; }
  const mins = 19 * 60 + 26 + Math.floor(t / 20);
  const cs = `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`; if (cs !== HUD.clock) { HUD.clock = cs; clockEl.textContent = cs; }

  if (P_NOPOST) renderer.render(scene, camera); else post.render();
  PROF.mark('render'); PROF.end();

  // fps + adaptive resolution
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) {
    const fps = fpsN / fpsAcc; { const fs = Math.round(fps) + ' FPS'; if (fs !== HUD.fps) { HUD.fps = fs; fpsEl.textContent = fs; } }
    if (FPSW) { const ri = renderer.info.render; FPSW.textContent = `${fps.toFixed(0)} fps  ${(1000 / fps).toFixed(1)} ms\nscale ${DPR.toFixed(2)}  calls ${ri.drawCalls ?? ri.calls ?? '—'}`; } fpsAcc = 0; fpsN = 0;
    if (fps < 38 && DPR > (IS_MOBILE ? 1.0 : 0.75) && !P_SHOT && dprSteps < 2) { lowFrames++; if (lowFrames > 8) { dprSteps++; DPR = Math.max(IS_MOBILE ? 1.0 : 0.75, DPR - 0.25); resize(); lowFrames = 0; } } else lowFrames = 0;
  }
}

const _bf = new THREE.Vector3(), _cd = new THREE.Vector3();
// §5.1: size from the *visual* viewport. On phones the layout viewport can be wider than the screen (any element
// past the right edge widens it), and iOS changes the visual height when the URL bar collapses. Pinch-zoom shrinks the
// visual viewport, so fall back to innerWidth/Height while scale != 1.
function viewSize() {
  const vv = window.visualViewport;
  if (vv && Math.abs(vv.scale - 1) < 1e-3) return [Math.round(vv.width), Math.round(vv.height)];
  return [window.innerWidth, window.innerHeight];
}
let VW = window.innerWidth, VH = window.innerHeight;
function resize() {
  [VW, VH] = viewSize();
  const w = VW, h = VH;
  renderer.setPixelRatio(DPR);
  renderer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  water.resize(w, h, REFL_S());
}
window.addEventListener('resize', resize);
window.visualViewport?.addEventListener('resize', resize);
resize();

// warm up: compile everything before revealing
stage('compiling shaders', 80, 95);
await new Promise((r) => requestAnimationFrame(() => r()));
treeField.update(new THREE.Vector3(cx(30), 0, 30), true);
// 11.3: compileAsync only sees *visible* objects, so anything hidden at load
// (empty tree buckets, the wader flock between passes, mid-story meshes) compiled on first sight = a hitch mid-scroll.
// Temporarily show every hidden object (except ?hide debug layers) for the compile, then restore. ?nowarm reverts.
if (!params.has('nowarm')) {
  const hidden = []; const dbgHidden = new Set((params.get('hide') || '').split(/[,|]/).filter(Boolean));
  treeField.warm = true; treeField.update(new THREE.Vector3(cx(30), 0, 30), true);
  scene.traverse((o) => { if (!o.visible && !(o.name && dbgHidden.has(o.name))) { hidden.push(o); o.visible = true; } });
  const tw = performance.now();
  // it12: compileAsync(scene) only resolves microtasks, so timers and the progress bar starved for the whole
  // compile (headless: 99 s of main-thread block with the bar stuck). Compile per top-level child and yield a
  // macrotask between them so the bar reports real progress. ?onecompile restores the single call.
  if (params.has('onecompile')) await renderer.compileAsync(scene, camera);
  else {
    const kids = scene.children.slice();
    for (let i = 0; i < kids.length; i++) {
      await renderer.compileAsync(kids[i], camera, scene);
      setLoad(80 + 15 * (i + 1) / kids.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (loadlabel && !params.has('oldloader')) loadlabel.textContent = 'reflections · post';
  await new Promise((r) => setTimeout(r, 0));
  post.render();   // post-pass + reflection pipelines too (render-target formats differ from the canvas)
  hidden.forEach((o) => { o.visible = false; });
  treeField.warm = false; treeField.update(new THREE.Vector3(cx(30), 0, 30), true);
  if (DEBUG) console.log('[warm] compiled incl.', treeField.buckets.filter((b) => b.n === 0).length, 'empty tree buckets +', hidden.length, 'other hidden objects + post pass in', Math.round(performance.now() - tw), 'ms');
} else await renderer.compileAsync(scene, camera);
stage('first light', 97, 100);
requestAnimationFrame(frame);
setTimeout(() => {
  clearInterval(LOAD.creep); setLoad(100);
  $('#loader').classList.add('done'); document.body.classList.remove('loading');
  $('#gfx-label').textContent = GFX.label; $('#btn-gfx').classList.toggle('max', gfxName === 'max');
  window.__ready = true;
}, 350);
