import { median } from './sync/clockSync';

/** Tempo of the calibration clicks. Slow enough that latencies up to ~800 ms stay unambiguous. */
export const CALIBRATION_PERIOD_MS = 1000;
export const CALIBRATION_TAPS = 16;
const WARMUP_TAPS = 4;

export interface TapResult {
  latencyMs: number;
  /** Median absolute deviation of the taps; large values mean an unreliable result. */
  spreadMs: number;
  used: number;
}

/**
 * Estimates the playback latency from taps made in time with clicks the user
 * hears. Each tap is paired with the latest click that could have caused it
 * (taps can land slightly early, so up to 150 ms before the click counts).
 * The first taps are skipped while the user finds the groove.
 *
 * The result includes touch-input delay and the user's own timing habit, so
 * it is a starting point to fine-tune by ear, not an exact measurement.
 */
export function analyzeTaps(taps: number[], t0: number, periodMs = CALIBRATION_PERIOD_MS): TapResult | null {
  const diffs: number[] = [];
  for (const tap of taps.slice(WARMUP_TAPS)) {
    const k = Math.floor((tap - t0 + 150) / periodMs);
    if (k < 0) continue;
    diffs.push(tap - (t0 + k * periodMs));
  }
  if (diffs.length < 6) return null;
  const latencyMs = median(diffs);
  return {
    latencyMs: Math.round(latencyMs),
    spreadMs: Math.round(median(diffs.map((d) => Math.abs(d - latencyMs)))),
    used: diffs.length,
  };
}
