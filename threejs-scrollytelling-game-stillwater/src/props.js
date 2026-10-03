// Life on the bend: stilt cabins with lit windows, a hanging HERON BEND sign and lanterns that swing
// in the same wind that moves the trees, and a school of fish that shadows the boat (birds live in birds.js).
// All meshes are StudioTwin image-to-3D props (normalised in Blender); motion is TSL + a little CPU physics.
import * as THREE from 'three';
import {
  uniform, time, vec3, float, sin, cos, mix, smoothstep, positionLocal, positionWorld, texture, uv, abs, max,
} from 'three/tsl';
import { cx, halfWidth, terrainHeight } from './channel.js';

// --- helpers -------------------------------------------------------------------------------
function nodeMat(src) {
  const m = new THREE.MeshStandardNodeMaterial();
  for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'roughness', 'metalness', 'side', 'normalScale', 'name'])
    if (src[k] !== undefined) m[k] = src[k];
  m.color.copy(src.color);
  return m;
}
const objPhase = () => uniform(0).onObjectUpdate(({ object }) => object.userData.ph || 0);
function firstMesh(gltf) { let r; gltf.scene.traverse((o) => { if (o.isMesh && !r) r = o; }); return r; }
function albedo(src) { return src.map ? texture(src.map, uv()).rgb.mul(uniform(src.color.clone())) : uniform(src.color.clone()); }
// warm, bright texels in the baked texture are the lit windows / lantern glass: make them emit
function warmGlow(base, gain) {
  const warm = smoothstep(0.08, 0.26, base.r.sub(base.b)).mul(smoothstep(0.3, 0.55, base.g)).mul(smoothstep(0.45, 0.7, base.r));
  return vec3(1.0, 0.62, 0.26).mul(warm).mul(gain);
}
// yaw that points a model's local +X (its front, per the Blender view renders) along a world direction
const yawFacing = (dx, dz) => Math.atan2(-dz, dx);
// a bank spot: `side` +1 = right of the channel centre line, `back` metres beyond the water's edge
function bank(z, side, back) {
  const x = cx(z) + side * (halfWidth(z) + back);
  return { x, z, y: terrainHeight(x, z), yaw: yawFacing(-side, 0) };
}

// wind shared with the trees (a slow gusting value, CPU side for pendulums)
function gust(t, x) { const g = Math.sin(t * 0.33 - x * 0.012) * 0.5 + 0.5; return g * g * 0.75 + 0.25; }

export const PROP_SITES = {
  // 11.3: at z560 the 1aba7a5 heron aim cropped the board to a 35 px sliver in the desktop heron shot (read as a log
  // poking into frame). tools/sign_frame.mjs: z574, 4 m back is whole in 6/7 heron frames (desktop) and never
  // partially cropped on phone. the original spot next to the heron reads best, so z560 stays default; ?newsign shows the moved one.
  cabin: bank(118, 1, 3), shack: bank(292, -1, 1.5),
  sign: (typeof location !== 'undefined' && new URLSearchParams(location.search).has('newsign')) ? bank(574, 1, 4) : bank(560, 1, 1.2),
};
export function propAvoidPoints() {
  const out = [];
  for (const [k, s] of Object.entries(PROP_SITES)) { const p = new THREE.Vector3(s.x, 0, s.z); p.r = k === 'sign' ? 7 : 16; out.push(p); }
  return out;
}

export class Props {
  constructor(g, mixer) {
    this.group = new THREE.Group(); this.group.name = 'props';
    this.mixer = mixer;
    this.pendulums = [];
    this.lights = [];
    this.windowGain = uniform(1.6);
    this._buildings(g);
    this._sign(g);
    this._fish(g);
    this.nextSplash = 6; this.nextWings = 10; this.nextCreak = 3;
  }

  _buildings(g) {
    const place = (gltf, site, scale, lanterns) => {
      const root = new THREE.Group();
      root.position.set(site.x, Math.max(site.y, -0.7), site.z); root.rotation.y = site.yaw; root.scale.setScalar(scale);
      const src = firstMesh(gltf); const mat = nodeMat(src.material);
      const base = albedo(src.material);
      mat.colorNode = base.mul(0.8);
      mat.emissiveNode = warmGlow(base, this.windowGain);
      const mesh = new THREE.Mesh(src.geometry, mat); root.add(mesh);
      // interior spill onto the porch / water
      const L = new THREE.PointLight(0xff9a48, 10, 18, 1.8); L.position.set(3.5, 5.2, 0); root.add(L); this.lights.push(L);
      for (const p of lanterns) this._lantern(g, root, p, scale);
      this.group.add(root);
      return root;
    };
    // cabin: porch eave ~0.71 of 9 m; front (+X) faces the water
    place(g.cabin, PROP_SITES.cabin, 0.85, [[4.9, 6.2, 0.9], [4.9, 6.2, 3.9]]);
    // shack: eave over the door ~0.75 of 6 m; its jetty reaches into the channel
    place(g.shack, PROP_SITES.shack, 0.9, [[4.7, 4.3, -1.6]]);
  }

  _lantern(g, parent, at, parentScale = 1, withLight = true) {
    const src = firstMesh(g.lantern);
    const mat = nodeMat(src.material); const base = albedo(src.material);
    mat.colorNode = base; mat.emissiveNode = warmGlow(base, 3.2).add(vec3(1.0, 0.6, 0.25).mul(smoothstep(0.12, 0.34, positionLocal.y).mul(smoothstep(0.4, 0.3, positionLocal.y)).mul(0.9)));
    const pivot = new THREE.Group(); pivot.position.set(...at);
    const hang = new THREE.Group(); hang.scale.setScalar(1.3 / parentScale);
    const m = new THREE.Mesh(src.geometry, mat); m.position.y = -0.5 - 0.25; // handle hook below the eave, 25 cm of chain
    const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.26, 4), new THREE.MeshStandardNodeMaterial({ color: 0x1a1512, roughness: 0.7, metalness: 0.6 }));
    chain.position.y = -0.13;
    hang.add(m, chain); pivot.add(hang); parent.add(pivot);
    if (withLight) { const L = new THREE.PointLight(0xffb060, 5, 11, 1.7); L.position.y = -0.52; hang.add(L); this.lights.push(L); }
    this.pendulums.push({ obj: pivot, a: 0, v: 0, ax: 0, vx: 0, len: 0.6, seed: Math.random() * 10 });
  }

  _sign(g) {
    const site = PROP_SITES.sign;
    const root = new THREE.Group(); root.position.set(site.x, Math.max(site.y, -0.4), site.z);
    // 11.3: turn the board 15 deg toward the heron-shot camera (tools/sign_yaw.mjs: face 59 -> ~95 px, post clears the H)
    root.rotation.y = site.yaw + (new URLSearchParams(location.search).has('newsign') ? -15 * Math.PI / 180 : 0);
    // weathered cypress post
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 3.8, 9), new THREE.MeshStandardNodeMaterial({ color: 0x3a3129, roughness: 0.95 }));
    post.position.set(0, 1.4, 0); root.add(post);
    const src = firstMesh(g.sign); const mat = nodeMat(src.material);
    // the board swings on its chains about the bracket arm (local Z axis at y≈0.86);
    // the iron bracket and wall plate (z > 0.62) stay put
    this.signSwing = uniform(0);
    const P = positionLocal, yp = float(0.86);
    const w = smoothstep(0.84, 0.72, P.y).mul(smoothstep(0.7, 0.6, P.z));
    const a = this.signSwing.mul(w), dy = P.y.sub(yp);
    const rot = vec3(P.x.mul(cos(a)).sub(dy.mul(sin(a))), yp.add(P.x.mul(sin(a))).add(dy.mul(cos(a))), P.z);
    mat.positionNode = rot;
    const sign = new THREE.Mesh(src.geometry, mat);
    sign.scale.setScalar(1.25); sign.position.set(0.02, 1.9, -0.8 * 1.25 - 0.1); // wall plate (+Z end) against the post
    root.add(sign);
    this.signState = { a: 0, v: 0 };
    // a lantern on the post top so the sign reads at dusk
    this._lantern(g, root, [0, 3.95, 0.25], 1, true);
    this.signRoot = root;
    this.group.add(root);
  }

  _fish(g) {
    const src = firstMesh(g.fish); const mat = nodeMat(src.material);
    const base = albedo(src.material);
    // it12: fish read as floating next to the boat (dark, crisp, 0.16 m deep). Under-water look by default:
    // tinted toward the deep teal water, lit by moving caustic bands, and refraction wobble across the whole body
    // (surface ripples bend the image) - 'diffraction'. Sunk a little deeper in update(). ?oldfish reverts.
    const OLD = new URLSearchParams(location.search).has('oldfish');
    const P = positionLocal, ph = objPhase();
    const dark = mix(base, vec3(0.1, 0.12, 0.09), 0.8);
    if (OLD) mat.colorNode = dark;
    else {
      const wpx = positionWorld.x, wpz = positionWorld.z;
      const ca = sin(wpx.mul(5.1).add(time.mul(1.7)).add(sin(wpz.mul(3.3).sub(time.mul(1.1))).mul(1.6)));
      const cb = sin(wpz.mul(4.4).sub(time.mul(1.3)).add(sin(wpx.mul(2.7).add(time.mul(0.9))).mul(1.4)));
      const caus = smoothstep(0.55, 1.0, ca.mul(cb).abs()).mul(0.5);
      mat.colorNode = mix(dark, vec3(0.05, 0.13, 0.12), 0.55).add(vec3(0.10, 0.20, 0.17).mul(caus));
    }
    mat.emissiveNode = vec3(0.0, 0.0, 0.0);
    mat.roughnessNode = float(OLD ? 0.55 : 0.85); mat.metalnessNode = float(OLD ? 0.1 : 0.0);
    // body wave: amplitude grows toward the tail (fish faces +Z)
    const tail = smoothstep(0.15, -0.3, P.z);
    const swim = P.x.add(sin(time.mul(11).add(P.z.mul(9)).add(ph)).mul(0.045).mul(tail.add(0.15)));
    const refr = OLD ? float(0) : sin(time.mul(2.3).add(P.z.mul(5)).add(ph.mul(3))).mul(0.035);
    mat.positionNode = vec3(swim.add(refr), P.y, P.z.add(OLD ? float(0) : sin(time.mul(1.9).add(P.x.mul(6)).add(ph)).mul(0.03)));
    const N = 9; this._oldFish = OLD;
    this.fish = makeSet(src.geometry, mat, N, 1.7); this.group.add(this.fish.group);
    // each fish is an agent: it has its own position/velocity and chases a moving slot near the boat
    this.fishState = Array.from({ length: N }, (_, i) => ({
      side: i % 2 ? 1 : -1, off: 1.4 + (i % 3) * 0.8 + Math.random() * 0.6, lead: -3 + Math.random() * 10,
      ph: Math.random() * 6.28, sc: 0.8 + Math.random() * 0.35, jump: -1,
      p: new THREE.Vector3(), v: new THREE.Vector3(), yaw: 0, init: false,
      mode: 'follow', modeT: 3 + Math.random() * 8, burst: 0, wander: new THREE.Vector3(),
    }));
  }

  // mobile / low tiers show fewer fish
  setFishCount(k) { this.fish.list.forEach((m, i) => { m.visible = i < k; }); this.fishActive = k; }

  update(t, dt, boatPos, boatFwd, camPos, audible) {
    // pendulums (lanterns): damped, gust-driven, two axes
    for (const p of this.pendulums) {
      const w = gust(t, p.obj.getWorldPosition(_v).x) * 1.0;
      const f = (w * 0.22 + Math.sin(t * 1.7 + p.seed) * 0.05) - p.a;
      p.v += (f * 9.8 / p.len - p.v * 1.2) * dt; p.a += p.v * dt;
      p.vx += ((Math.sin(t * 1.23 + p.seed * 2) * 0.07 * w) - p.ax) * 9.8 / p.len * dt - p.vx * 1.2 * dt; p.ax += p.vx * dt;
      p.obj.rotation.set(p.ax, 0, p.a);
    }
    // sign
    {
      const s = this.signState, w = gust(t, this.signRoot.position.x);
      s.v += ((w * 0.2 + Math.sin(t * 1.3) * 0.05 - s.a) * 12 - s.v * 1.1) * dt; s.a += s.v * dt;
      this.signSwing.value = s.a;
    }
    // fish shadow the boat just under the surface, dorsal fins breaking it; now and then one leaps
    // fish chase the boat: attracted to a drifting slot at the bow/flanks, they overshoot, dart in bursts,
    // peel off to investigate something and race back, and keep apart from each other.
    const side = _sd.set(boatFwd.z, 0, -boatFwd.x);
    const n = this.fishActive ?? this.fishState.length;
    const boatV = _bv.copy(boatPos).sub(this._lastBoat ?? boatPos).divideScalar(Math.max(dt, 1e-3));
    this._lastBoat = (this._lastBoat ?? new THREE.Vector3()).copy(boatPos);
    const bspd = Math.min(boatV.length(), 6);
    for (let i = 0; i < n; i++) {
      const f = this.fishState[i];
      if (!f.init || f.p.distanceTo(boatPos) > 40) {
        f.p.copy(boatPos).addScaledVector(boatFwd, f.lead - 6).addScaledVector(side, f.side * (f.off + 2)); f.v.copy(boatFwd).multiplyScalar(bspd); f.init = true;
      }
      // behaviour switching
      f.modeT -= dt;
      if (f.modeT <= 0) {
        const r = Math.random();
        if (f.mode === 'follow' && r < 0.35) { f.mode = 'stray'; f.modeT = 1.5 + Math.random() * 2.5;
          f.wander.copy(boatPos).addScaledVector(side, f.side * (5 + Math.random() * 5)).addScaledVector(boatFwd, -2 + Math.random() * 10); }
        else { f.mode = 'follow'; f.modeT = 3 + Math.random() * 7; f.burst = 0.6 + Math.random() * 0.5; }
      }
      // target: a slot that slides along the hull (bow-riding <-> flank), plus lazy weave
      const lead = f.lead + Math.sin(t * 0.33 + f.ph) * 3.5 + Math.sin(t * 0.9 + f.ph * 2) * 0.8;
      const off = f.side * (f.off + Math.sin(t * 0.5 + f.ph) * 0.9);
      const tgt = f.mode === 'stray' ? f.wander : _p.copy(boatPos).addScaledVector(boatFwd, lead + bspd * 0.6).addScaledVector(side, off);
      const to = _t2.copy(tgt).sub(f.p); to.y = 0;
      const dist = to.length();
      // arrive + chase: speed scales with distance, bursts when catching up
      f.burst = Math.max(0, f.burst - dt);
      const want = Math.min(1.2 + dist * 0.9 + bspd, f.burst > 0 ? 7 : 4.5);
      const desired = to.normalize().multiplyScalar(want);
      const steer = desired.sub(f.v); steer.y = 0;
      const maxA = f.burst > 0 ? 14 : 6;
      if (steer.length() > maxA) steer.setLength(maxA);
      f.v.addScaledVector(steer, dt);
      // separation from school mates and from the hull
      for (let j = 0; j < n; j++) { if (j === i) continue; const o = this.fishState[j]; const dx = f.p.x - o.p.x, dz = f.p.z - o.p.z, d2 = dx * dx + dz * dz;
        if (d2 < 0.8 && d2 > 1e-5) { f.v.x += dx / d2 * 0.6 * dt; f.v.z += dz / d2 * 0.6 * dt; } }
      const hx = f.p.x - boatPos.x, hz = f.p.z - boatPos.z, lat = hx * side.x + hz * side.z, lon = hx * boatFwd.x + hz * boatFwd.z;
      if (Math.abs(lat) < 1.3 && lon > -3.5 && lon < 3.5) { const k = (1.3 - Math.abs(lat)) * 8 * dt * (lat >= 0 ? 1 : -1); f.v.addScaledVector(side, k); }
      f.v.y = 0; f.p.addScaledVector(f.v, dt);
      // heading follows velocity with a turn-rate limit; the body banks into turns
      const sp = f.v.length();
      if (sp > 0.05) { const wantYaw = Math.atan2(f.v.x, f.v.z); let dy = wantYaw - f.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        const turn = THREE.MathUtils.clamp(dy, -dt * 5, dt * 5); f.yaw += turn; f.roll = THREE.MathUtils.lerp(f.roll ?? 0, THREE.MathUtils.clamp(-turn / Math.max(dt, 1e-3) * 0.08, -0.5, 0.5), Math.min(1, dt * 6)); }
      let y = (this._oldFish ? -0.16 : -0.34) * f.sc - (f.mode === 'stray' ? 0.14 : 0) + Math.sin(t * 2 + f.ph) * 0.03, pitch = 0;
      if (f.jump >= 0) {
        f.jump += dt * 1.4; const u = f.jump;
        if (u >= 1) f.jump = -1; else { y = -0.1 + Math.sin(u * Math.PI) * 0.9; pitch = -Math.cos(u * Math.PI) * 0.9; }
      }
      _q.setFromEuler(_e.set(pitch, f.yaw, (f.roll ?? 0) + Math.sin(t * 3 + f.ph) * 0.04, 'YXZ'));
      _m.compose(_p.copy(f.p).setY(y), _q, _s.setScalar(f.sc));
      this.fish.setMatrixAt(i, _m);
    }
        if (t > this.nextSplash) {
      const f = this.fishState[Math.floor(Math.random() * (this.fishActive ?? this.fishState.length))]; f.jump = 0;
      this.nextSplash = t + 7 + Math.random() * 9;
      if (audible) setTimeout(() => this.mixer.oneShot('splash', 0.35), 650);
    }
        if (audible && t > this.nextWings) { this.nextWings = t + 22 + Math.random() * 20; this.mixer.oneShot('wings', 0.25); }
    // creak when the camera is near a swinging sign/lantern
    if (audible && t > this.nextCreak) {
      this.nextCreak = t + 4 + Math.random() * 5;
      const d = Math.min(camPos.distanceTo(this.signRoot.position), ...['cabin', 'shack'].map((k) => Math.hypot(camPos.x - PROP_SITES[k].x, camPos.z - PROP_SITES[k].z)));
      if (d < 40) this.mixer.oneShot('creak', 0.4 * (1 - d / 40));
    }
  }
}
// small set of plain meshes with an InstancedMesh-like setMatrixAt/getMatrixAt
function makeSet(geo, mat, n, phK) {
  const group = new THREE.Group(), list = [];
  for (let i = 0; i < n; i++) { const m = new THREE.Mesh(geo, mat); m.matrixAutoUpdate = false; m.userData.ph = i * phK; m.frustumCulled = false; group.add(m); list.push(m); }
  return { group, list, setMatrixAt: (i, M) => { list[i].matrix.copy(M); list[i].matrixWorldNeedsUpdate = true; }, getMatrixAt: (i, M) => M.copy(list[i].matrix) };
}
const _v = new THREE.Vector3(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _m = new THREE.Matrix4(), _r = new THREE.Matrix4();
const _sd = new THREE.Vector3(), _bv = new THREE.Vector3(), _t2 = new THREE.Vector3();
