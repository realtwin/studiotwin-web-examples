import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { makeSkyNode, makeWaterNode, makeMistNode, makeFirefliesNode, lilyMaterial, boatNodeMaterial } from './worldNodes.js';
import { uniform } from 'three/tsl';
import { MOON_DIR, FOG_TEAL } from './fog.js';
import { cx, dcx, halfWidth, terrainHeight, channelDist, fbm, rng, Z_START, Z_END } from './channel.js';

export const shared = { time: { value: 0 } };

// ---------------------------------------------------------------------------
// SKY — StudioTwin HDR panorama + re-drawn low moon + teal horizon band
// ---------------------------------------------------------------------------
export function makeSky(skyTex) { return makeSkyNode(skyTex, { intensity: 0.8, yaw: 2.35 }); }

// ---------------------------------------------------------------------------
// WATER — planar reflection + analytic ripples + moon glitter + boat lamp spill
// ---------------------------------------------------------------------------
export function makeWater(renderer, reflScale = 0.6, sky = null) {
  const water = makeWaterNode({ size: 4000, resolutionScale: reflScale, taps: reflScale < 0.5 ? 3 : 6, sky: sky ? { tex: sky.userData.tex, U: sky.userData.U } : null });
  water.position.set(0, 0, (Z_START + Z_END) / 2);
  water.resize = (w, h, k = 0.6) => { water.userData.refl.reflector.resolutionScale = k; };
  return water;
}

// ---------------------------------------------------------------------------
// TERRAIN — a mud ribbon hugging the channel (StudioTwin text-to-material mud)
// ---------------------------------------------------------------------------
export function makeTerrain(tex) {
  const stepZ = 2.5, span = 320, nx = 170;
  const nz = Math.ceil((Z_END - Z_START) / stepZ) + 1;
  const pos = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2);
  let k = 0;
  const cWet = new THREE.Color(0.10, 0.11, 0.09), cDry = new THREE.Color(0.20, 0.22, 0.15), cMoss = new THREE.Color(0.13, 0.20, 0.10);
  const tmp = new THREE.Color();
  for (let j = 0; j < nz; j++) {
    const z = Z_START + j * stepZ;
    const c = cx(z);
    for (let i = 0; i < nx; i++) {
      const u = i / (nx - 1);
      // denser columns near the channel edges
      const t = Math.sign(u - 0.5) * Math.pow(Math.abs(u - 0.5) * 2, 1.6);
      const x = c + t * span;
      let y = terrainHeight(x, z);
      if (y < 0.4) y -= 0.55 * (1 - THREE.MathUtils.smoothstep(y, -0.3, 0.4));   // clean shoreline, no waterline mud flats
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      uv[k * 2] = x / 7; uv[k * 2 + 1] = z / 7;
      const wet = THREE.MathUtils.smoothstep(y, -0.2, 0.6);
      tmp.copy(cWet).lerp(cDry, wet).lerp(cMoss, 0.6 * fbm(x * 0.08, z * 0.08) * wet);
      col[k * 3] = tmp.r; col[k * 3 + 1] = tmp.g; col[k * 3 + 2] = tmp.b;
      k++;
    }
  }
  const idx = [];
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // TSL mud: wet, dark and glossy at the waterline so the bank melts into the water instead of a hard seam;
  // detail normals fade with distance so grazing views don't sparkle
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0, envMapIntensity: 0.25 });   // 11.3: 0.55 -> 0.25, sky sheen on dry mud
  const T = TSL, U = T.uv(), wy = T.positionWorld.y;
  const dist = T.length(T.cameraPosition.sub(T.positionWorld));
  const wet = T.smoothstep(0.55, -0.05, wy);
  const alb = T.texture(tex.mud_albedo, U).rgb.mul(T.attribute('color', 'vec3')).mul(2.2);
  mat.colorNode = T.mix(alb, alb.mul(0.28), wet);
  // 11.3: the image-to-material roughness map comes back normalised low (mean 0.26, p5-p95 0.14-0.36), which made
  // dry banks read as wet plastic under the lamp. Remap its p5-p95 range onto a dry-mud range 0.62-0.92 (keeps the
  // texture's variation, drops the gloss); only the thin waterline band stays wet (0.3).
  const rMap = T.clamp(T.texture(tex.mud_rough, U).r.sub(0.14).div(0.22), 0, 1);
  // 11.3 render check: heron close-up still read wet-plastic; wet floor 0.3 -> 0.5, dry range lifted
  mat.roughnessNode = T.mix(T.mix(T.float(0.72), T.float(0.95), rMap), T.float(0.5), wet);
  // 11.3: plus a pixel-footprint fade (texel < ~0.5 px -> detail normal off), same as bark; ?nofoot reverts
  const foot = new URLSearchParams(location.search).has('nofoot') ? T.float(1) : T.smoothstep(4.0, 1.5, T.length(T.fwidth(U)).mul(1024));
  const nk = T.smoothstep(90, 12, dist).mul(T.float(1).sub(wet.mul(0.7))).mul(1.2).mul(foot.mul(0.8).add(0.2));
  mat.normalNode = T.normalMap(T.texture(tex.mud_normal, U), T.vec2(nk, nk));
  // 11.3 specular AA (threejs-procedural-materials skill, procedural-pbr-system.md): widen roughness by the screen-space
  // variance of the shading normal, so sub-pixel mud bumps can't flicker as glints at grazing angles. ?nospecaa reverts.
  if (!new URLSearchParams(location.search).has('nospecaa')) {
    const dn = T.max(T.dot(T.dFdx(T.normalView), T.dFdx(T.normalView)), T.dot(T.dFdy(T.normalView), T.dFdy(T.normalView)));
    const r0 = mat.roughnessNode;
    mat.roughnessNode = T.clamp(T.sqrt(r0.mul(r0).add(T.min(dn, 0.18))), 0, 1);
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  return mesh;
}

// ---------------------------------------------------------------------------
// VEGETATION — StudioTwin cypress (Tripo) instanced with distance LOD
// ---------------------------------------------------------------------------
export function scatterTrees(avoidPts) {
  const r = rng(86);
  const trees = [];
  const tryAdd = (x, z, s, inWater) => {
    for (const p of avoidPts) { const dx = p.x - x, dz = p.z - z, rr = p.r || 7.5; if (dx * dx + dz * dz < rr * rr) return; }
    for (const t of trees) { const dx = t.x - x, dz = t.z - z; if (dx * dx + dz * dz < (t.s + s) * (t.s + s) * 16) return; }
    trees.push({ x, z, s, y: Math.min(terrainHeight(x, z), 0.2) - (inWater ? 0.3 : 0.15), rot: r() * Math.PI * 2,
      sx: 0.52 + r() * 0.22, sy: 1.0 + r() * 0.5, inWater });
  };
  for (let z = Z_START + 20; z < Z_END - 20; z += 3.2) {
    const w = halfWidth(z), c = cx(z), n = 1 / Math.sqrt(1 + dcx(z) ** 2);
    for (const side of [-1, 1]) {
      // edge trees, some standing in the water
      if (r() < 0.55) { const off = w - 3 + r() * 9; tryAdd(c + side * off * n / n, z + (r() - 0.5) * 3, 0.9 + r() * 0.5, off < w + 1); }
      // bank forest
      if (r() < 0.8) { const off = w + 7 + r() * 34; tryAdd(c + side * off, z + (r() - 0.5) * 4, 0.9 + r() * 0.6, false); }
      if (r() < 0.45) { const off = w + 40 + r() * 90; tryAdd(c + side * off, z + (r() - 0.5) * 6, 1.0 + r() * 0.6, false); }
    }
  }
  return trees;
}

export class TreeField {
  constructor(nearGLTF, farGLTF, trees) {
    this.trees = trees;
    const grab = (g) => { let m; g.scene.traverse((o) => { if (o.isMesh && !m) m = o; }); return m; };
    const near = grab(nearGLTF), far = grab(farGLTF);
    const prep = (mat) => { mat.envMapIntensity = 0.35; mat.roughness = 1; if (mat.color) mat.color.setRGB(0.52, 0.55, 0.5); return mat; };
    this.near = new THREE.InstancedMesh(near.geometry, prep(near.material), trees.length);
    this.far = new THREE.InstancedMesh(far.geometry, prep(far.material.clone()), trees.length);
    for (const im of [this.near, this.far]) { im.frustumCulled = false; im.count = 0; }
    this.group = new THREE.Group();
    this.group.add(this.near, this.far);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._p = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this.lastPos = new THREE.Vector3(1e9, 0, 0);
    this.matrices = trees.map((t) => {
      this._q.setFromAxisAngle(this._up, t.rot);
      this._s.set(t.sx * t.s, t.sy * t.s, t.sx * t.s);
      this._p.set(t.x, t.y, t.z);
      return new THREE.Matrix4().compose(this._p, this._q, this._s);
    });
  }
  update(camPos, force) {
    if (!force && camPos.distanceToSquared(this.lastPos) < 16) return;
    this.lastPos.copy(camPos);
    let n = 0, f = 0;
    const R2 = this.R2 || 95 * 95, FAR2 = this.FAR2 || 520 * 520;
    for (let i = 0; i < this.trees.length; i++) {
      const t = this.trees[i];
      const dx = t.x - camPos.x, dz = t.z - camPos.z, d2 = dx * dx + dz * dz;
      if (d2 > FAR2) continue;
      if (d2 < R2) this.near.setMatrixAt(n++, this.matrices[i]);
      else this.far.setMatrixAt(f++, this.matrices[i]);
    }
    this.near.count = n; this.far.count = f;
    this.near.instanceMatrix.needsUpdate = true; this.far.instanceMatrix.needsUpdate = true;
  }
}

// Cypress knees + bank shrubs (cheap silhouettes that read in the fog)
export function makeUndergrowth(trees, tex, camPts = []) {
  // keep the story camera's sightlines clear: no shrub mound within 10 m of a camera/boat path point
  const clear = (x, z) => !camPts.some((c) => (c.x - x) ** 2 + (c.z - z) ** 2 < 100);
  const r = rng(21);
  const knees = [], shrubs = [];
  for (const t of trees) {
    if (Math.abs(t.x - cx(t.z)) > halfWidth(t.z) + 40) continue;
    const n = Math.floor(r() * 7);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = 2.5 + r() * 5 * t.s;
      const x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d;
      knees.push({ x, z, y: Math.min(terrainHeight(x, z), 0) - 0.1, h: 0.3 + r() * 0.9, w: 0.15 + r() * 0.2 });
    }
  }
  for (let z = Z_START + 10; z < Z_END - 10; z += 2.2) {
    for (const side of [-1, 1]) {
      if (r() < 0.6) {
        const off = halfWidth(z) + 2 + r() * 22, x = cx(z) + side * off, y = terrainHeight(x, z);
        if (y > -0.2 && clear(x, z)) shrubs.push({ x, z, y: y - 0.2, s: 0.8 + r() * 2.2, rot: r() * 6.28 });
      }
    }
  }
  const kneeMat = new THREE.MeshStandardMaterial({ map: tex.bark_albedo, normalMap: tex.bark_normal, roughness: 0.95, color: 0x8a7a6a, envMapIntensity: 0.5 });
  const kGeo = new THREE.ConeGeometry(1, 1, 7, 1, true); kGeo.translate(0, 0.5, 0);
  const kIm = new THREE.InstancedMesh(kGeo, kneeMat, knees.length);
  const shrubMat = new THREE.MeshStandardMaterial({ color: 0x1b2b1c, roughness: 1, flatShading: true, envMapIntensity: 0.6 });
  const sGeo = new THREE.IcosahedronGeometry(1, 1);
  { const p = sGeo.attributes.position; for (let i = 0; i < p.count; i++) { const f = 0.75 + 0.5 * Math.abs(Math.sin(p.getX(i) * 5 + p.getZ(i) * 3)); p.setXYZ(i, p.getX(i) * f, p.getY(i) * 0.6 * f, p.getZ(i) * f); } sGeo.computeVertexNormals(); }
  const sIm = new THREE.InstancedMesh(sGeo, shrubMat, shrubs.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  knees.forEach((k, i) => { q.identity(); s.set(k.w, k.h, k.w); p.set(k.x, k.y, k.z); kIm.setMatrixAt(i, m.compose(p, q, s)); });
  shrubs.forEach((k, i) => { q.setFromAxisAngle(up, k.rot); s.set(k.s * 1.4, k.s, k.s * 1.2); p.set(k.x, k.y, k.z); sIm.setMatrixAt(i, m.compose(p, q, s)); });
  kIm.name = 'knees'; sIm.name = 'shrubs';
  const g = new THREE.Group(); g.add(kIm, sIm); g.name = 'undergrowth';
  return g;
}

// Lily pads (StudioTwin lily material drives the colour variation) + a few blooms
export function makeLilies(tex, avoidPts) {
  const r = rng(33);
  const pads = [];
  const cluster = (x0, z0, n, rad) => {
    for (let i = 0; i < n; i++) {
      const a = r() * 6.28, d = Math.sqrt(r()) * rad;
      const x = x0 + Math.cos(a) * d, z = z0 + Math.sin(a) * d;
      if (terrainHeight(x, z) > -0.5) continue;
      pads.push({ x, z, s: 0.35 + r() * 0.55, rot: r() * 6.28, flower: r() < 0.05 });
    }
  };
  for (let z = Z_START + 30; z < Z_END - 30; z += 7) {
    const w = halfWidth(z), c = cx(z);
    for (const side of [-1, 1]) if (r() < 0.7) cluster(c + side * (w - 2 - r() * 6), z, 14 + Math.floor(r() * 24), 3 + r() * 5);
    if (w > 22 && r() < 0.5) cluster(c + (r() - 0.5) * w, z, 20, 5);
  }
  // keep the story camera's water path clean
  const kept = pads.filter((p) => !avoidPts.some((a) => (a.x - p.x) ** 2 + (a.z - p.z) ** 2 < 4));
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.absarc(0, 0, 1, 0.22, Math.PI * 2 - 0.02, false); shape.lineTo(0, 0);
  // 11.3 perf (?prof inventory: pads were 298k tris desktop): 18 -> 10 arc segments (36 -> 20 tris/pad); a 1 m pad
  // seen from >= 4 m shows no facets at 10. ?padseg=N overrides.
  const PADSEG = parseInt(new URLSearchParams(location.search).get('padseg') || '10', 10);
  const geo = new THREE.ShapeGeometry(shape, PADSEG); geo.rotateX(-Math.PI / 2);
  const mat = lilyMaterial(tex.lily_albedo, tex.lilypad);
  const im = new THREE.InstancedMesh(geo, mat, kept.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  kept.forEach((o, i) => { q.setFromAxisAngle(up, o.rot); s.setScalar(o.s); p.set(o.x, 0.04, o.z); im.setMatrixAt(i, m.compose(p, q, s)); });
  const flowers = kept.filter((o) => o.flower);
  const fGeo = new THREE.ConeGeometry(0.16, 0.18, 8, 1, true); fGeo.rotateX(Math.PI); fGeo.translate(0, 0.12, 0);
  const fMat = new THREE.MeshStandardMaterial({ color: 0xf2e8ee, emissive: 0x5a4452, emissiveIntensity: 0.6, roughness: 0.6, side: THREE.DoubleSide });
  const fIm = new THREE.InstancedMesh(fGeo, fMat, flowers.length);
  flowers.forEach((o, i) => { q.identity(); s.setScalar(1 + o.s); p.set(o.x + 0.2, 0.02, o.z + 0.1); fIm.setMatrixAt(i, m.compose(p, q, s)); });
  im.name = 'pads';
  const g = new THREE.Group(); g.add(im); g.name = 'lilies';
  g.userData.count = kept.length;
  return g;
}

// Low mist sheets drifting over the water (camera-facing, soft noise alpha)
export function makeMist(n = 90, sxK = 1, nTall = 0) {
  const r = rng(99);
  const list = [];
  for (let i = 0; i < n; i++) {
    const z = Z_START + 60 + r() * (Z_END - Z_START - 120);
    const x = cx(z) + (r() - 0.5) * halfWidth(z) * 2.4;
    list.push({ x, y: -0.6, z, sx: (30 + r() * 50) * sxK, sy: 3 + r() * 5 });
  }
  // 11.1: the key art's mist stands up between the trunks along the banks (tall, narrow veils), not only a
  // low flat carpet over the channel; own rng so the base layer's layout is unchanged (?mistall=N)
  const r2 = rng(314);
  for (let i = 0; i < nTall; i++) {
    const z = Z_START + 60 + r2() * (Z_END - Z_START - 120);
    const side = r2() < 0.5 ? -1 : 1;
    const x = cx(z) + side * halfWidth(z) * (0.85 + r2() * 0.7);
    list.push({ x, y: -0.4, z, sx: 10 + r2() * 16, sy: 8 + r2() * 7 });
  }
  return makeMistNode(list);
}

// Fireflies: additive points drifting over the banks
export function makeFireflies(n = 900) {
  const r = rng(5);
  const list = [];
  for (let i = 0; i < n; i++) {
    const z = Z_START + 40 + r() * (Z_END - Z_START - 80);
    const side = r() < 0.5 ? -1 : 1;
    const x = cx(z) + side * (halfWidth(z) * (0.4 + r() * 1.3));
    list.push({ x, y: 0.4 + Math.pow(r(), 1.8) * 4.5, z, seed: r() });
    // a third drift out low over the open water, where their reflections double them
    if (r() < 0.35) { const z2 = z + (r() - 0.5) * 20; list.push({ x: cx(z2) + (r() - 0.5) * halfWidth(z2) * 1.4, y: 0.35 + r() * 1.4, z: z2, seed: r() }); }
  }
  return makeFirefliesNode(list);
}

// ---------------------------------------------------------------------------
// BOAT — StudioTwin/Tripo hero mesh + practical lights + lit cabin windows
// ---------------------------------------------------------------------------
export function makeBoat(gltf) {
  const root = new THREE.Group();
  const winU = uniform(5);   // §3.2 deep-amber cabin glow (was 1)
  const model = gltf.scene;
  model.position.y = -0.52; // waterline
  model.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material; src.envMapIntensity = 1.35;
    o.material = boatNodeMaterial(src, winU);
  });
  root.add(model);
  // practicals
  const cabin = new THREE.PointLight(0xffa24a, 6, 14, 1.6); cabin.position.set(0, 1.8, 0.2); root.add(cabin);
  const stern = new THREE.PointLight(0xff8a3a, 1.5, 7, 1.8); stern.position.set(0, 0.9, -2.6); root.add(stern);
  const glowMat = (c, s) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(s), fog: false });
  const mast = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8), glowMat(0xfff4e8, 4)); mast.position.set(-0.02, 3.0 - 0.52, 0.43); root.add(mast);
  
  const bowL = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), glowMat(0x9affc8, 3)); bowL.position.set(0.55, 0.9, 2.2); root.add(bowL);
  const bowR = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), glowMat(0xff6a6a, 3)); bowR.position.set(-0.55, 0.9, 2.2); root.add(bowR);
  root.name = 'boat';
  root.userData.model = model; root.userData.win = winU;
  return root;
}

export function makeHeron(gltf) {
  const g = new THREE.Group();
  const m = gltf.scene;
  m.rotation.y = Math.PI; // model faces -Z → face +Z in its group
  m.traverse((o) => { if (o.isMesh) { o.material.envMapIntensity = 0.9; } });
  g.add(m);
  g.scale.setScalar(1.35);
  g.name = 'heron';
  return g;
}

export { cx, dcx, halfWidth, terrainHeight, channelDist };
