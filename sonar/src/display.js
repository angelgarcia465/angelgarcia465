// Canvas rendering: the PPI (plan position indicator) and the A-scan trace.

import { DEG } from './world.js';

const DB_FLOOR = 6; // dB above noise where the display starts to glow
const DB_SPAN = 30;

function phosphor(db) {
  const t = Math.min(1, Math.max(0, (db - DB_FLOOR) / DB_SPAN));
  if (t === 0) return null;
  const r = Math.round(40 + 215 * t ** 3);
  const g = Math.round(120 + 135 * Math.sqrt(t));
  const b = Math.round(90 + 120 * t ** 2);
  return `rgba(${r},${g},${b},${(0.25 + 0.75 * t).toFixed(3)})`;
}

function fitCanvas(canvas, square) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = square ? w : Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

export class PPI {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.history = document.createElement('canvas');
    this.resize();
  }

  resize() {
    fitCanvas(this.canvas, true);
    const size = this.canvas.width;
    this.dpr = window.devicePixelRatio || 1;
    this.size = size;
    this.c = size / 2;
    this.R = size / 2 - 28 * this.dpr;
    this.history.width = size;
    this.history.height = size;
  }

  clearHistory() {
    this.history.getContext('2d').clearRect(0, 0, this.size, this.size);
  }

  /** Canvas angle (radians) for a compass bearing. */
  angle(bearing) {
    return (bearing - 90) * DEG;
  }

  toScreen(x, y, maxRange) {
    const k = this.R / maxRange;
    return [this.c + x * k, this.c - y * k];
  }

  toWorld(px, py, maxRange) {
    const k = maxRange / this.R;
    return [(px - this.c) * k, -(py - this.c) * k];
  }

  /** Burns one beam's echo intensities into the persistent phosphor layer. */
  paintBeam(bearing, stepDeg, powerDb, maxRange, binMeters) {
    const h = this.history.getContext('2d');
    const a0 = this.angle(bearing - stepDeg / 2) - 0.002;
    const a1 = this.angle(bearing + stepDeg / 2) + 0.002;
    const { c, R } = this;

    h.save();
    h.globalCompositeOperation = 'destination-out';
    h.beginPath();
    h.moveTo(c, c);
    h.arc(c, c, R + 1, a0, a1);
    h.closePath();
    h.fill();
    h.restore();

    const step = Math.max(1, R / 420);
    const binsPerPx = maxRange / binMeters / R;
    for (let p = 0; p < R; p += step) {
      const b0 = Math.floor(p * binsPerPx);
      const b1 = Math.min(powerDb.length, Math.max(b0 + 1, Math.floor((p + step) * binsPerPx)));
      let db = -Infinity;
      for (let b = b0; b < b1; b++) if (powerDb[b] > db) db = powerDb[b];
      const color = phosphor(db);
      if (!color) continue;
      h.fillStyle = color;
      h.beginPath();
      h.arc(c, c, p + step, a0, a1);
      h.arc(c, c, p, a1, a0, true);
      h.closePath();
      h.fill();
    }
  }

  /** Exponential afterglow so older sweeps dim before they are overwritten. */
  fade(dt, halfLife) {
    const h = this.history.getContext('2d');
    h.save();
    h.globalCompositeOperation = 'destination-out';
    h.fillStyle = `rgba(0,0,0,${1 - Math.pow(0.5, dt / halfLife)})`;
    h.fillRect(0, 0, this.size, this.size);
    h.restore();
  }

  render({ bearing, maxRange, contacts, truth, selectedId, now }) {
    const { ctx, c, R, dpr, size } = this;
    ctx.clearRect(0, 0, size, size);

    const bg = ctx.createRadialGradient(c, c, 0, c, c, R);
    bg.addColorStop(0, '#06231b');
    bg.addColorStop(1, '#020d0a');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.fill();

    ctx.drawImage(this.history, 0, 0);

    // Range rings and bearing scale.
    ctx.strokeStyle = 'rgba(120, 255, 200, 0.18)';
    ctx.fillStyle = 'rgba(150, 255, 210, 0.55)';
    ctx.lineWidth = dpr;
    ctx.font = `${11 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    for (let i = 1; i <= 4; i++) {
      const r = (R * i) / 4;
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(`${Math.round((maxRange * i) / 4)}m`, c + 4 * dpr, c - r - 2 * dpr);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let b = 0; b < 360; b += 10) {
      const a = this.angle(b);
      const major = b % 30 === 0;
      const r0 = R - (major ? 10 : 5) * dpr;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
      ctx.lineTo(c + Math.cos(a) * R, c + Math.sin(a) * R);
      ctx.stroke();
      if (major) {
        const rl = R + 14 * dpr;
        ctx.fillText(String(b).padStart(3, '0'), c + Math.cos(a) * rl, c + Math.sin(a) * rl);
      }
    }
    ctx.beginPath();
    ctx.moveTo(c - R, c);
    ctx.lineTo(c + R, c);
    ctx.moveTo(c, c - R);
    ctx.lineTo(c, c + R);
    ctx.stroke();

    // Sweep with a fading trail.
    const trail = 24;
    for (let i = 0; i < trail; i++) {
      ctx.fillStyle = `rgba(110, 255, 190, ${0.12 * (1 - i / trail) ** 2})`;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, R, this.angle(bearing - i - 1), this.angle(bearing - i));
      ctx.closePath();
      ctx.fill();
    }
    const a = this.angle(bearing);
    ctx.strokeStyle = 'rgba(170, 255, 220, 0.9)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + Math.cos(a) * R, c + Math.sin(a) * R);
    ctx.stroke();

    if (truth) {
      ctx.strokeStyle = 'rgba(255, 120, 220, 0.8)';
      ctx.fillStyle = 'rgba(255, 140, 225, 0.85)';
      ctx.textAlign = 'left';
      for (const t of truth) {
        const [x, y] = this.toScreen(t.x, t.y, maxRange);
        const s = 4 * dpr;
        ctx.beginPath();
        ctx.moveTo(x - s, y - s);
        ctx.lineTo(x + s, y + s);
        ctx.moveTo(x + s, y - s);
        ctx.lineTo(x - s, y + s);
        ctx.stroke();
        ctx.fillText(t.kind, x + 7 * dpr, y + 9 * dpr);
      }
    }

    // Tracks: box, velocity leader (where it will be in 2 minutes), trail.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    for (const t of contacts) {
      const [x, y] = this.toScreen(t.x, t.y, maxRange);
      const selected = t.id === selectedId;
      const color = selected ? '#fff2a8' : t.coasting ? 'rgba(255, 190, 90, 0.55)' : '#ffbe5a';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = (selected ? 2 : 1.4) * dpr;

      ctx.setLineDash([2 * dpr, 3 * dpr]);
      ctx.beginPath();
      t.history.forEach((p, i) => {
        const [hx, hy] = this.toScreen(p.x, p.y, maxRange);
        i ? ctx.lineTo(hx, hy) : ctx.moveTo(hx, hy);
      });
      if (t.history.length) ctx.lineTo(x, y);
      ctx.stroke();
      ctx.setLineDash([]);

      const s = (selected ? 7 : 5.5) * dpr;
      ctx.strokeRect(x - s, y - s, 2 * s, 2 * s);
      if (t.speed > 0.3) {
        const [lx, ly] = this.toScreen(t.x + t.vx * 120, t.y + t.vy * 120, maxRange);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(lx, ly);
        ctx.stroke();
      }
      ctx.fillText(`T${t.id}`, x + s + 3 * dpr, y - s);
    }
  }
}

export class AScan {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  render({ powerDb, thresholdDb, peaks, binMeters, maxRange, bearing }) {
    fitCanvas(this.canvas, false);
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width;
    const H = canvas.height;
    const padL = 34 * dpr;
    const padB = 18 * dpr;
    const padT = 8 * dpr;
    const dbMax = 50;
    const dbMin = -10;
    const X = (r) => padL + (r / maxRange) * (W - padL - 6 * dpr);
    const Y = (db) => padT + (1 - (Math.min(dbMax, Math.max(dbMin, db)) - dbMin) / (dbMax - dbMin)) * (H - padT - padB);

    ctx.clearRect(0, 0, W, H);
    ctx.font = `${10 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillStyle = 'rgba(150, 255, 210, 0.5)';
    ctx.strokeStyle = 'rgba(120, 255, 200, 0.12)';
    ctx.lineWidth = dpr;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let db = dbMin; db <= dbMax; db += 20) {
      ctx.beginPath();
      ctx.moveTo(padL, Y(db));
      ctx.lineTo(W, Y(db));
      ctx.stroke();
      ctx.fillText(`${db}`, padL - 5 * dpr, Y(db));
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const r = (maxRange * i) / 4;
      ctx.fillText(`${Math.round(r)}m`, Math.min(X(r), W - 18 * dpr), H - padB + 4 * dpr);
    }
    if (!powerDb) return;

    const n = powerDb.length;
    const cols = Math.floor(W - padL);
    const trace = (arr, color, reduce) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let col = 0; col < cols; col++) {
        const b0 = Math.floor((col / cols) * n);
        const b1 = Math.max(b0 + 1, Math.floor(((col + 1) / cols) * n));
        let v = reduce === 'max' ? -Infinity : 0;
        for (let b = b0; b < b1; b++) v = reduce === 'max' ? Math.max(v, arr[b]) : v + arr[b] / (b1 - b0);
        const x = padL + col;
        col ? ctx.lineTo(x, Y(v)) : ctx.moveTo(x, Y(v));
      }
      ctx.stroke();
    };
    ctx.lineWidth = dpr;
    trace(powerDb, 'rgba(120, 255, 190, 0.85)', 'max');
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    trace(thresholdDb, 'rgba(255, 110, 110, 0.8)', 'mean');
    ctx.setLineDash([]);

    ctx.fillStyle = '#ffbe5a';
    for (const p of peaks) {
      const x = X(p.index * binMeters);
      ctx.beginPath();
      ctx.moveTo(x, Y(10 * Math.log10(p.power)) - 4 * dpr);
      ctx.lineTo(x - 4 * dpr, Y(10 * Math.log10(p.power)) - 11 * dpr);
      ctx.lineTo(x + 4 * dpr, Y(10 * Math.log10(p.power)) - 11 * dpr);
      ctx.fill();
    }

    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(150, 255, 210, 0.7)';
    ctx.fillText(`BRG ${String(Math.round(bearing)).padStart(3, '0')}°  ·  ${peaks.length} det`, W - 6 * dpr, padT);
  }
}
