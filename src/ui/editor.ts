import { ROLES, type Role } from '../roles';
import { newSong, normalizeSong, type Marker, type Song } from '../song';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface EditorHandlers {
  onSave(song: Song): void;
  onDelete(id: string): void;
}

const INPUT = 'rounded-lg bg-neutral-900 px-2 py-2 text-center';

/** Opens the full-screen song editor; `song` is null for a new one. */
export function openEditor(song: Song | null, h: EditorHandlers): void {
  const draft: Song = structuredClone(song ?? newSong());
  const isNew = !song;
  $<HTMLInputElement>('edTitle').value = draft.title;
  $<HTMLInputElement>('edArtist').value = draft.artist;
  $<HTMLInputElement>('edBars').value = String(draft.bars);
  $<HTMLInputElement>('edCountIn').value = String(draft.countInBars);
  $('edDelete').classList.toggle('invisible', isNew);

  const list = $('edMarkers');
  list.innerHTML = '';
  for (const m of draft.markers) list.append(markerRow(m));

  const editor = $('editor');
  editor.classList.remove('hidden');
  editor.scrollTop = 0;
  const close = () => editor.classList.add('hidden');

  $('edAddMarker').onclick = () => {
    const last = [...list.querySelectorAll<HTMLInputElement>('[data-f="bar"]')].map((i) => Number(i.value) || 0);
    const row = markerRow({ bar: Math.max(1, ...last) + 8 });
    list.append(row);
    row.querySelector<HTMLInputElement>('[data-f="text"]')?.focus();
  };
  $('edCancel').onclick = close;
  $('edDelete').onclick = () => {
    if (confirm(`Ștergi „${draft.title || 'piesa'}”?`)) {
      h.onDelete(draft.id);
      close();
    }
  };
  $('edSave').onclick = () => {
    const title = $<HTMLInputElement>('edTitle').value.trim();
    if (!title) return alert('Piesa are nevoie de un titlu.');
    const saved = normalizeSong({
      ...draft,
      title,
      artist: $<HTMLInputElement>('edArtist').value.trim(),
      bars: Number($<HTMLInputElement>('edBars').value) || 1,
      countInBars: Number($<HTMLInputElement>('edCountIn').value) || 0,
      markers: [...list.children].map((row) => readRow(row as HTMLElement)).filter((m): m is Marker => m !== null),
      updatedAt: Date.now(),
    });
    h.onSave(saved);
    close();
  };
}

function markerRow(m: Marker): HTMLElement {
  const row = document.createElement('div');
  row.className = 'flex flex-col gap-2 rounded-xl bg-neutral-950 p-3 ring-1 ring-neutral-800';
  const meter = m.beatsPerBar ? `${m.beatsPerBar}/${m.beatUnit ?? 4}` : '';
  row.innerHTML = `
    <div class="flex items-end gap-2 text-xs text-neutral-500">
      <label class="flex w-16 flex-col">Măsura<input data-f="bar" type="number" inputmode="numeric" min="1" class="${INPUT} text-lg text-neutral-100"></label>
      <label class="flex w-20 flex-col">BPM<input data-f="bpm" type="number" inputmode="numeric" min="20" max="400" class="${INPUT} text-lg text-neutral-100"></label>
      <label class="flex w-16 flex-col">Ritm<input data-f="meter" placeholder="4/4" class="${INPUT} text-lg text-neutral-100"></label>
      <label class="flex flex-col items-center">Treptat<input data-f="ramp" type="checkbox" class="mt-2 h-6 w-6 accent-amber-500"></label>
      <button data-f="remove" class="ml-auto h-10 w-10 rounded-lg bg-neutral-900 text-lg" aria-label="Șterge rândul">✕</button>
    </div>
    <input data-f="text" placeholder="Instrucțiune (ex: REFREN – Explozie)" class="rounded-lg bg-neutral-900 px-3 py-2">
    <div class="flex flex-wrap items-center gap-1 text-xs text-neutral-500">
      <span class="mr-1">Pentru:</span>
      ${ROLES.map((r) => `<button type="button" data-role="${r.id}" class="chip">${r.icon} ${r.short}</button>`).join('')}
      <span data-f="everyone" class="ml-1">toți</span>
    </div>`;
  const f = (name: string) => row.querySelector<HTMLInputElement>(`[data-f="${name}"]`)!;
  f('bar').value = String(m.bar);
  f('bpm').value = m.bpm !== undefined ? String(m.bpm) : '';
  f('meter').value = meter;
  f('ramp').checked = !!m.ramp;
  f('text').value = m.text ?? '';
  f('remove').addEventListener('click', () => row.remove());
  const chips = [...row.querySelectorAll<HTMLButtonElement>('[data-role]')];
  const paint = () => f('everyone').classList.toggle('hidden', chips.some((c) => c.classList.contains('on')));
  for (const c of chips) {
    c.classList.toggle('on', !!m.roles?.includes(c.dataset.role as Role));
    c.addEventListener('click', () => {
      c.classList.toggle('on');
      paint();
    });
  }
  paint();
  return row;
}

function readRow(row: HTMLElement): Marker | null {
  const f = (name: string) => row.querySelector<HTMLInputElement>(`[data-f="${name}"]`)!;
  const bar = Math.round(Number(f('bar').value));
  if (!(bar >= 1)) return null;
  const bpm = Number(f('bpm').value);
  const meter = parseMeter(f('meter').value);
  return {
    bar,
    bpm: bpm >= 20 && bpm <= 400 ? bpm : undefined,
    ...meter,
    ramp: f('ramp').checked && bpm > 0 ? true : undefined,
    text: f('text').value.trim() || undefined,
    roles: [...row.querySelectorAll<HTMLButtonElement>('[data-role].on')].map((c) => c.dataset.role as Role),
  };
}

/** "7/8" -> 7 clicks of an eighth; "5" -> 5/4; anything else -> unchanged. */
export function parseMeter(text: string): { beatsPerBar?: number; beatUnit?: number } {
  const m = /^\s*(\d{1,2})\s*(?:\/\s*(4|8|16|2))?\s*$/.exec(text);
  if (!m) return {};
  const beats = Number(m[1]);
  if (beats < 1 || beats > 32) return {};
  return { beatsPerBar: beats, beatUnit: m[2] ? Number(m[2]) : 4 };
}
