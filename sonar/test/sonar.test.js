import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, makeGaussian, lfmChirp, hannWeighted, matchedFilter, caCfar, extractPeaks } from '../src/dsp.js';
import { SonarModel, Target, bearingOf, angleDiff } from '../src/world.js';
import { Tracker } from '../src/tracker.js';

test('matched filter peaks at the echo delay with expected compression gain', () => {
  const tx = lfmChirp(2500, 0.02, 2000);
  const replica = hannWeighted(tx);
  const N = 1000;
  const delay = 437;
  const rx = { re: new Float64Array(N), im: new Float64Array(N) };
  for (let k = 0; k < tx.re.length; k++) {
    rx.re[delay + k] = tx.re[k];
    rx.im[delay + k] = tx.im[k];
  }
  const out = matchedFilter(rx, replica);
  const peak = out.indexOf(Math.max(...out));
  assert.equal(peak, delay);
  // Unit-amplitude pulse of M samples through a Hann replica: (sum w)^2 / sum w^2 ~= 2M/3.
  const M = tx.re.length;
  assert.ok(Math.abs(out[peak] - (2 * M) / 3) < 0.05 * M);
});

test('white noise keeps unit mean power through the matched filter', () => {
  const g = makeGaussian(mulberry32(7));
  const N = 20000;
  const rx = { re: new Float64Array(N), im: new Float64Array(N) };
  for (let i = 0; i < N; i++) {
    rx.re[i] = g() * Math.SQRT1_2;
    rx.im[i] = g() * Math.SQRT1_2;
  }
  const out = matchedFilter(rx, hannWeighted(lfmChirp(2500, 0.02, 2000)), N - 50);
  const mean = out.reduce((a, b) => a + b, 0) / out.length;
  assert.ok(Math.abs(mean - 1) < 0.05, `mean ${mean}`);
});

test('CA-CFAR holds the false-alarm rate on noise and finds a strong target', () => {
  const rand = mulberry32(3);
  const N = 200000;
  const power = new Float64Array(N);
  for (let i = 0; i < N; i++) power[i] = -Math.log(1 - rand()); // exponential = square-law noise
  const pfa = 1e-3;
  const { threshold } = caCfar(power, { pfa, guard: 2, train: 16 });
  let fa = 0;
  for (let i = 100; i < N - 100; i++) if (power[i] > threshold[i]) fa++;
  const rate = fa / (N - 200);
  assert.ok(rate > pfa / 2 && rate < pfa * 2, `false alarm rate ${rate}`);

  power[5000] = 200;
  const c = caCfar(power, { pfa: 1e-6 });
  const peaks = extractPeaks(power, c.threshold, c.noise);
  assert.ok(peaks.some((p) => p.index === 5000));
});

test('sonar model + processing chain recovers target range and bearing', () => {
  const rand = mulberry32(11);
  const gauss = makeGaussian(rand);
  const sonar = new SonarModel();
  const t = new Target({ x: 300, y: 400, ts: 10 }); // 500 m at 036.87 deg
  const bearing = bearingOf(t.x, t.y);
  const rx = sonar.ping(bearing, 1000, [t], gauss, rand);
  const power = matchedFilter(rx, sonar.replica, rx.nRange);
  const { threshold, noise } = caCfar(power);
  const peaks = extractPeaks(power, threshold, noise, { start: 100 });
  const hit = peaks.find((p) => Math.abs(p.index * sonar.binMeters - 500) < 1);
  assert.ok(hit, 'target detected at 500 m');
  assert.ok(hit.snrDb > 20);

  // Pointing 90 degrees away, the beam pattern should hide it.
  const rx2 = sonar.ping(bearing + 90, 1000, [t], gauss, rand);
  const p2 = matchedFilter(rx2, sonar.replica, rx2.nRange);
  const c2 = caCfar(p2);
  assert.ok(!extractPeaks(p2, c2.threshold, c2.noise, { start: 100 }).some((p) => Math.abs(p.index * sonar.binMeters - 500) < 1));
});

test('tracker confirms a moving target and estimates its velocity', () => {
  const tracker = new Tracker();
  const vx = 2;
  const vy = -1;
  for (let scan = 0; scan < 8; scan++) {
    const time = scan * 3;
    // Same object seen in two adjacent beams, plus a far-away false alarm.
    tracker.addDetection({ x: 200 + vx * time, y: 300 + vy * time, power: 100, snrDb: 20, time });
    tracker.addDetection({ x: 210 + vx * time, y: 295 + vy * time, power: 50, snrDb: 17, time });
    tracker.addDetection({ x: -500 + scan * 137, y: (scan * 311) % 600, power: 10, snrDb: 11, time });
    tracker.endScan();
  }
  const contacts = tracker.contacts(21);
  assert.equal(contacts.length, 1);
  const [c] = contacts;
  assert.ok(Math.abs(c.vx - vx) < 0.3 && Math.abs(c.vy - vy) < 0.3, `v=(${c.vx}, ${c.vy})`);
  assert.ok(Math.abs(angleDiff(c.course, bearingOf(vx, vy))) < 8);
});

test('a distant target seen in adjacent beams becomes one track, not several', () => {
  const tracker = new Tracker();
  const DEG = Math.PI / 180;
  for (let scan = 0; scan < 6; scan++) {
    const time = scan * 3;
    const r = 810 - scan * 5;
    // Beams every 3 deg: ~42 m apart in cross-range at this distance.
    for (const b of [315, 318, 321]) {
      tracker.addDetection({ x: r * Math.sin(b * DEG), y: r * Math.cos(b * DEG), power: 50, snrDb: 20, time });
    }
    tracker.endScan();
  }
  assert.equal(tracker.contacts(15).length, 1);
});
