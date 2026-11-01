// Signal processing core: waveform generation, pulse compression and detection.
// All signals are complex baseband, stored as { re: Float64Array, im: Float64Array }.

export const SOUND_SPEED = 1500; // m/s, nominal speed of sound in seawater

/** Small, fast, seedable PRNG so simulations and tests are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal generator (Box–Muller) driven by a uniform PRNG. */
export function makeGaussian(rand) {
  let spare = null;
  return function gaussian() {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = rand();
    const v = rand();
    const m = Math.sqrt(-2 * Math.log(u));
    spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  };
}

/**
 * Linear FM ("chirp") pulse sweeping -B/2 .. +B/2 around the carrier.
 * Long pulses give energy (detection range); wide bandwidth gives range
 * resolution (c / 2B) once the echo is compressed by the matched filter.
 */
export function lfmChirp(fs, duration, bandwidth) {
  const n = Math.max(1, Math.round(fs * duration));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const k = bandwidth / duration;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const phase = Math.PI * k * t * t - Math.PI * bandwidth * t;
    re[i] = Math.cos(phase);
    im[i] = Math.sin(phase);
  }
  return { re, im };
}

/** Hann-weighted copy of a signal; used on the receive replica to suppress range sidelobes. */
export function hannWeighted(sig) {
  const n = sig.re.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
    re[i] = sig.re[i] * w;
    im[i] = sig.im[i] * w;
  }
  return { re, im };
}

/**
 * Matched filter (pulse compression): y[n] = sum_k x[n+k] * conj(h[k]).
 * Returns |y|^2 normalised by replica energy, so unit-power white noise
 * comes out with unit mean power and output index n == echo delay in samples.
 */
export function matchedFilter(rx, replica, outLength = rx.re.length) {
  const N = rx.re.length;
  const M = replica.re.length;
  const hr = replica.re;
  const hi = replica.im;
  const xr = rx.re;
  const xi = rx.im;
  let energy = 0;
  for (let k = 0; k < M; k++) energy += hr[k] * hr[k] + hi[k] * hi[k];

  const L = Math.min(outLength, N);
  const out = new Float64Array(L);
  for (let n = 0; n < L; n++) {
    let sr = 0;
    let si = 0;
    const kmax = Math.min(M, N - n);
    for (let k = 0; k < kmax; k++) {
      const a = xr[n + k];
      const b = xi[n + k];
      sr += a * hr[k] + b * hi[k];
      si += b * hr[k] - a * hi[k];
    }
    out[n] = (sr * sr + si * si) / energy;
  }
  return out;
}

/** CA-CFAR scale factor for a square-law detector: Pfa = (1 + alpha/N)^-N. */
export function cfarAlpha(cells, pfa) {
  return cells * (Math.pow(pfa, -1 / cells) - 1);
}

/**
 * Cell-averaging CFAR. For each range cell, estimates the local noise power
 * from `train` cells either side (skipping `guard` cells around the cell under
 * test) and scales it so the false-alarm rate stays at `pfa` even as the
 * background (noise, reverberation) changes with range.
 */
export function caCfar(power, { guard = 3, train = 24, pfa = 1e-5 } = {}) {
  const N = power.length;
  const prefix = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) prefix[i + 1] = prefix[i] + power[i];

  const threshold = new Float64Array(N);
  const noise = new Float64Array(N);
  const alphaByCount = new Map();
  for (let i = 0; i < N; i++) {
    const l0 = Math.max(0, i - guard - train);
    const l1 = Math.max(0, i - guard);
    const r0 = Math.min(N, i + guard + 1);
    const r1 = Math.min(N, i + guard + 1 + train);
    const count = l1 - l0 + (r1 - r0);
    if (count === 0) {
      threshold[i] = Infinity;
      noise[i] = Infinity;
      continue;
    }
    let alpha = alphaByCount.get(count);
    if (alpha === undefined) {
      alpha = cfarAlpha(count, pfa);
      alphaByCount.set(count, alpha);
    }
    noise[i] = (prefix[l1] - prefix[l0] + prefix[r1] - prefix[r0]) / count;
    threshold[i] = alpha * noise[i];
  }
  return { threshold, noise };
}

/**
 * Turns threshold crossings into discrete detections: one peak per run of
 * contiguous crossings, merging peaks closer than `minSeparation` cells.
 */
export function extractPeaks(power, threshold, noise, { start = 0, minSeparation = 4 } = {}) {
  const peaks = [];
  const N = power.length;
  let i = start;
  while (i < N) {
    if (power[i] <= threshold[i]) {
      i++;
      continue;
    }
    let best = i;
    let j = i;
    while (j < N && power[j] > threshold[j]) {
      if (power[j] > power[best]) best = j;
      j++;
    }
    const peak = { index: best, power: power[best], snrDb: 10 * Math.log10(power[best] / noise[best]) };
    const last = peaks[peaks.length - 1];
    if (last && best - last.index < minSeparation) {
      if (peak.power > last.power) peaks[peaks.length - 1] = peak;
    } else {
      peaks.push(peak);
    }
    i = j;
  }
  return peaks;
}
