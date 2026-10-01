/**
 * Transport state shared by the master with every member. All times are in
 * master-clock milliseconds; every device derives the click grid from this
 * alone, so only state changes travel over the network, never individual beats.
 *
 * The grid is a list of segments, each starting on a downbeat with its own
 * tempo and meter. A change made while playing is appended as a new segment
 * on an upcoming downbeat, so the beats before it keep playing unchanged.
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
}

export interface Transport {
  running: boolean;
  /** Sorted by start time; never empty. */
  segments: Segment[];
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
  /** 0-based bar number. */
  bar: number;
}

export interface BeatPos {
  beat: number;
  beatInBar: number;
  bar: number;
}

const beatMs = (s: Segment) => 60000 / s.bpm;
/** Old segments are kept this long so late reschedules still find them. */
const KEEP_PAST_MS = 10000;

export function idleTransport(bpm = 120, beatsPerBar = 4): Transport {
  return { running: false, rev: 0, segments: [{ t: 0, beat: 0, bar: 0, bpm, beatsPerBar }] };
}

export function startTransport(prev: Transport, startAt: number): Transport {
  const { bpm, beatsPerBar } = lastSegment(prev);
  return { running: true, rev: prev.rev + 1, segments: [{ t: startAt, beat: 0, bar: 0, bpm, beatsPerBar }] };
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
    time: s.t + (rel + inBeat / sub) * beatMs(s),
    level: inBeat !== 0 ? 'sub' : beatInBar === 0 ? 'accent' : 'beat',
    beatInBar,
    bar: s.bar + Math.floor(rel / s.beatsPerBar),
  };
}

/** Index of the first tick at or after `time`, never before the first beat. */
export function firstTickAtOrAfter(t: Transport, sub: Subdivision, time: number): number {
  const i = t.segments.findLastIndex((s) => s.t <= time);
  if (i < 0) return t.segments[0].beat * sub;
  const s = t.segments[i];
  const index = s.beat * sub + Math.ceil(((time - s.t) * sub) / beatMs(s) - 1e-9);
  const next = t.segments[i + 1];
  return next ? Math.min(index, next.beat * sub) : index;
}

/** Beat currently sounding at `time`, or null when stopped or before the start. */
export function beatAt(t: Transport, time: number): BeatPos | null {
  if (!t.running || time < t.segments[0].t) return null;
  const s = segmentAt(t, time);
  const rel = Math.floor((time - s.t) / beatMs(s));
  return { beat: s.beat + rel, beatInBar: mod(rel, s.beatsPerBar), bar: s.bar + Math.floor(rel / s.beatsPerBar) };
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
  patch: Partial<Pick<Segment, 'bpm' | 'beatsPerBar'>>,
): Transport {
  const last = lastSegment(t);
  if (!t.running) return { ...t, rev: t.rev + 1, segments: [{ ...last, ...patch }] };

  const earliest = now + leadMs;
  const kept = t.segments.filter((_, i) => (t.segments[i + 1]?.t ?? Infinity) > now - KEEP_PAST_MS);
  if (last.t >= earliest) {
    return { ...t, rev: t.rev + 1, segments: [...kept.slice(0, -1), { ...last, ...patch }] };
  }
  const barMs = beatMs(last) * last.beatsPerBar;
  const bars = Math.ceil((earliest - last.t) / barMs);
  const next: Segment = {
    ...last,
    ...patch,
    t: last.t + bars * barMs,
    beat: last.beat + bars * last.beatsPerBar,
    bar: last.bar + bars,
  };
  return { ...t, rev: t.rev + 1, segments: [...kept, next] };
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
