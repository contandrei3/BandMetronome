import type { Song } from '../song';
import { searchSongs, type Library } from '../store';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface LibraryHandlers {
  /** Present only while this device is Master in a session. */
  load?(song: Song): void;
  edit(song: Song): void;
  addToSetlist(id: string): void;
  removeFromSetlist(index: number): void;
  move(index: number, delta: number): void;
}

const BTN = 'h-10 min-w-10 shrink-0 rounded-lg bg-neutral-800 px-3 font-bold';
const ROW = 'flex items-center gap-2 rounded-2xl p-3 ring-1';
const rowColor = (current: boolean) => (current ? 'bg-amber-500/15 ring-amber-500' : 'bg-neutral-950 ring-neutral-800');

/** "Piese" page: searchable library as cards. */
export function renderSongList(lib: Library, query: string, currentId: string | null, h: LibraryHandlers): void {
  const list = $('songList');
  list.innerHTML = '';
  for (const song of searchSongs(lib.songs, query)) {
    const li = document.createElement('li');
    li.className = `${ROW} ${rowColor(song.id === currentId)}`;
    const inSetlist = lib.setlist.includes(song.id);
    li.append(
      songInfo(song, ''),
      ...(h.load ? [button('▶', () => h.load!(song), 'Încarcă în sesiune')] : []),
      button('✎', () => h.edit(song), 'Editează'),
      button(inSetlist ? '✓' : '+ Setlist', () => !inSetlist && h.addToSetlist(song.id), inSetlist ? 'Deja în setlist' : 'Adaugă în setlist'),
    );
    list.append(li);
  }
  if (lib.songs.length === 0) {
    const li = document.createElement('li');
    li.className = 'text-neutral-500';
    li.textContent = 'Nicio piesă încă. Apasă „+ Piesă nouă”.';
    list.append(li);
  }
}

/** "Setlist" page: running order with reordering. */
export function renderSetlist(lib: Library, currentId: string | null, h: LibraryHandlers): void {
  const list = $('setlist');
  list.innerHTML = '';
  for (const { song, index } of setlistSongs(lib)) {
    const li = document.createElement('li');
    li.className = `${ROW} ${rowColor(song.id === currentId)}`;
    li.append(
      songInfo(song, `${index + 1}.`),
      ...(h.load ? [button('▶', () => h.load!(song), 'Încarcă în sesiune')] : []),
      button('▲', () => h.move(index, -1), 'Mai sus'),
      button('▼', () => h.move(index, 1), 'Mai jos'),
      button('✕', () => h.removeFromSetlist(index), 'Scoate din setlist'),
    );
    list.append(li);
  }
  $('setlistEmpty').classList.toggle('hidden', lib.setlist.length > 0);
}

/** Compact setlist in the Master panel: tap a song to load it. */
export function renderLiveSetlist(lib: Library, currentId: string | null, load: (song: Song) => void): void {
  const list = $('liveSetlist');
  list.innerHTML = '';
  for (const { song, index } of setlistSongs(lib)) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = `w-full truncate rounded-lg px-3 py-2 text-left ${song.id === currentId ? 'bg-amber-500 font-bold text-black' : 'bg-neutral-900'}`;
    b.textContent = `${index + 1}. ${song.title}`;
    b.addEventListener('click', () => load(song));
    li.append(b);
    list.append(li);
  }
}

function setlistSongs(lib: Library): { song: Song; index: number }[] {
  const byId = new Map(lib.songs.map((s) => [s.id, s]));
  return lib.setlist.flatMap((id, index) => {
    const song = byId.get(id);
    return song ? [{ song, index }] : [];
  });
}

function songInfo(song: Song, prefix: string): HTMLElement {
  const d = document.createElement('div');
  d.className = 'min-w-0 flex-1';
  const first = song.markers[0];
  const meta = `${first?.bpm ?? '–'} BPM · ${first?.beatsPerBar ?? 4}/${first?.beatUnit ?? 4} · ${song.bars} măs.`;
  d.innerHTML = `<div class="truncate font-bold"></div><div class="truncate text-xs text-neutral-500"></div>`;
  (d.children[0] as HTMLElement).textContent = `${prefix} ${song.title}${song.track ? ' 🎧' : ''}`.trim();
  (d.children[1] as HTMLElement).textContent = [song.artist, meta].filter(Boolean).join(' · ');
  return d;
}

function button(label: string, onClick: () => void, title: string): HTMLElement {
  const b = document.createElement('button');
  b.className = BTN;
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}
