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

describe('ClockSync on bad Wi-Fi', () => {
  it('holds the offset through a long spell of slow, one-sided delays', () => {
    const sync = new ClockSync();
    const rand = lcg(7);
    let jumps = 0;
    sync.onJump = () => jumps++;
    let local = 1000;
    const offset = 5000;
    const send = (up: number, down: number) => {
      sync.addSample(local, local + up + offset, local + up + down);
      local += 500;
    };
    for (let i = 0; i < 60; i++) send(3 + rand(), 3 + rand());
    expect(Math.abs(sync.offset - offset)).toBeLessThan(1);
    // 40 s where the answers come back 150-250 ms late: the old estimator moved ~75 ms.
    for (let i = 0; i < 80; i++) {
      send(3 + rand() * 5, 150 + rand() * 100);
      expect(Math.abs(sync.offset - offset)).toBeLessThan(2);
    }
    for (let i = 0; i < 60; i++) send(3 + rand(), 3 + rand());
    expect(Math.abs(sync.offset - offset)).toBeLessThan(1);
    expect(jumps).toBe(0);
  });

  it('still jumps when fast samples prove the clock really moved', () => {
    const sync = new ClockSync();
    let jumps = 0;
    sync.onJump = () => jumps++;
    for (let i = 0; i < 40; i++) sync.addSample(i * 500, i * 500 + 3 + 100, i * 500 + 6);
    expect(sync.offset).toBeCloseTo(100, 0);
    for (let i = 40; i < 100; i++) sync.addSample(i * 500, i * 500 + 3 + 400, i * 500 + 6);
    expect(sync.offset).toBeCloseTo(400, 0);
    expect(jumps).toBe(1);
  });
});
