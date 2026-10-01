import { describe, expect, it } from 'vitest';
import { ClockSync } from '../src/sync/clockSync';

/** Simulates a link where each direction gets a base delay plus random bursts. */
function simulate(sync: ClockSync, trueOffset: number, n: number, rand: () => number) {
  let local = 1000;
  for (let i = 0; i < n; i++) {
    const up = 3 + (rand() < 0.3 ? rand() * 40 : rand());
    const down = 3 + (rand() < 0.3 ? rand() * 40 : rand());
    const c0 = local;
    const m = c0 + up + trueOffset;
    const c2 = c0 + up + down;
    sync.addSample(c0, m, c2);
    local += 500;
  }
}

function lcg(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('ClockSync', () => {
  it('estimates the offset within 1 ms despite bursty, asymmetric delays', () => {
    const sync = new ClockSync();
    simulate(sync, 123456.7, 60, lcg(42));
    expect(sync.locked).toBe(true);
    expect(Math.abs(sync.offset - 123456.7)).toBeLessThan(1);
  });

  it('slews small corrections instead of jumping', () => {
    const sync = new ClockSync({ maxSlewMs: 0.5 });
    sync.addSample(0, 100, 10); // offset 95
    expect(sync.offset).toBe(95);
    for (let i = 1; i <= 10; i++) sync.addSample(i * 100, i * 100 + 105, i * 100 + 10); // offset 100
    expect(sync.offset).toBeGreaterThan(95);
    expect(sync.offset).toBeLessThanOrEqual(100);
  });

  it('snaps on large changes', () => {
    const sync = new ClockSync({ windowSize: 4 });
    for (let i = 0; i < 4; i++) sync.addSample(i, i + 5, i + 10);
    for (let i = 0; i < 4; i++) sync.addSample(i, i + 505, i + 10);
    expect(sync.offset).toBe(500);
  });
});
