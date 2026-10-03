import type { SongInfo } from './timeline';

/**
 * Backing-track audio files, kept in this browser's IndexedDB keyed by the
 * file's SHA-256. Files never go to Firebase: the device that has one passes
 * it to the others over the session's data channel.
 */

const DB = 'bandmetro-tracks';
const STORE = 'tracks';

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = op(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export function getTrack(id: string): Promise<ArrayBuffer | undefined> {
  return run('readonly', (s) => s.get(id) as IDBRequest<ArrayBuffer | undefined>);
}

export function putTrack(id: string, data: ArrayBuffer): Promise<void> {
  return run('readwrite', (s) => s.put(data, id)).then(() => undefined);
}

export async function hasTrack(id: string): Promise<boolean> {
  return (await run('readonly', (s) => s.count(id))) > 0;
}

/** Content id of an audio file: hex SHA-256. */
export async function trackId(data: ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Length of an audio file in ms, decoded without needing a running AudioContext. */
export async function audioDurationMs(data: ArrayBuffer): Promise<number> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const buf = await ctx.decodeAudioData(data.slice(0));
  return Math.round(buf.duration * 1000);
}

/**
 * Position in the track file (ms) that should be heard at master time `time`.
 * Bar 1 of the song sits `offsetMs` into the file; the file runs in real time.
 */
export function trackPositionAt(song: SongInfo, time: number): number | null {
  if (!song.track) return null;
  return song.track.offsetMs + (time - song.bar1At);
}

/**
 * Master time at which the track should start sounding: when the count-in
 * starts, or later if the file only begins after that.
 */
export function trackStartAt(song: SongInfo, firstSegmentAt: number): number | null {
  if (!song.track) return null;
  return Math.max(firstSegmentAt, song.bar1At - song.track.offsetMs);
}
