import type { Role } from './roles';

/**
 * Transport state shared by the master with every member. All times are in
 * master-clock milliseconds; every device derives the click grid from this
 * alone, so only state changes travel over the network, never individual beats.
 *
 * The grid is a list of segments, each starting on a downbeat with its own
 * tempo and meter. A change made while playing is appended as a new segment
 * on an upcoming downbeat, so the beats before it keep playing unchanged.
 * A segment can ramp its tempo (accelerando / ritardando) beat by beat.
 */
export interface Segment {
  /** Master time at which this segment's first beat sounds. */
  t: number;
  /** Global beat number of that first beat. */
  beat: number;
  /** Global bar number of that first beat. */
  bar: number;
  bpm: number;
  beatsPerBar: number;
  /** Note value of one click, for display only (7/8 = 7 clicks of an eighth). Default 4. */
  beatUnit?: number;
  /** Tempo ramp: reaches `bpmEnd` after `rampBeats` beats, then stays there. */
  bpmEnd?: number;
  rampBeats?: number;
}

/** What members need to show song structure; bars are global bar numbers. */
export interface SongInfo {
  title: string;
  artist: string;
  /** Bar where the song proper starts (bars before it are the count-in). */
  firstBar: number;
  /** Bar right after the last one; the click stops there. */
  endBar: number;
  /** Total bars of the song, for "bar 3 of 64" style display. */
  bars: number;
  /** Bar number as written in the song (1-based) of `firstBar`. */
  firstSongBar: number;
  cues: Cue[];
  /** Master time at which song bar 1 starts (or would have, when starting later in the song). */
  bar1At: number;
  /** Backing tracks; every device plays its own copies in sync with the click, mixed to taste. */
  track?: { offsetMs: number; files: { id: string; label: string; volume: number }[] };
}

export interface Cue {
  /** Global bar number. */
  bar: number;
  text?: string;
  bpm?: number;
  beatsPerBar?: number;
  beatUnit?: number;
  /** The tempo is reached gradually, ending at this bar. */
  ramp?: boolean;
  /** Who the text is for; empty or missing = everyone. */
  roles?: Role[];
}

export interface Transport {
  running: boolean;
  /** Sorted by start time; never empty. */
  segments: Segment[];
  /** First beat that is no longer played (end of song), if any. */
  endBeat?: number;
  song?: SongInfo;
  /** Incremented by the master on every change. */
  rev: number;
}

/** Clicks per beat: quarters, eighths, triplets, sixteenths. */
export type Subdivision = 1 | 2 | 3 | 4;

export type TickLevel = 'accent' | 'beat' | 'sub';

export interface Tick {
  index: number;
  time: number;
  level: TickLevel;
  /** 0-based beat within the bar. */
  beatInBar: number;
  /** Global bar number. */
  bar: number;
  /** False past the end of the song. */
  audible: boolean;
}

export interface BeatPos {
  beat: number;
  beatInBar: number;
  bar: number;
}

/** Old segments are kept this long so late reschedules still find them. */
const KEEP_PAST_MS = 10000;

// ---------- Segment math ----------

function rampLen(s: Segment): number {
  return s.bpmEnd !== undefined && s.rampBeats ? s.rampBeats : 0;
}

/** Tempo of beat `rel` (0-based) inside the segment. */
export function bpmOfBeat(s: Segment, rel: number): number {
  const n = rampLen(s);
  if (n === 0) return s.bpm;
  if (rel >= n) return s.bpmEnd!;
  return s.bpm + ((s.bpmEnd! - s.bpm) * Math.max(0, rel)) / n;
}

const prefixCache = new WeakMap<Segment, number[]>();

/** prefix[k] = offset in ms of beat k from the segment start, for k <= ramp length. */
function prefix(s: Segment): number[] {
  let p = prefixCache.get(s);
  if (!p) {
    const n = rampLen(s);
    p = [0];
    for (let k = 0; k < n; k++) p.push(p[k] + 60000 / bpmOfBeat(s, k));
    prefixCache.set(s, p);
  }
  return p;
}

/** Offset in ms from the segment start to (fractional) beat `rel` >= 0. */
export function beatOffset(s: Segment, rel: number): number {
  const p = prefix(s);
  const n = p.length - 1;
  if (rel >= n) return p[n] + (rel - n) * (60000 / bpmOfBeat(s, n));
  const k = Math.floor(rel);
  return p[k] + (rel - k) * (60000 / bpmOfBeat(s, k));
}

/** Inverse of beatOffset: fractional beat at `dt` ms after the segment start. */
function beatAtOffset(s: Segment, dt: number): number {
  const p = prefix(s);
  const n = p.length - 1;
  if (dt >= p[n]) return n + (dt - p[n]) / (60000 / bpmOfBeat(s, n));
  let lo = 0;
  let hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p[mid] <= dt) lo = mid;
    else hi = mid;
  }
  return lo + (dt - p[lo]) / (60000 / bpmOfBeat(s, lo));
}

/** A segment starting `rel` beats into `s` (must be a downbeat), with the remaining ramp. */
export function splitSegment(s: Segment, rel: number): Segment {
  const n = rampLen(s);
  const base: Segment = {
    t: s.t + beatOffset(s, rel),
    beat: s.beat + rel,
    bar: s.bar + Math.floor(rel / s.beatsPerBar),
    bpm: bpmOfBeat(s, rel),
    beatsPerBar: s.beatsPerBar,
    beatUnit: s.beatUnit,
  };
  return rel < n ? { ...base, bpmEnd: s.bpmEnd, rampBeats: n - rel } : base;
}

// ---------- Transport ----------

export function idleTransport(bpm = 120, beatsPerBar = 4): Transport {
  return { running: false, rev: 0, segments: [{ t: 0, beat: 0, bar: 0, bpm, beatsPerBar }] };
}

export function startTransport(prev: Transport, startAt: number): Transport {
  const { bpm, beatsPerBar, beatUnit } = lastSegment(prev);
  return { running: true, rev: prev.rev + 1, segments: [{ t: startAt, beat: 0, bar: 0, bpm, beatsPerBar, beatUnit }] };
}

export function stopTransport(prev: Transport): Transport {
  return { ...prev, running: false, rev: prev.rev + 1 };
}

export function lastSegment(t: Transport): Segment {
  return t.segments[t.segments.length - 1];
}

/** Segment in effect at master time `time` (the first one before the start). */
export function segmentAt(t: Transport, time: number): Segment {
  let seg = t.segments[0];
  for (const s of t.segments) if (s.t <= time) seg = s;
  return seg;
}

/** Tempo at master time `time`, following ramps. */
export function bpmAt(t: Transport, time: number): number {
  const s = segmentAt(t, time);
  return bpmOfBeat(s, Math.floor(beatAtOffset(s, Math.max(0, time - s.t))));
}

function segmentForBeat(t: Transport, beat: number): Segment {
  let seg = t.segments[0];
  for (const s of t.segments) if (s.beat <= beat) seg = s;
  return seg;
}

export function tickAt(t: Transport, sub: Subdivision, index: number): Tick {
  const beat = Math.floor(index / sub);
  const inBeat = index - beat * sub;
  const s = segmentForBeat(t, beat);
  const rel = beat - s.beat;
  const beatInBar = mod(rel, s.beatsPerBar);
  return {
    index,
    time: s.t + beatOffset(s, rel + inBeat / sub),
    level: inBeat !== 0 ? 'sub' : beatInBar === 0 ? 'accent' : 'beat',
    beatInBar,
    bar: s.bar + Math.floor(rel / s.beatsPerBar),
    audible: t.endBeat === undefined || beat < t.endBeat,
  };
}

/** Index of the first tick at or after `time`, never before the first beat. */
export function firstTickAtOrAfter(t: Transport, sub: Subdivision, time: number): number {
  const i = t.segments.findLastIndex((s) => s.t <= time);
  if (i < 0) return t.segments[0].beat * sub;
  const s = t.segments[i];
  const index = s.beat * sub + Math.ceil(beatAtOffset(s, time - s.t) * sub - 1e-9);
  const next = t.segments[i + 1];
  return next ? Math.min(index, next.beat * sub) : index;
}

/** Beat currently sounding at `time`, or null when stopped, before the start or after the end. */
export function beatAt(t: Transport, time: number): BeatPos | null {
  if (!t.running || time < t.segments[0].t) return null;
  const s = segmentAt(t, time);
  const rel = Math.floor(beatAtOffset(s, time - s.t) + 1e-9);
  if (t.endBeat !== undefined && s.beat + rel >= t.endBeat) return null;
  return { beat: s.beat + rel, beatInBar: mod(rel, s.beatsPerBar), bar: s.bar + Math.floor(rel / s.beatsPerBar) };
}

/** True once a running transport has played past its last beat. */
export function isFinished(t: Transport, time: number): boolean {
  if (!t.running || t.endBeat === undefined) return false;
  const s = segmentForBeat(t, t.endBeat);
  return time >= s.t + beatOffset(s, t.endBeat - s.beat);
}

/**
 * Applies a tempo/meter change. When stopped it applies immediately; when
 * playing it starts on the first downbeat at least `leadMs` after `now`, so
 * every member has received it by then. A change landing on a segment that
 * has not started yet is merged into it.
 */
export function changeTransport(
  t: Transport,
  now: number,
  leadMs: number,
  patch: Partial<Pick<Segment, 'bpm' | 'beatsPerBar' | 'beatUnit'>>,
): Transport {
  const last = lastSegment(t);
  const plain = (s: Segment): Segment => {
    const { bpmEnd: _e, rampBeats: _r, ...rest } = s;
    return rest;
  };
  if (!t.running) return { running: false, rev: t.rev + 1, segments: [{ ...plain(last), ...patch }] };

  const earliest = now + leadMs;
  const kept = t.segments.filter((_, i) => (t.segments[i + 1]?.t ?? Infinity) > now - KEEP_PAST_MS);
  if (last.t >= earliest) {
    return { ...t, rev: t.rev + 1, segments: [...kept.slice(0, -1), { ...plain(last), ...patch }] };
  }
  const bars = Math.ceil(beatAtOffset(last, earliest - last.t) / last.beatsPerBar - 1e-9);
  const next = { ...plain(splitSegment(last, bars * last.beatsPerBar)), ...patch };
  return { ...t, rev: t.rev + 1, segments: [...kept, next] };
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
