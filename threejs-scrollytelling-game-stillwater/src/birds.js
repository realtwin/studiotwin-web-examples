// Birds: small dusk silhouettes with articulated wings, flocking in code.
//   swifts  — a loose flock of small dark birds wheeling high over the channel (boids: separation /
//             alignment / cohesion + a wandering anchor ahead of the camera), flap bursts and glides.
//   waders  — a few long-necked wading birds crossing the channel in a lazy echelon, slow deep wingbeats
//             with long glides, legs trailing.
// Wings are two-segment (arm + hand): the hand lags the arm and folds back on the upstroke, the body
// counter-bobs, birds bank into turns. All deformation is a TSL positionNode driven by one per-instance
// (phase, amplitude, glide) attribute; the CPU only steers.
import * as THREE from 'three';
import { attribute, positionLocal, positionWorld, cameraPosition, vec3, float, sin, cos, min, max, mix, smoothstep } from 'three/tsl';
import { cx } from './channel.js';

function birdGeometry(o) {
  // o: { span, wrist, chord, body, tail, neck, legs }
  const P = [], S = [], I = [];
  const v = (x, y, z, span = 0, side = 0) => { P.push(x, y, z); S.push(span, side); return P.length / 3 - 1; };
  const tri = (a, b, c) => I.push(a, b, c);
  // body: a slim spindle (diamond section) + head + optional tucked neck
  const L = o.body, nose = v(0, 0.01 * L, L * 0.55 + o.neck), top = v(0, 0.09 * L, 0.05 * L), bot = v(0, -0.08 * L, 0.05 * L);
  const lft = v(-0.09 * L, 0, 0.1 * L), rgt = v(0.09 * L, 0, 0.1 * L), tailR = v(0, 0.02 * L, -0.45 * L);
  for (const [a, b] of [[top, lft], [lft, bot], [bot, rgt], [rgt, top]]) { tri(nose, a, b); tri(a, tailR, b); }
  if (o.neck > 0) { // tucked S-neck bulge under the head
    const n1 = v(0, -0.14 * L, L * 0.3), n2 = v(-0.05 * L, -0.02 * L, L * 0.35), n3 = v(0.05 * L, -0.02 * L, L * 0.35);
    tri(nose, n1, n2); tri(nose, n3, n1); tri(n1, bot, n2); tri(n1, n3, bot);
  }
  // tail fan (forked for the small birds)
  const tw = o.tail, tz = -0.45 * L;
  const tl = v(-tw, 0.01 * L, tz - tw * 1.6), tr = v(tw, 0.01 * L, tz - tw * 1.6), tm = v(0, 0.01 * L, tz - tw * (o.fork ? 0.8 : 1.4));
  tri(tailR, tl, tm); tri(tailR, tm, tr);
  // trailing legs (waders)
  if (o.legs > 0) {
    const h0 = v(-0.02 * L, -0.05 * L, -0.3 * L), h1 = v(0.02 * L, -0.05 * L, -0.3 * L);
    const f0 = v(-0.015 * L, -0.07 * L, -0.3 * L - o.legs), f1 = v(0.015 * L, -0.07 * L, -0.3 * L - o.legs);
    tri(h0, f0, h1); tri(h1, f0, f1);
  }
  // wings: span stations root → wrist → tip, swept back, leading edge thicker chord at the arm
  for (const side of [-1, 1]) {
    const st = [0.06 * L, o.wrist * 0.5, o.wrist, o.wrist + (o.span - o.wrist) * 0.55, o.span];
    const chord = [o.chord, o.chord * 0.95, o.chord * 0.85, o.chord * 0.6, 0.02];
    const sweep = [0, 0.02, 0.05, 0.14, 0.3].map((k) => k * o.span);
    const lead = [], trail = [];
    st.forEach((d, i) => {
      lead.push(v(side * d, 0, 0.12 * L - sweep[i], d, side));
      trail.push(v(side * d, 0, 0.12 * L - sweep[i] - chord[i], d, side));
    });
    for (let i = 0; i < st.length - 1; i++) { tri(lead[i], trail[i], lead[i + 1]); tri(trail[i], trail[i + 1], lead[i + 1]); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('wing', new THREE.Float32BufferAttribute(S, 2));
  g.setIndex(I); g.computeVertexNormals(); g.computeBoundingSphere();
  return g;
}

function birdMaterial(wrist, bodyBob) {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const w = attribute('wing', 'vec2');                      // (span distance, side)
  const f = attribute('flap', 'vec3');                      // (phase, amplitude, glide 0..1)
  const P = positionLocal, d = w.x, side = w.y;
  const ph = f.x, amp = f.y, glide = f.z;
  const dihedral = float(0.1).add(glide.mul(0.12));
  const a1 = amp.mul(sin(ph)).add(dihedral);                            // arm
  const a2 = amp.mul(0.85).mul(sin(ph.sub(1.1))).add(glide.mul(-0.06)); // hand lags the arm
  const dIn = min(d, float(wrist)), dOut = max(d.sub(wrist), 0);
  const x = dIn.mul(cos(a1)).add(dOut.mul(cos(a1.add(a2))));
  const y = dIn.mul(sin(a1)).add(dOut.mul(sin(a1.add(a2))));
  const fold = max(cos(ph).negate(), 0).mul(amp).mul(0.45).mul(dOut);  // hand sweeps back on the upstroke
  const isWing = d.greaterThan(0.0001);
  const wingPos = vec3(side.mul(x), P.y.add(y), P.z.sub(fold));
  const bob = amp.mul(sin(ph)).mul(-bodyBob);
  m.positionNode = isWing.select(wingPos, P).add(vec3(0, bob, 0));
  // dusk silhouette: near-black with a whisper of cool sky bounce; distance fog lifts far birds into the haze
  m.fog = false;
  const dist = cameraPosition.sub(positionWorld).length();
  const haze = smoothstep(60, 180, dist).mul(0.55);
  m.colorNode = mix(vec3(0.012, 0.014, 0.02), vec3(0.2, 0.22, 0.27), haze);
  return m;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3(),
  _r = new THREE.Vector3(), _a = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

class Flock {
  constructor(n, geo, mat, cfg, rnd) {
    this.cfg = cfg; this.rnd = rnd;
    this.flap = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3); this.flap.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('flap', this.flap);
    this.mesh = new THREE.InstancedMesh(geo, mat, n); this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.b = Array.from({ length: n }, () => ({
      p: new THREE.Vector3(), v: new THREE.Vector3(0, 0, cfg.speed), acc: new THREE.Vector3(), roll: 0,
      ph: rnd() * 6.28, freq: cfg.freq * (0.9 + rnd() * 0.2), amp: cfg.amp, glide: 0, timer: rnd() * 2, flapping: true,
      sc: cfg.scale * (0.85 + rnd() * 0.3),
    }));
    this.active = n;
  }
  setActive(k) { this.active = Math.min(k, this.b.length); this.mesh.count = this.active; }
  wings(b, dt) {
    const c = this.cfg;
    b.timer -= dt;
    if (b.timer <= 0) {
      b.flapping = !b.flapping;
      b.timer = b.flapping ? c.flapT[0] + this.rnd() * c.flapT[1] : c.glideT[0] + this.rnd() * c.glideT[1];
    }
    const climb = THREE.MathUtils.clamp(b.v.y * 0.25, -0.3, 0.6);
    const wantAmp = b.flapping ? c.amp * (1 + climb * 0.5) : 0.04;
    b.amp += (wantAmp - b.amp) * Math.min(1, dt * (b.flapping ? 6 : 3));
    b.glide += ((b.flapping ? 0 : 1) - b.glide) * Math.min(1, dt * 3);
    // while gliding, ease the phase toward mid-downstroke so wings settle level instead of freezing mid-beat
    if (b.flapping || Math.sin(b.ph) > 0.05) b.ph += 6.2832 * b.freq * (1 + climb * 0.3) * dt;
  }
  write(i, b, dt, cam) {
    _f.copy(b.v).normalize();
    // bank into the turn: lateral acceleration → roll
    _r.crossVectors(_f, _up).normalize();
    const lat = -b.acc.dot(_r);
    let want = THREE.MathUtils.clamp(lat * this.cfg.bank, -1.1, 1.1);
    // silhouette assist: seen from near wing level a flat wing is a 1-px line, so bias the roll toward the
    // viewer (as painters do with flocks) - the wing plane opens up and the swept shape reads
    if (cam) {
      _t.copy(cam).sub(b.p); _t.addScaledVector(_f, -_t.dot(_f));
      const toward = Math.atan2(-_t.dot(_r), Math.max(_t.y, 1e-3));
      want += THREE.MathUtils.clamp(toward * 0.75, -1.0, 1.0);
    }
    b.roll += (want - b.roll) * Math.min(1, dt * 4);
    _u.crossVectors(_r, _f).normalize().applyAxisAngle(_f, b.roll);
    _r.crossVectors(_u, _f).normalize();
    _m.makeBasis(_r.negate(), _u, _f);
    _q.setFromRotationMatrix(_m);
    _m.compose(b.p, _q, _s.setScalar(b.sc));
    this.mesh.setMatrixAt(i, _m);
    this.flap.array[3 * i] = b.ph; this.flap.array[3 * i + 1] = b.amp; this.flap.array[3 * i + 2] = b.glide;
  }
  commit() { this.mesh.instanceMatrix.needsUpdate = true; this.flap.needsUpdate = true; }
}

export class Birds {
  constructor(seed = 7) {
    let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    this.rnd = rnd;
    this.group = new THREE.Group(); this.group.name = 'birds';
    // swifts / swallows: ~0.4 m span, fast wingbeats, short glides
    const small = { span: 0.22, wrist: 0.08, chord: 0.075, body: 0.16, tail: 0.035, fork: true, neck: 0, legs: 0 };
    this.swifts = new Flock(28, birdGeometry(small), birdMaterial(small.wrist, 0.012), {
      speed: 10, freq: 7.5, amp: 0.85, flapT: [0.4, 0.9], glideT: [0.25, 0.9], bank: 0.09, scale: 2.0,
    }, rnd);
    // wading birds in flight: ~1.7 m span, neck tucked, legs trailing, slow deep beats + long glides
    const big = { span: 0.85, wrist: 0.34, chord: 0.24, body: 0.55, tail: 0.08, fork: false, neck: 0.12, legs: 0.42 };
    this.waders = new Flock(4, birdGeometry(big), birdMaterial(big.wrist, 0.05), {
      speed: 6.5, freq: 2.1, amp: 0.7, flapT: [2.0, 2.5], glideT: [1.2, 2.2], bank: 0.06, scale: 1,
    }, rnd);
    this.group.add(this.swifts.mesh, this.waders.mesh);
    this.anchor = new THREE.Vector3(); this.wind = new THREE.Vector3();
    this.cross = null; this.nextCross = 0.5;
    this.inited = false;
  }
  setDensity(k) { this.swifts.setActive(Math.round(28 * k)); this.waders.setActive(k < 0.8 ? 3 : 4); }

  _scatter(center) {
    for (const b of this.swifts.b) {
      b.p.copy(center).add(_t.set((this.rnd() - 0.5) * 12, (this.rnd() - 0.5) * 3, (this.rnd() - 0.5) * 12));
      b.v.set(this.rnd() - 0.5, 0, this.rnd() - 0.5).normalize().multiplyScalar(this.swifts.cfg.speed);
    }
  }

  update(t, dt, camPos, camDir) {
    dt = Math.min(dt, 1 / 20);
    // swifts: wandering anchor ~70 m ahead of the camera over the channel, 18–30 m up
    _f.set(camDir.x, 0, camDir.z).normalize();
    this.anchor.copy(camPos).addScaledVector(_f, 24);
    this.anchor.x += Math.sin(t * 0.13) * 7; this.anchor.z += Math.cos(t * 0.11) * 5;
    this.anchor.y = camPos.y + 5.5 + Math.sin(t * 0.21) * 1.5;
    if (!this.inited || _c.copy(this.swifts.b[0].p).distanceTo(this.anchor) > 90) { this._scatter(this.anchor); this.inited = true; }
    const F = this.swifts, n = F.active, B = F.b;
    for (let i = 0; i < n; i++) {
      const b = B[i]; b.acc.set(0, 0, 0);
      _a.set(0, 0, 0); _c.set(0, 0, 0); _t.set(0, 0, 0); let na = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const o = B[j]; const dx = o.p.x - b.p.x, dy = o.p.y - b.p.y, dz = o.p.z - b.p.z, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 9) { const k = 1 / Math.max(d2, 0.2); _t.x -= dx * k; _t.y -= dy * k; _t.z -= dz * k; }   // separation
        if (d2 < 100) { _a.add(o.v); _c.add(o.p); na++; }                                                      // alignment + cohesion
      }
      if (na) { _a.divideScalar(na).sub(b.v).multiplyScalar(0.9); _c.divideScalar(na).sub(b.p).multiplyScalar(0.35); b.acc.add(_a).add(_c); }
      b.acc.addScaledVector(_t, 6);
      // pull toward the anchor, stronger with distance; a little individual wander keeps the flock breathing
      _c.copy(this.anchor).sub(b.p); const dA = _c.length();
      b.acc.addScaledVector(_c, 0.05 + Math.min(dA, 60) * 0.004);
      b.acc.x += Math.sin(t * 0.9 + i * 1.7) * 2.2; b.acc.y += Math.sin(t * 1.3 + i * 2.3) * 1.2; b.acc.z += Math.cos(t * 0.8 + i * 1.1) * 2.2;
    }
    for (let i = 0; i < n; i++) {
      const b = B[i];
      b.v.addScaledVector(b.acc, dt);
      b.v.y *= 0.985;
      const sp = b.v.length(), lo = F.cfg.speed * 0.7, hi = F.cfg.speed * 1.35;
      if (sp < lo) b.v.multiplyScalar(lo / sp); else if (sp > hi) b.v.multiplyScalar(hi / sp);
      b.p.addScaledVector(b.v, dt);
      if (b.p.y < camPos.y + 2.5) b.v.y += (camPos.y + 2.5 - b.p.y) * 2 * dt;
      F.wings(b, dt); F.write(i, b, dt, camPos);
    }
    F.commit();

    // waders: an echelon crossing the channel ahead of the camera, then a pause, then another pass
    const W = this.waders;
    if (!this.cross && t > this.nextCross) {
      const side = this.rnd() < 0.5 ? -1 : 1, z0 = camPos.z + 40 + this.rnd() * 30;
      const start = new THREE.Vector3(cx(z0) + side * 120, 11 + this.rnd() * 5, z0);
      const dir = new THREE.Vector3(-side, 0, (this.rnd() - 0.3) * 0.5).normalize();
      this.cross = { start, dir, t0: t };
      W.b.forEach((b, i) => {
        b.p.copy(start).addScaledVector(dir, -i * 3.2).add(_t.set(0, i * 0.35, -i * 2.4 * Math.sign(dir.x || 1)));
        b.v.copy(dir).multiplyScalar(W.cfg.speed); b.ph = i * 0.7; b.flapping = true; b.timer = 1 + i * 0.3;
      });
    }
    if (this.cross) {
      const c = this.cross;
      for (let i = 0; i < W.active; i++) {
        const b = W.b[i];
        // gentle undulation + a slow drift so the line never looks rigid
        b.acc.set(Math.sin(t * 0.4 + i) * 0.3, Math.sin(t * 0.7 + i * 1.3) * 0.25 + (b.flapping ? 0.12 : -0.18), Math.cos(t * 0.35 + i) * 0.3);
        b.v.addScaledVector(b.acc, dt); b.v.setLength(W.cfg.speed);
        b.p.addScaledVector(b.v, dt);
        W.wings(b, dt); W.write(i, b, dt, camPos);
      }
      W.commit(); W.mesh.visible = true;
      if (t - c.t0 > 240 / W.cfg.speed || W.b[0].p.distanceTo(camPos) > 320) { this.cross = null; this.nextCross = t + 6 + this.rnd() * 14; }
    } else W.mesh.visible = false;
  }
  // debug: world position + forward of a bird
  pose(which = 'swift', i = 0) {
    const b = (which === 'wader' ? this.waders : this.swifts).b[i];
    return { p: b.p.clone(), f: b.v.clone().normalize() };
  }
}
