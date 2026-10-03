// Procedural swamp trees: grown in code, dressed with StudioTwin scans.
//
// Structure (after the "structured growth" pattern): a per-species table drives a recursive
// grower. Tubes are swept with a parallel-transport frame (no twisting); radii follow a
// taper curve; the bald-cypress trunk gets a flared, fluted buttress that sinks into the water.
// Children are stratified along the parent with golden-angle azimuths so they never line up.
//
// Wind is hierarchical and continuous across joints: every vertex carries
//   windA = (heightFrac, f1, s1, f2)   windB = (s2, kind)
// f1/s1 = flex amplitude (m) + phase seed of its level-1 bough, inherited unchanged by
// everything that grows from it; f2/s2 = the same for its own twig. The TSL vertex stage sums
// trunk lean + bough sway + twig sway, so a twig can never detach from its bough.
// Leaves add a flutter; Spanish moss adds a travelling wave down the strand (cloth-like swing).
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, uniform, time, vec3, vec4, float, sin, cos, mix, smoothstep, positionLocal,
  texture, uv, modelWorldMatrix, clamp, fwidth, cameraPosition, length, positionWorld, normalMap, normalViewGeometry, pow, max, color,
} from 'three/tsl';

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const UP = new THREE.Vector3(0, 1, 0);

export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const lerp = (a, b, t) => a + (b - a) * t;
const pick = (r, [a, b]) => lerp(a, b, r());

export const SPECIES = {
  // Bald cypress: tall straight bole, heavily buttressed and fluted, near-horizontal boughs,
  // flat-topped open crown, feathery sprays, moss everywhere.
  cypress: {
    height: [21, 28], trunkR: [0.5, 0.72], flare: 3.3, flareH: 0.13, flutes: 7, fluteAmp: 0.5,
    taper: 0.78, taperCurve: 0.9, levels: 3, children: [9, 16], childStart: [0.66, 0.08],
    angle: [76, 50], angleVar: 16, lenRatio: [0.44, 0.55], radiusRatio: [0.5, 0.42],
    upPull: [0.35, 0.3], droop: [0.5, 0.25], gnarl: [0.02, 0.16, 0.24], kink: 0.2, crown: 'flat', lean: 0.05,
    breakTop: 0.7, knees: [7, 16], leaf: 'cypress', leafSize: [2.0, 3.2], leafSpacing: 0.26, leafPer: 5,
    padOnly: 1, moss: 52, mossLen: [1.6, 7], mossyFrac: 0.55,
  },
  // Water tupelo: swollen base, upright oval crown, broad glossy leaves.
  tupelo: {
    height: [15, 20], trunkR: [0.5, 0.64], flare: 2.1, flareH: 0.16, flutes: 3, fluteAmp: 0.06,
    taper: 0.82, taperCurve: 0.7, levels: 3, children: [12, 7], childStart: [0.5, 0.15],
    angle: [38, 46], angleVar: 16, lenRatio: [0.3, 0.5], radiusRatio: [0.4, 0.5],
    upPull: [0.55, 0.35], droop: [0.1, 0.25], gnarl: [0.02, 0.14, 0.24], kink: 0.1, crown: 'oval', lean: 0.04,
    breakTop: 0, knees: [0, 0], leaf: 'tupelo', leafSize: [1.0, 1.5], leafSpacing: 0.32, leafPer: 2,
    moss: 18, mossLen: [1.2, 4], mossyFrac: 0.3,
  },
  // Dead snag: broken-topped cypress skeleton, a few stubs, lots of moss.
  snag: {
    height: [9, 15], trunkR: [0.45, 0.62], flare: 2.2, flareH: 0.12, flutes: 6, fluteAmp: 0.4,
    taper: 0.45, taperCurve: 1.0, levels: 2, children: [8], childStart: [0.4],
    angle: [62], angleVar: 28, lenRatio: [0.3], radiusRatio: [0.4], upPull: [0.2], droop: [0.3],
    gnarl: [0.035, 0.22], kink: 0.25, crown: 'flat', lean: 0.2, breakTop: 1, knees: [4, 10], dead: 1,
    leaf: null, moss: 26, mossLen: [1.5, 5.5], mossyFrac: 0.6,
  },
};

function crownMul(shape, u) {
  if (shape === 'flat') return 0.8 + 0.25 * Math.sin(Math.PI * u) - 0.25 * Math.pow(Math.max(0, u - 0.8) / 0.2, 2);
  return 0.3 + 0.8 * Math.sin(Math.PI * (0.12 + 0.8 * u));
}

// ---------------------------------------------------------------------------
// growth
// ---------------------------------------------------------------------------
export function growTree(species, seed, opts = {}) {
  const sp = SPECIES[species];
  const r = rng(seed * 7919 + 13);
  const H = pick(r, sp.height), R0 = pick(r, sp.trunkR);
  const lod = opts.lod ?? 0;                    // 0 near, 1 mid, 2 far (fewer rings/cards, same skeleton)
  // Coherent LODs: the skeleton (every branch path, radius, child) comes from ONE random stream that no LOD
  // setting touches, so near/mid/far are the same tree; LODs only decimate rings/sides and thin the cards.
  // Leaves draw from a per-branch stream, knees and moss from their own streams (lower LODs = prefix subsets).
  const rk = rng(seed * 104729 + 7), rm = rng(seed * 130363 + 11);
  const LRING = [1, 3, 6][lod], LRAD = [[22, 8, 5], [10, 5, 3], [6, 4, 0]][lod];
  const B = new Builder(), L = new Builder(), M = new Builder();
  const mossSpots = [];
  const crownC = new THREE.Vector3(0, H * 0.72, 0);
  const flutePhase = r() * 6.28; const k0 = r() * 6.28;

  function grow(base, dir, len, r0, level, inh) {
    const secLen = level === 0 ? 0.8 : 0.55;
    const segs = THREE.MathUtils.clamp(Math.round(len / secLen), 3, 30);
    const radial = LRAD[Math.min(level, 2)];
    const bseed = r();
    const rl = rng(Math.floor(bseed * 4294967295) ^ 0x5bd1e995);
    const d = dir.clone().normalize();
    const n = new THREE.Vector3().crossVectors(d, Math.abs(d.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0)).normalize();
    const p = base.clone();
    const rings = [];
    let acc = 0;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      let rad = r0 * (1 - sp.taper * Math.pow(t, sp.taperCurve));
      rad = Math.max(rad, level === 0 ? 0.05 : 0.012);
      let f1 = 0, s1 = 0, f2 = 0, s2 = 0;
      if (level === 1) { f1 = Math.pow(t, 1.5) * len * 0.035; s1 = bseed; }
      else if (level >= 2) { f1 = inh.f1; s1 = inh.s1; f2 = Math.pow(t, 1.3) * len * 0.07; s2 = bseed; }
      const b = new THREE.Vector3().crossVectors(d, n);
      rings.push({ p: p.clone(), d: d.clone(), n: n.clone(), b, r: rad, t, acc, w: [Math.max(0, p.y / H), f1, s1, f2], s2 });
      if (i < segs) {
        const g = sp.gnarl[level] * (level > 0 && r() < (sp.kink || 0) ? 3.2 : 1);
        d.x += (r() - 0.5) * g * 2; d.z += (r() - 0.5) * g * 2; d.y += (r() - 0.5) * g;
        if (level > 0) d.y += sp.upPull[level - 1] * 0.12 - sp.droop[level - 1] * 0.16 * t;
        d.normalize();
        n.addScaledVector(d, -n.dot(d)).normalize();
        const st = len / segs; p.addScaledVector(d, st); acc += st;
      }
    }
    // --- bark tube
    const uRep = Math.max(1, Math.round((2 * Math.PI * r0) / 1.1));
    const vScale = uRep / (2 * Math.PI * r0);
    const start = B.count;
    const tubeRings = rings.filter((_, i) => i % LRING === 0 || i === rings.length - 1);
    for (const ring of (radial ? tubeRings : [])) {
      for (let j = 0; j <= radial; j++) {
        const th = (j / radial) * Math.PI * 2;
        let rr = ring.r;
        if (level === 0) {
          const hh = Math.max(0, (ring.p.y + 1.2) / H);
          const fl = Math.pow(Math.max(0, 1 - hh / sp.flareH), 2.2);
          rr *= 1 + sp.flare * fl;
          const flute = Math.pow(Math.max(0, 1 - hh / (sp.flareH * 1.7)), 1.4);
          rr *= 1 + sp.fluteAmp * flute * (Math.cos(th * sp.flutes + flutePhase + Math.sin(th * 3) * 0.6) - 0.3);
        }
        const c = Math.cos(th), s = Math.sin(th);
        const nx = ring.n.x * c + ring.b.x * s, ny = ring.n.y * c + ring.b.y * s, nz = ring.n.z * c + ring.b.z * s;
        B.v(ring.p.x + nx * rr, ring.p.y + ny * rr, ring.p.z + nz * rr, nx, ny, nz,
          (j / radial) * uRep, ring.acc * vScale, ring.w, ring.s2, 0, sp.dead ? 1 : 0);
      }
    }
    for (let i = 0; radial && i < tubeRings.length - 1; i++) for (let j = 0; j < radial; j++) {
      const a = start + i * (radial + 1) + j, b2 = a + radial + 1;
      B.tri(a, b2, a + 1); B.tri(a + 1, b2, b2 + 1);
    }
    // --- children
    if (level < sp.levels - 1) {
      const nC = level === 0 ? sp.children[0] : Math.max(2, Math.round(sp.children[level] * Math.min(1.4, len / 6)));
      const cs = sp.childStart[level];
      for (let k = 0; k < nC; k++) {
        const u = (k + 0.2 + 0.6 * r()) / nC;
        const t = cs + u * (1 - cs) * 0.96;
        const ring = rings[Math.min(rings.length - 1, Math.round(t * segs))];
        const az = level === 0 ? k * GOLDEN + r() * 0.6 : (k % 2 ? 1 : -1) * (1.2 + r() * 0.8) + r() * 0.4;
        const side = ring.n.clone().multiplyScalar(Math.cos(az)).addScaledVector(ring.b, Math.sin(az));
        const ang = THREE.MathUtils.degToRad(sp.angle[level] + (r() - 0.5) * 2 * sp.angleVar);
        const cdir = ring.d.clone().multiplyScalar(Math.cos(ang)).addScaledVector(side, Math.sin(ang)).normalize();
        let cl = len * sp.lenRatio[level] * (0.8 + 0.4 * r());
        cl *= level === 0 ? crownMul(sp.crown, u) : (1 - 0.55 * t);
        if (species === 'snag') cl *= 0.35 + 0.65 * r() * r();   // broken stubs
        const cr = ring.r * sp.radiusRatio[level] * (0.8 + 0.3 * r());
        if (cl < 0.6) continue;
        const cbase = ring.p.clone().addScaledVector(side, ring.r * 0.5);
        grow(cbase, cdir, cl, cr, level + 1, { f1: ring.w[1], s1: ring.w[2] });
      }
    }
    // --- foliage cards on boughs (outer half) and twigs
    if (sp.leaf && level >= 1 && !(sp.padOnly && level === 1)) {
      const spacing = sp.leafSpacing * [1, 2.2, 4.2][lod] * (level === 1 ? 1.6 : 1);
      let next = len * (level === 1 ? 0.45 : sp.padOnly ? 0.35 : 0.15);
      for (const ring of rings) {
        if (ring.acc < next) continue;
        next = ring.acc + spacing * (0.7 + 0.6 * rl());
        const n2 = level === 1 ? 1 : Math.max(1, Math.round((sp.leafPer || 2) * (0.6 + 0.8 * rl()) * [1, 0.6, 0.45][lod]));
        for (let q = 0; q < n2; q++) card(ring, level, rl);
      }
    }
    // --- moss attach points (under boughs)
    if (level === 1 && r() < (sp.mossyFrac ?? 0.5)) for (const ring of rings) if (ring.t > 0.1 && ring.t < 0.85) mossSpots.push(ring);
    if (level === 2 && r() < (sp.mossyFrac ?? 0.5) * 0.5) for (const ring of rings) if (ring.t < 0.6) mossSpots.push(ring);
    if (level === 0 && species === 'snag') for (const ring of rings) if (ring.t > 0.5) mossSpots.push(ring);
  }

  function card(ring, level, r) {
    const size = pick(r, sp.leafSize) * [1, 1.6, 2.3][lod];
    const cypress = sp.leaf === 'cypress';
    // cypress sprays lie flat-ish (feathery horizontal plates); tupelo twigs point any way
    const along = ring.d.clone();
    const sideAz = r() * Math.PI * 2;
    const off = ring.n.clone().multiplyScalar(Math.cos(sideAz)).addScaledVector(ring.b, Math.sin(sideAz));
    const c = ring.p.clone().addScaledVector(off, ring.r + size * 0.25).addScaledVector(along, (r() - 0.5) * 0.4);
    let fn;
    if (cypress) fn = new THREE.Vector3((r() - 0.5) * 0.5, 1, (r() - 0.5) * 0.5).normalize();
    else fn = new THREE.Vector3(r() - 0.5, r() * 0.8 + 0.2, r() - 0.5).normalize();
    const a = along.clone().addScaledVector(fn, -along.dot(fn));
    if (a.lengthSq() < 1e-4) a.set(1, 0, 0);
    a.normalize().applyAxisAngle(fn, (r() - 0.5) * 1.2);
    const w = new THREE.Vector3().crossVectors(fn, a).normalize();
    if (cypress) c.y -= size * 0.12;                                // sprays droop below the twig
    const rn = c.clone().sub(crownC).normalize().multiplyScalar(0.7).addScaledVector(fn, 0.5).normalize();
    const hw = size * 0.5, hl = size * 0.55;
    const tint = r();
    const base = L.count;
    const corners = [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]];
    for (const [sx, sy, u, v] of corners) {
      const px = c.x + w.x * sx * hw + a.x * sy * hl, py = c.y + w.y * sx * hw + a.y * sy * hl, pz = c.z + w.z * sx * hw + a.z * sy * hl;
      // twig-end corners sway with the twig tip, base corners with the attach point
      L.v(px, py, pz, rn.x, rn.y, rn.z, u, v, ring.w, ring.s2, 1, tint);
    }
    L.tri(base, base + 1, base + 2); L.tri(base, base + 2, base + 3);
  }

  // trunk starts under the water/mud line so the buttress roots into it
  const lean = sp.lean || 0, la = r() * Math.PI * 2;
  const broken = r() < (sp.breakTop || 0);
  const trunkLen = (H + 1.2) * (broken ? 0.86 + r() * 0.06 : 1);
  grow(new THREE.Vector3(0, -1.2, 0), new THREE.Vector3(Math.cos(la) * lean * r(), 1, Math.sin(la) * lean * r()), trunkLen, R0, 0, null);
  // cypress knees: conical woody stubs rising out of the water around the tree
  const nK = Math.round(pick(r, sp.knees || [0, 0]) * [1, 0.5, 0][lod]);
  const rootAz = Array.from({ length: 4 + Math.floor(r() * 3) }, () => r() * Math.PI * 2);
  for (let k = 0; k < nK; k++) {
    const a = rootAz[k % rootAz.length] + (rk() - 0.5) * 0.35, dist = R0 * (2.0 + Math.pow(rk(), 1.3) * 4.5);
    const kh = (0.2 + Math.pow(rk(), 1.5) * 1.2) * (1.1 - dist / (R0 * 8)), kr = 0.14 + rk() * 0.16;
    knee(new THREE.Vector3(Math.cos(a) * dist, -0.9, Math.sin(a) * dist), kh + 0.9, kr);
  }
  function knee(base, h, kr) {
    const radial = lod ? 8 : 14, segs = 12, start = B.count;
    const tilt = new THREE.Vector3((rk() - 0.5) * 0.25, 1, (rk() - 0.5) * 0.25).normalize();
    for (let i = 0; i <= segs; i++) {
      // body flares into the water, then a knobbly rounded dome cap
      const t = i / segs, dome = t > 0.6 ? Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.6) / 0.4, 2))) : 1;
      const rad = kr * (1.5 - 0.6 * t) * (1 - 0.35 * Math.pow(1 - t, 6)) * Math.max(dome, 0.02);
      const c = base.clone().addScaledVector(tilt, h * t);
      for (let j = 0; j <= radial; j++) {
        const th = (j / radial) * Math.PI * 2, rr = rad * (1 + 0.16 * Math.cos(th * 3 + k0 + h) + 0.08 * Math.sin(th * 5 + i));
        const ny = 0.15 + 1.2 * Math.max(0, t - 0.6), nl = Math.hypot(1, ny);
        B.v(c.x + Math.cos(th) * rr, c.y, c.z + Math.sin(th) * rr, Math.cos(th) / nl, ny / nl, Math.sin(th) / nl, j / radial, t * h * 0.5, [0, 0, 0, 0], 0, 0, sp.dead ? 1 : 0);
      }
    }
    for (let i = 0; i < segs; i++) for (let j = 0; j < radial; j++) { const a = start + i * (radial + 1) + j, b2 = a + radial + 1; B.tri(a, b2, a + 1); B.tri(a + 1, b2, b2 + 1); }
  }

  // Spanish moss: two crossed ribbons per strand, hanging from the underside of boughs
  const nMoss = Math.round(sp.moss * [1, 0.45, 0.22][lod]);
  for (let i = 0; i < nMoss && mossSpots.length; i++) {
    const ring = mossSpots[Math.floor(rm() * mossSpots.length)];
    const len = pick(r, sp.mossLen) * (ring.p.y > 4 ? 1 : 0.4);
    if (ring.p.y - len < 0.6) continue;
    const top = ring.p.clone().addScaledVector(UP, -ring.r * 0.8).addScaledVector(ring.d, (rm() - 0.5) * 1.2);
    const wid = 1.3 + rm() * 1.4, seed2 = rm();
    const rot = rm() * Math.PI;
    const segs = [10, 4, 3][lod];
    for (const k of [0, 1]) {
      const ax = new THREE.Vector3(Math.cos(rot + k * Math.PI / 2), 0, Math.sin(rot + k * Math.PI / 2));
      const nrm = new THREE.Vector3(-ax.z, 0, ax.x);
      const base = M.count;
      for (let s = 0; s <= segs; s++) {
        const f = s / segs, ww = wid * (1 - 0.7 * Math.pow(f, 1.3)) * 0.5;
        for (const sx of [-1, 1]) {
          M.v(top.x + ax.x * sx * ww, top.y - f * len, top.z + ax.z * sx * ww, nrm.x, 0.3, nrm.z,
            sx < 0 ? 0 : 1, 0.92 - f * 0.92, ring.w, ring.s2, 2, seed2, [f, seed2, len]);
        }
      }
      for (let s = 0; s < segs; s++) { const a = base + s * 2; M.tri(a, a + 2, a + 1); M.tri(a + 1, a + 2, a + 3); }
    }
  }
  return { bark: B.geometry(), leaves: L.count ? L.geometry() : null, moss: M.count ? M.geometry(true) : null, height: H, radius: R0 };
}

class Builder {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.wa = []; this.wb = []; this.tint = []; this.moss = []; this.idx = []; this.count = 0; }
  v(x, y, z, nx, ny, nz, u, v, w, s2, kind, tint = 0, moss = null) {
    this.pos.push(x, y, z); this.nrm.push(nx, ny, nz); this.uv.push(u, v);
    this.wa.push(w[0], w[1], w[2], w[3]); this.wb.push(s2, kind); this.tint.push(tint);
    if (moss) this.moss.push(moss[0], moss[1], moss[2]);
    this.count++;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  geometry(withMoss) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('windA', new THREE.Float32BufferAttribute(this.wa, 4));
    g.setAttribute('windB', new THREE.Float32BufferAttribute(this.wb, 2));
    g.setAttribute('tint', new THREE.Float32BufferAttribute(this.tint, 1));
    if (withMoss) g.setAttribute('moss', new THREE.Float32BufferAttribute(this.moss, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------
// TSL materials
// ---------------------------------------------------------------------------
export const WIND = {
  dir: uniform(new THREE.Vector2(0.82, 0.57)),
  strength: uniform(1.0),
};

// world-space hierarchical wind offset (positionLocal is post-instance here)
const windOffset = Fn(([kind]) => {
  const A = attribute('windA', 'vec4');
  const Bv = attribute('windB', 'vec2');
  const wp = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz;
  const d3 = vec3(WIND.dir.x, 0, WIND.dir.y);
  const s3 = vec3(WIND.dir.y.negate(), 0, WIND.dir.x);
  const t = time;
  // travelling gust bands sweep across the swamp
  const gust = sin(t.mul(0.33).sub(wp.x.mul(0.012)).sub(wp.z.mul(0.009))).mul(0.5).add(0.5);
  const g = gust.mul(gust).mul(0.75).add(0.25);
  const h = A.x;
  const trunk = d3.mul(h.mul(h).mul(0.45).mul(g.add(sin(t.mul(0.6).add(wp.x.mul(0.03))).mul(0.15))));
  const b1 = d3.mul(sin(t.mul(1.5).add(A.z.mul(40))).mul(0.5).add(g.mul(0.9)))
    .add(s3.mul(sin(t.mul(1.13).add(A.z.mul(23))).mul(0.45)))
    .add(vec3(0, sin(t.mul(1.9).add(A.z.mul(17))).mul(0.3), 0)).mul(A.y);
  const b2 = d3.mul(sin(t.mul(2.9).add(Bv.x.mul(50))).mul(0.6).add(g.mul(0.6)))
    .add(vec3(0, sin(t.mul(3.4).add(Bv.x.mul(31))).mul(0.5), 0)).mul(A.w);
  return trunk.add(b1).add(b2).mul(WIND.strength).mul(g.mul(0.6).add(0.55));
});

const NOFOOT = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nofoot');
export function barkMaterial(tex) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const uvb = uv();
  const alb = texture(tex.albedo, uvb).rgb;
  // wet, darker, mossy bark near the water line, lighter weathered grey higher up
  const y = positionWorld.y;
  const wet = smoothstep(2.2, 0.0, y);
  const mossy = smoothstep(0.35, 0.8, sin(positionWorld.x.mul(0.7)).mul(sin(positionWorld.z.mul(0.9).add(y.mul(0.8)))).mul(0.5).add(0.5)).mul(smoothstep(6.0, 1.0, y));
  const dead = attribute('tint', 'float');
  let c = mix(alb.mul(vec3(0.42, 0.4, 0.38)), alb.dot(vec3(0.33)).mul(vec3(1.25, 1.22, 1.15)).add(0.06), dead);
  c = mix(c, c.mul(vec3(0.42, 0.5, 0.4)), mossy.mul(0.55));
  c = mix(c, c.mul(0.38), wet);
  m.colorNode = c;
  // 11.3: fade the detail normal once a bark-map texel is under ~0.5 px - below that
  // it only adds per-pixel sparkle/shimmer (mips alone keep some). ?nofoot reverts.
  const texPerPx = length(fwidth(uvb)).mul(1024);
  const footK = NOFOOT ? float(1) : smoothstep(4.0, 1.5, texPerPx);
  m.normalNode = normalMap(texture(tex.normal, uvb), float(1.3).mul(footK.mul(0.8).add(0.2)));
  m.roughnessNode = mix(texture(tex.rough, uvb).r.mul(0.25).add(0.75), float(0.45), wet);
  m.positionNode = positionLocal.add(windOffset(0));
  return m;
}

export function leafMaterial(map, tintA, tintB) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5, transparent: false, alphaToCoverage: true });
  const tx = texture(map, uv());
  const tint = attribute('tint', 'float');
  const base = tx.rgb.mul(mix(color(tintA), color(tintB), tint)).mul(0.55);
  const camD = length(cameraPosition.sub(positionWorld));
  const crisp = clamp(tx.a.sub(0.5).div(max(fwidth(tx.a), 1e-4)).add(0.5), 0, 1);
  const soft = clamp(tx.a.mul(1.35).sub(0.12), 0, 1);
  const aSharp = mix(crisp, soft, smoothstep(14, 45, camD));
  m.colorNode = vec4(base, aSharp);
  m.opacityNode = aSharp;
  // rounded crown normals, no back-face flip -> soft, volumetric canopy shading
  m.normalNode = normalViewGeometry;
  // cheap translucency: moonlit sprays glow faintly from behind
  m.emissiveNode = base.mul(0.02);
  const t = time;
  const wp = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz;
  const flutter = vec3(
    sin(t.mul(7.3).add(tint.mul(60)).add(wp.y.mul(1.7))),
    sin(t.mul(9.1).add(tint.mul(33)).add(wp.x.mul(1.3))).mul(1.4),
    sin(t.mul(6.7).add(tint.mul(47)).add(wp.z.mul(1.9))),
  ).mul(0.045).mul(WIND.strength);
  m.positionNode = positionLocal.add(windOffset(1)).add(flutter);
  return m;
}

export function mossMaterial(map) {
  // it12: the old material desaturated the card 45 % toward grey and was fully matte (roughness 1) - the 'cardboard'
  // look. Wet card + no grey mix + roughness 0.38 so lamps/moon catch it; ?oldmoss restores the old card and shading.
  const OLD = new URLSearchParams(location.search).has('oldmoss');
  const m = new THREE.MeshStandardNodeMaterial({ roughness: OLD ? 1 : 0.38, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.35, alphaToCoverage: true });
  const tx = texture(map, uv());
  const mo = attribute('moss', 'vec3');         // (s along strand, seed, length)
  const grey = tx.rgb.dot(vec3(0.3, 0.55, 0.15));
  const mc = (OLD ? mix(tx.rgb, vec3(grey), 0.45).mul(vec3(0.95, 1.05, 0.9)) : tx.rgb.mul(vec3(0.9, 1.0, 0.85))).mul(mo.y.mul(0.25).add(0.8));
  const mD = length(cameraPosition.sub(positionWorld));
  const mA = mix(clamp(tx.a.sub(0.35).div(max(fwidth(tx.a), 1e-4)).add(0.5), 0, 1), clamp(tx.a.mul(1.5).sub(0.1), 0, 1), smoothstep(10, 40, mD));
  m.colorNode = vec4(mc, mA);
  m.emissiveNode = mc.mul(0.04);
  m.opacityNode = mA;
  m.normalNode = normalViewGeometry;
  const t = time;
  const s = mo.x, L = mo.z, seed = mo.y;
  const d3 = vec3(WIND.dir.x, 0, WIND.dir.y);
  const s3 = vec3(WIND.dir.y.negate(), 0, WIND.dir.x);
  // travelling wave down the strand: the tip lags the root, like a hanging cloth
  const w1 = sin(t.mul(1.25).sub(s.mul(2.6)).add(seed.mul(30)));
  const w2 = sin(t.mul(1.9).sub(s.mul(3.8)).add(seed.mul(17)));
  const lean = d3.mul(w2.mul(0.35).add(0.55)).add(s3.mul(w1.mul(0.6)));
  const amp = pow(s, float(1.6)).mul(L).mul(0.16).mul(WIND.strength);
  const swing = lean.mul(amp);
  // pendulum: the strand shortens a little as it swings out
  const lift = vec3(0, amp.mul(amp).div(max(L, 0.5)).mul(0.5), 0);
  m.positionNode = positionLocal.add(windOffset(2)).add(swing).add(lift);
  return m;
}
