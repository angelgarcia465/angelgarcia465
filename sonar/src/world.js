// Ocean + sonar model: target kinematics and the sonar equation used to
// synthesise what the hydrophone actually receives on each ping.

import { SOUND_SPEED, lfmChirp, hannWeighted } from './dsp.js';

export const DEG = Math.PI / 180;
export const wrap360 = (a) => ((a % 360) + 360) % 360;
/** Signed difference a - b in degrees, in (-180, 180]. */
export function angleDiff(a, b) {
  const d = wrap360(a - b);
  return d > 180 ? d - 360 : d;
}
/** Compass bearing (0 = north, clockwise) of an east/north offset. */
export const bearingOf = (x, y) => wrap360(Math.atan2(x, y) / DEG);

/**
 * Something in the water that reflects sound. Positions are metres east (x)
 * and north (y) of the sonar. `parts` lets one target be several scatterers
 * (e.g. a school of fish) that move together.
 */
export class Target {
  constructor({ kind = 'contact', x, y, course = 0, speed = 0, ts = 0, wander = 0, parts = null }) {
    Object.assign(this, { kind, x, y, course, speed, ts, wander });
    this.parts = parts ?? [{ dx: 0, dy: 0, ts }];
  }

  get vx() {
    return this.speed * Math.sin(this.course * DEG);
  }
  get vy() {
    return this.speed * Math.cos(this.course * DEG);
  }

  step(dt, rand, maxRange) {
    if (this.speed === 0) return;
    if (this.wander) this.course = wrap360(this.course + (rand() - 0.5) * this.wander * dt);
    // Turn back toward the sonar when leaving the coverage area.
    const r = Math.hypot(this.x, this.y);
    if (r > maxRange * 0.9 && this.x * this.vx + this.y * this.vy > 0) {
      this.course = wrap360(bearingOf(-this.x, -this.y) + (rand() - 0.5) * 70);
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    for (const p of this.parts) {
      if (this.parts.length > 1) {
        p.dx += (rand() - 0.5) * 0.6 * dt;
        p.dy += (rand() - 0.5) * 0.6 * dt;
      }
    }
  }
}

export function makeScenario(rand) {
  const school = [];
  for (let i = 0; i < 14; i++) {
    school.push({ dx: (rand() - 0.5) * 28, dy: (rand() - 0.5) * 28, ts: -22 });
  }
  return [
    new Target({ kind: 'submarine', x: -620, y: 680, course: 125, speed: 3.5, ts: 10 }),
    new Target({ kind: 'wreck', x: 430, y: -360, ts: 15 }),
    new Target({ kind: 'whale', x: 280, y: 520, course: 250, speed: 2, ts: 5, wander: 8 }),
    new Target({ kind: 'diver', x: -160, y: -230, course: 45, speed: 0.8, ts: -10, wander: 15 }),
    new Target({ kind: 'fish school', x: -420, y: -480, course: 70, speed: 1.2, wander: 4, parts: school }),
  ];
}

export class SonarModel {
  constructor(opts = {}) {
    Object.assign(
      this,
      {
        fs: 2500, // complex sample rate, Hz
        bandwidth: 2000, // chirp bandwidth, Hz  -> range resolution c/2B = 0.375 m
        pulse: 0.02, // pulse length, s       -> time-bandwidth product 40
        carrier: 25000, // Hz, used for Doppler shift of moving targets
        sourceLevel: 200, // dB
        noiseLevel: 72, // in-band ambient noise, dB
        absorption: 6, // dB/km at ~25 kHz
        beamwidth: 6, // -3 dB one-way beamwidth, degrees
        reverbStrength: -50, // dB, volume reverberation scattering strength
      },
      opts,
    );
    this.tx = lfmChirp(this.fs, this.pulse, this.bandwidth);
    this.replica = hannWeighted(this.tx);
  }

  /** Metres of range per sample (two-way travel). */
  get binMeters() {
    return SOUND_SPEED / (2 * this.fs);
  }

  /** Range inside which the receiver is blanked while transmitting. */
  get blankingMeters() {
    return (SOUND_SPEED * this.pulse) / 2;
  }

  transmissionLoss(r) {
    return 20 * Math.log10(Math.max(r, 1)) + (this.absorption * r) / 1000;
  }

  /** One-way beam pattern in dB for a direction `offDeg` off the beam axis. */
  beamGainDb(offDeg) {
    return Math.max(-12 * (offDeg / this.beamwidth) ** 2, -35);
  }

  /** Sonar equation: per-sample echo-to-noise ratio in dB (before pulse compression). */
  echoToNoiseDb(range, ts, offDeg) {
    return this.sourceLevel - 2 * this.transmissionLoss(range) + ts + 2 * this.beamGainDb(offDeg) - this.noiseLevel;
  }

  /** Simulates the hydrophone signal for one ping on `bearing`. Noise has unit power. */
  ping(bearing, maxRange, targets, gauss, rand) {
    const M = this.tx.re.length;
    const nRange = Math.ceil(maxRange / this.binMeters);
    const N = nRange + M;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const sigma = Math.SQRT1_2;
    for (let i = 0; i < N; i++) {
      re[i] = gauss() * sigma;
      im[i] = gauss() * sigma;
    }

    // Volume reverberation: a random field of tiny scatterers, each returning a
    // copy of the pulse. Strong close in, decays ~40 log R.
    const bin = this.binMeters;
    for (let n = 1; n < nRange; n++) {
      const r = n * bin;
      const db = this.sourceLevel - 40 * Math.log10(Math.max(r, 5)) + this.reverbStrength - this.noiseLevel;
      if (db < -25) break;
      const a = Math.pow(10, db / 20) * sigma;
      this.#addPulse(re, im, n, a * gauss(), a * gauss(), 0);
    }

    for (const t of targets) {
      for (const p of t.parts) {
        const x = t.x + p.dx;
        const y = t.y + p.dy;
        const r = Math.hypot(x, y);
        const d = Math.round(r / bin);
        if (d <= 0 || d >= nRange) continue;
        const off = angleDiff(bearingOf(x, y), bearing);
        const db = this.echoToNoiseDb(r, p.ts, off);
        if (db < -40) continue;
        // Random phase and Rayleigh-ish fluctuation: real echoes scintillate.
        const amp = Math.pow(10, db / 20) * (0.6 + 0.8 * rand());
        const phi = 2 * Math.PI * rand();
        // Doppler: closing speed shifts the echo frequency by 2 v f / c.
        const closing = -(x * t.vx + y * t.vy) / r;
        const fd = (2 * closing * this.carrier) / SOUND_SPEED;
        this.#addPulse(re, im, d, amp * Math.cos(phi), amp * Math.sin(phi), fd);
      }
    }
    return { re, im, nRange };
  }

  /** Adds (ar + j ai) * tx[k] * exp(j 2 pi fd k / fs) starting at sample `start`. */
  #addPulse(re, im, start, ar, ai, fd) {
    const { re: tr, im: ti } = this.tx;
    const M = tr.length;
    const w = (2 * Math.PI * fd) / this.fs;
    for (let k = 0; k < M; k++) {
      let sr = tr[k];
      let si = ti[k];
      if (fd !== 0) {
        const c = Math.cos(w * k);
        const s = Math.sin(w * k);
        const r2 = sr * c - si * s;
        si = sr * s + si * c;
        sr = r2;
      }
      re[start + k] += ar * sr - ai * si;
      im[start + k] += ar * si + ai * sr;
    }
  }
}
