import { describe, expect, it } from 'vitest';
import { rebaseTransport } from '../src/masterState';
import { songTransport, type Song } from '../src/song';
import { trackPositionAt, trackStartAt } from '../src/tracks';
import { tickAt } from '../src/timeline';
import { smoothBeats, tempoRange } from '../src/analysis/beats';

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

describe('following the backing track tempo', () => {
  // A recording that speeds up: beat k at 500 + sum of drifting intervals.
  const beats: number[] = [500];
  for (let k = 1; k < 40; k++) beats.push(beats[k - 1] + 640 - k * 2);
  const followSong: Song = {
    ...song,
    bars: 8,
    countInBars: 1,
    markers: [{ bar: 1, bpm: 96, beatsPerBar: 4 }],
    track: { id: 'abc', name: 'a.mp3', offsetMs: 3000, durationMs: 60000, beats, follow: true },
  };

  // The click follows the smoothed beats (detection jitter removed, drift kept).
  const smooth = smoothBeats(beats);

  it('puts every click on a detected beat, bar 1 on the beat nearest the offset', () => {
    const t = songTransport(followSong, 0, 1);
    // Offset 3000 snaps to beat 4 (≈3040 ms in the file).
    expect(t.song!.track!.offsetMs).toBe(smooth[4]);
    // Downbeats land exactly on the recording's beats.
    for (const k of [0, 4, 12, 20, 28]) {
      expect(trackPositionAt(t.song!, tickAt(t, 1, k).time)).toBeCloseTo(smooth[4 + k], 6);
    }
    // Inside a bar the tempo is that bar's average: within a few ms even for this
    // exaggerated acceleration (real recordings drift far less within one bar).
    for (const k of [1, 7, 13, 31]) {
      expect(Math.abs(trackPositionAt(t.song!, tickAt(t, 1, k).time)! - beats[4 + k])).toBeLessThan(12);
    }
  });

  it('reports the bar tempo from the recording', () => {
    const t = songTransport(followSong, 0, 1);
    const bar2 = t.segments.find((s) => s.bar === 1)!;
    expect(bar2.bpm).toBeCloseTo(60000 / ((smooth[12] - smooth[8]) / 4), 6);
  });

  it('can start from a later bar', () => {
    const t = songTransport(followSong, 0, 1, 3);
    const first = tickAt(t, 1, 8); // bar 3, beat 1
    expect(trackPositionAt(t.song!, first.time)).toBeCloseTo(smooth[12], 6);
  });

  it('keeps using the BPM markers when following is off', () => {
    const t = songTransport({ ...followSong, track: { ...followSong.track!, follow: false } }, 0, 1);
    expect(t.segments.at(-1)!.bpm).toBe(96);
    expect(t.song!.track!.offsetMs).toBe(3000);
  });
});

describe('beat smoothing', () => {
  it('ignores a single misdetected beat', () => {
    const beats = Array.from({ length: 40 }, (_, i) => 500 + i * 620);
    beats[20] += 45; // one beat detected 45 ms late
    const s = smoothBeats(beats);
    expect(Math.abs(s[20] - (500 + 20 * 620))).toBeLessThan(2);
    expect(Math.abs(s[19] - (500 + 19 * 620))).toBeLessThan(2);
  });

  it('keeps a real tempo drift (95 -> 99 BPM)', () => {
    const beats = [0];
    for (let i = 1; i < 200; i++) beats.push(beats[i - 1] + 60000 / (95 + (4 * i) / 200));
    const s = smoothBeats(beats);
    expect(Math.max(...s.map((v, i) => Math.abs(v - beats[i])))).toBeLessThan(1);
    const r = tempoRange(beats);
    expect(r.min).toBeGreaterThan(94.9);
    expect(r.max).toBeLessThan(99.1);
    expect(r.max - r.min).toBeGreaterThan(3);
  });
});
