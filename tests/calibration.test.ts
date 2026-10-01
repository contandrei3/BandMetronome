import { describe, expect, it } from 'vitest';
import { analyzeTaps } from '../src/calibration';

describe('analyzeTaps', () => {
  it('recovers the latency of taps that follow each click', () => {
    const t0 = 5000;
    const taps = Array.from({ length: 16 }, (_, k) => t0 + k * 1000 + 240 + ((k * 7) % 11) - 5);
    const r = analyzeTaps(taps, t0)!;
    expect(Math.abs(r.latencyMs - 240)).toBeLessThanOrEqual(2);
    expect(r.spreadMs).toBeLessThan(10);
  });

  it('pairs slightly early taps with the right click', () => {
    const taps = Array.from({ length: 16 }, (_, k) => k * 1000 - 40);
    expect(analyzeTaps(taps, 0)!.latencyMs).toBe(-40);
  });

  it('needs enough taps', () => {
    expect(analyzeTaps([100, 1100, 2100], 0)).toBeNull();
  });
});
