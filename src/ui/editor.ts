import { ROLES, type Role } from '../roles';
import { analyzeBeats, decodeForAnalysis, fitGrid, tempoRange, type BeatAnalysis } from '../analysis/beats';
import { MetronomeEngine } from '../audio/engine';
import { newSong, normalizeSong, normalizeTrack, songPosition, songTransport, type Marker, type Song } from '../song';
import { beatAt } from '../timeline';
import { audioDurationMs, getTrack, putTrack, trackId } from '../tracks';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface EditorHandlers {
  onSave(song: Song): void;
  onDelete(id: string): void;
}

const INPUT = 'rounded-lg bg-neutral-900 px-2 py-2 text-center';

/** Opens the full-screen song editor; `song` is null for a new one. */
export function openEditor(song: Song | null, h: EditorHandlers, canPreview: () => boolean = () => true): void {
  const draft: Song = structuredClone(song ?? newSong());
  draft.track = normalizeTrack(draft.track);
  const isNew = !song;
  $<HTMLInputElement>('edTitle').value = draft.title;
  $<HTMLInputElement>('edArtist').value = draft.artist;
  $<HTMLInputElement>('edBars').value = String(draft.bars);
  $<HTMLInputElement>('edCountIn').value = String(draft.countInBars);
  $('edDelete').classList.toggle('invisible', isNew);

  const list = $('edMarkers');
  list.innerHTML = '';
  for (const m of draft.markers) list.append(markerRow(m));

  const offsetInput = $<HTMLInputElement>('edTrackOffset');
  offsetInput.value = draft.track ? String(draft.track.offsetMs / 1000) : '0';

  /** The song as currently typed in the form. */
  const readDraft = (): Song =>
    normalizeSong({
      ...draft,
      title: $<HTMLInputElement>('edTitle').value.trim(),
      artist: $<HTMLInputElement>('edArtist').value.trim(),
      bars: Number($<HTMLInputElement>('edBars').value) || 1,
      countInBars: Number($<HTMLInputElement>('edCountIn').value) || 0,
      markers: [...list.children].map((row) => readRow(row as HTMLElement)).filter((m): m is Marker => m !== null),
      track: draft.track && { ...draft.track, offsetMs: Math.round((Number(offsetInput.value) || 0) * 1000) },
      updatedAt: Date.now(),
    });

  const tools = setupTrackTools(draft, readDraft, list, canPreview);

  const editor = $('editor');
  editor.classList.remove('hidden');
  editor.scrollTop = 0;
  const close = () => {
    void tools.stopPreview();
    editor.classList.add('hidden');
  };

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
    const saved = readDraft();
    if (!saved.title) return alert('Piesa are nevoie de un titlu.');
    h.onSave(saved);
    close();
  };
}

/**
 * Backing-track controls: pick the file, detect its beats, choose fixed or
 * followed tempo, move bar 1 and listen to track + click right in the editor.
 */
function setupTrackTools(draft: Song, readDraft: () => Song, list: HTMLElement, canPreview: () => boolean) {
  const trackName = $('edTrackName');
  const fileInput = $<HTMLInputElement>('edTrackFile');
  const offsetInput = $<HTMLInputElement>('edTrackOffset');
  const follow = $<HTMLInputElement>('edFollow');
  const analysisText = $('edAnalysis');
  const applyBpm = $('edApplyBpm');
  let found: BeatAnalysis | null = null;

  const paint = (status?: string) => {
    trackName.textContent = status ?? '';
    renderFiles();
    show($('edTrackTools'), !!draft.track);
    follow.disabled = !draft.track?.beats?.length;
    follow.checked = !!draft.track?.follow && !follow.disabled;
    // A fixed BPM is only offered when it can actually hold for the whole song.
    applyBpm.classList.toggle('hidden', !found || !isSteady(found.maxDeviationMs));
  };

  /** One row per file: label, default volume, "used for tempo", remove. */
  const renderFiles = () => {
    const box = $('edFiles');
    box.innerHTML = '';
    const files = draft.track?.files ?? [];
    for (const f of files) {
      const row = document.createElement('div');
      row.className = 'flex flex-col gap-2 rounded-lg bg-neutral-900/60 p-2';
      row.innerHTML = `
        <div class="flex items-center gap-2">
          <input data-f="label" class="w-32 rounded-lg bg-neutral-900 px-2 py-2 font-bold" placeholder="Nume (ex: Voce)">
          <span data-f="name" class="min-w-0 flex-1 truncate text-xs text-neutral-500"></span>
          <button data-f="remove" class="h-9 w-9 shrink-0 rounded-lg bg-neutral-900" aria-label="Scoate fișierul">✕</button>
        </div>
        <div class="flex flex-wrap items-center gap-3 text-sm text-neutral-400">
          <label class="flex min-w-0 flex-1 items-center gap-2">Volum<input data-f="volume" type="range" min="0" max="1" step="0.05" class="w-full accent-amber-500"><span data-f="pct" class="w-10 font-mono text-xs"></span></label>
          <label class="flex items-center gap-1"><input data-f="tempo" type="radio" name="edTempoFile" class="h-4 w-4 accent-amber-500"> pentru tempo</label>
        </div>`;
      const q = <T extends HTMLElement>(n: string) => row.querySelector<T>(`[data-f="${n}"]`)!;
      q<HTMLInputElement>('label').value = f.label;
      q('name').textContent = `${f.name} · ${formatDuration(f.durationMs)}`;
      q<HTMLInputElement>('volume').value = String(f.volume);
      q('pct').textContent = f.volume === 0 ? 'mut' : `${Math.round(f.volume * 100)}%`;
      q<HTMLInputElement>('tempo').checked = draft.track!.tempoFile === f.id;
      q<HTMLInputElement>('label').oninput = (e) => (f.label = (e.target as HTMLInputElement).value.trim() || 'Pistă');
      q<HTMLInputElement>('volume').oninput = (e) => {
        f.volume = Number((e.target as HTMLInputElement).value);
        q('pct').textContent = f.volume === 0 ? 'mut' : `${Math.round(f.volume * 100)}%`;
      };
      q<HTMLInputElement>('tempo').onchange = () => {
        draft.track!.tempoFile = f.id;
        // Beats came from another file: detect again from this one.
        draft.track!.beats = undefined;
        draft.track!.follow = false;
        found = null;
        analysisText.textContent = 'Fișierul pentru tempo s-a schimbat: apasă din nou „Detectează tempo-ul”.';
        paint();
      };
      q('remove').onclick = () => {
        draft.track!.files = draft.track!.files.filter((x) => x !== f);
        if (draft.track!.files.length === 0) {
          draft.track = undefined;
          found = null;
          analysisText.textContent = '';
        } else if (draft.track!.tempoFile === f.id) {
          draft.track!.tempoFile = draft.track!.files[0].id;
          draft.track!.beats = undefined;
          draft.track!.follow = false;
        }
        paint();
      };
      box.append(row);
    }
  };

  const describe = () => {
    const beats = draft.track?.beats;
    if (!beats?.length) return '';
    const a = found ?? { bpm: 60000 / fitGrid(beats).period, maxDeviationMs: fitGrid(beats).maxDeviation };
    const r = tempoRange(beats);
    return isSteady(a.maxDeviationMs)
      ? `Tempo constant: ${a.bpm.toFixed(2)} BPM (${beats.length} bătăi). Apasă „Folosește BPM-ul găsit”.`
      : `Tempo-ul variază între ${r.min.toFixed(1)} și ${r.max.toFixed(1)} BPM (înregistrare fără click), deci un BPM fix ` +
          `s-ar decala după câteva măsuri. Lasă bifat „Click-ul urmărește tempo-ul negativului”.`;
  };
  analysisText.textContent = describe();
  paint();

  fileInput.value = '';
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    paint('Se încarcă…');
    try {
      const data = await file.arrayBuffer();
      const [id, durationMs] = await Promise.all([trackId(data), audioDurationMs(data)]);
      await putTrack(id, data);
      const first = !draft.track;
      draft.track ??= { files: [], offsetMs: 0 };
      if (!draft.track.files.some((f) => f.id === id)) {
        draft.track.files.push({ id, name: file.name, label: guessLabel(file.name, first), durationMs, volume: 1 });
      }
      draft.track.tempoFile ??= id;
      if (first) {
        offsetInput.value = '0';
        found = null;
        analysisText.textContent = '';
      }
      paint();
    } catch {
      paint('Fișierul nu a putut fi citit ca audio');
    }
    fileInput.value = '';
  };

  $('edAnalyze').onclick = async () => {
    if (!draft.track) return;
    const btn = $<HTMLButtonElement>('edAnalyze');
    btn.disabled = true;
    analysisText.textContent = 'Analizez negativul… (câteva secunde)';
    await new Promise((r) => setTimeout(r, 30)); // let the message show before the heavy work
    try {
      const data = await getTrack(draft.track.tempoFile ?? draft.track.files[0].id);
      if (!data) throw new Error('fișierul nu e pe acest dispozitiv');
      const first = readDraft().markers[0];
      found = analyzeBeats(await decodeForAnalysis(data), first?.bpm, first?.beatsPerBar ?? 4);
      if (!found) throw new Error('nu am găsit un ritm clar');
      draft.track.beats = found.beats.map((b) => Math.round(b * 10) / 10);
      // Bar 1 on the first detected beat 1 (where chords change / the kick lands).
      const bar1 = draft.track.beats[found.downbeat];
      offsetInput.value = String(bar1 / 1000);
      const repaired = found.extrapolated
        ? ` ${found.extrapolated} bătăi fără un ritm clar (ex. intro fără tobe) au primit tempo-ul părții cu tobe de lângă ele.`
        : '';
      analysisText.textContent =
        describe() +
        repaired +
        ` Măsura 1 pusă pe primul timp 1 găsit (${(bar1 / 1000).toFixed(2)} s). Ascultă cu click; dacă nu cade pe 1, mută cu „o bătaie”.`;
      draft.track.follow = !isSteady(found.maxDeviationMs);
    } catch (e) {
      analysisText.textContent = `Nu a mers: ${(e as Error).message}. Poți seta BPM-ul și măsura 1 manual.`;
    }
    btn.disabled = false;
    paint();
  };

  applyBpm.onclick = () => {
    if (!found || !draft.track?.beats) return;
    const bpm = Math.round(found.bpm * 100) / 100;
    const first = list.querySelector<HTMLInputElement>('[data-f="bpm"]');
    if (first) first.value = String(bpm);
    // Bar 1 on the fitted grid nearest the current choice (less jitter than a single detected beat).
    const fit = fitGrid(draft.track.beats);
    const cur = Number(offsetInput.value) * 1000;
    offsetInput.value = String(Math.round(fit.offset + Math.round((cur - fit.offset) / fit.period) * fit.period) / 1000);
    draft.track.follow = false;
    paint();
    void restartPreview();
  };

  const steady = $<HTMLInputElement>('edSteadyBar');
  steady.value = draft.track?.steadyFromBar ? String(draft.track.steadyFromBar) : '';
  steady.onchange = () => {
    if (!draft.track) return;
    const bar = Math.round(Number(steady.value));
    draft.track.steadyFromBar = bar > 1 ? bar : undefined;
    void restartPreview();
  };

  follow.onchange = () => {
    if (draft.track) draft.track.follow = follow.checked;
    void restartPreview();
  };

  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-nudge]')) {
    b.onclick = () => {
      if (!draft.track) return;
      const cur = Number(offsetInput.value) * 1000;
      const step = b.dataset.nudge!;
      let next: number;
      if (step === 'beat' || step === '-beat' || step === 'bar' || step === '-bar') {
        const dir = (step.startsWith('-') ? -1 : 1) * (step.endsWith('bar') ? (readDraft().markers[0]?.beatsPerBar ?? 4) : 1);
        const beats = draft.track.beats;
        if (draft.track.follow && beats?.length) {
          const i = beats.indexOf(nearest(beats, cur));
          next = beats[Math.min(beats.length - 1, Math.max(0, i + dir))];
        } else {
          next = cur + (dir * 60000) / (readDraft().markers[0]?.bpm ?? 120);
        }
      } else {
        next = cur + Number(step);
      }
      offsetInput.value = String(Math.round(next) / 1000);
      void restartPreview();
    };
  }

  // ---- Preview: track + click on this device, no session needed ----
  let preview: { engine: MetronomeEngine; raf: number } | null = null;
  const previewBtn = $('edPreview');
  const posText = $('edPreviewPos');

  async function startPreview(fromBar: number) {
    if (!draft.track) return;
    if (!canPreview()) {
      posText.textContent = 'Oprește întâi metronomul din sesiune.';
      return;
    }
    const engine = new MetronomeEngine();
    preview = { engine, raf: 0 };
    await engine.start();
    engine.latencyMs = 0; // click and track go through the same output: no compensation needed
    const t = songTransport(readDraft(), performance.now() + 400, 1, fromBar);
    engine.setTransport(t);
    for (const f of draft.track.files) {
      engine.setFileVolume(f.id, f.volume);
      const data = f.volume > 0 ? await getTrack(f.id) : undefined;
      if (data) await engine.addTrack(f.id, data);
    }
    previewBtn.textContent = '■ Oprește';
    const tick = () => {
      if (!preview) return;
      const b = beatAt(t, performance.now());
      const pos = b && t.song ? songPosition(t.song, b.bar) : null;
      posText.textContent = pos
        ? pos.countIn
          ? `count-in · ${b!.beatInBar + 1}`
          : `măsura ${pos.songBar} · bătaia ${b!.beatInBar + 1}${pos.section ? ' · ' + pos.section : ''}`
        : '';
      preview.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  async function stopPreview() {
    if (!preview) return;
    cancelAnimationFrame(preview.raf);
    const e = preview.engine;
    preview = null;
    previewBtn.textContent = '▶ Ascultă cu click';
    posText.textContent = '';
    await e.dispose();
  }

  /** After a change while listening: start again from the bar being played. */
  async function restartPreview() {
    if (!preview) return;
    const bar = Number(posText.textContent?.match(/măsura (\d+)/)?.[1] ?? $<HTMLInputElement>('edPreviewBar').value);
    await stopPreview();
    await startPreview(bar || 1);
  }

  previewBtn.onclick = () => (preview ? stopPreview() : startPreview(Number($<HTMLInputElement>('edPreviewBar').value) || 1));
  return { stopPreview };
}

/** Under this, one BPM keeps every beat within ~25 ms of the recording for the whole song. */
function isSteady(maxDeviationMs: number): boolean {
  return maxDeviationMs < 25;
}

/** "vocals.wav" -> "Voce", "...instrumental..." -> "Negativ"; the first file of a song defaults to "Original". */
function guessLabel(name: string, first: boolean): string {
  const n = name.toLowerCase();
  if (/vocal|voce|voice/.test(n)) return 'Voce';
  if (/instrumental|negativ|karaoke|backing|minus/.test(n)) return 'Negativ';
  if (/drum|tobe/.test(n)) return 'Tobe';
  if (/bass|bas/.test(n)) return 'Bas';
  return first ? 'Original' : 'Pistă';
}

function nearest(xs: number[], x: number): number {
  return xs.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));
}

function show(el: HTMLElement, on: boolean) {
  el.classList.toggle('hidden', !on);
  el.classList.toggle('flex', on);
}

function markerRow(m: Marker): HTMLElement {
  const row = document.createElement('div');
  row.className = 'flex flex-col gap-2 rounded-xl bg-neutral-950 p-3 ring-1 ring-neutral-800';
  const meter = m.beatsPerBar ? `${m.beatsPerBar}/${m.beatUnit ?? 4}` : '';
  row.innerHTML = `
    <div class="flex items-end gap-2 text-xs text-neutral-500">
      <label class="flex w-16 flex-col">Măsura<input data-f="bar" type="number" inputmode="numeric" min="1" class="${INPUT} text-lg text-neutral-100"></label>
      <label class="flex w-20 flex-col">BPM<input data-f="bpm" type="number" inputmode="decimal" step="0.01" min="20" max="400" class="${INPUT} text-lg text-neutral-100"></label>
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

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
