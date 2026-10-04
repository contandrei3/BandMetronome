import { smoothBeats } from './analysis/beats';
import { cueIsFor, type Role } from './roles';
import { beatOffset, splitSegment, type Cue, type Segment, type SongInfo, type Transport } from './timeline';

/**
 * A change at a bar of the song, as the band writes it: "bar 17: CHORUS",
 * "bar 33: 7/8", "bar 41: 140 BPM (accelerando from bar 33)".
 * Fields left empty keep the previous value.
 */
export interface Marker {
  /** 1-based bar number in the song. */
  bar: number;
  bpm?: number;
  beatsPerBar?: number;
  /** 4 or 8: 7/8 means 7 clicks per bar where the BPM counts eighths. */
  beatUnit?: number;
  /** Reach `bpm` gradually over the bars since the previous tempo marker instead of jumping. */
  ramp?: boolean;
  /** Instruction shown from this bar on. */
  text?: string;
  /** Who sees `text`; empty or missing = the whole band. */
  roles?: Role[];
}

/**
 * One audio file of a song: a backing track, an extracted vocal, the original
 * recording used only to follow its tempo... Only this description is shared
 * via Firebase; the audio itself is kept on the devices and passed phone to phone.
 */
export interface TrackFile {
  /** SHA-256 of the file, so every device knows it has exactly the same audio. */
  id: string;
  /** File name as picked. */
  name: string;
  /** What it is, shown in everyone's mix: "Voce", "Original", "Negativ"... */
  label: string;
  durationMs: number;
  /** Starting volume (0–1) for every member; 0 = silent unless someone turns it up. */
  volume: number;
}

/**
 * The audio of a song. All files share one timeline (stems extracted from the
 * same recording line up sample for sample), so one bar-1 offset and one set
 * of detected beats apply to all of them.
 */
export interface TrackRef {
  files: TrackFile[];
  /** File the tempo and bar 1 are detected from (usually the original recording). */
  tempoFile?: string;
  /** Where song bar 1 starts in the files, in ms. */
  offsetMs: number;
  /** Beats found in the file (ms), from the analysis in the editor. */
  beats?: number[];
  /**
   * Take the tempo from `beats`, bar by bar, instead of the BPM markers: for
   * recordings made without a click, whose tempo drifts.
   */
  follow?: boolean;
}

/** Songs saved before multi-file support had one file described inline on the track. */
interface LegacyTrack {
  id?: string;
  name?: string;
  durationMs?: number;
}

/** The track in the current format (also converts songs saved with a single file). */
export function normalizeTrack(t: (TrackRef & LegacyTrack) | undefined): TrackRef | undefined {
  if (!t) return undefined;
  const files: TrackFile[] = t.files?.length
    ? t.files
    : t.id
      ? [{ id: t.id, name: t.name ?? 'negativ', label: 'Negativ', durationMs: t.durationMs ?? 0, volume: 1 }]
      : [];
  if (files.length === 0) return undefined;
  const { id: _i, name: _n, durationMs: _d, ...rest } = t;
  return { ...rest, files, tempoFile: files.some((f) => f.id === t.tempoFile) ? t.tempoFile : files[0].id };
}

export interface Song {
  id: string;
  title: string;
  artist: string;
  /** Length of the song in bars; the click stops after the last one. */
  bars: number;
  countInBars: number;
  /** Sorted by bar; the first one is at bar 1 and sets the initial tempo and meter. */
  markers: Marker[];
  track?: TrackRef;
  updatedAt: number;
}

export function newSong(): Song {
  return {
    id: crypto.randomUUID(),
    title: '',
    artist: '',
    bars: 32,
    countInBars: 1,
    markers: [{ bar: 1, bpm: 120, beatsPerBar: 4, text: 'Intro' }],
    updatedAt: Date.now(),
  };
}

/** Sorts, drops markers outside the song and makes sure bar 1 sets tempo and meter. */
export function normalizeSong(song: Song): Song {
  const markers: Marker[] = song.markers
    .map((m) => ({ ...m, bar: Math.round(m.bar) }))
    .filter((m) => m.bar >= 1 && m.bar <= song.bars)
    .sort((a, b) => a.bar - b.bar)
    .map((m) => ({ ...m, text: m.text?.trim() || undefined, roles: m.roles?.length ? m.roles : undefined }));
  if (markers[0]?.bar !== 1) markers.unshift({ bar: 1 });
  const first = markers[0];
  first.bpm ??= 120;
  first.beatsPerBar ??= 4;
  first.beatUnit ??= 4;
  first.ramp = undefined;
  for (const m of markers) {
    if (m.bpm !== undefined) m.bpm = clamp(m.bpm, 20, 400);
    if (m.beatsPerBar !== undefined) m.beatsPerBar = clamp(Math.round(m.beatsPerBar), 1, 32);
  }
  return {
    ...song,
    markers,
    track: normalizeTrack(song.track),
    bars: clamp(Math.round(song.bars) || 1, 1, 2000),
    countInBars: clamp(Math.round(song.countInBars) || 0, 0, 8),
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Builds the click grid of a song. Global bar 0 is song bar 1; the count-in
 * uses negative bars. With `fromBar` the song starts at that (1-based) bar,
 * with the count-in at the tempo in effect there. `startAt` is the master
 * time of the first count-in beat.
 */
export function songTransport(input: Song, startAt: number, rev: number, fromBar = 1): Transport {
  const song = normalizeSong(input);
  const followed = song.track?.follow && song.track.beats?.length ? beatMapSegments(song) : null;
  const segs: Segment[] = followed?.segs ?? markerSegments(song);
  const last = segs[segs.length - 1];
  const endBeat = last.beat + (song.bars - last.bar) * last.beatsPerBar;

  // Cut at the starting bar.
  const startBar = Math.min(Math.max(1, Math.round(fromBar)), song.bars) - 1;
  const at = segs.findLastIndex((s) => s.bar <= startBar);
  const first = splitSegment(segs[at], (startBar - segs[at].bar) * segs[at].beatsPerBar);
  const playing = [first, ...segs.slice(at + 1)];

  // Count-in at the tempo and meter of the starting bar.
  const countIn: Segment[] = [];
  if (song.countInBars > 0) {
    const ci: Segment = {
      t: 0,
      beat: first.beat - song.countInBars * first.beatsPerBar,
      bar: first.bar - song.countInBars,
      bpm: first.bpm,
      beatsPerBar: first.beatsPerBar,
      beatUnit: first.beatUnit,
    };
    ci.t = first.t - beatOffset(ci, first.beat - ci.beat);
    countIn.push(ci);
  }

  const all = [...countIn, ...playing];
  const shift = startAt - all[0].t;
  const cues: Cue[] = song.markers.map((m) => ({
    bar: m.bar - 1,
    text: m.text,
    bpm: m.bpm,
    beatsPerBar: m.beatsPerBar,
    beatUnit: m.beatsPerBar !== undefined ? (m.beatUnit ?? 4) : undefined,
    ramp: m.ramp,
    roles: m.roles,
  }));
  const info: SongInfo = {
    title: song.title,
    artist: song.artist,
    firstBar: first.bar,
    firstSongBar: startBar + 1,
    bar1At: shift,
    track: song.track && {
      offsetMs: followed?.offsetMs ?? song.track.offsetMs,
      files: song.track.files.map((f) => ({ id: f.id, label: f.label, volume: f.volume })),
    },
    endBar: song.bars,
    bars: song.bars,
    cues,
  };
  return { running: true, rev, endBeat, song: info, segments: all.map((s) => ({ ...s, t: s.t + shift })) };
}

export interface SongPosition {
  /** Current instruction (latest text cue at or before this bar). */
  section?: string;
  /** 1-based bar within the section and the section's length. */
  barInSection: number;
  sectionBars: number;
  /** 1-based bar of the song. */
  songBar: number;
  countIn: boolean;
  /** Next cue (text or tempo/meter change) and how many bars until it. */
  next?: Cue;
  barsToNext?: number;
}

/**
 * Where `bar` (global) sits in the song's structure, for the on-screen
 * prompts of `role`. Instructions meant for other roles are ignored, so a
 * "SOLO" for the lead guitar replaces the section name only on that phone.
 */
export function songPosition(info: SongInfo, bar: number, role: Role | null = null): SongPosition {
  if (bar < info.firstBar) {
    return { barInSection: bar - info.firstBar + 1, sectionBars: 0, songBar: info.firstSongBar, countIn: true };
  }
  const texts = info.cues.filter((c) => c.text && cueIsFor(c.roles, role));
  const current = texts.findLast((c) => c.bar <= bar);
  const following = texts.find((c) => c.bar > bar);
  const start = current?.bar ?? 0;
  const end = following?.bar ?? info.endBar;
  // Tempo/meter changes concern everyone; text-only cues only their roles.
  const visible = (c: Cue) => c.bpm !== undefined || c.beatsPerBar !== undefined || (c.text && cueIsFor(c.roles, role));
  const next = info.cues.find((c) => c.bar > bar && visible(c));
  return {
    section: current?.text,
    barInSection: bar - start + 1,
    sectionBars: end - start,
    songBar: bar + 1,
    countIn: false,
    next,
    barsToNext: next ? next.bar - bar : undefined,
  };
}

/** Short description of a cue's tempo/meter change, e.g. "140 BPM · 7/8". */
export function describeChange(c: Cue): string {
  return [
    c.bpm !== undefined ? `${c.ramp ? 'accel./rit. → ' : ''}${c.bpm} BPM` : '',
    c.beatsPerBar !== undefined ? `${c.beatsPerBar}/${c.beatUnit ?? 4}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Song-relative segments (t = 0 at bar 1), one per tempo/meter marker. */
function markerSegments(song: Song): Segment[] {
  const tempo = song.markers.filter((m) => m.bpm !== undefined || m.beatsPerBar !== undefined);
  const segs: Segment[] = [];
  let beat = 0;
  for (let i = 0; i < tempo.length; i++) {
    const m = tempo[i];
    const prev = segs[segs.length - 1];
    const bar = m.bar - 1;
    if (prev) {
      const rel = (bar - prev.bar) * prev.beatsPerBar;
      beat = prev.beat + rel;
      if (m.ramp && m.bpm !== undefined && rel > 0) {
        prev.bpmEnd = m.bpm;
        prev.rampBeats = rel;
      }
    }
    const t = prev ? prev.t + beatOffset(prev, beat - prev.beat) : 0;
    segs.push({
      t,
      beat,
      bar,
      bpm: m.bpm ?? (prev ? (prev.bpmEnd ?? prev.bpm) : 120),
      beatsPerBar: m.beatsPerBar ?? prev?.beatsPerBar ?? 4,
      beatUnit: m.beatUnit ?? prev?.beatUnit ?? 4,
    });
  }
  return segs;
}

/**
 * Song-relative segments taken from the beats found in the backing track:
 * one segment per bar, its tempo from that bar's real length, so the click
 * follows a recording that speeds up or slows down. Bar 1 starts at the
 * detected beat nearest to the chosen offset; meters still come from the
 * markers. Past the last detected beat the last bar's tempo continues.
 */
function beatMapSegments(song: Song): { segs: Segment[]; offsetMs: number } {
  const beats = smoothBeats(song.track!.beats!);
  let b0 = 0;
  for (let i = 1; i < beats.length; i++) {
    if (Math.abs(beats[i] - song.track!.offsetMs) < Math.abs(beats[b0] - song.track!.offsetMs)) b0 = i;
  }
  const meterAt = (bar: number) => {
    let bpb = 4;
    let unit = 4;
    for (const m of song.markers) {
      if (m.bar - 1 > bar) break;
      if (m.beatsPerBar !== undefined) {
        bpb = m.beatsPerBar;
        unit = m.beatUnit ?? 4;
      }
    }
    return { bpb, unit };
  };
  const segs: Segment[] = [];
  let beat = 0;
  let lastBeatMs = 60000 / 120;
  for (let bar = 0; bar < song.bars; bar++) {
    const { bpb, unit } = meterAt(bar);
    const i = b0 + beat;
    const prev = segs[segs.length - 1];
    const t = i < beats.length ? beats[i] - beats[b0] : prev ? prev.t + beatOffset(prev, prev.beatsPerBar) : 0;
    if (i + bpb < beats.length) lastBeatMs = (beats[i + bpb] - beats[i]) / bpb;
    segs.push({ t, beat, bar, bpm: 60000 / lastBeatMs, beatsPerBar: bpb, beatUnit: unit });
    beat += bpb;
  }
  return { segs, offsetMs: beats[b0] };
}
