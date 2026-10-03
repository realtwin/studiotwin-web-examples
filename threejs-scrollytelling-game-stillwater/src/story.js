import * as THREE from 'three';
import { cx, dcx, halfWidth, terrainHeight } from './channel.js';
import { MOON_DIR } from './fog.js';

// Story shots, one per chapter. Offsets are in the boat's frame:
//   side (+ = boat's port/left when looking downstream), up, along (+ = ahead of the bow).
export const SHOTS = [
  /* 0 hero      */ { bz: 30,  cam: [-7, 5.5, -24], look: [2, 4.5, 40],   fov: 42, shift: 0 },
  /* 1 concept   */ { bz: 95,  cam: [-8.5, 2.6, 9], look: [2.2, 1.4, -1], fov: 34, shift: 0.17 },
  /* 2 env       */ { bz: 175, cam: [2.5, 0.55, -9], look: [-4, 16, 70],  fov: 58, shift: -0.17 },
  /* 3 meshes    */ { bz: 262, cam: [11, 7.5, -6],  look: [-6, 8, 26],    fov: 46, shift: 0.17 },
  /* 4 materials */ { bz: 350, cam: [-5, 1.2, 7],   look: [0.8, 0.2, 0.5], fov: 40, shift: -0.17 },
  /* 5 boat      */ { bz: 452, cam: [5.8, 2.1, 4.8], look: [-1.8, 1.3, 0.2], fov: 32, orbit: 1, shift: 0.17 },
  /* 6 heron     */ { bz: 550, cam: [-8, 1.6, -12],  look: [0, 1.2, 0],     fov: 34, heron: 1, shift: -0.17, lift: 1 },
  /* 7 solo      */ { bz: 572, cam: [-8, 1.6, -12],  look: [0, 1.2, 0],     fov: 30, heron: 2, shift: 0 },
  /* 8 sound     */ { bz: 640, cam: [0.8, 3.0, -10.5], look: [0, 1.6, 22], fov: 44, shift: 0.17 },
  /* 9 ledger    */ { bz: 730, cam: [-3, 12, -30],  look: [0, 3, 36],    fov: 44, shift: 0 },
  /* 10 finale    */ { bz: 810, cam: [-2, 6.5, -22],  look: [0, 9, 60],      fov: 46, shift: 0, moon: 1 },
];
// §4.2: chapters are ~100 m apart in world space (tools/path_audit.mjs fails the build above 110 m of camera travel).
// The heron wades 10 m downstream of the chapter-6 boat position so "the boat passes the heron" reads in one frame;
// it sits just upstream of the Heron Bend lagoon, where the channel is ~21 m wide, so the bird is ~20 m off the boat
// line rather than 36 m (at z 652 the 35 m lagoon half-width put it in a frame of nothing).

export const HERON_Z = 560;

export function boatFrame(z) {
  const f = new THREE.Vector3(dcx(z), 0, 1).normalize();
  const s = new THREE.Vector3(f.z, 0, -f.x);
  return { pos: new THREE.Vector3(cx(z), 0, z), f, s };
}

// wading spot for the heron on the port bank of the lagoon
export function heronSpot() {
  const z = HERON_Z;
  const { s } = boatFrame(z);
  const c = new THREE.Vector3(cx(z), 0, z);
  let best = null;
  // §4.2.2: search only the channel's edge band so the bird wades at the water line, not up on the bank
  for (let d = halfWidth(z) - 6; d < halfWidth(z) + 2; d += 0.25) {
    const p = c.clone().addScaledVector(s, d);
    const h = terrainHeight(p.x, p.z);
    if (h > -0.42) { best = p; best.y = Math.min(h, -0.05); best.d = d; break; }
  }
  if (!best) { best = c.clone().addScaledVector(s, halfWidth(z) + 1); best.y = -0.3; best.d = halfWidth(z) + 1; }
  best.yaw = Math.atan2(-s.x, -s.z) + 0.5;   // faces the channel, a little downstream
  return best;
}

// eased move between held shots, blended with 10% linear so the camera never fully stops
// it12: linear floor 0.1 -> 0.3 (?easelin): 0.1 left the held heron shots still for ~20 %vh of scroll each.
// preroll = metres of hero crane-in over T 0-0.5 (?preroll). tools/scroll_life.mjs gates both (DEAD_OK).
export const STORY_TUNE = { easeLin: 0.3, preroll: 4 };
if (typeof process !== 'undefined' && process.env) {
  if (process.env.EASELIN) STORY_TUNE.easeLin = +process.env.EASELIN;
  if (process.env.PREROLL) STORY_TUNE.preroll = +process.env.PREROLL;
}
const ease = (x) => { x = THREE.MathUtils.clamp(x, 0, 1); const k = STORY_TUNE.easeLin; return k * x + (1 - k) * THREE.MathUtils.smoothstep(x, 0.12, 0.88); };
const lerpArr = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const _g1 = new THREE.Vector3(), _g2 = new THREE.Vector3(), _g3 = new THREE.Vector3(), _g4 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// T in [0, SHOTS.length): continuous chapter parameter (chapter + local progress)
// view: { aspect, mobile } of the viewport. mobile applies the heron-shot tilt (text sits in the lower 60 % of a
// phone screen) and both feed the subject guard below. Defaults = 16:9 desktop (path_audit, storyAvoidPoints).
export function storyPose(T, time, heron, view = {}) {
  const aspect = view.aspect ?? 16 / 9, mobile = !!view.mobile;
  const n = SHOTS.length;
  const tc = THREE.MathUtils.clamp(T - 0.5, 0, n - 1);
  const i = Math.min(Math.floor(tc), n - 2);
  const f = ease(tc - i);
  const A = SHOTS[i], B = SHOTS[i + 1];
  // boat drifts linearly (continuous motion), camera eases between held shots
  const bz = A.bz + (B.bz - A.bz) * THREE.MathUtils.clamp(tc - i, 0, 1) + time * 0.25;
  let cam = lerpArr(A.cam, B.cam, f), look = lerpArr(A.look, B.look, f);
  // 11.3: blend the look *direction* (slerp, seen from the moving camera), not the look point. A point lerp swings
  // the gaze through ~90 deg in a few hundredths of T whenever the interpolated look point passes close to the
  // camera (meshes -> materials, T 4.15: 15-21 deg per 0.01 T). Held shots (f = 0, 1) are unchanged.
  {
    const dA = new THREE.Vector3(A.look[0] - cam[0], A.look[1] - cam[1], A.look[2] - cam[2]);
    const dB = new THREE.Vector3(B.look[0] - cam[0], B.look[1] - cam[1], B.look[2] - cam[2]);
    const len = dA.length() + (dB.length() - dA.length()) * f;
    dA.normalize(); dB.normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(dA, dB);
    const d = dA.applyQuaternion(new THREE.Quaternion().slerp(q, f));
    look = [cam[0] + d.x * len, cam[1] + d.y * len, cam[2] + d.z * len];
  }
  // 11.3: hold the lens a little longer on the heron -> sound pull-away, so the bird still reads as it recedes
  const fov = (A.fov + (B.fov - A.fov) * f) * (1 - 0.2 * THREE.MathUtils.smoothstep(T, 7.7, 7.95) * (1 - THREE.MathUtils.smoothstep(T, 8.1, 8.45)));
  const shift = (A.shift || 0) + ((B.shift || 0) - (A.shift || 0)) * f;
  // chapter-5 orbit around the hero boat
  const orbitW = (A.orbit ? 1 - f : 0) + (B.orbit ? f : 0);
  if (orbitW > 0) {
    const local = THREE.MathUtils.clamp(T - 5, 0, 1);
    // §4.2.4: sweep from port-aft around the stern to starboard abeam, so the orbit ends on the far side of the boat
    // line (the heron wades to port) and the dolly into the heron shot never crosses ahead of the bow
    const ang = -0.9 - local * 2.3;
    const r = 7.6;
    cam = lerpArr(cam, [Math.cos(ang) * r, 2.1 + local * 0.8, Math.sin(ang) * r], orbitW);
  }
  const fr = boatFrame(bz);
  const toWorld = (o, out) => out.copy(fr.pos).addScaledVector(fr.s, o[0]).addScaledVector(fr.f, o[2]).setY(o[1]);
  const _rel = new THREE.Vector3();
  const toLocal = (p) => { _rel.copy(p).sub(fr.pos); return [_rel.dot(fr.s), p.y, _rel.dot(fr.f)]; };
  // heron chapters: frame the heron with the boat drifting past. The heron framings are computed in world space,
  // then blended in *boat-frame* offsets (§4.2.4), so the transition from the chapter-5 orbit is a short dolly
  // around a nearby subject rather than a straight flight between two distant world points.
  const heronW = (A.heron ? 1 - f : 0) + (B.heron ? f : 0);
  if (heronW > 0 && heron) {
    // two heron framings: 1 = wide, from the far side of the boat line looking across it at the bird (boat in shot),
    //                     2 = close profile, framed to the bird itself
    const hfr = boatFrame(heron.z), hs = hfr.s, hf = new THREE.Vector3(Math.sin(heron.yaw || 0), 0, Math.cos(heron.yaw || 0));
    const side = new THREE.Vector3(hf.z, 0, -hf.x);
    if (side.dot(hs) > 0) side.negate();                 // stay on the open-water side
    const centre = hfr.pos;                              // channel centre abreast of the heron
    const shotCam = (k) => k === 2
      ? heron.clone().addScaledVector(side, 6.4).addScaledVector(hf, 1.6).setY(0.9)
      : centre.clone().addScaledVector(hs, -8).addScaledVector(hfr.f, -22).setY(1.6);
    const shotLook = (k) => k === 2
      ? heron.clone().addScaledVector(hf, 0.25).setY(0.78)
      : heron.clone().lerp(centre, 0.22).setY(1.2);      // aim between bird and boat line so both stay in frame
    const wa = A.heron ? 1 - f : 0, wb = B.heron ? f : 0;
    const hc = new THREE.Vector3(), lk = new THREE.Vector3();
    if (A.heron && B.heron) { hc.lerpVectors(shotCam(A.heron), shotCam(B.heron), f); lk.lerpVectors(shotLook(A.heron), shotLook(B.heron), f); }
    else { const k = A.heron || B.heron; hc.copy(shotCam(k)); lk.copy(shotLook(k)); }
    // slow push-in while the bird has the frame
    if (A.heron === 2 || B.heron === 2) {
      const w2 = (A.heron === 2 ? 1 - f : 0) + (B.heron === 2 ? f : 0);
      hc.lerp(lk, 0.12 * w2 * THREE.MathUtils.clamp(T - 7, 0, 1));
    }
    const w = Math.min(1, wa + wb);
    // §4.2.4: during the transition the heron framing is an *offset from the boat frame at the heron chapter's bz*,
    // so the camera dollies along with the boat and the boat stays ahead of the lens (a fixed world target left the
    // boat behind the camera at t≈6.2: a frame of reeds and the sign). Once the framing holds (w→1) the offset
    // converges to the world-fixed shot, so the bird does not slide in frame with the live boat drift.
    const hzb = boatFrame((B.heron ? B : A).bz);
    _rel.copy(hc).sub(hzb.pos);
    const hcOff = [_rel.dot(hzb.s), hc.y, _rel.dot(hzb.f)];
    const hold = THREE.MathUtils.smoothstep(w, 0.55, 1);   // 11.3: 0.92 made the boat-offset -> world-shot handoff a ~3 m / 0.01 T jump at T 6.3 and 7.7
    const hcLocal = lerpArr(hcOff, toLocal(hc), hold);
    cam = lerpArr(cam, hcLocal, w);
    // §4.3: while the shot is still travelling, aim at the angular bisector of boat and bird as seen from the
    // camera. A lerp of the two look *points* weights the far bird by distance and swings the boat out of a
    // portrait frame (t≈6.2 was reeds and the sign). Orbit look -> bisector over the first half of the move,
    // bisector -> the held framing over the second, so no frame holds neither subject.
    const herL = toLocal(heron);
    const dB = new THREE.Vector3(-cam[0], 1.2 - cam[1], -cam[2]).normalize();
    const dH = new THREE.Vector3(herL[0] - cam[0], herL[1] - cam[1], herL[2] - cam[2]).normalize();
    const bis = dB.add(dH).normalize();
    const mid = [cam[0] + bis.x * 20, cam[1] + bis.y * 20, cam[2] + bis.z * 20];
    const wA = THREE.MathUtils.smoothstep(w, 0, 0.45), wB = THREE.MathUtils.smoothstep(w, 0.55, 1);
    look = lerpArr(lerpArr(look, mid, wA), toLocal(lk), wB);
  }
  const camPos = toWorld(cam, new THREE.Vector3());
  // it12 hero pre-roll: T 0-0.5 used to be the clamped hero hold (75 %vh of scroll with a frozen camera). Now the
  // first half-chapter is a slow crane-down/push-in that lands exactly on the authored hero at T 0.5 (continuous).
  if (STORY_TUNE.preroll > 0 && T < 0.5) {
    // u: 1 at T 0 -> 0 at T 0.5, linear so the motion is constant per scrolled pixel
    const u = 1 - T / 0.5;
    const back = _g1.copy(toWorld(look, _g2)).sub(camPos).normalize();
    camPos.addScaledVector(back, -STORY_TUNE.preroll * u).y += STORY_TUNE.preroll * 0.35 * u;
  }
  const lookAt = toWorld(look, new THREE.Vector3());
  const lift = (A.lift ? 1 - f : 0) + (B.lift ? f : 0);
  // finale: turn toward the moon so its glitter path runs down the frame under the end card
  const moonW = B.moon ? f : (A.moon ? 1 : 0);
  if (moonW > 0) {
    const md = MOON_DIR.clone(); md.y = 0.0; md.normalize();
    const mk = camPos.clone().addScaledVector(md, 60); mk.y = camPos.y + 60 * 0.02;
    lookAt.lerp(mk, moonW);
  }
  // keep camera above water and above the banks
  const th = terrainHeight(camPos.x, camPos.z);
  camPos.y = Math.max(camPos.y, Math.max(th, 0) + 0.45);
  if (mobile && lift > 0) lookAt.y -= 1.05 * lift;
  // 11.1: phone close-heron framing (t≈7.9) had the bird at 87 % across; the 16:9 look point is between bird and
  // post. On a portrait frame, pull the horizontal aim onto the bird (keep the authored height).
  if (mobile && heron && (A.heron === 2 || B.heron === 2)) {
    const w2 = (A.heron === 2 ? 1 - f : 0) + (B.heron === 2 ? f : 0);
    const y = lookAt.y; lookAt.lerp(heron, (view.heronAim ?? 1.3) * w2 * THREE.MathUtils.smoothstep(T, 7.55, 7.9));
    lookAt.y = y;   // 11.3: this restore sat after a // comment in 11.2 and never ran
    // 11.2: full aim at t7.5 put 1.39->1.59 stripe water in frame; ramp in only for the 7.9 close-up
  }
  // §4.3 subject guard (boat + heron chapters only, 4 → 8): if neither subject is inside the frustum for THIS
  // viewport's aspect, rotate the gaze toward the nearer one (in angle) just enough to put it 20 % inside the edge.
  // Shots are authored for 16:9; a phone's ~15° horizontal half-FOV otherwise loses the boat on the orbit and on
  // the heron→sound transition (tools/path_audit.mjs checks both aspects).
  // 11.3 subject aim (replaces the §4.3 subject guard). The guard was a hard in/out-of-frame decision that swapped
  // targets within one scroll tick - 145 deg snaps at T 4.0, 6.3, 7.7, 7.95, the 'second camera fighting the scroll'
  // - and it still lost both subjects on the heron -> sound move. Now the gaze in the boat/heron act is steered toward
  // an authored aim point P(T) = mix(boat, bird, a(T)), with a(T) and the steering weight g(T) smooth functions of T
  // only. Every term is continuous, so the camera can't cut; tools/jerk_audit.mjs + path_audit.mjs gate it.
  {
    const ss = THREE.MathUtils.smoothstep;
    // Timings are in scroll T (held shots: boat 5.5, heron wide 6.5, heron close 7.5, sound 8.5).
    const g = ss(T, 3.9, 4.4) * (1 - ss(T, 8.05, 8.4)) * (view.aimK ?? 0.95);
    if (g > 0 && heron) {
      // aim = yaw/pitch blend of the boat and bird directions (a: 0 boat, 1 bird). Yaw is interpolated about world-up
      // so the blend stays well-defined when the two sit ~180 deg apart (the heron -> sound fly-past).
      // portrait: too narrow to hold boat and bird side by side at the wide shot, so it stays on the boat until the
      // dolly toward the bird, then hands over quickly (the bird enters the frame from the edge)
      const a = view.aspect < 1 ? ss(T, 6.76, 6.84) : THREE.MathUtils.clamp(ss(T, 6.35, 6.65) * 0.45 + ss(T, 6.65, 7.0) * 0.55, 0, 1);
      const dist = lookAt.distanceTo(camPos);
      const dA = _g1.copy(lookAt).sub(camPos).normalize();
      const dB = _g2.copy(boatFrame(bz).pos).setY(1.0).sub(camPos).normalize();
      const dH = _g3.copy(heron).setY(heron.y + 0.8).sub(camPos).normalize();
      const yB = Math.atan2(dB.x, dB.z), yH = Math.atan2(dH.x, dH.z);
      let dy = yH - yB; dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
      const yaw = yB + dy * a, pit = Math.asin(dB.y) * (1 - a) + Math.asin(dH.y) * a;
      const dP = _g4.set(Math.sin(yaw) * Math.cos(pit), Math.sin(pit), Math.cos(yaw) * Math.cos(pit));
      const qg = new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(dA, dP), g);
      lookAt.copy(camPos).addScaledVector(dA.applyQuaternion(qg), dist);
    }
  }
  // breathing handheld drift
  camPos.x += Math.sin(time * 0.31) * 0.12; camPos.y += Math.sin(time * 0.47) * 0.07;
  return { bz, camPos, lookAt, fov, shift, lift };
}

// sampled camera + boat path (for keeping trees/lilies out of shot)
export function storyAvoidPoints() {
  const pts = [];
  const her = heronSpot();
  for (let T = 0; T < SHOTS.length; T += 0.02) {
    const p = storyPose(T, 0, her);
    pts.push(p.camPos.clone());
    pts.push(boatFrame(p.bz).pos);
  }
  pts.push(her);
  // finale: carve a widening clearing from the end-card camera toward the moon
  const fin = storyPose(SHOTS.length - 0.5, 0, her);
  const md = MOON_DIR.clone(); md.y = 0; md.normalize();
  for (let k = 6; k < 420; k += 4) { const p = fin.camPos.clone().addScaledVector(md, k); p.y = 0; p.r = 5 + k * 0.32; pts.push(p); }
  return pts;
}
