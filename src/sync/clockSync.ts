/**
 * NTP-style clock offset estimator.
 *
 * The client sends a ping stamped with its local time c0, the master answers
 * with its own time m, and the client receives the answer at c2. Assuming a
 * symmetric path, the master clock read m at local time (c0 + c2) / 2, so
 *
 *   offset = m - (c0 + c2) / 2        (masterTime = localTime + offset)
 *   rtt    = c2 - c0
 *
 * Wi-Fi delays are asymmetric and bursty, so a single sample can be off by
 * tens of ms. Samples with the smallest RTT have the least room for
 * asymmetry, so we keep a sliding window, take the fastest fraction and use
 * the median of their offsets. The window is short enough that clock drift
 * between phones (tens of ppm) stays well under a millisecond inside it.
 */

export interface SyncSample {
  offset: number;
  rtt: number;
  at: number;
}

export interface ClockSyncOptions {
  windowSize?: number;
  bestFraction?: number;
  /** Max correction applied per update once locked, in ms (avoids audible jumps). */
  maxSlewMs?: number;
  /** Corrections larger than this are applied immediately (initial lock, network change). */
  snapThresholdMs?: number;
}

export class ClockSync {
  private samples: SyncSample[] = [];
  private smoothed: number | null = null;
  private readonly windowSize: number;
  private readonly bestFraction: number;
  private readonly maxSlewMs: number;
  private readonly snapThresholdMs: number;

  constructor(opts: ClockSyncOptions = {}) {
    this.windowSize = opts.windowSize ?? 40;
    this.bestFraction = opts.bestFraction ?? 0.3;
    this.maxSlewMs = opts.maxSlewMs ?? 0.5;
    this.snapThresholdMs = opts.snapThresholdMs ?? 30;
  }

  addSample(c0: number, m: number, c2: number): void {
    const rtt = c2 - c0;
    if (!(rtt >= 0)) return;
    this.samples.push({ offset: m - (c0 + c2) / 2, rtt, at: c2 });
    if (this.samples.length > this.windowSize) this.samples.shift();

    const target = this.estimate();
    if (target === null) return;
    if (this.smoothed === null || Math.abs(target - this.smoothed) > this.snapThresholdMs) {
      this.smoothed = target;
    } else {
      const delta = target - this.smoothed;
      this.smoothed += Math.max(-this.maxSlewMs, Math.min(this.maxSlewMs, delta));
    }
  }

  /** Raw best estimate from the current window, without slewing. */
  estimate(): number | null {
    const best = this.bestSamples();
    if (best.length === 0) return null;
    return median(best.map((s) => s.offset));
  }

  /** Smoothed offset to add to local time to get master time. */
  get offset(): number {
    return this.smoothed ?? 0;
  }

  get locked(): boolean {
    return this.samples.length >= 8;
  }

  /** Stats for display: min RTT and spread of the best offsets (a proxy for sync error). */
  stats(): { samples: number; minRtt: number; jitter: number } {
    const best = this.bestSamples();
    if (best.length === 0) return { samples: 0, minRtt: NaN, jitter: NaN };
    const offs = best.map((s) => s.offset);
    return {
      samples: this.samples.length,
      minRtt: Math.min(...best.map((s) => s.rtt)),
      jitter: Math.max(...offs) - Math.min(...offs),
    };
  }

  reset(): void {
    this.samples = [];
    this.smoothed = null;
  }

  private bestSamples(): SyncSample[] {
    if (this.samples.length === 0) return [];
    const n = Math.max(1, Math.ceil(this.samples.length * this.bestFraction));
    return [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, n);
  }
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
