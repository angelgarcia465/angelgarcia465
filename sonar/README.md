# Active Sonar

A browser-based active sonar simulator. It runs the full processing chain on
simulated hydrophone data, from waveform to tracked contacts, and draws it on
a classic PPI display. It's plain HTML, CSS and JavaScript (ES modules) with no
dependencies.

**Live demo:** https://angelgarcia465.github.io/angelgarcia465/sonar/

## Run it

```sh
cd sonar
npm start            # or: python3 -m http.server 8000
# open http://localhost:8000
```

ES modules don't load from `file://`, so serve the folder over HTTP.

## What it does

| Stage | File | Details |
| --- | --- | --- |
| Transmit | `src/dsp.js` | 20 ms linear-FM chirp, 2 kHz bandwidth, complex baseband at 2.5 kHz |
| Propagation | `src/world.js` | Sonar equation: `SL − 2·TL + TS + 2·beam − NL`, spherical spreading + 6 dB/km absorption, 6° beam, Doppler, volume reverberation, ambient noise, echo scintillation |
| Pulse compression | `src/dsp.js` | Hann-weighted matched filter: 0.375 m resolution, ~15 dB gain |
| Detection | `src/dsp.js` | Cell-averaging CFAR (3 guard + 24 training cells per side), adjustable false-alarm rate |
| Tracking | `src/tracker.js` | Clusters detections per scan by range/bearing, nearest-neighbour association, α-β filter, confirms after 4 hits, merges duplicates |
| Display | `src/display.js` | Phosphor-style PPI with afterglow, track symbols and velocity leaders, A-scan of the current beam |

The scenario has a submarine, a wreck, a whale, a diver and a fish school.
Click the display to add more contacts. Turn on **Show ground truth** to
compare the tracker's estimates with where things really are.

With the default settings, the submarine (TS +10 dB) is detected to about
1.2 km, the whale (+5 dB) to about 1 km, and the diver (−10 dB) to about
600 m. Raise the ambient noise to see the ranges shrink.

**Simplification:** a real mechanically scanned sonar needs 2R/c seconds per
ping, so a full scan at 1 km takes minutes. Here the scan is time-compressed,
while target motion runs in real time (× the time-scale slider).

## Tests

```sh
npm test
```

The tests cover matched-filter delay and gain, noise normalisation, the CFAR
false-alarm rate, end-to-end detection of range and bearing, and tracker
velocity estimation and de-duplication.
