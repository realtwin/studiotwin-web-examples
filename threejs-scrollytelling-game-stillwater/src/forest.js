// Procedural forest: a pool of grown tree variants (trees.js), instanced per variant and distance band.
//   near  (< NEAR m)  full-detail grown trees, wind-driven sprays + cloth-like moss
//   mid   (< MID m)   reduced grown trees (fewer rings/cards, same silhouette family)
//   far   (< FAR m)   the SAME grown tree at lod 2 (same skeleton, decimated tubes, a few big soft cards)
// Every band of one variant is literally the same tree (lod only decimates), so band swaps never change
// the silhouette; the far band's soft alpha + fog makes distant canopy read as a soft, painterly mass.
// Every part of one variant+band (bark, leaves, moss) shares a single instance-matrix buffer.
import * as THREE from 'three';
import { growTree, barkMaterial, leafMaterial, mossMaterial, rng } from './trees.js';
import { cx, halfWidth } from './channel.js';

const MIX = [['cypress', 0.7], ['tupelo', 0.18], ['snag', 0.12]];
const NOCULL = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nocull');
const VARIANTS = { cypress: 6, tupelo: 3, snag: 3 };

export class ProcForest {
  constructor(trees, tex, _unused, camPts = [], corridors = []) {
    this.trees = trees;
    this.group = new THREE.Group(); this.group.name = 'trees';
    const bark = barkMaterial({ albedo: tex.albedo, normal: tex.normal, rough: tex.rough });
    const leaf = { cypress: leafMaterial(tex.leafC, 0x86a868, 0x9fae6a), tupelo: leafMaterial(tex.leafT, 0x7d9870, 0x96a870) };
    const moss = mossMaterial(tex.moss);
    const r = rng(4242);
    // variant pool
    this.buckets = [];   // { band, sp, v, attr, meshes, list }
    const t0 = performance.now(); let tris = 0;
    const byKey = {};
    for (const [sp, n] of Object.entries(VARIANTS)) for (let v = 0; v < n; v++) for (const band of ['near', 'mid', 'far']) {
      const g = growTree(sp, 100 + v * 17 + (sp === 'tupelo' ? 3 : sp === 'snag' ? 7 : 0), { lod: { near: 0, mid: 1, far: 2 }[band] });
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(16 * trees.length), 16);
      attr.setUsage(THREE.DynamicDrawUsage);
      const meshes = [];
      const add = (geo, mat) => {
        if (!geo) return;
        const im = new THREE.InstancedMesh(geo, mat, trees.length);
        im.instanceMatrix = attr; im.count = 0; im.name = band;   // ?prof inventory groups trees by LOD band
        // 11.3 perf (?nocull reverts): each bucket gets a live bounding sphere from the trees it
        // holds, so the renderer frustum-culls whole buckets (main + mirror camera) instead of drawing all 36 always
        im.frustumCulled = !NOCULL; im.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
        if (!geo.boundingSphere) geo.computeBoundingSphere();
        this.group.add(im); meshes.push(im); tris += geo.index.count / 3;
      };
      add(g.bark, bark); add(g.leaves, leaf[sp === 'tupelo' ? 'tupelo' : 'cypress']); add(g.moss, moss);
      const gR = Math.max(...[g.bark, g.leaves, g.moss].filter(Boolean).map((x) => (x.boundingSphere || (x.computeBoundingSphere(), x.boundingSphere)).radius + x.boundingSphere.center.length()));
      const b = { band, sp, v, attr, meshes, n: 0, gR, lo: new THREE.Vector3(), hi: new THREE.Vector3(), maxS: 0 };
      this.buckets.push(b); byKey[`${band}:${sp}:${v}`] = b;
    }
    this.growMs = Math.round(performance.now() - t0); this.poolTris = Math.round(tris);
    // assign each tree a species + variant, and precompute its matrices
    const up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    for (const t of trees) {
      let x = r(), sp = 'cypress';
      for (const [name, w] of MIX) { if (x < w) { sp = name; break; } x -= w; }
      // distance from the channel edge (negative = standing in the water)
      const edge = Math.abs(t.x - cx(t.z)) - halfWidth(t.z);
      t.edge = edge;
      if (edge < 12 && sp === 'cypress' && r() < 0.45) sp = r() < 0.6 ? 'snag' : 'tupelo';
      let dCam = 1e9;
      for (const c of camPts) { const dx = c.x - t.x, dz = c.z - t.z; const d = dx * dx + dz * dz; if (d < dCam) dCam = d; }
      dCam = Math.sqrt(dCam); t.dCam = dCam;
      if (dCam < 26 && sp === 'cypress') sp = r() < 0.7 ? 'snag' : 'tupelo';
      // sight corridors (e.g. story camera -> moon): trees inside the cone are cut low so the disc and glitter path stay clear
      t.corr = 1;
      for (const c of corridors) {
        const dx = t.x - c.o.x, dz = t.z - c.o.z, along = dx * c.d.x + dz * c.d.z;
        if (along < 0 || along > c.len) continue;
        const lat = Math.abs(dx * c.d.z - dz * c.d.x);
        if (lat < 8 + along * c.spread) { t.corr = 0.4; if (sp === 'cypress') sp = 'snag'; }
      }
      t.sp = sp; t.v = Math.floor(r() * VARIANTS[sp]); t.keep = r();
      t.near = byKey[`near:${sp}:${t.v}`]; t.mid = byKey[`mid:${sp}:${t.v}`]; t.farB = byKey[`far:${sp}:${t.v}`];
      q.setFromAxisAngle(up, t.rot);
      const hero = t.edge > 10 && r() < 0.1 ? 1.35 : 1;
      const edgeK = THREE.MathUtils.clamp(0.55 + t.edge * 0.03, 0.55, 1) * THREE.MathUtils.clamp(0.5 + t.dCam * 0.02, 0.5, 1) * t.corr;
      const sc = THREE.MathUtils.clamp(t.s * 0.72, 0.62, 1.15) * hero * edgeK * (sp === 'tupelo' ? 0.85 : 1);
      t.girth = (1.5 + r() * 0.5) * (hero > 1 ? 1.25 : 1);
      t.pm = new THREE.Matrix4().compose(p.set(t.x, t.y + 0.1, t.z), q, s.set(sc * t.girth, sc, sc * t.girth));
    }
    this.density = 1;
    this.farDensity = parseFloat(new URLSearchParams(location.search).get('fardens') || '1');   // <1 thins mid/far trees (mobile tier); near trees always stay
    this.NEAR2 = 55 * 55; this.R2 = 160 * 160; this.FAR2 = 520 * 520;
    this.lastPos = new THREE.Vector3(1e9, 0, 0);
  }

  update(camPos, force) {
    if (this.density !== this._lastDensity) { this._lastDensity = this.density; force = true; }
    if (!force && camPos.distanceToSquared(this.lastPos) < 16) return;
    this.lastPos.copy(camPos);
    for (const b of this.buckets) { b.n = 0; b.lo.set(1e9, 1e9, 1e9); b.hi.set(-1e9, -1e9, -1e9); b.maxS = 0; }
    const NEAR2 = Math.min(this.NEAR2, this.R2), MID2 = Math.max(this.R2, NEAR2);
    for (const t of this.trees) {
      const dx = t.x - camPos.x, dz = t.z - camPos.z, d2 = dx * dx + dz * dz;
      if (d2 > this.FAR2) continue;
      if (d2 > NEAR2 && t.keep > this.density) continue;
      // hysteresis: a tree keeps its band until it is 8% past the boundary, so bands don't flicker
      const hy = (lim, cur, band) => (cur === band ? lim * 1.17 : lim);
      const band = d2 < hy(NEAR2, t.band, 'near') ? 'near' : d2 < hy(MID2, t.band, 'mid') ? 'mid' : 'far';
      // 11.3 perf candidate (?fardens=k, default 1 = off): thin only the far band (777k of 4.67M desktop tris at t6.5);
      // fog + soft far cards hide individual trees there, and it halves the mirror's far canopy too
      if (band === 'far' && t.keep > this.farDensity) continue;
      t.band = band;
      const b = band === 'near' ? t.near : band === 'mid' ? t.mid : t.farB;
      t.pm.toArray(b.attr.array, 16 * b.n++);
      const e = t.pm.elements; b.lo.min(_tp.set(e[12], e[13], e[14])); b.hi.max(_tp);
      b.maxS = Math.max(b.maxS, Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]));
    }
    for (const b of this.buckets) {
      // empty buckets are hidden (no zero-instance draw); only the live prefix is uploaded, and a zero-length range
      // is never issued (WebGL2 bufferSubData reads length 0 as 'to the end of the buffer')
      const had = b.prevN ?? -1; b.prevN = b.n;
      for (const m of b.meshes) {
        m.count = b.n; m.visible = b.n > 0 || this.warm;
        if (b.n > 0) { m.boundingSphere.center.addVectors(b.lo, b.hi).multiplyScalar(0.5); m.boundingSphere.radius = b.lo.distanceTo(b.hi) * 0.5 + b.gR * b.maxS + 3; }
      }
      if (b.n > 0) { b.attr.clearUpdateRanges(); b.attr.addUpdateRange(0, b.n * 16); b.attr.needsUpdate = true; }
      else if (had !== 0) b.attr.clearUpdateRanges();
    }
  }
}
const _tp = new THREE.Vector3();
