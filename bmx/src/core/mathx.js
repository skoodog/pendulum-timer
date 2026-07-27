// Deterministic math helpers shared by every system.

let _seed = 0x2f6e2b1 >>> 0;

export function seed(n) { _seed = (n >>> 0) || 1; }

/** xorshift32 — deterministic replacement for Math.random(). */
export function rng() {
  _seed ^= _seed << 13; _seed >>>= 0;
  _seed ^= _seed >>> 17;
  _seed ^= _seed << 5; _seed >>>= 0;
  return _seed / 4294967296;
}

export function rand(min, max) { return min + rng() * (max - min); }
export function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
export function pick(arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (v - a) / (b - a);
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const deg = Math.PI / 180;
export const TAU = Math.PI * 2;

/** Frame-rate independent exponential smoothing. */
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Wrap an angle to [-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

export function moveTowards(a, b, maxDelta) {
  const d = b - a;
  if (Math.abs(d) <= maxDelta) return b;
  return a + Math.sign(d) * maxDelta;
}

/** 2D value noise, deterministic, for texture and terrain generation. */
export function hash2(x, y) {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

export function valueNoise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smoothstep(xf), v = smoothstep(yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

export function fbm2(x, y, octaves = 5, lacunarity = 2, gain = 0.5) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq);
    norm += amp;
    amp *= gain; freq *= lacunarity;
  }
  return sum / norm;
}
