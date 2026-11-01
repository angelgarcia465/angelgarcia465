// Turns per-ping detections into tracked contacts with course and speed.

import { bearingOf, angleDiff } from './world.js';

/**
 * Single-linkage clustering: detections of one object across adjacent beams
 * become one plot. Two detections link when they are close in range AND
 * bearing (beams spread apart with range), or simply close in metres.
 */
export function clusterDetections(dets, { mergeDistance = 20, rangeGate = 12, bearingGate = 5 } = {}) {
  const parent = dets.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < dets.length; i++) {
    for (let j = i + 1; j < dets.length; j++) {
      const a = dets[i];
      const b = dets[j];
      const near = Math.hypot(a.x - b.x, a.y - b.y) <= mergeDistance;
      const sameBeamGroup =
        Math.abs(Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y)) <= rangeGate &&
        Math.abs(angleDiff(bearingOf(a.x, a.y), bearingOf(b.x, b.y))) <= bearingGate;
      if (near || sameBeamGroup) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map();
  dets.forEach((d, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(d);
  });
  return [...groups.values()].map((g) => {
    let w = 0, x = 0, y = 0, time = 0, snrDb = -Infinity;
    for (const d of g) {
      w += d.power;
      x += d.x * d.power;
      y += d.y * d.power;
      time += d.time * d.power;
      snrDb = Math.max(snrDb, d.snrDb);
    }
    return { x: x / w, y: y / w, time: time / w, snrDb, count: g.length };
  });
}

export class Tracker {
  constructor(opts = {}) {
    Object.assign(
      this,
      {
        mergeDistance: 20, // m, cluster detections closer than this
        rangeGate: 12, // m, ...or within this range and bearingGate of each other
        bearingGate: 5, // deg (beams are 3 deg apart, 6 deg wide)
        dedupeDistance: 30, // m, tracks this close with similar velocity are one object
        gateBase: 25, // m
        maxSpeed: 12, // m/s, bounds the gate for new tracks (~23 kn)
        maneuver: 2, // m/s of unexplained motion allowed for established tracks
        confirmHits: 4, // 3 lets ~2 false tracks/min through on noise; 4 lets none
        maxMisses: 3,
        alpha: 0.5,
        beta: 0.2,
      },
      opts,
    );
    this.tracks = [];
    this.pending = [];
    this.nextId = 1;
  }

  addDetection(det) {
    this.pending.push(det);
  }

  /** Call once per full scan: clusters the scan's detections and updates tracks. */
  endScan() {
    const plots = clusterDetections(this.pending, this);
    this.pending = [];

    // Global nearest-neighbour association inside each track's gate.
    const pairs = [];
    this.tracks.forEach((t, ti) => {
      plots.forEach((p, pi) => {
        const dt = Math.max(p.time - t.time, 1e-3);
        const d = Math.hypot(p.x - (t.x + t.vx * dt), p.y - (t.y + t.vy * dt));
        const gate = this.gateBase + (t.hits >= 2 ? this.maneuver : this.maxSpeed) * dt;
        if (d <= gate) pairs.push({ ti, pi, d });
      });
    });
    pairs.sort((a, b) => a.d - b.d);
    const usedT = new Set();
    const usedP = new Set();
    for (const { ti, pi } of pairs) {
      if (usedT.has(ti) || usedP.has(pi)) continue;
      usedT.add(ti);
      usedP.add(pi);
      this.#update(this.tracks[ti], plots[pi]);
    }

    this.tracks.forEach((t, ti) => {
      if (!usedT.has(ti)) t.misses++;
    });
    this.tracks = this.tracks.filter((t) => t.misses <= (t.confirmed ? this.maxMisses : 1));

    plots.forEach((p, pi) => {
      if (usedP.has(pi)) return;
      this.tracks.push({ id: null, x: p.x, y: p.y, vx: 0, vy: 0, time: p.time, hits: 1, misses: 0, snrDb: p.snrDb, confirmed: false, history: [] });
    });
    this.#dedupe();
  }

  /** Keeps one track per object: confirmed and longer-lived tracks win. */
  #dedupe() {
    const ranked = [...this.tracks].sort((a, b) => b.confirmed - a.confirmed || b.hits - a.hits);
    const kept = [];
    for (const t of ranked) {
      const dup = kept.some((k) => {
        const dt = t.time - k.time;
        const d = Math.hypot(t.x - (k.x + k.vx * dt), t.y - (k.y + k.vy * dt));
        const dv = t.hits >= 2 ? Math.hypot(t.vx - k.vx, t.vy - k.vy) : 0;
        return d <= this.dedupeDistance && dv <= 2;
      });
      if (!dup) kept.push(t);
    }
    this.tracks = kept;
  }

  #update(t, p) {
    const dt = Math.max(p.time - t.time, 1e-3);
    const px = t.x + t.vx * dt;
    const py = t.y + t.vy * dt;
    t.history.push({ x: t.x, y: t.y });
    if (t.history.length > 30) t.history.shift();
    if (t.hits === 1) {
      // Second sighting: velocity straight from the two plots.
      t.vx = (p.x - t.x) / dt;
      t.vy = (p.y - t.y) / dt;
      t.x = p.x;
      t.y = p.y;
    } else {
      const rx = p.x - px;
      const ry = p.y - py;
      t.x = px + this.alpha * rx;
      t.y = py + this.alpha * ry;
      t.vx += (this.beta * rx) / dt;
      t.vy += (this.beta * ry) / dt;
    }
    t.time = p.time;
    t.hits++;
    t.misses = 0;
    t.snrDb = p.snrDb;
    if (!t.confirmed && t.hits >= this.confirmHits) {
      t.confirmed = true;
      t.id = this.nextId++;
    }
  }

  /** Snapshot of confirmed tracks extrapolated to `now`. */
  contacts(now) {
    return this.tracks
      .filter((t) => t.confirmed)
      .map((t) => {
        const dt = now - t.time;
        const x = t.x + t.vx * dt;
        const y = t.y + t.vy * dt;
        const speed = Math.hypot(t.vx, t.vy);
        return {
          id: t.id,
          x,
          y,
          vx: t.vx,
          vy: t.vy,
          range: Math.hypot(x, y),
          bearing: bearingOf(x, y),
          speed,
          course: speed > 0.3 ? bearingOf(t.vx, t.vy) : null,
          snrDb: t.snrDb,
          coasting: t.misses > 0,
          history: t.history,
        };
      });
  }
}
