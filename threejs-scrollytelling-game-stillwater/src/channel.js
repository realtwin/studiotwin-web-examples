// Swamp layout: a meandering channel parametrised by z. Everything (terrain mesh,
// tree placement, boat collisions, story camera) shares these pure functions.

export const Z_START = -120;
export const Z_END = 1500;

// centreline x as a function of z
export function cx(z) {
  return 58 * Math.sin(z / 230) + 24 * Math.sin(z / 97 + 1.0) + 8 * Math.sin(z / 41 + 2.0);
}
export function dcx(z) {
  return (58 / 230) * Math.cos(z / 230) + (24 / 97) * Math.cos(z / 97 + 1.0) + (8 / 41) * Math.cos(z / 41 + 2.0);
}

// channel half-width: narrow tunnels, a moon pool at the start, a wide lagoon at Heron Bend
export function halfWidth(z) {
  let w = 13 + 5 * Math.pow(Math.sin(z / 120), 2);
  w += 26 * Math.exp(-Math.pow((z - 70) / 70, 2));    // Moon Pool
  w += 20 * Math.exp(-Math.pow((z - 640) / 60, 2));   // Heron Bend lagoon
  w += 10 * Math.exp(-Math.pow((z - 1050) / 90, 2));  // Far reach
  return w;
}

// --- tiny deterministic noise -------------------------------------------------
function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}
export function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
export function fbm(x, y) {
  let v = 0, a = 0.5, f = 1;
  for (let i = 0; i < 4; i++) { v += a * vnoise(x * f, y * f); f *= 2.03; a *= 0.5; }
  return v;
}

// signed-ish distance from centreline (perpendicular approximation)
export function channelDist(x, z) {
  const s = dcx(z);
  return Math.abs(x - cx(z)) / Math.sqrt(1 + s * s);
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// terrain height: below water inside the channel, low muddy banks outside
export function terrainHeight(x, z) {
  const d = channelDist(x, z);
  const w = halfWidth(z) + (fbm(x * 0.05, z * 0.05) - 0.5) * 6;
  let bank = 0.15 + 0.9 * fbm(x * 0.03 + 7, z * 0.03) + 0.35 * fbm(x * 0.2, z * 0.2);
  // scattered pools out in the forest so the banks read as swamp, not lawn
  bank -= 1.2 * smoothstep(0.62, 0.72, fbm(x * 0.018 + 3, z * 0.018 - 5));
  let h = -1.6 + (bank + 1.6) * smoothstep(w - 3, w + 7, d);
  // close the ends of the world
  const endT = Math.max(smoothstep(Z_START + 60, Z_START, z), smoothstep(Z_END - 60, Z_END, z));
  h = h + (0.8 - h) * endT;
  return h;
}

export function isWater(x, z) { return terrainHeight(x, z) < -0.35; }

// seeded RNG
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
