import { mulberry32, makeGaussian, matchedFilter, caCfar, extractPeaks } from './dsp.js';
import { SonarModel, Target, makeScenario, wrap360, angleDiff, DEG } from './world.js';
import { Tracker } from './tracker.js';
import { PPI, AScan } from './display.js';

const $ = (id) => document.getElementById(id);
const KNOTS = 1.943844;

const rand = mulberry32((Math.random() * 2 ** 32) >>> 0);
const gauss = makeGaussian(rand);

const state = {
  maxRange: 1000,
  bearing: 0,
  stepDeg: 3,
  pingsPerSec: 40,
  timeScale: 1,
  pfa: 1e-5,
  running: true,
  showTruth: false,
  audio: false,
  simTime: 0,
  selectedId: null,
  last: null,
};

let sonar = new SonarModel();
let targets = makeScenario(rand);
let tracker = new Tracker();
const ppi = new PPI($('ppi'));
const ascan = new AScan($('ascan'));

// ---------- audio: transmit ping each scan, echo blip as the beam crosses a contact ----------
let audioCtx = null;
function tone(freq, gain, decay, delay = 0) {
  if (!state.audio) return;
  audioCtx ??= new AudioContext();
  const t0 = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const amp = audioCtx.createGain();
  osc.frequency.value = freq;
  amp.gain.setValueAtTime(0, t0);
  amp.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
  osc.connect(amp).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + decay + 0.05);
}

// ---------- one transmit/receive cycle ----------
function doPing() {
  const prev = state.bearing;
  state.bearing = wrap360(prev + state.stepDeg);
  if (state.bearing < prev) {
    tracker.endScan();
    tone(1450, 0.12, 0.9);
  }

  const rx = sonar.ping(state.bearing, state.maxRange, targets, gauss, rand);
  const power = matchedFilter(rx, sonar.replica, rx.nRange);
  // Receiver is blanked while transmitting; CFAR also needs a full leading
  // window of real data, so detection starts one training window further out.
  const blank = Math.ceil(sonar.blankingMeters / sonar.binMeters);
  const cfarOpts = { pfa: state.pfa, guard: 3, train: 24 };
  for (let i = 0; i < blank; i++) power[i] = 0;
  const { threshold, noise } = caCfar(power, cfarOpts);
  const peaks = extractPeaks(power, threshold, noise, { start: blank + cfarOpts.guard + cfarOpts.train });

  const b = state.bearing * DEG;
  for (const p of peaks) {
    const r = p.index * sonar.binMeters;
    tracker.addDetection({ x: r * Math.sin(b), y: r * Math.cos(b), power: p.power, snrDb: p.snrDb, time: state.simTime });
  }

  const powerDb = new Float32Array(power.length);
  const thresholdDb = new Float32Array(power.length);
  for (let i = 0; i < power.length; i++) {
    powerDb[i] = 10 * Math.log10(power[i] + 1e-12);
    thresholdDb[i] = 10 * Math.log10(threshold[i] + 1e-12);
  }
  ppi.paintBeam(state.bearing, state.stepDeg, powerDb, state.maxRange, sonar.binMeters);
  state.last = { powerDb, thresholdDb, peaks, bearing: state.bearing };

  for (const c of tracker.contacts(state.simTime)) {
    if (Math.abs(angleDiff(c.bearing, state.bearing)) < state.stepDeg / 2) {
      // Echo pitch rises for closing contacts and drops for opening ones (exaggerated Doppler).
      const closing = -(c.x * c.vx + c.y * c.vy) / Math.max(c.range, 1);
      tone(1450 * (1 + closing * 0.03), Math.min(0.1, 0.01 + c.snrDb / 400), 0.35, 0.05 + (c.range / state.maxRange) * 0.3);
    }
  }
}

// ---------- main loop ----------
let lastFrame = performance.now();
let pingDebt = 0;
let lastTable = 0;

function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (state.running) {
    const simDt = dt * state.timeScale;
    state.simTime += simDt;
    for (const t of targets) t.step(simDt, rand, state.maxRange);

    pingDebt += dt * state.pingsPerSec;
    const n = Math.min(6, Math.floor(pingDebt));
    pingDebt = n === 6 ? 0 : pingDebt - n;
    for (let i = 0; i < n; i++) doPing();

    const scanSeconds = 360 / state.stepDeg / state.pingsPerSec;
    ppi.fade(dt, scanSeconds * 0.6);
  }

  const contacts = tracker.contacts(state.simTime);
  ppi.render({
    bearing: state.bearing,
    maxRange: state.maxRange,
    contacts,
    truth: state.showTruth ? targets : null,
    selectedId: state.selectedId,
  });
  if (state.last) ascan.render({ ...state.last, binMeters: sonar.binMeters, maxRange: state.maxRange });

  if (now - lastTable > 250) {
    lastTable = now;
    renderContacts(contacts);
    $('clock').textContent = formatClock(state.simTime);
  }
  requestAnimationFrame(frame);
}

function formatClock(s) {
  const t = Math.floor(s);
  return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60].map((v) => String(v).padStart(2, '0')).join(':');
}

function renderContacts(contacts) {
  const body = $('contacts');
  $('contact-count').textContent = contacts.length;
  if (!contacts.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">No contacts held</td></tr>';
    return;
  }
  body.innerHTML = contacts
    .sort((a, b) => a.range - b.range)
    .map(
      (c) => `<tr data-id="${c.id}" class="${c.id === state.selectedId ? 'sel' : ''} ${c.coasting ? 'coast' : ''}">
        <td>T${c.id}</td>
        <td>${String(Math.round(c.bearing) % 360).padStart(3, '0')}°</td>
        <td>${Math.round(c.range)} m</td>
        <td>${c.course === null ? '—' : String(Math.round(c.course) % 360).padStart(3, '0') + '°'}</td>
        <td>${(c.speed * KNOTS).toFixed(1)} kn</td>
        <td>${c.snrDb.toFixed(0)} dB</td>
      </tr>`,
    )
    .join('');
}

// ---------- controls ----------
function bindRange(id, outId, fmt, apply) {
  const el = $(id);
  const update = () => {
    const v = Number(el.value);
    $(outId).textContent = fmt(v);
    apply(v);
  };
  el.addEventListener('input', update);
  update();
}

bindRange('noise', 'noise-out', (v) => `${v} dB`, (v) => (sonar.noiseLevel = v));
bindRange('sweep', 'sweep-out', (v) => `${(360 / state.stepDeg / v).toFixed(1)} s/scan`, (v) => (state.pingsPerSec = v));
bindRange('timescale', 'timescale-out', (v) => `×${v}`, (v) => (state.timeScale = v));

$('range').addEventListener('change', (e) => {
  state.maxRange = Number(e.target.value);
  ppi.clearHistory();
  tracker = new Tracker();
});
$('pfa').addEventListener('change', (e) => (state.pfa = Number(e.target.value)));
$('truth').addEventListener('change', (e) => (state.showTruth = e.target.checked));
$('audio').addEventListener('change', (e) => {
  state.audio = e.target.checked;
  if (state.audio) {
    audioCtx ??= new AudioContext();
    audioCtx.resume();
  }
});
$('pause').addEventListener('click', (e) => {
  state.running = !state.running;
  e.currentTarget.textContent = state.running ? 'Pause' : 'Resume';
});
$('reset').addEventListener('click', () => {
  targets = makeScenario(rand);
  tracker = new Tracker();
  state.selectedId = null;
  ppi.clearHistory();
});
$('contacts').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (row) state.selectedId = Number(row.dataset.id) === state.selectedId ? null : Number(row.dataset.id);
});

// Click the display to drop a new contact into the water there.
$('ppi').addEventListener('click', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const k = ppi.size / rect.width;
  const [x, y] = ppi.toWorld((e.clientX - rect.left) * k, (e.clientY - rect.top) * k, state.maxRange);
  if (Math.hypot(x, y) > state.maxRange) return;
  targets.push(new Target({ kind: 'unknown', x, y, course: rand() * 360, speed: 1 + rand() * 4, ts: -5 + rand() * 15, wander: 3 }));
});

new ResizeObserver(() => ppi.resize()).observe($('ppi'));

requestAnimationFrame(frame);
