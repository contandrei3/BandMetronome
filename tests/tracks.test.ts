import { describe, expect, it } from 'vitest';
import { rebaseTransport } from '../src/masterState';
import { songTransport, type Song } from '../src/song';
import { trackPositionAt, trackStartAt } from '../src/tracks';

const song: Song = {
  id: 's',
  title: 'T',
  artist: '',
  bars: 8,
  countInBars: 1,
  updatedAt: 0,
  markers: [{ bar: 1, bpm: 120, beatsPerBar: 4 }],
  track: { id: 'abc', name: 'a.mp3', offsetMs: 500, durationMs: 20000 },
};

describe('backing track timing', () => {
  it('lines bar 1 up with the offset in the file', () => {
    // Count-in starts at 1000, bar 1 at 3000; bar 1 is 0.5 s into the file.
    const t = songTransport(song, 1000, 1);
    expect(t.song!.bar1At).toBe(3000);
    expect(trackPositionAt(t.song!, 3000)).toBe(500);
    expect(trackStartAt(t.song!, t.segments[0].t)).toBe(2500);
  });

  it('starts at the count-in when the file has a longer intro', () => {
    const t = songTransport({ ...song, track: { ...song.track!, offsetMs: 5000 } }, 1000, 1);
    expect(trackStartAt(t.song!, t.segments[0].t)).toBe(1000);
    expect(trackPositionAt(t.song!, 1000)).toBe(3000);
  });

  it('starting from bar 5 jumps into the file accordingly', () => {
    const t = songTransport(song, 0, 1, 5);
    // Bar 5 is 8 s after bar 1; the count-in bar before it starts at 0.
    expect(trackPositionAt(t.song!, 2000)).toBe(500 + 8000);
  });

  it('keeps bar 1 aligned when a refreshed master rebases its clock', () => {
    const t = songTransport(song, 40_000, 1);
    const r = rebaseTransport({ code: '1', transport: t, perfAt: 50_000, wallAt: 1_000_000 }, 300, 1_005_000);
    expect(r.song!.bar1At - r.segments[0].t).toBe(t.song!.bar1At - t.segments[0].t);
  });
});
