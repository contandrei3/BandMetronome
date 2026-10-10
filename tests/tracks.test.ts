import { describe, expect, it } from 'vitest';
import { rebaseTransport } from '../src/masterState';
import { findSteadyBar, normalizeTrack, songTransport, type Song } from '../src/song';
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
  track: { files: [{ id: 'abc', name: 'a.mp3', label: 'Negativ', durationMs: 20000, volume: 1 }], offsetMs: 500 },
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
    track: { files: [{ id: 'abc', name: 'a.mp3', label: 'Original', durationMs: 60000, volume: 0 }], offsetMs: 3000, beats, follow: true },
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

describe('songs with several audio files', () => {
  it('converts songs saved with a single inline file', () => {
    const legacy = { id: 'f1', name: 'x.mp3', durationMs: 1000, offsetMs: 250, follow: true, beats: [1, 2] } as never;
    expect(normalizeTrack(legacy)).toEqual({
      files: [{ id: 'f1', name: 'x.mp3', label: 'Negativ', durationMs: 1000, volume: 1 }],
      tempoFile: 'f1',
      offsetMs: 250,
      follow: true,
      beats: [1, 2],
    });
    const plain = { id: 'f1', name: 'x.mp3', durationMs: 1000, offsetMs: 250 } as never;
    const t = songTransport({ ...song, track: plain }, 0, 1);
    expect(t.song!.track).toEqual({ offsetMs: 250, files: [{ id: 'f1', label: 'Negativ', volume: 1 }] });
  });

  it('shares every file, with its label and default volume, on one timeline', () => {
    const track = {
      files: [
        { id: 'voc', name: 'vocals.wav', label: 'Voce', durationMs: 1000, volume: 1 },
        { id: 'orig', name: 'song.mp3', label: 'Original', durationMs: 1000, volume: 0 },
      ],
      tempoFile: 'orig',
      offsetMs: 500,
    };
    const t = songTransport({ ...song, track }, 1000, 1);
    expect(t.song!.track!.files.map((f) => [f.id, f.label, f.volume])).toEqual([
      ['voc', 'Voce', 1],
      ['orig', 'Original', 0],
    ]);
    expect(trackPositionAt(t.song!, 3000)).toBe(500);
  });
});

describe('drums come in later (steadyFromBar)', () => {
  // Steady band from beat 16 on; the 16 intro beats were detected wandering up to ±70 ms.
  const beats = Array.from({ length: 80 }, (_, i) => 500 + i * 627 + (i < 16 ? 70 * Math.sin(i / 3) : 0));
  const base: Song = {
    ...song,
    bars: 20,
    countInBars: 1,
    markers: [{ bar: 1, bpm: 96, beatsPerBar: 4 }],
    track: { files: [{ id: 'o', name: 'o', label: 'Original', durationMs: 60000, volume: 0 }], offsetMs: 500, beats, follow: true },
  };
  const errAt = (t: ReturnType<typeof songTransport>, k: number) => trackPositionAt(t.song!, tickAt(t, 1, k).time)! - (500 + k * 627);

  it('without it the intro clicks follow the wandering detections', () => {
    const t = songTransport(base, 0, 1);
    expect(Math.max(...Array.from({ length: 16 }, (_, k) => Math.abs(errAt(t, k))))).toBeGreaterThan(30);
  });

  it('with it the intro takes the tempo of the bars where the drums play', () => {
    const t = songTransport({ ...base, track: { ...base.track!, steadyFromBar: 5 } }, 0, 1);
    for (let k = 0; k < 40; k++) expect(Math.abs(errAt(t, k))).toBeLessThan(3);
  });
});

describe('intro without a clear beat', () => {
  // 4 bars of guitar intro detected ±100 ms off, then a steady drum groove at 96 BPM.
  const wobble = [0, 60, -80, 110, -40, 90, -120, 30, 100, -60, 70, -100, 50, -90, 120, -30];
  const truth = Array.from({ length: 120 }, (_, k) => 600 + k * 625);
  const beats = truth.map((t, k) => t + (k < 16 ? wobble[k] : (k % 2 ? 8 : -8)));
  const s: Song = {
    ...song,
    bars: 28,
    markers: [{ bar: 1, bpm: 96, beatsPerBar: 4 }],
    track: { files: [{ id: 'abc', name: 'a.mp3', label: 'Original', durationMs: 80000, volume: 1 }], offsetMs: 600, beats, follow: true },
  };

  it('finds where the beat becomes steady', () => {
    expect(findSteadyBar(s, beats, 0)).toBe(5);
    expect(findSteadyBar(s, truth, 0)).toBe(1);
  });

  it('puts the intro clicks on the groove tempo extended backwards', () => {
    const t = songTransport(s, 0, 1);
    for (let k = 0; k < 24; k++) {
      expect(Math.abs(trackPositionAt(t.song!, tickAt(t, 1, k).time)! - truth[k])).toBeLessThan(6);
    }
  });
});
