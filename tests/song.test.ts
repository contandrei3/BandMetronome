import { describe, expect, it } from 'vitest';
import { barsToCover, normalizeSong, songLengthMs, songPosition, songTransport, type Song } from '../src/song';
import { beatAt, bpmAt, firstTickAtOrAfter, isFinished, tickAt } from '../src/timeline';

const song: Song = {
  id: 's',
  title: 'Test',
  artist: 'Band',
  bars: 12,
  countInBars: 1,
  updatedAt: 0,
  markers: [
    { bar: 1, bpm: 120, beatsPerBar: 4, text: 'Intro' },
    { bar: 3, text: 'Vers' },
    { bar: 5, beatsPerBar: 3, text: 'Bridge' },
    { bar: 7, bpm: 60, ramp: true },
    { bar: 9, bpm: 120, text: 'Final' },
  ],
};

describe('songTransport', () => {
  const t = songTransport(song, 1000, 1);

  it('starts with a one-bar count-in before song bar 1', () => {
    expect(tickAt(t, 1, -4)).toMatchObject({ time: 1000, bar: -1, level: 'accent' });
    expect(tickAt(t, 1, 0)).toMatchObject({ time: 3000, bar: 0, level: 'accent' });
  });

  it('switches meter at bar 5', () => {
    // Bars 1-4 at 4/4 120 BPM = 16 beats * 500 ms after 3000.
    expect(tickAt(t, 1, 16)).toMatchObject({ time: 11000, bar: 4, level: 'accent' });
    expect(tickAt(t, 1, 19)).toMatchObject({ bar: 5, level: 'accent' });
  });

  it('ramps from 120 down to 60 BPM over bars 5-6 (ritardando)', () => {
    // Bars 5-6 are 6 beats at 3/4; tempo per beat: 120, 110, 100, 90, 80, 70.
    const durations = [120, 110, 100, 90, 80, 70].map((b) => 60000 / b);
    const end = 11000 + durations.reduce((a, b) => a + b, 0);
    expect(tickAt(t, 1, 22).time).toBeCloseTo(end);
    expect(bpmAt(t, end + 1)).toBe(60);
    // A subdivision splits the ramped beat evenly.
    expect(tickAt(t, 2, 33).time).toBeCloseTo(11000 + durations[0] / 2);
  });

  it('jumps back to 120 at bar 9 and stops after bar 12', () => {
    const bar9 = tickAt(t, 1, 22 + 6); // bars 7-8: 6 beats at 60 BPM
    expect(bar9).toMatchObject({ bar: 8, level: 'accent' });
    expect(tickAt(t, 1, 29).time - bar9.time).toBeCloseTo(500);
    // Bars 9-12 at 3/4 = 12 beats; beat 40 is past the end.
    expect(tickAt(t, 1, 39).audible).toBe(true);
    expect(tickAt(t, 1, 40).audible).toBe(false);
    expect(beatAt(t, tickAt(t, 1, 40).time + 1)).toBeNull();
    expect(isFinished(t, tickAt(t, 1, 40).time)).toBe(true);
    expect(isFinished(t, tickAt(t, 1, 39).time)).toBe(false);
  });

  it('finds ticks inside a ramp', () => {
    const tk = tickAt(t, 1, 20);
    expect(firstTickAtOrAfter(t, 1, tk.time - 1)).toBe(20);
    expect(firstTickAtOrAfter(t, 1, tk.time + 1)).toBe(21);
  });

  it('can start mid-song with a count-in at that tempo', () => {
    const r = songTransport(song, 0, 1, 9);
    expect(r.segments[0]).toMatchObject({ t: 0, bar: 7, bpm: 120, beatsPerBar: 3 });
    expect(r.song).toMatchObject({ firstBar: 8, firstSongBar: 9 });
    expect(tickAt(r, 1, 28)).toMatchObject({ time: 1500, bar: 8, level: 'accent' });
  });

  it('starts mid-ramp with the tempo reached so far', () => {
    const r = songTransport({ ...song, countInBars: 0 }, 0, 1, 6);
    expect(r.segments[0]).toMatchObject({ bar: 5, bpm: 90, bpmEnd: 60, rampBeats: 3 });
  });
});

describe('songPosition', () => {
  const info = songTransport(song, 0, 1).song!;
  it('reports count-in, sections and the next cue', () => {
    expect(songPosition(info, -1).countIn).toBe(true);
    expect(songPosition(info, 3)).toMatchObject({ section: 'Vers', barInSection: 2, sectionBars: 2, songBar: 4, barsToNext: 1 });
    expect(songPosition(info, 3).next).toMatchObject({ bar: 4, text: 'Bridge', beatsPerBar: 3 });
    expect(songPosition(info, 6)).toMatchObject({ section: 'Bridge', barInSection: 3, sectionBars: 4, barsToNext: 2 });
    expect(songPosition(info, 11)).toMatchObject({ section: 'Final', barInSection: 4, sectionBars: 4, next: undefined });
  });
});

describe('role-specific cues', () => {
  const s: Song = {
    ...song,
    markers: [
      { bar: 1, bpm: 120, beatsPerBar: 4, text: 'Intro' },
      { bar: 5, text: 'Refren' },
      { bar: 5, text: 'SOLO', roles: ['lead'] },
      { bar: 9, text: 'Fără tobe', roles: ['drums'] },
    ],
  };
  const info = songTransport(s, 0, 1).song!;
  it('shows a role cue only to that role', () => {
    expect(songPosition(info, 5, 'lead').section).toBe('SOLO');
    expect(songPosition(info, 5, 'bass').section).toBe('Refren');
    expect(songPosition(info, 5, null).section).toBe('Refren');
  });
  it('announces upcoming cues only to the roles they are for', () => {
    expect(songPosition(info, 6, 'drums').next?.text).toBe('Fără tobe');
    expect(songPosition(info, 6, 'bass').next).toBeUndefined();
  });
});

describe('normalizeSong', () => {
  it('rounds and clamps values typed in the editor', () => {
    const n = normalizeSong({ ...song, bars: 10.4, countInBars: 1.6, markers: [{ bar: 1.2, bpm: 9999, beatsPerBar: 0 }] });
    expect(n).toMatchObject({ bars: 10, countInBars: 2 });
    expect(n.markers[0]).toMatchObject({ bar: 1, bpm: 400, beatsPerBar: 1 });
  });
});

describe('song length vs backing track', () => {
  const base: Song = { ...song, bars: 32, countInBars: 1, markers: [{ bar: 1, bpm: 120, beatsPerBar: 4 }] };
  it('measures the click length from bar 1', () => {
    expect(songLengthMs(base)).toBeCloseTo(32 * 2000);
  });
  it('finds the bars needed to cover the audio', () => {
    // 2:53 of audio after bar 1 at 120 BPM 4/4 (2 s per bar) -> 87 bars.
    expect(barsToCover(base, 173000)).toBe(87);
    expect(barsToCover({ ...base, bars: 200 }, 173000)).toBe(87);
  });
});
