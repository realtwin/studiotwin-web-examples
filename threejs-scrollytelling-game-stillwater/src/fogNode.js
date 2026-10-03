// Stillwater height fog as a TSL node (WebGPU/WebGL2 via three/webgpu).
// §2.3: teal is a *band*, not a filter. A self-luminous teal layer pools on the water (below ~1.5 m, fading out
// by ~3.5 m), trunks rise out of it into a mauve-rose haze, and forward scattering has two lobes: the moon and,
// stronger, the coral sunset afterglow down-channel, so the vanishing point glows pink through the fog.
// Use: scene.fogNode = stillwaterFog();  live controls: FOG.color / FOG.density / FOG.band / FOG.sky.
import * as THREE from 'three/webgpu';
import {
  Fn, fog, uniform, positionWorld, cameraPosition, vec3, float, exp, abs, max, clamp, smoothstep, pow, dot, mix, select,
} from 'three/tsl';
import { MOON_DIR, FOG_TEAL, SUNSET_DIR, HAZE_MAUVE } from './fog.js';

export const FOG = {
  color: uniform(FOG_TEAL.clone()),                       // base teal (distance, dim)
  // luminances held at the pre-§2 fog's level: the first A/B (s6) with a 2x band / 1.8x haze read milky, with no
  // blacks anywhere; §2.3 changes *where* the teal sits and the haze hue, not how bright the fog is
  band: uniform(new THREE.Color(0.055, 0.17, 0.165)),      // teal band on the water
  density: uniform(0.012),
  sky: uniform(HAZE_MAUVE.clone()),                        // mauve-rose haze above the band
  glowTint: uniform(new THREE.Color(0.26, 0.13, 0.16)),    // haze toward the afterglow azimuth
  coral: uniform(new THREE.Color(0.95, 0.42, 0.45)),
  moon: uniform(new THREE.Color(0.55, 0.52, 0.50)),
  moonDir: uniform(MOON_DIR.clone()),
  sunsetDir: uniform(SUNSET_DIR.clone()),
  hazeNear: uniform(40),
};

// scene.fogNode must return the final colour: fog(color, factor) mixes it into the material output
export const stillwaterFog = () => Fn(() => {
  const ray = positionWorld.sub(cameraPosition);
  const dist = ray.length();
  const dir = ray.div(max(dist, 1e-4));
  const falloff = float(0.3);
  const y0 = max(cameraPosition.y, -0.5);
  const k = falloff.mul(ray.y);
  const lineInt = select(abs(k).greaterThan(1e-4), float(1).sub(exp(k.negate())).div(k), float(1));
  const hf = FOG.density.mul(exp(falloff.negate().mul(y0))).mul(lineInt).mul(dist);
  const haze = FOG.density.mul(0.06).mul(dist);
  const f = clamp(float(1).sub(exp(hf.add(haze).negate())), 0, 1);
  const y = positionWorld.y;
  // azimuthal weight toward the afterglow (horizontal only)
  const sd = max(dot(vec3(dir.x, 0, dir.z).normalize(), FOG.sunsetDir), 0);
  // band: teal densest at the waterline, gone by 3.5 m; haze: mauve above, blended over 1.5–5 m
  const bandW = smoothstep(3.5, 0.2, y);
  const hazeC = mix(FOG.sky, FOG.glowTint, pow(sd, 3).mul(0.8));
  const teal = mix(FOG.color, FOG.band, bandW);
  // key art: near canopy stays green-black, only the distant treeline takes the mauve; the haze colour fades in
  // with distance (FOG.hazeNear = start metres; 0 = old behaviour) and near fog above the band stays teal-dark
  const hazeD = select(FOG.hazeNear.greaterThan(0), smoothstep(FOG.hazeNear, FOG.hazeNear.mul(4), dist), float(1));
  let fc = mix(teal, hazeC, smoothstep(1.5, 5.0, y).mul(hazeD));
  // forward scattering: moon (secondary) + coral afterglow lobe (§2.3.3)
  const mo = max(dot(dir, FOG.moonDir), 0);
  fc = fc.add(FOG.moon.mul(pow(mo, 12).mul(0.08)));
  const so = max(dot(dir, FOG.sunsetDir), 0);
  fc = fc.add(FOG.coral.mul(pow(so, 6).mul(0.07)));
  return fog(fc, f);
})();
