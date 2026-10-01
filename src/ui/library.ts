import type { Song } from '../song';
import { searchSongs, type Library } from '../store';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface LibraryHandlers {
  select(song: Song): void;
  edit(song: Song): void;
  addToSetlist(id: string): void;
  removeFromSetlist(index: number): void;
  move(index: number, delta: number): void;
}

const BTN = 'h-10 min-w-10 rounded-lg bg-neutral-900 px-2 font-bold';

/** Renders the setlist and the searchable library. */
export function renderLibrary(lib: Library, query: string, currentId: string | null, h: LibraryHandlers): void {
  const byId = new Map(lib.songs.map((s) => [s.id, s]));

  const setlist = $('setlist');
  setlist.innerHTML = '';
  lib.setlist.forEach((id, i) => {
    const song = byId.get(id);
    if (!song) return;
    const li = document.createElement('li');
    li.className = `flex items-center gap-2 rounded-xl p-2 ${id === currentId ? 'bg-amber-500/20 ring-1 ring-amber-500' : 'bg-neutral-900/60'}`;
    li.append(
      songButton(song, `${i + 1}.`, () => h.select(song)),
      button('▲', () => h.move(i, -1)),
      button('▼', () => h.move(i, 1)),
      button('✕', () => h.removeFromSetlist(i)),
    );
    setlist.append(li);
  });
  $('setlistEmpty').classList.toggle('hidden', lib.setlist.length > 0);

  const list = $('songList');
  list.innerHTML = '';
  for (const song of searchSongs(lib.songs, query)) {
    const li = document.createElement('li');
    li.className = `flex items-center gap-2 rounded-xl p-2 ${song.id === currentId ? 'bg-amber-500/20 ring-1 ring-amber-500' : 'bg-neutral-900/60'}`;
    li.append(
      songButton(song, '', () => h.select(song)),
      button('✎', () => h.edit(song)),
      button('+ Setlist', () => h.addToSetlist(song.id)),
    );
    list.append(li);
  }
  if (lib.songs.length === 0) {
    const li = document.createElement('li');
    li.className = 'text-sm text-neutral-500';
    li.textContent = 'Nicio piesă încă. Apasă „+ Nouă”.';
    list.append(li);
  }
}

function songButton(song: Song, prefix: string, onClick: () => void): HTMLElement {
  const b = document.createElement('button');
  b.className = 'min-w-0 flex-1 text-left';
  const first = song.markers[0];
  const meta = `${first?.bpm ?? '–'} BPM · ${first?.beatsPerBar ?? 4}/${first?.beatUnit ?? 4} · ${song.bars} măs.`;
  b.innerHTML = `<div class="truncate font-bold"></div><div class="truncate text-xs text-neutral-500"></div>`;
  (b.children[0] as HTMLElement).textContent = `${prefix} ${song.title}`.trim();
  (b.children[1] as HTMLElement).textContent = [song.artist, meta].filter(Boolean).join(' · ');
  b.addEventListener('click', onClick);
  return b;
}

function button(label: string, onClick: () => void): HTMLElement {
  const b = document.createElement('button');
  b.className = BTN;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
