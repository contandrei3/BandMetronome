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
 *
 * A bad Wi-Fi spell (Bluetooth sharing 2.4 GHz, a microwave, someone
 * streaming) can last longer than the window, and then even its fastest
 * samples are skewed by tens of ms. Two safeguards keep the band together:
 *  - Each sample proves the true offset lies within ±rtt/2 of its offset.
 *    The estimate only jumps when the fastest samples rule out the current
 *    value, twice in a row; slow, wide samples can never cause a jump.
 *  - Small corrections are only followed while the window holds samples
 *    nearly as fast as the best seen in the last minutes; otherwise the
 *    offset is held, which costs at most ~1 ms of drift per 20 s.
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

const LOCK_SAMPLES = 8;
/** ~4 minutes of pings at 2 Hz. */
const RTT_HISTORY = 480;
/** Allowance for clock drift inside the window and timer granularity, in ms. */
const SLACK_MS = 2;

export class ClockSync {
  private samples: SyncSample[] = [];
  private smoothed: number | null = null;
  /** RTTs of the last few minutes, for what a fast sample looks like on this network. */
  private rtts: number[] = [];
  private total = 0;
  private pending = 0;
  /** Called when the offset jumps (not slews), with the size of the jump in ms. */
  onJump: (deltaMs: number) => void = () => {};
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
    this.rtts.push(rtt);
    if (this.rtts.length > RTT_HISTORY) this.rtts.shift();
    this.total++;

    const target = this.estimate();
    if (target === null) return;
    if (this.smoothed === null) {
      this.smoothed = target;
      return;
    }
    const delta = target - this.smoothed;
    if (Math.abs(delta) > this.snapThresholdMs) {
      // Still converging: follow the estimate. Locked: only if the fast samples disagree, twice.
      if (this.total <= LOCK_SAMPLES || (this.contradicted(this.smoothed) && ++this.pending >= 2)) {
        this.jump(target);
      }
      return;
    }
    this.pending = 0;
    if (this.fastWindow()) this.smoothed += Math.max(-this.maxSlewMs, Math.min(this.maxSlewMs, delta));
  }

  private jump(to: number): void {
    const delta = to - (this.smoothed ?? to);
    this.smoothed = to;
    this.pending = 0;
    if (this.total > LOCK_SAMPLES) this.onJump(delta);
  }

  /** True when most of the fastest samples prove `offset` wrong. */
  private contradicted(offset: number): boolean {
    const best = this.bestSamples();
    const out = best.filter((s) => Math.abs(s.offset - offset) > s.rtt / 2 + SLACK_MS).length;
    return out * 2 >= best.length;
  }

  /** The window holds samples about as fast as this network normally gives. */
  private fastWindow(): boolean {
    const best = this.bestSamples();
    if (best.length === 0) return false;
    return best[0].rtt <= 2 * Math.min(...this.rtts) + 10;
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
    return this.total >= LOCK_SAMPLES;
  }

  /** Stats for display: min RTT and spread of the best offsets (a proxy for sync error). */
  stats(): { samples: number; minRtt: number; jitter: number; fast: boolean } {
    const best = this.bestSamples();
    if (best.length === 0) return { samples: 0, minRtt: NaN, jitter: NaN, fast: false };
    const offs = best.map((s) => s.offset);
    return {
      samples: this.samples.length,
      minRtt: Math.min(...best.map((s) => s.rtt)),
      jitter: Math.max(...offs) - Math.min(...offs),
      fast: this.fastWindow(),
    };
  }

  reset(): void {
    this.samples = [];
    this.smoothed = null;
    this.rtts = [];
    this.total = 0;
    this.pending = 0;
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
