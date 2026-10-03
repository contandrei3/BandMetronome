import { describe, expect, it } from 'vitest';
import { analyzeBeats, ANALYSIS_RATE, fitGrid } from '../src/analysis/beats';

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

describe('beat analysis', () => {
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
