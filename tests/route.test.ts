import { describe, expect, it } from 'vitest';
import { rebaseTransport } from '../src/masterState';
import { parseRoute, routeHash } from '../src/route';
import { idleTransport, startTransport } from '../src/timeline';

describe('route', () => {
  it('parses session hashes and the legacy join query', () => {
    expect(parseRoute('#master/1234', '')).toEqual({ role: 'master', code: '1234' });
    expect(parseRoute('#join/0042', '')).toEqual({ role: 'join', code: '0042' });
    expect(parseRoute('', '?join=5678')).toEqual({ role: 'join', code: '5678' });
    expect(parseRoute('#master/12', '')).toBeNull();
    expect(parseRoute('', '')).toBeNull();
    expect(routeHash({ role: 'join', code: '1234' })).toBe('#join/1234');
  });
});

describe('rebaseTransport', () => {
  it('keeps the beat grid at the same wall-clock time after a reload', () => {
    // Saved when perf=50_000 matched wall=1_000_000; the song started at perf 40_000 (wall 990_000).
    const transport = startTransport(idleTransport(), 40_000);
    const saved = { code: '1234', transport, perfAt: 50_000, wallAt: 1_000_000 };
    // New page: perf=300 matches wall=1_005_000, so wall 990_000 is perf -14_700.
    const t = rebaseTransport(saved, 300, 1_005_000);
    expect(t.segments[0].t).toBe(-14_700);
    expect(t.running).toBe(true);
  });
});
