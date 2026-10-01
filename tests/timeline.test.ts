import { describe, expect, it } from 'vitest';
import {
  beatAt,
  changeTransport,
  firstTickAtOrAfter,
  idleTransport,
  startTransport,
  tickAt,
  type Transport,
} from '../src/timeline';

const t: Transport = startTransport(idleTransport(120, 4), 1000);

describe('timeline', () => {
  it('lays out ticks with accents and subdivisions', () => {
    expect(tickAt(t, 1, 0)).toMatchObject({ time: 1000, level: 'accent', bar: 0 });
    expect(tickAt(t, 1, 1)).toMatchObject({ time: 1500, level: 'beat', beatInBar: 1 });
    expect(tickAt(t, 1, 4)).toMatchObject({ time: 3000, level: 'accent', bar: 1 });
    expect(tickAt(t, 2, 1)).toMatchObject({ time: 1250, level: 'sub' });
    expect(tickAt(t, 3, 3).time).toBeCloseTo(1500);
    expect(tickAt(t, 3, 3).level).toBe('beat');
  });

  it('finds the next tick and never goes before the start', () => {
    expect(firstTickAtOrAfter(t, 1, 0)).toBe(0);
    expect(firstTickAtOrAfter(t, 1, 1500)).toBe(1);
    expect(firstTickAtOrAfter(t, 1, 1501)).toBe(2);
    expect(firstTickAtOrAfter(t, 4, 1126)).toBe(2);
  });

  it('reports the current beat', () => {
    expect(beatAt(t, 999)).toBeNull();
    expect(beatAt(t, 3600)).toEqual({ beat: 5, beatInBar: 1, bar: 1 });
    expect(beatAt({ ...t, running: false }, 3600)).toBeNull();
  });

  it('applies a change while playing on the next downbeat, keeping the beats before it', () => {
    // At 2500 ms (bar 1, beat 4 is at 2500) with 600 ms lead -> next downbeat at 5000 (bar 2).
    const c = changeTransport(t, 2500, 600, { bpm: 60, beatsPerBar: 3 });
    expect(c.segments.at(-1)).toMatchObject({ t: 5000, beat: 8, bar: 2, bpm: 60, beatsPerBar: 3 });
    expect(tickAt(c, 1, 7)).toMatchObject({ time: 4500, level: 'beat', beatInBar: 3, bar: 1 });
    expect(tickAt(c, 1, 8)).toMatchObject({ time: 5000, level: 'accent', bar: 2 });
    expect(tickAt(c, 1, 11)).toMatchObject({ time: 8000, level: 'accent', bar: 3 });
    expect(beatAt(c, 4600)).toEqual({ beat: 7, beatInBar: 3, bar: 1 });
    expect(beatAt(c, 7100)).toEqual({ beat: 10, beatInBar: 2, bar: 2 });
    expect(firstTickAtOrAfter(c, 1, 4600)).toBe(8);
    expect(firstTickAtOrAfter(c, 1, 5001)).toBe(9);
  });

  it('merges a second change into a segment that has not started yet', () => {
    const c1 = changeTransport(t, 2500, 600, { bpm: 60 });
    const c2 = changeTransport(c1, 2700, 600, { beatsPerBar: 3 });
    expect(c2.segments).toHaveLength(2);
    expect(c2.segments[1]).toMatchObject({ t: 5000, bpm: 60, beatsPerBar: 3 });
  });

  it('applies changes immediately when stopped', () => {
    const c = changeTransport(idleTransport(), 0, 600, { bpm: 90 });
    expect(c.segments).toEqual([{ t: 0, beat: 0, bar: 0, bpm: 90, beatsPerBar: 4 }]);
  });
});
