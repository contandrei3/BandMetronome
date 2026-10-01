import type { Song } from './song';

/** The band's song library and the running order for tonight. */
export interface Library {
  songs: Song[];
  /** Song ids in playing order. */
  setlist: string[];
}

/**
 * Where the library lives. Both stores keep a copy on the device, so the
 * setlist works without internet; the Firebase store also shares it with
 * the whole band and pushes everyone's edits live.
 */
export interface LibraryStore {
  readonly kind: 'local' | 'cloud';
  /** Calls `cb` now and on every change (local or remote). Returns an unsubscribe function. */
  subscribe(cb: (lib: Library) => void): () => void;
  saveSong(song: Song): Promise<void>;
  deleteSong(id: string): Promise<void>;
  saveSetlist(ids: string[]): Promise<void>;
}

const KEY = 'bandmetro.library.v1';

export function readLocalLibrary(): Library {
  try {
    const lib = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Library | null;
    if (lib && Array.isArray(lib.songs)) return { songs: lib.songs, setlist: lib.setlist ?? [] };
  } catch {
    // Corrupt or unavailable storage: start empty.
  }
  return { songs: [], setlist: [] };
}

export class LocalLibraryStore implements LibraryStore {
  readonly kind = 'local';
  private listeners = new Set<(lib: Library) => void>();

  constructor() {
    // Other tabs on the same device.
    window.addEventListener('storage', (e) => e.key === KEY && this.emit());
  }

  subscribe(cb: (lib: Library) => void): () => void {
    this.listeners.add(cb);
    cb(readLocalLibrary());
    return () => this.listeners.delete(cb);
  }

  async saveSong(song: Song): Promise<void> {
    const lib = readLocalLibrary();
    const i = lib.songs.findIndex((s) => s.id === song.id);
    if (i >= 0) lib.songs[i] = song;
    else lib.songs.push(song);
    this.write(lib);
  }

  async deleteSong(id: string): Promise<void> {
    const lib = readLocalLibrary();
    this.write({ songs: lib.songs.filter((s) => s.id !== id), setlist: lib.setlist.filter((x) => x !== id) });
  }

  async saveSetlist(ids: string[]): Promise<void> {
    this.write({ ...readLocalLibrary(), setlist: ids });
  }

  private write(lib: Library): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(lib));
    } catch {
      // Storage full or disabled: changes live until the page closes.
    }
    this.emit(lib);
  }

  private emit(lib = readLocalLibrary()): void {
    for (const cb of this.listeners) cb(lib);
  }
}

/** Case- and diacritic-insensitive search on title and artist. */
export function searchSongs(songs: Song[], query: string): Song[] {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const q = fold(query.trim());
  const sorted = [...songs].sort((a, b) => a.title.localeCompare(b.title, 'ro'));
  return q ? sorted.filter((s) => fold(`${s.title} ${s.artist}`).includes(q)) : sorted;
}
