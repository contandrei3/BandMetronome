import type { Song } from './song';

/** The master's song library and the running order for tonight. */
export interface Library {
  songs: Song[];
  /** Song ids in playing order. */
  setlist: string[];
}

/**
 * Where the library lives. The local store keeps everything on the master's
 * phone, so the setlist works without internet; a cloud store (Firebase) can
 * implement the same interface and sync it across devices.
 */
export interface LibraryStore {
  load(): Promise<Library>;
  saveSong(song: Song): Promise<void>;
  deleteSong(id: string): Promise<void>;
  saveSetlist(ids: string[]): Promise<void>;
}

const KEY = 'bandmetro.library.v1';

export class LocalLibraryStore implements LibraryStore {
  async load(): Promise<Library> {
    return this.read();
  }

  async saveSong(song: Song): Promise<void> {
    const lib = this.read();
    const i = lib.songs.findIndex((s) => s.id === song.id);
    if (i >= 0) lib.songs[i] = song;
    else lib.songs.push(song);
    this.write(lib);
  }

  async deleteSong(id: string): Promise<void> {
    const lib = this.read();
    this.write({ songs: lib.songs.filter((s) => s.id !== id), setlist: lib.setlist.filter((x) => x !== id) });
  }

  async saveSetlist(ids: string[]): Promise<void> {
    this.write({ ...this.read(), setlist: ids });
  }

  private read(): Library {
    try {
      const lib = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Library | null;
      if (lib && Array.isArray(lib.songs)) return { songs: lib.songs, setlist: lib.setlist ?? [] };
    } catch {
      // Corrupt or unavailable storage: start empty.
    }
    return { songs: [], setlist: [] };
  }

  private write(lib: Library): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(lib));
    } catch {
      // Storage full or disabled: changes live until the page closes.
    }
  }
}

/** Case- and diacritic-insensitive search on title and artist. */
export function searchSongs(songs: Song[], query: string): Song[] {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const q = fold(query.trim());
  const sorted = [...songs].sort((a, b) => a.title.localeCompare(b.title, 'ro'));
  return q ? sorted.filter((s) => fold(`${s.title} ${s.artist}`).includes(q)) : sorted;
}
