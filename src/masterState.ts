import type { Transport } from './timeline';

/**
 * The master's transport, saved so a refresh can carry on playing in time.
 * Transport times are in performance.now() milliseconds, which restart at 0
 * on every page load, so they are stored together with the matching wall
 * clock and shifted onto the new page's clock when restored.
 */
export interface SavedMaster {
  code: string;
  transport: Transport;
  /** performance.now() and Date.now() taken at the same moment when saving. */
  perfAt: number;
  wallAt: number;
}

const KEY = 'bandmetro.master.v1';
const MAX_AGE_MS = 12 * 3600 * 1000;

export function saveMaster(code: string, transport: Transport): void {
  const s: SavedMaster = { code, transport, perfAt: performance.now(), wallAt: Date.now() };
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable: a refresh will start stopped instead.
  }
}

export function clearMaster(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing saved anyway.
  }
}

export function loadMaster(code: string): Transport | null {
  let s: SavedMaster;
  try {
    s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
  if (!s || s.code !== code || Date.now() - s.wallAt > MAX_AGE_MS) return null;
  return rebaseTransport(s, performance.now(), Date.now());
}

/** Moves a saved transport onto a clock where `perfNow` corresponds to `wallNow`. */
export function rebaseTransport(s: SavedMaster, perfNow: number, wallNow: number): Transport {
  const shift = s.wallAt - s.perfAt - (wallNow - perfNow);
  const song = s.transport.song;
  return {
    ...s.transport,
    segments: s.transport.segments.map((seg) => ({ ...seg, t: seg.t + shift })),
    song: song && { ...song, bar1At: song.bar1At + shift },
  };
}
