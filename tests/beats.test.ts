import { describe, expect, it } from 'vitest';
import { analyzeBeats, ANALYSIS_RATE, bar1FromTaps, firstSoundMs, fitGrid, spliceTappedIntro } from '../src/analysis/beats';

/** Deterministic pseudo-random numbers. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/**
 * A rough rock groove: kick + noise on every beat (louder on 1 and 3),
 * snare-ish noise on 2 and 4, hi-hat on eighths, constant background noise.
 */
function groove(beatTimes: number[], seconds: number): Float32Array {
  const sr = ANALYSIS_RATE;
  const x = new Float32Array(Math.round(seconds * sr));
  const r = rng(7);
  for (let i = 0; i < x.length; i++) x[i] = 0.02 * r();
  const hit = (tMs: number, freq: number, amp: number, noise: number, decayMs: number) => {
    const s0 = Math.round((tMs / 1000) * sr);
    const len = Math.round((decayMs / 1000) * sr * 4);
    for (let i = 0; i < len && s0 + i < x.length; i++) {
      const env = Math.exp(-i / ((decayMs / 1000) * sr));
      x[s0 + i] += env * (amp * Math.sin((2 * Math.PI * freq * i) / sr) + noise * r());
    }
  };
  beatTimes.forEach((t, i) => {
    hit(t, 60, i % 2 === 0 ? 0.8 : 0.4, 0.1, 60);
    if (i % 2 === 1) hit(t, 200, 0.2, 0.5, 40);
    const next = beatTimes[i + 1] ?? t + (t - beatTimes[i - 1]);
    hit(t, 0, 0, 0.12, 8);
    hit((t + next) / 2, 0, 0, 0.12, 8);
  });
  return x;
}

/** Signed error of the detected beat nearest to each true beat (edges excluded). */
function signedErrors(found: number[], truth: number[]): number[] {
  return truth
    .filter((t) => t > 1500 && t < truth[truth.length - 1] - 1500)
    .map((t) => found.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a)) - t);
}

/** Beat-to-beat precision matters most (a constant offset is fixed by the bar-1 setting). */
function stats(errs: number[]) {
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  return { mean, spread: Math.max(...errs.map((e) => Math.abs(e - mean))) };
}

/** Adds sustained triads that change at every bar start (beat index ≡ firstBar mod 4). */
function withChords(x: Float32Array, beatTimes: number[], firstBar: number): Float32Array {
  const chords = [
    [261.6, 329.6, 392.0],
    [220.0, 261.6, 329.6],
    [174.6, 220.0, 261.6],
    [196.0, 246.9, 293.7],
  ];
  const sr = ANALYSIS_RATE;
  let c = 0;
  for (let i = firstBar; i + 4 < beatTimes.length; i += 4, c++) {
    const [a, b] = [beatTimes[i], beatTimes[i + 4]].map((t) => Math.round((t / 1000) * sr));
    for (const f of chords[c % 4]) for (let s = a; s < b; s++) x[s] += 0.05 * Math.sin((2 * Math.PI * f * (s - a)) / sr);
  }
  return x;
}

function introSong(seed = 5) {
  const sr = ANALYSIS_RATE, period = 627.6, n = 60, t0 = 500;
  const truth = Array.from({ length: n }, (_, i) => t0 + i * period);
  const x = new Float32Array(Math.round((truth[n - 1] / 1000 + 1) * sr));
  const r = rng(seed);
  for (let i = 0; i < x.length; i++) x[i] = 0.01 * r();
  const pluck = (t: number, f: number, amp: number) => {
    const s0 = Math.round((t / 1000) * sr);
    for (let i = 0; i < sr * 0.5 && s0 + i < x.length; i++) x[s0 + i] += amp * Math.exp(-i / (sr * 0.15)) * Math.sin((2 * Math.PI * f * i) / sr);
  };
  const hit = (t: number, f: number, amp: number, noise: number, d: number) => {
    const s0 = Math.round((t / 1000) * sr), dd = (d / 1000) * sr;
    for (let i = 0; i < dd * 4 && s0 + i < x.length; i++) x[s0 + i] += Math.exp(-i / dd) * (amp * Math.sin((2 * Math.PI * f * i) / sr) + noise * r());
  };
  const notes = [330, 392, 494, 440, 392, 330, 294, 262];
  // Guitar arpeggio on eighths throughout, accents irregular (syncopated), loud in the intro.
  // Syncopated riff: 3+3+2 sixteenths, accents on the off-grid notes, played loosely (±25 ms).
  const pattern = [0, 3, 6, 8, 11, 14];
  for (let bar = 0; bar < n / 4; bar++) {
    for (let k = 0; k < pattern.length; k++) {
      const t = t0 + bar * 4 * period + (pattern[k] * period) / 4;
      pluck(t + 25 * r(), notes[(bar * 6 + k) % 8], 0.3 * (k % 3 === 1 ? 1 : 0.6));
    }
  }
  // Drums from beat 12 on.
  truth.forEach((t, i) => {
    if (i < 12) return;
    hit(t, 55, i % 2 === 0 ? 0.7 : 0.35, 0.1, 70);
    if (i % 2 === 1) hit(t, 180, 0.2, 0.45, 50);
  });
  return { x, truth };
}

describe('beat analysis', () => {
  it('keeps a drumless, syncopated intro on the tempo of the band that follows', () => {
    const { x, truth } = introSong();
    const res = analyzeBeats(x, 96)!;
    expect(res.extrapolated).toBeGreaterThanOrEqual(8);
    const errs = truth.slice(0, 16).map((t) => Math.abs(res.beats.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a)) - t));
    expect(Math.max(...errs)).toBeLessThan(12);
  });

  it('leaves confident sections untouched', () => {
    const truth = Array.from({ length: 60 }, (_, i) => 400 + i * 600);
    const res = analyzeBeats(groove(truth, 37), 100)!;
    expect(res.extrapolated).toBe(0);
  });

  it('finds beat 1 of the bar from chord changes, also after a pickup', () => {
    const truth = Array.from({ length: 70 }, (_, i) => 600 + i * 625);
    for (const firstBar of [0, 1, 2, 3]) {
      const res = analyzeBeats(withChords(groove(truth, 45), truth, firstBar), 96)!;
      const first = res.beats[res.downbeat];
      // The first detected downbeat is one of the true bar starts.
      const barStarts = truth.filter((_, i) => i % 4 === firstBar);
      expect(Math.min(...barStarts.map((t) => Math.abs(t - first)))).toBeLessThan(15);
    }
  });

  it('finds a non-round constant tempo and the beat positions', () => {
    const bpm = 96.3;
    const truth = Array.from({ length: 90 }, (_, i) => 430 + (i * 60000) / bpm);
    const res = analyzeBeats(groove(truth, 58), 96)!;
    expect(Math.abs(res.bpm - bpm)).toBeLessThan(0.05);
    const { mean, spread } = stats(signedErrors(res.beats, truth));
    expect(Math.abs(mean)).toBeLessThan(10);
    expect(spread).toBeLessThan(5);
    expect(res.maxDeviationMs).toBeLessThan(12);
  });

  it('follows a drifting tempo beat by beat and reports the drift', () => {
    // 94 -> 99 BPM over the song, as a band without a click would play.
    const truth: number[] = [300];
    for (let i = 1; i < 100; i++) truth.push(truth[i - 1] + 60000 / (94 + (5 * i) / 100));
    const res = analyzeBeats(groove(truth, truth[99] / 1000 + 1), 96)!;
    const { mean, spread } = stats(signedErrors(res.beats, truth));
    expect(Math.abs(mean)).toBeLessThan(10);
    expect(spread).toBeLessThan(6);
    expect(res.maxDeviationMs).toBeGreaterThan(40);
  });

  it('works without a tempo hint', () => {
    const truth = Array.from({ length: 80 }, (_, i) => 250 + i * 500);
    const res = analyzeBeats(groove(truth, 41))!;
    expect(Math.abs(res.bpm - 120)).toBeLessThan(0.1);
  });

  it('fits a grid', () => {
    const f = fitGrid([100, 600, 1100, 1600]);
    expect(f.period).toBeCloseTo(500);
    expect(f.offset).toBeCloseTo(100);
    expect(f.maxDeviation).toBeCloseTo(0);
  });
});

describe('bar1FromTaps', () => {
  const beats = Array.from({ length: 64 }, (_, i) => 1000 + i * 500);
  it('picks the beat the taps agree on, despite sloppy taps', () => {
    // The "1" is beat index 2 (2000 ms); taps up to 180 ms off, one on the wrong beat.
    const taps = [2150, 3880, 6120, 8000, 9500, 12100];
    const r = bar1FromTaps(taps, 4, beats)!;
    expect(r.offsetMs).toBe(2000);
    expect(r.agreement).toBeCloseTo(5 / 6);
  });
  it('works without detected beats, with a missed tap', () => {
    const r = bar1FromTaps([1510, 3490, 7505, 9500], 4)!;
    expect(r.offsetMs).toBeGreaterThan(1495);
    expect(r.offsetMs).toBeLessThan(1515);
    expect(r.barMs).toBeCloseTo(2000, -1);
  });
});

describe('spliceTappedIntro', () => {
  // Free intro: tempo drifting 90 -> 98 BPM over 16 beats; drums from 10 s, steady 96 BPM.
  const intro: number[] = [500];
  for (let k = 1; k < 16; k++) intro.push(intro[k - 1] + 60000 / (90 + k / 2));
  const drums = Array.from({ length: 60 }, (_, k) => intro[15] + 625 * (k + 1));
  const wobble = [0, 90, -110, 70, -60, 120, -100, 40, 80, -90, 60, -120, 100, -50, 30, -70];
  const detected = [...intro.map((t, k) => t + wobble[k]), ...drums];

  it('uses the taps for the intro and the detection from the drums on', () => {
    // Taps 35 ms late with jitter, one missed, going on 2 bars into the drums.
    const truth = [...intro, ...drums.slice(0, 8)];
    const taps = truth.map((t, k) => t + 35 + (k % 3 === 0 ? 15 : k % 3 === 1 ? -12 : 0)).filter((_, k) => k !== 7);
    const r = spliceTappedIntro(detected, taps)!;
    expect(r.biasMs).toBeGreaterThan(25);
    expect(r.biasMs).toBeLessThan(45);
    expect(r.beats.length).toBe(intro.length + drums.length);
    const err = intro.map((t, k) => Math.abs(r.beats[k] - t));
    // A single tap is ±15 ms off; smoothing over neighbours removes most of it.
    expect(Math.max(...err)).toBeLessThanOrEqual(16);
    expect(err.reduce((a, v) => a + v, 0) / err.length).toBeLessThan(9);
    // The calibration taps on the drums: tapped for the first ones, then the detection.
    expect(Math.abs(r.beats[16] - drums[0])).toBeLessThan(16);
    expect(r.beats.slice(18)).toEqual(drums.slice(2));
  });
});

describe('firstSoundMs', () => {
  it('finds where the music starts after silence', () => {
    const rate = 11025;
    const x = new Float32Array(rate * 2);
    for (let i = Math.round(rate * 0.73); i < x.length; i++) x[i] = Math.sin(i / 3) * Math.exp(-(i - rate * 0.73) / 2000) * 0.8;
    for (let i = 0; i < x.length; i++) x[i] += (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.0005;
    const t = firstSoundMs(x, rate);
    expect(t).toBeGreaterThan(715);
    expect(t).toBeLessThan(735);
  });
});
