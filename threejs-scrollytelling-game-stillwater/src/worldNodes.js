// Sky dome + reflective water as TSL node materials (three/webgpu, WebGPU with WebGL2 fallback).
// Direct ports of the GLSL makeSky / WaterShader in world.js.
import * as THREE from 'three/webgpu';
const ReflectorNode = THREE.ReflectorNode;
import {
  Fn, uniform, time, vec2, vec3, vec4, float, sin, cos, atan, asin, clamp, max, pow, dot, mix, smoothstep, exp,
  normalize, length, abs, sign, step, fract, floor, fwidth, texture, positionWorld, cameraPosition, reflector,
  mat2, Loop, uv, attribute, positionGeometry, positionLocal, cameraWorldMatrix,
  viewportDepthTexture, perspectiveDepthToViewZ, cameraNear, cameraFar, positionView, screenUV, normalMap, instanceIndex,
} from 'three/tsl';
import { MOON_DIR, FOG_TEAL, SUNSET_DIR } from './fog.js';

const PI = Math.PI;

// ---------------------------------------------------------------------------
// SKY: equirect texture, yaw, moon disc + halo (HDR for bloom), horizon sinks into the teal fog
// ---------------------------------------------------------------------------
export function makeSkyNode(skyTex, opts = {}) {
  const U = {
    intensity: uniform(opts.intensity ?? 0.5), yaw: uniform(opts.yaw ?? 2.35),
    moonDir: uniform(MOON_DIR.clone()), fog: uniform(FOG_TEAL.clone()), underM: uniform(opts.underM ?? 0),   // 11.1: mauve blend (1) bought no visible gain and stripe ratio 1.19->1.30; wide soft band kept, teal kept
    sunsetDir: uniform(SUNSET_DIR.clone()), split: uniform(opts.split ?? 0.3), glow: uniform(opts.glow ?? 1.0),
    sat: uniform(opts.sat ?? 0.65), moonDisc: uniform(opts.moonDisc ?? 1.1), moonHalo: uniform(opts.moonHalo ?? 0.25),
  };
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  mat.colorNode = Fn(() => skyDirColor(skyTex, U, normalize(positionWorld.sub(cameraPosition))))();
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), mat);
  mesh.frustumCulled = false; mesh.renderOrder = -10; mesh.name = 'sky';
  mesh.onBeforeRender = (r, sc, cam) => { mesh.position.copy(cam.position); mesh.updateMatrixWorld(); };
  mesh.userData.U = U; mesh.userData.tex = skyTex;
  return mesh;
}

// sky colour for a world direction d (node). Shared by the dome and the water, which samples it along the
// reflected ray where the planar reflector saw no geometry (the reflector pass never contains the dome: ?skymag
// painted the dome magenta and the raw mirror did not change, at dome radius 900, 100, 20 or 5 m).
export function skyDirColor(skyTex, U, d) {
  {
    const c = cos(U.yaw), s = sin(U.yaw);
    const r = vec3(c.mul(d.x).sub(s.mul(d.z)), d.y, s.mul(d.x).add(c.mul(d.z)));
    const rr = normalize(vec3(r.x, max(r.y, 0.004), r.z));
    const suv = vec2(atan(rr.z, rr.x).mul(0.5 / PI).add(0.5), asin(clamp(rr.y, -1, 1)).div(PI).add(0.5));
    let col = texture(skyTex, suv).rgb.mul(U.intensity);
    // §11 S5.3 / §2.2.2: the sky7 texture now carries the plate's palette (rose cumulus, navy zenith, coral band),
    // so the split-tone is only a light time-of-day consistency pass (0.85 -> 0.3). Zenith deep indigo-violet,
    // mid lavender; lit cloud tops rose, warming to peach toward the horizon.
    const lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    const shade = mix(vec3(0.16, 0.15, 0.34), vec3(0.45, 0.36, 0.7), smoothstep(0.7, 0.05, d.y));
    const lit = mix(vec3(1.15, 0.74, 0.8), vec3(1.25, 0.7, 0.55), smoothstep(0.35, 0.05, d.y));
    const tone = mix(shade, lit, smoothstep(0.18, 0.55, lum));
    col = mix(col, tone.mul(lum).mul(1.4), U.split);
    // §2.2 palette: the key art's sky is dusty lavender (sat 0.27, R-G 11) where the render ran hot magenta
    // (sat 0.33, R-G 30): pull chroma toward luminance and lift green a touch
    {
      const l2 = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l2), col, U.sat).mul(vec3(0.97, 1.04, 0.98));
    }
    // darken the zenith so the top corners frame the shot (target <= 0.08 linear)
    col = col.mul(mix(float(1), float(0.55), smoothstep(0.35, 0.9, d.y)));
    // §2.2.4 moon: crisp limb, tight halo (was a "streetlight in fog")
    const m = dot(d, U.moonDir);
    const disc = smoothstep(0.99972, 0.99984, m);
    const mm = max(m, 0);
    const halo = pow(mm, 2500).mul(U.moonHalo).add(pow(mm, 180).mul(0.05)).add(pow(mm, 16).mul(0.006));
    const moonC = vec3(1.0, 0.94, 0.8);
    col = mix(col, moonC.mul(U.moonDisc), disc).add(moonC.mul(halo));
    // §2.2.1 horizon afterglow: coral at the horizon -> rose at d.y 0.12, strongest toward sunsetDir but present
    // everywhere. Replaces the old blend into fog-teal; only a thin teal remains *below* the horizon.
    const az = pow(max(dot(normalize(vec3(d.x, 0, d.z)), U.sunsetDir), 0), 1.5).mul(0.6).add(0.4);
    const glowC = mix(vec3(0.95, 0.42, 0.45), vec3(0.78, 0.35, 0.55), smoothstep(0.0, 0.12, d.y));
    const glowW = smoothstep(0.2, 0.02, d.y).mul(smoothstep(-0.03, 0.01, d.y)).mul(az).mul(U.glow);
    col = mix(col, glowC.mul(0.55), glowW.mul(0.7)).add(glowC.mul(glowW).mul(0.12));
    const under = smoothstep(0.0, -0.04, d.y);
    // 11.1: the teal below the horizon showed as a 2–4 px saturated cyan stroke where the far water plane ends;
    // blend it toward the afterglow mauve (?underm=0 restores the teal), and over a wider band so there's no edge
    const under2 = smoothstep(0.005, -0.06, d.y);
    const underC = mix(U.fog.mul(1.25).add(vec3(0.02, 0.012, 0.02)), glowC.mul(0.5).add(U.fog.mul(0.4)), U.underM);
    col = mix(col, underC, under2);
    return col;
  }
}

// ---------------------------------------------------------------------------
// WATER: planar reflection (ReflectorNode), analytic ripples, boat wake, moon glitter, lamp spill
// ---------------------------------------------------------------------------
const hash = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));

export function makeWaterNode(opts = {}) {
  // 11.2: cyan sparkle (bioK) drove t6.5 stripes 1.57->1.85 and isn't in the key art -> 0; lampK 1.6->0.8 shrinks the t6.5 orange pool 13.2->9.8 %
  const U = {
    // §2.5.2 deep: bluer, less green
    moonDir: uniform(MOON_DIR.clone()), deep: uniform(new THREE.Color(0.006, 0.012, 0.016)),
    boat: uniform(new THREE.Vector3()), boatFwd: uniform(new THREE.Vector2(0, 1)),
    speed: uniform(0), glitter: uniform(1), reflGain: uniform(opts.reflGain ?? 0.62), dbg: uniform(0),
    // §2.5.1 mirror gain at grazing angles (near water stays dark via Fresnel + the base gain)
    reflGrazing: uniform(opts.reflGrazing ?? 0.85),
    sunsetDir: uniform(SUNSET_DIR.clone()), sunGlitter: uniform(1), skyRefl: uniform(opts.skyRefl ?? 1.3), skyBend: uniform(opts.skyBend ?? 0.1), reflV: uniform(opts.reflV ?? 2.4), ripAmp: uniform(1), heron: uniform(new THREE.Vector3(0, -99, -9999)), aaPx: uniform(opts.aaPx ?? 8), lampK: uniform(opts.lampK ?? 0.8), bioK: uniform(opts.bioK ?? 0), lampW: uniform(opts.lampW ?? 2.5), lampD: uniform(opts.lampD ?? 0.012), lampBar: uniform(opts.lampBar ?? 1), lampBarF: uniform(opts.lampBarF ?? 2.4), lampL: uniform(opts.lampL ?? 26), boatRefl: uniform(opts.boatRefl ?? 1), boatReflR: uniform(opts.boatReflR ?? 7), skyNear: uniform(opts.skyNear ?? 60), skyNearW: uniform(opts.skyNearW ?? 0), skyFar: uniform(opts.skyFar ?? 260),
  };
  const refl = reflector({ resolutionScale: opts.resolutionScale ?? 0.6, bounces: false, generateMipmaps: false, depth: !!opts.sky });
  // Off-axis story camera (setViewOffset lens shift): the mirrored camera's lookAt flips its x axis,
  // so the copied projection's shift term must be negated or the reflection slides sideways.
  // Same fix as the vendored WebGL Reflector; ReflectorBaseNode copies camera.projectionMatrix verbatim.
  {
    const base = refl.reflector, orig = base.getVirtualCamera.bind(base);
    base.getVirtualCamera = (camera) => {
      const vc = orig(camera);
      if (!vc.userData.shiftFix) {
        vc.userData.shiftFix = true;
        const pm = vc.projectionMatrix, copy = pm.copy.bind(pm);
        pm.copy = (m) => { copy(m); pm.elements[8] *= -1; return pm; };
      }
      return vc;
    };
  }
  const mat = new THREE.MeshBasicNodeMaterial();
  const W = Fn(() => {
    const wp = positionWorld;
    const V = normalize(cameraPosition.sub(wp));
    const dist = length(cameraPosition.sub(wp));
    const t = time;
    // 9 directional ripple octaves -> slope (d/dx, d/dz)
    const g = vec2(0).toVar();
    // anti-alias: metres per pixel along the (foreshortened) depth axis; octaves whose wavelength spans fewer
    // than ~6 px alias into horizontal slivers (?ripamp=0 took the stripe ratio 1.36 -> 1.08)
    const pxM = max(length(fwidth(wp.xz)), 1e-4);
    Loop(9, ({ i }) => {
      const fi = float(i);
      const a = fi.mul(2.399).add(0.4);
      const dir = vec2(cos(a), sin(a));
      const f = pow(1.37, fi).mul(0.35);
      const amp = float(0.05).div(pow(1.3, fi)).mul(smoothstep(U.aaPx.mul(0.5), U.aaPx, float(6.2832).div(f).div(pxM)));
      const ph = dot(dir, wp.xz).mul(f).add(t.mul(fi.mul(0.23).add(0.55))).add(fi.mul(1.7));
      g.addAssign(dir.mul(f.mul(amp).mul(cos(ph))));
    });
    // §3.3.3 near-camera calm: the key art's water is glassy; octave chop -30 % inside 25 m, the cat's-paws and
    // drop rings (added below) carry the life
    g.mulAssign(mix(0.7, 1.0, smoothstep(12, 25, length(cameraPosition.sub(wp)))));
    // slow swell + a drifting cat's-paw field (wind patches brush the surface, then calm)
    const cat = vnoise(wp.xz.mul(0.045).add(vec2(t.mul(0.05), t.mul(-0.03)))).mul(vnoise(wp.xz.mul(0.11).sub(vec2(t.mul(0.07), 0))));
    const cp = wp.xz.mul(2.1).add(vec2(t.mul(0.9), t.mul(0.4)));
    g.addAssign(vec2(sin(cp.x.add(sin(cp.y.mul(1.3)))), cos(cp.y.add(sin(cp.x.mul(0.8))))).mul(cat.mul(cat).mul(0.16)));
    // drop rings: insects / falling leaves / fish touching the surface — expanding, fading concentric ripples
    const ringE = float(0).toVar();
    for (let L = 0; L < 2; L++) {
      const cs = L === 0 ? 4.0 : 7.0;
      const gp = wp.xz.div(cs).add(L * 3.7);
      const cell = floor(gp);
      const h1 = hash(cell.add(L * 11.3)), h2 = hash(cell.add(4.1 + L)), h3 = hash(cell.add(8.9 + L));
      const period = h3.mul(5).add(4);
      const age = fract(t.div(period).add(h1)).mul(period);
      const ctr = cell.add(vec2(h1.mul(0.7).add(0.15), h2.mul(0.7).add(0.15))).mul(cs).sub(L * 3.7 * cs);
      const rv = wp.xz.sub(ctr); const rr = length(rv);
      const front = age.mul(0.55);
      const env = exp(age.mul(-0.7)).mul(exp(rr.sub(front).pow(2).mul(-6)));
      const ring = sin(rr.sub(front).mul(14)).mul(env).mul(0.09).mul(step(0.5, h2.add(0.3)));
      g.addAssign(rv.div(max(rr, 1e-3)).mul(ring));
      ringE.addAssign(env.mul(step(0.5, h2.add(0.3))).mul(smoothstep(0.2, 1.0, age)));
    }
    // boat wake
    const rel = wp.xz.sub(U.boat.xz);
    const side = vec2(U.boatFwd.y, U.boatFwd.x.negate());
    const along = dot(rel, U.boatFwd).negate(); const lat = dot(rel, side);
    // §3.1: the wake starts *under* the stern and ramps in (a step() here drew a straight line across the water)
    const wakeMask = smoothstep(-1.5, 2.5, along).mul(exp(along.mul(-0.05))).mul(U.speed);
    const arm = abs(abs(lat).sub(along.mul(0.36)));
    const wake = wakeMask.mul(exp(arm.mul(arm).mul(-1.6))).mul(sin(along.mul(2.6).sub(t.mul(6))).mul(0.4).add(0.6));
    const rl = length(rel);
    const bowRing = exp(rl.sub(2.9).pow(2).mul(-1.5)).mul(U.speed).mul(0.5);
    g.addAssign(side.mul(sign(lat)).mul(wake).mul(0.22).add(normalize(rel.add(1e-4)).mul(bowRing).mul(0.15).mul(sin(rl.mul(6).sub(t.mul(5))))));
    // §3.4 heron stands IN the water: slow concentric rings at its legs (period ~3 s)
    const hRel = wp.xz.sub(U.heron.xz); const hd = length(hRel);
    const hAge = fract(t.div(3)).mul(3);
    const hEnv = exp(hd.sub(hAge.mul(0.7)).pow(2).mul(-4)).mul(exp(hAge.mul(-0.6))).mul(smoothstep(6, 0.3, hd));
    g.addAssign(hRel.div(max(hd, 1e-3)).mul(sin(hd.sub(hAge.mul(0.7)).mul(12))).mul(hEnv).mul(0.12));
    g.mulAssign(mix(1, 0.25, smoothstep(40, 260, dist)).mul(U.ripAmp));
    const N = normalize(vec3(g.x.negate(), 1, g.y.negate()));
    // distorted reflection, clamped inside the target
    // it12: near the hull the mirror is 'hard': ripple distortion cut to 35 % so the boat's reflection holds its
    // shape (a harder boat reflection). bNear is 1 at the hull, 0 beyond boatReflR m; ?boatrefl=0 reverts.
    const bNear = smoothstep(U.boatReflR, U.boatReflR.mul(0.3), length(wp.xz.sub(U.boat.xz))).mul(U.boatRefl.min(1));
    const off = N.xz.mul(0.095).mul(mix(1, 0.3, smoothstep(10, 140, dist))).mul(mix(float(1), float(0.35), bNear));
    refl.uvNode = clamp(refl.uvNode.add(vec2(off.x.negate().mul(0.6), off.y.mul(U.reflV))), 0.002, 0.998);
    let rcRaw = refl.rgb;
    const baseUV = refl.uvNode;
    // §2.5 sky in the mirror: where the reflector drew nothing (depth still cleared), use the sky along the
    // reflected ray, bent by the ripple normal, so the water doubles the pink cumulus like the key art
    if (opts.sky) {
      const dn = refl.getDepthNode(); dn.uvNode = baseUV;
      // soft, distance-based: reflected geometry fades into the reflected sky with its mirrored distance (far
      // banks are hazy in the key art); a hard "reflector drew nothing" mask left flat, stair-stepped dark wedges
      const rz = perspectiveDepthToViewZ(dn.r, cameraNear, cameraFar).negate();
      const empty = smoothstep(U.skyNear, U.skyFar, rz);
      const rv = normalize(wp.sub(cameraPosition));
      // bend the reflected ray only a little (full ripple normal smeared the clouds into glitter)
      const Ns = normalize(mix(vec3(0, 1, 0), N, U.skyBend));
      const rd = rv.sub(Ns.mul(dot(rv, Ns).mul(2)));
      const skyR = skyDirColor(opts.sky.tex, opts.sky.U, normalize(vec3(rd.x, max(rd.y, 0.004), rd.z)));
      // near/steep water stays dark like the key art: the sky term follows its own Fresnel (the shared
      // mix(0.5, 0.95, fres) floor let the phone's near water reflect half the sky; blacks 22/26/38 vs 11/17/23)
      const fS = pow(float(1).sub(max(dot(N, V), 0)), 5);
      const skyW = mix(U.skyNearW, float(1), smoothstep(0.04, 0.4, fS));
      rcRaw = mix(rcRaw, skyR.mul(U.skyRefl).mul(skyW), empty);
    }
    const streak = vec3(0).toVar();
    const nTaps = opts.taps ?? 6;
    for (let k = 1; k <= nTaps; k++) {
      const tap = new ReflectorNode({ reflector: refl.reflector });
      const jit = g.x.mul(0.05 * k);
      tap.uvNode = clamp(baseUV.add(vec2(jit, g.y.abs().mul(0.12).add(0.004).mul(k))), 0.002, 0.998);
      const tc = tap.rgb; const tl = dot(tc, vec3(0.2126, 0.7152, 0.0722));
      streak.addAssign(tc.mul(smoothstep(0.12, 0.7, tl)).mul(smoothstep(0.02, 0.25, tc.x.sub(tc.z).div(tl.add(0.05)))).mul(1 - k / (nTaps + 1)));
    }
    // bright things in the mirror (lamps, moon, fireflies, windows) bloom out of the reflection; dark stays deep
    const rl0 = dot(rcRaw, vec3(0.2126, 0.7152, 0.0722));
    const warm = smoothstep(0.02, 0.25, rcRaw.x.sub(rcRaw.z).div(rl0.add(0.05)));
    const rcBoost = rcRaw.add(rcRaw.mul(smoothstep(0.05, 0.45, rl0)).mul(warm).mul(1.6));
    const rcL = dot(rcBoost, vec3(0.2126, 0.7152, 0.0722));
    const rc = rcBoost.mul(float(1).div(rcL.mul(0.9).add(1)).mul(rcL.mul(0.25).add(1)));   // soft highlight rolloff
    const fres = pow(float(1).sub(max(dot(N, V), 0)), 5).mul(0.92).add(0.08);
    const gain = mix(U.reflGain, U.reflGrazing, smoothstep(0.1, 0.6, fres));
    const col = U.deep.add(rc.mul(mix(0.5, 0.95, fres)).mul(gain)).toVar();
    col.addAssign(streak.mul(0.55).mul(U.reflGain).mul(smoothstep(160, 15, dist)));
    // it12: hard boat mirror. Near the hull the reflected geometry gets a full-strength, Fresnel-free term on top
    // (the shared Fresnel left the steep near water at ~0.5 x 0.62 of the mirror, so the white hull read as a
    // smudge). Sky reflection and far water are untouched (bNear is 0 there).
    col.addAssign(rc.mul(bNear).mul(U.boatRefl).mul(float(1).sub(mix(0.5, 0.95, fres).mul(gain))).mul(0.85));
    // grazing sheen: the mauve sky laid over the far water, broken by the ripples. §2.5.3: weighted toward the
    // afterglow azimuth and warmed there, so the far water glows pink where the sky does
    const toPw = normalize(wp.xz.sub(cameraPosition.xz));
    const sunAz = max(dot(toPw, normalize(vec2(U.sunsetDir.x, U.sunsetDir.z))), 0);
    const sheen = fres.mul(smoothstep(0.02, 0.2, N.y.sub(0.97).abs().oneMinus().mul(0.2))).mul(smoothstep(8, 90, dist));
    const sheenC = mix(vec3(0.16, 0.1, 0.19), vec3(0.34, 0.16, 0.18), pow(sunAz, 3));
    col.addAssign(sheenC.mul(sheen).mul(mix(0.4, 1.0, pow(sunAz, 2))).mul(0.55));
    // moon glitter
    const H = normalize(V.add(U.moonDir));
    const lobe = pow(max(dot(N, H), 0), 60);
    // anisotropic moon column: narrow across the view, long toward the camera (the classic glitter path)
    const md = normalize(vec2(U.moonDir.x, U.moonDir.z));
    const toP = normalize(wp.xz.sub(cameraPosition.xz));
    const across = abs(md.x.mul(toP.y).sub(md.y.mul(toP.x)));
    const column = exp(across.mul(across).mul(-260)).mul(step(0, dot(md, toP)));
    const fg = vec2(0).toVar();
    for (let k = 0; k < 3; k++) {
      const a2 = 0.9 + k * 2.1, f2 = [7.0, 11.3, 17.9][k];
      const d2 = vec2(Math.cos(a2), Math.sin(a2));
      const ph2 = dot(d2, wp.xz).mul(f2).add(t.mul(2.2 + k * 0.9)).add(vnoise(wp.xz.mul(0.8 + k)).mul(6.28));
      fg.addAssign(d2.mul(cos(ph2)).mul(0.22));
    }
    const fpx = fwidth(wp.x).add(fwidth(wp.z));
    const fineFade = smoothstep(0.09, 0.02, fpx);       // drop the capillaries before they alias
    const Nf = normalize(N.add(vec3(fg.x.negate(), 0, fg.y.negate()).mul(fineFade)));
    const glit = float(0).toVar();
    for (let L = 0; L < 2; L++) {
      const sc = L === 0 ? 9.0 : 15.0;
      const gp = wp.xz.mul(sc).add(vec2(t.mul(0.35 + L * 0.2), t.mul(-0.2)));
      const cell = floor(gp), fc = fract(gp);
      const h1 = hash(cell.add(31.7 + L)), h2 = hash(cell.add(12.9 + L)), h3 = hash(cell.add(47.3 + L));
      const pt = vec2(h1.mul(0.8).add(0.1), h2.mul(0.8).add(0.1));
      const px = fwidth(gp.x).add(fwidth(gp.y));
      const r = max(px.mul(0.9), 0.05);
      const pnt = smoothstep(r, r.mul(0.2), length(fc.sub(pt)));
      // each facet has its own tilt; only facets that mirror the moon right now flash
      const Nc = normalize(Nf.add(vec3(h1.sub(0.5), 0, h3.sub(0.5)).mul(0.35)));
      const catchF = pow(max(dot(Nc, H), 0), 160);
      const tw = pow(sin(t.mul(h3.mul(3).add(2)).add(h1.mul(50))).mul(0.5).add(0.5), 4);
      glit.addAssign(pnt.mul(catchF).mul(tw).mul(smoothstep(0.45, 0.12, px)).mul(1 - L * 0.4));
    }
    glit.mulAssign(column.mul(0.8).add(0.2).mul(18));
    const stars = float(0).toVar();
    for (let L = 0; L < 2; L++) {
      const ang = 0.61 + L * 1.37, sc = L === 0 ? 2.3 : 4.1;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const gp = vec2(wp.x.mul(ca).add(wp.z.mul(sa)), wp.x.mul(-sa).add(wp.z.mul(ca))).mul(sc).add(L * 17);
      const cell = floor(gp), fc = fract(gp);
      const h1 = hash(cell), h2 = hash(cell.add(3.1)), h3 = hash(cell.add(7.7));
      const pt = vec2(h1.mul(0.7).add(0.15), h2.mul(0.7).add(0.15));
      const px = fwidth(gp.x).add(fwidth(gp.y));
      const rr = float(0.05);
      const dvec = fc.sub(pt);
      // glints stretch toward the camera (anisotropic, like real sun/moon glitter), and fade out once a cell
      // is smaller than ~2 px rather than blurring into a grid of soft squares
      const star = smoothstep(rr, 0, length(dvec.mul(vec2(1, 0.45)))).mul(step(mix(0.55, 0.08, column), h3)).mul(smoothstep(0.35, 0.08, px));
      const Nm = normalize(N.add(vec3(hash(cell.add(1.3)).sub(0.5), 0, hash(cell.add(5.9)).sub(0.5)).mul(0.22)));
      const catchL = mix(pow(max(dot(Nm, H), 0), 900), pow(max(dot(Nm, H), 0), 40), column);
      const tw = pow(sin(t.mul(h1.mul(2.2).add(1.3)).add(h2.mul(60))).mul(0.5).add(0.5), 6);
      stars.addAssign(star.mul(catchL).mul(tw).mul(0.8).mul(1 - L * 0.35).mul(0.2));
    }
    // organic ripple brightness: domain-warped value noise + the real slope field (no sin*sin lattice)
    const rw = wp.xz.mul(1.3).add(vec2(t.mul(0.4), t.mul(-0.25)));
    const warpv = vec2(vnoise(rw.mul(0.7)), vnoise(rw.mul(0.7).add(5.2))).mul(2.5);
    const ripple = vnoise(rw.add(warpv)).mul(2).sub(1).mul(0.6).add(g.x.mul(2.5)).add(g.y.mul(2)).clamp(-1, 1);
    const shimmer = ripple.mul(0.5).add(0.5).pow(2).mul(0.3).mul(smoothstep(14, 60, dist)).mul(column).mul(smoothstep(1.5, 6, dist)).mul(mix(1.8, 1, smoothstep(10, 120, dist))).mul(smoothstep(0.05, 0.3, dot(normalize(vec2(U.moonDir.x, U.moonDir.z)), toP)));
    const spec = stars.mul(5).mul(column.mul(2.5).add(0.15)).add(lobe.mul(0.05)).add(shimmer.mul(0.9)).add(column.mul(0.06)).mul(smoothstep(420, 20, dist));
    // moon path in #FFF0CC like the disc (a blue-white column read as a cold blob against the warm sky)
    // §3.4 no source-less glitter pool under the heron
    const hCalm = smoothstep(0.5, 4, length(wp.xz.sub(U.heron.xz)));
    col.addAssign(vec3(1.0, 0.9, 0.72).mul(spec).mul(U.glitter).mul(hCalm));
    col.addAssign(vec3(1.0, 0.97, 0.92).mul(glit).mul(U.glitter).mul(hCalm).mul(smoothstep(300, 20, dist)));
    // §3.3.2 afterglow glitter path: the key art's hero light path is golden, under the horizon glow. Second
    // anisotropic column aimed at sunsetDir (#FFB070), at least as bright as the moon column; ripple-broken.
    {
      const sd2 = normalize(vec2(U.sunsetDir.x, U.sunsetDir.z));
      const across2 = abs(sd2.x.mul(toP.y).sub(sd2.y.mul(toP.x)));
      const column2 = exp(across2.mul(across2).mul(-180)).mul(smoothstep(0.05, 0.3, dot(sd2, toP)));
      const brk = ripple.mul(0.5).add(0.5).pow(2);
      const path = column2.mul(brk.mul(0.35).add(0.05)).mul(smoothstep(6, 30, dist)).mul(smoothstep(420, 60, dist))
        .add(stars.mul(5).mul(column2).mul(2.5));
      col.addAssign(vec3(1.0, 0.69, 0.44).mul(path).mul(U.sunGlitter).mul(U.glitter));
    }
    // sky glitter everywhere: ripple crests catch the mauve sky and the moon's halo as fine, twinkling needles
    const crest = ripple.mul(0.5).add(0.5).pow(4).mul(smoothstep(0.02, 0.06, length(g))).mul(smoothstep(12, 40, dist));
    const skyCatch = pow(max(dot(N, H), 0), 6).mul(0.6).add(0.4);
    col.addAssign(mix(vec3(0.62, 0.48, 0.78), vec3(0.75, 0.9, 1.0), skyCatch).mul(crest).mul(skyCatch).mul(0.16).mul(smoothstep(3, 10, dist)).mul(smoothstep(160, 30, dist)).mul(U.glitter));
    // bioluminescence: plankton points that wake up in the boat's wake, in drop rings and in slow drifting blooms
    {
      const bp = wp.xz.mul(2.6);
      const bc = floor(bp), bf = fract(bp);
      const bh = hash(bc.add(21.7)), bh2 = hash(bc.add(9.3)), bh3 = hash(bc.add(2.9));
      const pt = vec2(bh.mul(0.8).add(0.1), bh2.mul(0.8).add(0.1));
      const bpx = fwidth(bp.x).add(fwidth(bp.y));
      const bl = length(bf.sub(pt));
      const dot0 = smoothstep(0.12, 0.0, bl).add(exp(bl.mul(bl).mul(-40)).mul(0.35)).mul(step(0.45, bh3)).mul(smoothstep(1.2, 0.35, bpx));
      const bloomField = smoothstep(0.7, 0.95, vnoise(wp.xz.mul(0.07).add(vec2(t.mul(0.02), t.mul(-0.015)))));
      // §3.1: hull glow sits aft and to the sides (a plain radial disc lit the water ahead of the bow)
      const bnear = exp(length(wp.xz.sub(U.boat.xz)).mul(-0.28)).mul(smoothstep(-3, 1, along).mul(0.7).add(0.3));
      // §3.1: trail ramps in under the stern (no hard plane), its edge is broken by noise, and a turbulent prop-wash core
      // widens with age; brightness still decays with distance astern
      const trailEdge = smoothstep(0.2, 0.6, vnoise(wp.xz.mul(0.6).add(t.mul(0.1))).add(0.35));
      const trail = smoothstep(-1.5, 2.5, along).mul(exp(along.mul(-0.07)))
        .mul(exp(lat.mul(lat).mul(-0.18).div(along.mul(0.04).add(1))).add(exp(lat.mul(lat).mul(-2)).mul(smoothstep(0, 3, along)).mul(0.6)))
        .mul(trailEdge);
      const excite = wake.mul(3).add(trail.mul(1.6)).add(bnear.mul(0.25)).add(bloomField.mul(bloomField).mul(1.2));
      const pulse = pow(sin(t.mul(bh.mul(1.7).add(0.6)).add(bh2.mul(40))).mul(0.5).add(0.5), 3);
      const bio = dot0.mul(smoothstep(0.12, 0.9, excite)).mul(excite.min(2)).mul(pulse.mul(0.7).add(0.3)).mul(smoothstep(120, 10, dist));
      col.addAssign(vec3(0.2, 0.95, 0.8).mul(bio).mul(U.bioK));
      // soft teal glow under the surface where the plankton is lit
      // 11.3.1: this under-surface glow was NOT gated by bioK, so with the plankton off (default since 11.2) it still
      // drew a teal patch that rides with the boat (bnear/trail/wake are boat-relative). Now it follows the plankton
      // switch; ?underglow=1 restores the old always-on glow for comparison.
      const UG = new URLSearchParams(location.search).has('underglow') ? float(1) : U.bioK;
      col.addAssign(vec3(0.02, 0.09, 0.08).mul(excite.min(1.5)).mul(smoothstep(80, 5, dist)).mul(0.5).mul(UG));
    }
    const bd = length(wp.xz.sub(U.boat.xz));
    // lamp spill as a glitter streak: long toward the camera, narrow across it, broken by the ripples
    const lr = wp.xz.sub(U.boat.xz); const cdir = normalize(cameraPosition.xz.sub(U.boat.xz));
    const lAlong = dot(lr, cdir), lAcross = abs(lr.x.mul(cdir.y).sub(lr.y.mul(cdir.x)));
    // §3.2.1: soft start under the hull instead of a hard step at the lamp's plane
    // §3.2: key art's window reflections are boat-wide, ~1.5x boat height long amber columns broken into ripple
    // bars; the old streak was ~0.4 m wide and died within ~8 m. Width/decay tunable (?lampw, ?lampd)
    // 11.1: key art's column is broken into horizontal ripple bars; bars are bands across the column (constant
    // lAlong), their phase wobbled by the ripple field so they shimmer instead of scrolling; ?lampbar=0 disables
    const barPh = lAlong.mul(U.lampBarF).add(ripple.mul(2.2)).add(t.mul(0.6));
    const bars = mix(float(1), smoothstep(0.1, 0.75, sin(barPh).mul(0.5).add(0.5)).mul(1.6), U.lampBar);
    const lampStreak = exp(lAcross.mul(lAcross).mul(U.lampW.negate())).mul(smoothstep(-0.5, 1.0, lAlong)).mul(exp(lAlong.mul(U.lampD.negate()))).mul(smoothstep(U.lampL, U.lampL.mul(0.55), lAlong)).mul(ripple.mul(0.3).add(0.7)).mul(bars);
    // 11.1: lampD 0.012 left the column at ~55 % after 50 m, so with the boat off-frame (phone t7.9) it swept in as
    // source-less orange smears and lifted the phone's bottom-edge blacks; hard length cap ?lampl (m)
    col.addAssign(vec3(1.0, 0.42, 0.12).mul(U.lampK).mul(lampStreak.pow(1.4)).mul(fres.mul(0.4).add(0.8)));
    col.addAssign(vec3(0.55, 0.62, 0.6).mul(wake).mul(0.08));
    // ?wdbg=1: (column, shimmer, stars); ?wdbg=2: the raw reflector image (what the mirror actually sees);
    // ?wdbg=3: fresnel-weighted mirror term alone
    const d1 = step(0.5, U.dbg).mul(step(U.dbg, 1.5)), d2 = step(1.5, U.dbg).mul(step(U.dbg, 2.5)), d3 = step(2.5, U.dbg);
    const outc = mix(col, vec3(column, shimmer, stars), d1);
    return mix(mix(outc, rcRaw, d2), rc.mul(mix(0.5, 0.95, fres)).mul(gain), d3);
  });
  mat.colorNode = W();
  // shoreline: fade the water out over its first ~0.6 m of depth so wet mud shows through (no hard seam)
  const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(screenUV).x, cameraNear, cameraFar);
  const thick = positionView.z.sub(sceneZ);
  const V2 = normalize(cameraPosition.sub(positionWorld));
  mat.transparent = true; mat.depthWrite = true;
  mat.opacityNode = smoothstep(0.0, 1.0, thick.mul(max(V2.y, 0.04)).div(0.6));
  const geo = new THREE.PlaneGeometry(opts.size ?? 4000, opts.size ?? 4000);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.add(refl.target);            // reflection plane rides with the water
  mesh.name = 'water';
  mesh.userData.U = U; mesh.userData.refl = refl;
  return mesh;
}

// ---------------------------------------------------------------------------
// MIST: upright camera-facing sheets drifting low over the water (instanced, value-noise alpha)
// ---------------------------------------------------------------------------
const vnoise = Fn(([p]) => {
  const i = floor(p), f = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  const a = hash(i), b = hash(i.add(vec2(1, 0))), c = hash(i.add(vec2(0, 1))), d = hash(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

export function makeMistNode(sourceList) {
  // A 30-80 m x 3-8 m billboard becomes a long, one-to-three-pixel scanline near the horizon. Because transparent
  // instances cannot be depth-sorted independently, overlapping wide cards expose their separate noise phases and
  // ends as the reported stair-stepped strips. Build the same total span from roughly isotropic foglets instead: their
  // independently feathered ends are short in screen space and their varied tops cannot join into a scanline.
  // ?mistcards=1 restores the old one-wide-card-per-sheet geometry for diagnosis and regression captures.
  const LEGACY_CARDS = new URLSearchParams(location.search).get('mistcards') === '1';
  const list = LEGACY_CARDS ? sourceList.map((o) => ({ ...o, offset: 0 })) : sourceList.flatMap((o, sheet) => {
    // Keep each foglet narrower than it is tall. A camera-facing foglet therefore cannot project to a long
    // horizontal scanline even when its vertical span is only a few pixels.
    const count = Math.max(1, Math.ceil(o.sx / (o.sy * 0.55)));
    const step = o.sx / count;
    return Array.from({ length: count }, (_, part) => {
      const raw = Math.sin((sheet + 1) * 91.17 + (part + 1) * 47.73) * 43758.5453;
      const h = raw - Math.floor(raw);
      return { ...o, sx: step * 1.12, sy: o.sy * (0.82 + h * 0.36), offset: (part + 0.5 - count * 0.5) * step };
    });
  });
  const plane = new THREE.PlaneGeometry(1, 1); plane.translate(0, 0.5, 0);
  const g = new THREE.InstancedBufferGeometry().copy(plane); g.instanceCount = list.length;
  const ip = new Float32Array(list.length * 3), is = new Float32Array(list.length * 2), io = new Float32Array(list.length);
  list.forEach((o, i) => { ip.set([o.x, o.y, o.z], i * 3); is.set([o.sx, o.sy], i * 2); io[i] = o.offset; });
  g.setAttribute('ipos', new THREE.InstancedBufferAttribute(ip, 3));
  g.setAttribute('iscale', new THREE.InstancedBufferAttribute(is, 2));
  g.setAttribute('ioffset', new THREE.InstancedBufferAttribute(io, 1));
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  const P = attribute('ipos', 'vec3'), S = attribute('iscale', 'vec2'), O = attribute('ioffset', 'float');
  const seed = fract(sin(dot(P.xz.add(O), vec2(12.9898, 78.233))).mul(43758.5453));
  const camR = LEGACY_CARDS ? normalize(cameraWorldMatrix.element(0).xyz.mul(vec3(1, 0, 1))) : normalize(cameraWorldMatrix.element(0).xyz);
  const camU = LEGACY_CARDS ? vec3(0, 1, 0) : normalize(cameraWorldMatrix.element(1).xyz);
  const drift = vec3(sin(time.mul(0.05).add(seed.mul(30))).mul(6), 0, 0);
  // Use both camera basis vectors. The old yaw-only billboard kept world Y as its vertical axis, so camera pitch
  // foreshortened every card into a scanline; a spherical billboard preserves each foglet's screen-space aspect.
  const wp = P.add(drift).add(camR.mul(O.add(positionGeometry.x.mul(S.x)))).add(camU.mul(positionGeometry.y.mul(S.y)));
  mat.positionNode = wp;
  const col = uniform(new THREE.Color(0.075, 0.17, 0.15));
  const U = uv();
  // isotropic noise in world units (the old uv-space noise was stretched 30-80 m wide -> horizontal bands)
  const wq = positionWorld.xz.add(positionWorld.y.mul(0.7)).mul(0.09).add(vec2(time.mul(0.035), time.mul(0.012))).add(seed.mul(9));
  const wy = positionWorld.y.mul(0.35);
  const n = vnoise(wq.add(vec2(wy, 0))).mul(0.5).add(vnoise(wq.mul(2.3).sub(vec2(0, wy))).mul(0.3)).add(vnoise(wq.mul(5.1)).mul(0.2));
  const edge = smoothstep(0, 0.3, U.x).mul(smoothstep(1, 0.7, U.x));
  const vert = smoothstep(0, 0.45, U.y).mul(smoothstep(1, 0.4, U.y));
  // Keep the old underwater cleanup: it avoids wasted overdraw, although depth/water bisections proved it was not
  // the source of the above-water strips.
  const aboveWater = smoothstep(0.08, 0.9, positionWorld.y);
  const dist = length(positionWorld.sub(cameraPosition));
  // 11.3 bisection: ?mistfar=D fades sheets out by distance D (default 420 -> 160..420 ramp)
  const FAR = parseFloat(new URLSearchParams(location.search).get('mistfar') || '420');
  const near = smoothstep(4, 22, dist).mul(smoothstep(FAR, FAR * 0.38, dist));
  // soft particles: fade where the sheet approaches the water / banks / trunks behind it (no hard cut lines)
  // ?mistnodepth (build-time): leave the viewportDepthTexture node out of the graph entirely. ?mistsoft=0 only
  // multiplied it away, so the mid-pass depth copy it forces (from the MSAA scene target) still happened.
  const NODEPTH = new URLSearchParams(location.search).has('mistnodepth');
  const soft = NODEPTH ? float(1) : smoothstep(0, 3.5, positionView.z.sub(perspectiveDepthToViewZ(viewportDepthTexture(screenUV).x, cameraNear, cameraFar)));
  // Decorrelate sub-pixel foglet coverage in both screen axes instead of quantizing a faint, smooth card to a
  // whole scanline. The legacy switch omits this so it reproduces the original geometry and rasterization together.
  const dith = fract(sin(dot(screenUV.mul(vec2(1731.3, 977.7)), vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5).mul(0.6);
  // §2.3.5: mist stays teal but picks up the afterglow toward the vanishing point (rose, up to 35 %)
  const toSun = max(dot(normalize(positionWorld.sub(cameraPosition).mul(vec3(1, 0, 1))), vec3(SUNSET_DIR.x, 0, SUNSET_DIR.z)), 0);
  const mcol = mix(col, vec3(0.2, 0.1, 0.13), pow(toSun, 3).mul(0.35));
  mat.colorNode = mcol.mul(n.mul(0.4).add(0.8));
  // debug (11.3 tearing bisection): ?mistsoft=0 drops the depth fade, ?mistnoise=0 the noise shape
  const dbgSoft = uniform(1), dbgNoise = uniform(1);
  const nn = mix(float(0.6), smoothstep(0.3, 0.85, n), dbgNoise);
  // Retain the earlier projected-size experiment for A/B diagnosis. It cannot solve overlapping-card silhouettes;
  // ?mistpx=0 disables it.
  const pxFade = new URLSearchParams(location.search).get('mistpx') === '0' ? float(1) : smoothstep(1 / 25, 1 / 60, fwidth(U.y));
  const coverageDither = LEGACY_CARDS ? float(1) : float(1).add(dith);
  mat.opacityNode = nn.mul(edge).mul(vert).mul(aboveWater).mul(near).mul(pxFade).mul(mix(float(1), soft, dbgSoft)).mul(coverageDither).mul(0.2).max(0);
  // ?mistdbg=1: paint the raw noise n opaque (red) and the final alpha x5 (green) to see which one tears
  const dbgView = uniform(0);
  // ?mistdbg=2: flat random colour per sheet instance (are the strips separate sheets?)
  const idc = vec3(fract(seed.mul(7.13)), fract(seed.mul(13.7)), fract(seed.mul(29.3)));
  const DBG2 = new URLSearchParams(location.search).get('mistdbg') === '2';
  mat.colorNode = mix(mat.colorNode, DBG2 ? idc : vec3(n, mat.opacityNode.mul(5), 0), dbgView);
  mat.opacityNode = mix(mat.opacityNode, edge.mul(vert).mul(aboveWater).mul(near).mul(0.9), dbgView);
  mat.userData.dbg = { soft: dbgSoft, noise: dbgNoise, view: dbgView };
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 5; mesh.name = 'mist';
  return mesh;
}

// ---------------------------------------------------------------------------
// FIREFLIES: additive billboards drifting over the banks, each on its own blink
// ---------------------------------------------------------------------------
export function makeFirefliesNode(list) {
  const g = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1)); g.instanceCount = list.length;
  const ip = new Float32Array(list.length * 4);
  list.forEach((o, i) => ip.set([o.x, o.y, o.z, o.seed], i * 4));
  g.setAttribute('ifly', new THREE.InstancedBufferAttribute(ip, 4));
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const F = attribute('ifly', 'vec4'), sd = F.w, t = time;
  // organic wander: three incommensurate loops per fly, plus a slow vertical bob
  const wob = vec3(
    sin(t.mul(0.31).add(sd.mul(50))).mul(1.4).add(sin(t.mul(0.83).add(sd.mul(13))).mul(0.5)),
    sin(t.mul(0.47).add(sd.mul(20))).mul(0.5).add(sin(t.mul(1.3).add(sd.mul(7))).mul(0.15)),
    cos(t.mul(0.27).add(sd.mul(40))).mul(1.4).add(cos(t.mul(0.71).add(sd.mul(29))).mul(0.5)));
  const c = F.xyz.add(wob);
  // slow breathing glow with an occasional bright flash (each fly on its own rhythm)
  const ph = t.mul(sd.mul(0.9).add(0.5)).add(sd.mul(80));
  const breath = sin(ph).mul(0.5).add(0.5);
  const flash = pow(max(sin(ph.mul(0.37).add(sd.mul(11))), 0), 18);
  const glow = breath.mul(breath).mul(0.75).add(flash.mul(1.6)).add(0.06);
  const dist = length(c.sub(cameraPosition));
  // keep at least ~3 px wide at any distance so far flies twinkle as points instead of vanishing / aliasing
  const size = max(float(0.34).add(glow.mul(0.22)), dist.mul(0.009));
  const camR = cameraWorldMatrix.element(0).xyz, camU = cameraWorldMatrix.element(1).xyz;
  mat.positionNode = c.add(camR.mul(positionGeometry.x.mul(size))).add(camU.mul(positionGeometry.y.mul(size)));
  const d = length(uv().sub(0.5)).mul(2);                 // 0 centre .. 1 edge (circle inscribed in the quad)
  const core = exp(d.mul(d).mul(-60));                    // hot pinpoint
  const halo = exp(d.mul(d).mul(-4.5)).mul(smoothstep(1, 0.6, d));   // soft falloff, zero before the quad edge
  const hue = mix(vec3(1.0, 0.82, 0.32), vec3(0.62, 1.0, 0.45), fract(sd.mul(7.31)));   // amber .. lime
  const a = core.mul(2.2).add(halo.mul(0.55));
  mat.colorNode = hue.mul(a).mul(glow).mul(5.5).add(vec3(1, 1, 0.9).mul(core).mul(flash).mul(3)).mul(smoothstep(170, 25, dist));
  mat.opacityNode = float(1);
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false; mesh.name = 'fireflies';
  return mesh;
}

// ---------------------------------------------------------------------------
// LILY PADS: StudioTwin lily material sampled in world space, radial veins
// ---------------------------------------------------------------------------
export function lilyMaterial(lilyTex, pad) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  // 11.3: real pad PBR set on the pad's own UVs (ShapeGeometry uv = shape xy in [-1,1]). ?oldlily reverts to the
  // v11 world-space wall texture. Per-pad hue/value jitter so a cluster doesn't read as one stamp.
  if (pad && !new URLSearchParams(location.search).has('oldlily')) {
    const pu = uv().mul(0.5).add(0.5);
    const h = fract(sin(float(instanceIndex).mul(12.9898)).mul(43758.5453));
    const alb = texture(pad.albedo, pu).rgb;
    // 11.3 render check: first pass read pale grey against the dark water (sky sheen on a too-glossy leaf); darker
    // albedo like the v11 pads and a waxy-but-not-mirror roughness floor
    // 2nd render check: 0.62 made them vanish into the water at t6.5; between that and the pale first pass
    // 3rd pass: 0.8 x muted tint still invisible at t6.5 (11.2 pads read pale grey, not green); full-strength green tint
    m.colorNode = alb.mul(mix(vec3(0.8, 1.05, 0.62), vec3(0.95, 1.0, 0.6), h)).mul(1.1);
    m.roughnessNode = texture(pad.rough, pu).r.mul(0.6).add(0.4).clamp(0.45, 0.9);
    m.envMapIntensity = 0.5;
    m.normalNode = normalMap(texture(pad.normal, pu), vec2(0.8, 0.8));
    // ?lilydbg: flat bright magenta so the pads can be located in a frame
    if (new URLSearchParams(location.search).has('lilydbg')) { m.colorNode = vec3(0, 0, 0); m.emissiveNode = vec3(1, 0, 1); }
    return m;
  }
  const wp = positionWorld;
  const lc = texture(lilyTex, wp.xz.mul(0.23)).rgb;
  const vein = sin(atan(wp.z, wp.x).mul(40)).mul(0.15).add(0.85);
  m.colorNode = mix(vec3(0.07, 0.13, 0.05), lc.mul(vec3(0.55, 0.7, 0.45)), 0.8).mul(vein);
  return m;
}

// ---------------------------------------------------------------------------
// BOAT: convert the glTF materials to node materials and light the cabin glass from inside
// ---------------------------------------------------------------------------
export function boatNodeMaterial(src, winU) {
  const m = new THREE.MeshStandardNodeMaterial();
  for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'roughness', 'metalness', 'transparent', 'opacity', 'side', 'alphaTest', 'vertexColors', 'envMapIntensity', 'normalScale', 'name'])
    if (src[k] !== undefined) m[k] = src[k] && src[k].clone && !src[k].isTexture ? src[k].clone() : src[k];
  m.color.copy(src.color); if (src.emissive) m.emissive.copy(src.emissive);
  const base = src.map ? texture(src.map, uv()).rgb.mul(uniform(src.color.clone())) : uniform(src.color.clone());
  const lum = dot(base, vec3(0.299, 0.587, 0.114));
  const L = positionLocal;
  const inCab = step(1.28, L.y).mul(step(L.y, 2.28)).mul(step(abs(L.x), 1.02)).mul(step(-0.62, L.z)).mul(step(L.z, 1.0));
  const glass = smoothstep(0.035, 0.11, lum).mul(smoothstep(0.42, 0.2, lum)).mul(inCab);
  m.emissiveNode = vec3(1.0, 0.45, 0.13).mul(glass).mul(1.25).mul(winU)
    .add(vec3(0.8, 0.84, 0.92).mul(smoothstep(0.55, 0.8, lum)).mul(base).mul(0.1));
  return m;
}
