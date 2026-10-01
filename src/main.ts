import './style.css';
import QRCode from 'qrcode';
import { IDENTITY_TIME, MetronomeEngine } from './audio/engine';
import { SOUND_LABELS, type SoundKind } from './audio/sounds';
import { analyzeTaps, CALIBRATION_PERIOD_MS, CALIBRATION_TAPS } from './calibration';
import { clearMaster, loadMaster, saveMaster } from './masterState';
import { ClientSession, MasterSession, type ConnState } from './net/session';
import { parseRoute, routeHash, type Route } from './route';
import { loadSettings, saveSettings } from './settings';
import { describeChange, songPosition, songTransport, type Song } from './song';
import { LocalLibraryStore, type Library, type LibraryStore } from './store';
import { openEditor, parseMeter } from './ui/editor';
import { renderLibrary } from './ui/library';
import {
  beatAt,
  bpmAt,
  changeTransport,
  isFinished,
  idleTransport,
  lastSegment,
  segmentAt,
  startTransport,
  stopTransport,
  type Segment,
  type Subdivision,
  type Transport,
} from './timeline';
import { keepScreenOn } from './wakeLock';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (el: HTMLElement, on = true) => {
  el.classList.toggle('hidden', !on);
  el.classList.toggle('flex', on);
};

/** Lead time before a start or tempo change, so every member receives it in time. */
const START_LEAD_MS = 1200;
const CHANGE_LEAD_MS = 600;

const settings = loadSettings();
let engine: MetronomeEngine;
let master: MasterSession | null = null;
let client: ClientSession | null = null;
/** Transport as known locally; for a member it is only applied once the clock is locked. */
let transport: Transport = idleTransport();
let transportApplied = false;

// ---------- Start / resume ----------

const nameInput = $<HTMLInputElement>('name');
const codeInput = $<HTMLInputElement>('code');
nameInput.value = settings.name;

$('version').textContent = `versiune ${__BUILD__}`;

// Any unexpected error is shown on screen: there is no console on a phone at rehearsal.
const reportError = (msg: string) => {
  const box = $('errors');
  box.classList.remove('hidden');
  box.textContent = `${box.textContent}\n${new Date().toLocaleTimeString()} ${msg}`.trim();
};
window.addEventListener('error', (e) => reportError(e.message));
window.addEventListener('unhandledrejection', (e) => reportError(String(e.reason?.message ?? e.reason)));

const initialRoute = parseRoute(location.hash, location.search);
if (initialRoute) {
  // A refresh inside a session: same session, one tap to unlock audio.
  show($('start'), false);
  show($('resume'));
  $('resumeRole').textContent = initialRoute.role === 'master' ? 'Sesiunea ta (Master)' : 'Intri în sesiunea';
  $('resumeCode').textContent = initialRoute.code;
  $('resumeGo').addEventListener('click', () => {
    if (initialRoute.role === 'master') void startMaster(initialRoute.code);
    else void startMember(initialRoute.code);
  });
  $('resumeExit').addEventListener('click', exitSession);
}

$('create').addEventListener('click', () => void startMaster());
$('join').addEventListener('click', () => {
  const code = codeInput.value.trim();
  if (!/^\d{4}$/.test(code)) return startError('Introdu codul de 4 cifre al sesiunii.');
  void startMember(code);
});
$('exit').addEventListener('click', exitSession);

function startError(msg: string) {
  for (const id of ['startError', 'resumeError']) {
    $(id).textContent = msg;
    $(id).classList.toggle('hidden', !msg);
  }
}

/** Shows progress and blocks double taps while connecting. */
function setBusy(label: string | null) {
  for (const id of ['create', 'join', 'resumeGo']) $<HTMLButtonElement>(id).disabled = label !== null;
  $('startStatus').textContent = label ?? '';
  $('resumeStatus').textContent = label ?? '';
  if (label) startError('');
}

function exitSession() {
  clearMaster();
  location.hash = '';
  location.reload();
}

let booted = false;
async function boot(): Promise<void> {
  if (nameInput.value.trim()) settings.name = nameInput.value.trim();
  saveSettings(settings);
  if (booted) return;
  booted = true;
  engine = new MetronomeEngine();
  await engine.start();
  engine.sound = settings.sound;
  engine.volume = settings.volume;
  engine.subdivision = settings.subdivision;
  engine.latencyMs = settings.latencyMs;
  keepScreenOn();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void engine.resume();
  });
}

/** `preferred` is the code from the URL after a refresh; the master tries to keep it. */
async function startMaster(preferred?: string) {
  try {
    setBusy('Pornesc sunetul…');
    await boot();
    setBusy(preferred ? `Recuperez sesiunea ${preferred}…` : 'Mă conectez la serverul de sesiuni…');
    master = new MasterSession(transport);
    master.onState = setConnState;
    master.onMembersChange = renderMembers;
    const code = await master.open(preferred);
    setBusy(null);
    // Carry on where the page left off (same tempo, and in time if it was playing).
    const restored = loadMaster(code);
    if (restored) transport = restored;
    master.setTransport(transport);
    saveMaster(code, transport);
    engine.setTimeSource(IDENTITY_TIME);
    engine.setTransport(transport);
    transportApplied = true;
    enterSession({ role: 'master', code });
    show($('masterPanel'));
    renderMasterControls();
    if (preferred && code !== preferred) reportError(`Codul ${preferred} era ocupat; sesiunea nouă are codul ${code}.`);
    const url = `${location.origin}${location.pathname}${routeHash({ role: 'join', code })}`;
    $('joinUrl').textContent = url;
    void QRCode.toCanvas($('qr'), url, { width: 220, margin: 1 });
  } catch (e) {
    setBusy(null);
    master = null;
    startError(`Nu s-a putut crea sesiunea (${(e as { type?: string }).type ?? e}). Verifică internetul și mai încearcă.`);
  }
}

async function startMember(code: string) {
  setBusy('Pornesc sunetul…');
  await boot();
  setBusy(null);
  const c = new ClientSession(code);
  client = c;
  c.onState = setConnState;
  c.getStatus = () => ({ name: settings.name || 'anonim', latencyMs: settings.latencyMs });
  c.onTransport = (t) => {
    transport = t;
    if (transportApplied) engine.setTransport(t);
  };
  // The master's clock restarted: stay silent until it is locked again (see frame()).
  c.onMasterRestart = () => {
    transportApplied = false;
    engine.setTransport(null);
  };
  engine.setTimeSource({
    masterToLocal: (m) => m - c.sync.offset,
    localToMaster: (l) => l + c.sync.offset,
  });
  c.open();
  enterSession({ role: 'join', code });
}

function enterSession(route: Route) {
  show($('start'), false);
  show($('resume'), false);
  show($('session'));
  $('role').textContent = route.role === 'master' ? 'Master' : 'Membru';
  $('sessionCode').textContent = route.code;
  history.replaceState(null, '', location.pathname + routeHash(route));
  renderPersonal();
  requestAnimationFrame(frame);
}

function setConnState(s: ConnState, detail?: string) {
  const labels: Record<ConnState, string> = {
    connecting: '⏳ conectare…',
    connected: '🟢 conectat',
    reconnecting: '🟠 reconectare…',
    error: `🔴 eroare ${detail ?? ''}`,
  };
  $('connState').textContent = labels[s];
}

// ---------- Master controls ----------

const BPM_MIN = 30;
const BPM_MAX = 300;
const METERS = ['1/4', '2/4', '3/4', '4/4', '5/4', '6/4', '7/4', '5/8', '6/8', '7/8', '9/8', '11/8', '12/8', '15/8'];
let pendingChange: number | undefined;

type Mode = 'free' | 'songs';
const store: LibraryStore = new LocalLibraryStore();
let library: Library = { songs: [], setlist: [] };
let currentSong: Song | null = null;
let mode: Mode = 'free';
let songQuery = '';

function renderMasterControls() {
  const sel = $<HTMLSelectElement>('meter');
  for (const m of METERS) sel.add(new Option(m, m));
  sel.addEventListener('change', () => updateMasterTransport(parseMeter(sel.value)));

  for (const b of document.querySelectorAll<HTMLButtonElement>('.bpmBtn')) {
    b.addEventListener('click', () => {
      const current = { ...lastSegment(transport), ...pendingPatch }.bpm;
      const bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, current + Number(b.dataset.bpm)));
      updateMasterTransport({ bpm });
    });
  }

  for (const b of document.querySelectorAll<HTMLButtonElement>('.modeBtn')) {
    b.addEventListener('click', () => setMode(b.dataset.mode as Mode));
  }

  $('startStop').addEventListener('click', () => {
    flushPending();
    if (transport.running) return publish(stopTransport(transport));
    const at = performance.now() + START_LEAD_MS;
    if (mode === 'free') return publish(startTransport(transport, at));
    if (!currentSong) return;
    const from = Number($<HTMLInputElement>('fromBar').value) || 1;
    publish(songTransport(currentSong, at, transport.rev + 1, from));
  });
  $('prevSong').addEventListener('click', () => stepSetlist(-1));
  $('nextSong').addEventListener('click', () => stepSetlist(1));
  $('newSong').addEventListener('click', () => openEditor(null, editorHandlers));
  $<HTMLInputElement>('songSearch').addEventListener('input', (e) => {
    songQuery = (e.target as HTMLInputElement).value;
    renderSongs();
  });

  // A refreshed master comes back in the mode it was in, with the same song loaded.
  void store.load().then((lib) => {
    library = lib;
    const id = transport.song ? settings.lastSongId : null;
    currentSong = library.songs.find((s) => s.id === id) ?? null;
    setMode(transport.song ? 'songs' : settings.masterMode, true);
  });
}

function setMode(m: Mode, restoring = false) {
  mode = m;
  settings.masterMode = m;
  saveSettings(settings);
  for (const b of document.querySelectorAll<HTMLButtonElement>('.modeBtn')) {
    const on = b.dataset.mode === m;
    b.className = `modeBtn rounded-xl py-3 font-bold ${on ? 'bg-amber-500 text-black' : 'bg-neutral-900'}`;
  }
  show($('freePanel'), m === 'free');
  show($('songPanel'), m === 'songs');
  show($('libraryPanel'), m === 'songs');
  if (!restoring) {
    // Switching mode stops the click and shows the band what is loaded now.
    if (m === 'free') publish(changeTransport({ ...transport, running: false }, 0, 0, {}));
    else if (currentSong) selectSong(currentSong);
    else if (transport.running) publish(stopTransport(transport));
  }
  renderSongs();
  renderMasterState();
}

/** Loads a song (stopped) so the band sees what comes next; START plays it. */
function selectSong(song: Song) {
  currentSong = song;
  settings.lastSongId = song.id;
  saveSettings(settings);
  $<HTMLInputElement>('fromBar').value = '1';
  publish({ ...songTransport(song, 0, transport.rev + 1), running: false });
  renderSongs();
}

function stepSetlist(delta: number) {
  const ids = library.setlist.filter((id) => library.songs.some((s) => s.id === id));
  if (ids.length === 0) return;
  const i = currentSong ? ids.indexOf(currentSong.id) : -1;
  const next = i < 0 ? (delta > 0 ? 0 : ids.length - 1) : i + delta;
  if (next < 0 || next >= ids.length) return;
  selectSong(library.songs.find((s) => s.id === ids[next])!);
}

const editorHandlers = {
  onSave(song: Song) {
    void store.saveSong(song);
    const i = library.songs.findIndex((s) => s.id === song.id);
    if (i >= 0) library.songs[i] = song;
    else library.songs.push(song);
    if (currentSong?.id === song.id || !currentSong) selectSong(song);
    renderSongs();
  },
  onDelete(id: string) {
    void store.deleteSong(id);
    library = { songs: library.songs.filter((s) => s.id !== id), setlist: library.setlist.filter((x) => x !== id) };
    if (currentSong?.id === id) currentSong = null;
    renderSongs();
  },
};

function updateSetlist(ids: string[]) {
  library.setlist = ids;
  void store.saveSetlist(ids);
  renderSongs();
}

function renderSongs() {
  if (!master) return;
  renderLibrary(library, songQuery, currentSong?.id ?? null, {
    select: selectSong,
    edit: (song) => openEditor(song, editorHandlers),
    addToSetlist: (id) => updateSetlist([...library.setlist, id]),
    removeFromSetlist: (i) => updateSetlist(library.setlist.filter((_, j) => j !== i)),
    move: (i, d) => {
      const ids = [...library.setlist];
      const j = i + d;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      updateSetlist(ids);
    },
  });
  const cs = $('currentSong');
  cs.textContent = currentSong
    ? `${currentSong.title}${currentSong.artist ? ' — ' + currentSong.artist : ''}`
    : 'Alege o piesă din setlist sau bibliotecă';
  cs.classList.toggle('text-neutral-400', !currentSong);
  cs.classList.toggle('font-bold', !!currentSong);
}

/**
 * Tempo and meter edits while playing take effect on the next downbeat.
 * Rapid button presses are batched so the band does not hear several restarts.
 */
type Patch = Partial<Pick<Segment, 'bpm' | 'beatsPerBar' | 'beatUnit'>>;
let pendingPatch: Patch = {};

function updateMasterTransport(patch: Patch) {
  pendingPatch = { ...pendingPatch, ...patch };
  clearTimeout(pendingChange);
  if (!transport.running) return flushPending();
  renderMasterState();
  pendingChange = window.setTimeout(flushPending, 400);
}

function flushPending() {
  clearTimeout(pendingChange);
  if (Object.keys(pendingPatch).length === 0) return;
  const patch = pendingPatch;
  pendingPatch = {};
  publish(changeTransport(transport, performance.now(), CHANGE_LEAD_MS, patch));
}

function publish(t: Transport) {
  transport = t;
  engine.setTransport(t);
  if (master) {
    master.setTransport(t);
    saveMaster(master.code, t);
  }
  renderMasterState();
}

function renderMasterState() {
  const seg = { ...lastSegment(transport), ...pendingPatch };
  $('bpm').textContent = String(seg.bpm);
  $<HTMLSelectElement>('meter').value = `${seg.beatsPerBar}/${seg.beatUnit ?? 4}`;
  const btn = $<HTMLButtonElement>('startStop');
  const r = transport.running;
  btn.textContent = r ? 'STOP' : 'START';
  btn.disabled = !r && mode === 'songs' && !currentSong;
  btn.classList.toggle('opacity-40', btn.disabled);
  btn.classList.toggle('bg-red-600', r);
  btn.classList.toggle('active:bg-red-500', r);
  btn.classList.toggle('bg-green-600', !r);
  btn.classList.toggle('active:bg-green-500', !r);
}

function renderMembers() {
  if (!master) return;
  $('memberCount').textContent = String(master.members.size);
  $('members').innerHTML = '';
  for (const m of master.members.values()) {
    const li = document.createElement('li');
    li.textContent = `${m.name.padEnd(12)} rtt ${fmt(m.minRtt)} ms · ±${fmt(m.jitter / 2)} ms · lat ${m.latencyMs} ms`;
    $('members').append(li);
  }
}

// ---------- Personal mix ----------

function renderPersonal() {
  const sound = $<HTMLSelectElement>('sound');
  for (const [k, label] of Object.entries(SOUND_LABELS)) sound.add(new Option(label, k));
  sound.value = settings.sound;
  sound.addEventListener('change', () => {
    settings.sound = sound.value as SoundKind;
    engine.sound = settings.sound;
    saveSettings(settings);
  });

  const vol = $<HTMLInputElement>('volume');
  vol.value = String(settings.volume);
  vol.addEventListener('input', () => {
    settings.volume = Number(vol.value);
    engine.volume = settings.volume;
    saveSettings(settings);
  });

  const subs: [Subdivision, string][] = [[1, '♩'], [2, '♪♪'], [3, '3'], [4, '♬♬']];
  const box = $('subdivisions');
  const paint = () => {
    for (const b of box.querySelectorAll<HTMLButtonElement>('button')) {
      const on = Number(b.dataset.sub) === settings.subdivision;
      b.className = `rounded-xl py-3 text-xl font-bold ${on ? 'bg-amber-500 text-black' : 'bg-neutral-900'}`;
    }
  };
  for (const [n, label] of subs) {
    const b = document.createElement('button');
    b.dataset.sub = String(n);
    b.textContent = label;
    b.addEventListener('click', () => {
      settings.subdivision = n;
      engine.subdivision = n;
      saveSettings(settings);
      paint();
    });
    box.append(b);
  }
  paint();

  for (const b of document.querySelectorAll<HTMLButtonElement>('.latBtn')) {
    b.addEventListener('click', () => setLatency(settings.latencyMs + Number(b.dataset.lat)));
  }
  setLatency(settings.latencyMs);
  $('calibrate').addEventListener('click', startCalibration);
}

function setLatency(ms: number) {
  settings.latencyMs = Math.max(0, Math.min(1000, Math.round(ms)));
  engine.latencyMs = settings.latencyMs;
  $('latency').textContent = String(settings.latencyMs);
  saveSettings(settings);
}

// ---------- Tap calibration ----------

let calResult: number | null = null;

function startCalibration() {
  const overlay = $('calOverlay');
  show(overlay);
  const savedSub = engine.subdivision;
  // Play locally, uncompensated, at a fixed slow tempo.
  const t0 = performance.now() + 1000;
  const taps: number[] = [];
  calResult = null;
  engine.setTimeSource(IDENTITY_TIME);
  engine.latencyMs = 0;
  engine.subdivision = 1;
  engine.setTransport({
    running: true,
    rev: -1,
    segments: [{ t: t0, beat: 0, bar: 0, bpm: 60000 / CALIBRATION_PERIOD_MS, beatsPerBar: 4 }],
  });
  $('calCount').textContent = '0';
  $('calResult').textContent = '';
  $<HTMLButtonElement>('calApply').disabled = true;

  const pad = $('calPad');
  const onTap = (e: PointerEvent) => {
    e.preventDefault();
    taps.push(e.timeStamp);
    $('calCount').textContent = String(taps.length);
    if (taps.length >= CALIBRATION_TAPS) {
      const r = analyzeTaps(taps, t0);
      if (!r) {
        $('calResult').textContent = 'Nu am putut măsura. Mai încearcă.';
      } else {
        calResult = r.latencyMs;
        const shaky = r.spreadMs > 25 ? ' — imprecis, mai încearcă' : '';
        $('calResult').textContent = `≈ ${r.latencyMs} ms (±${r.spreadMs})${shaky}`;
        $<HTMLButtonElement>('calApply').disabled = false;
      }
      taps.length = 0;
      calibrationEnd(false);
    }
  };
  pad.addEventListener('pointerdown', onTap);

  const calibrationEnd = (close: boolean) => {
    pad.removeEventListener('pointerdown', onTap);
    engine.subdivision = savedSub;
    engine.latencyMs = settings.latencyMs;
    if (client) {
      const c = client;
      engine.setTimeSource({ masterToLocal: (m) => m - c.sync.offset, localToMaster: (l) => l + c.sync.offset });
    } else {
      engine.setTimeSource(IDENTITY_TIME);
    }
    engine.setTransport(transportApplied ? transport : null);
    if (close) show(overlay, false);
  };
  $('calCancel').onclick = () => calibrationEnd(true);
  $('calApply').onclick = () => {
    if (calResult !== null) setLatency(calResult);
    calibrationEnd(true);
  };
}

// ---------- Visuals ----------

let lastBeat = -1;

function frame() {
  requestAnimationFrame(frame);

  if (client && !transportApplied && client.sync.locked && client.transport) {
    transportApplied = true;
    engine.setTransport(transport);
  }

  const calibrating = !$('calOverlay').classList.contains('hidden');
  const now = engine.masterNow();

  // The master stops the song after its last bar and loads the next one from the setlist.
  if (master && isFinished(transport, now)) {
    publish(stopTransport(transport));
    if (mode === 'songs' && currentSong && library.setlist.includes(currentSong.id)) stepSetlist(1);
  }

  const b = calibrating || !transportApplied ? null : beatAt(transport, now);
  const song = transport.song;
  const pos = b && song ? songPosition(song, b.bar) : null;
  const preRoll = !!pos && pos.barsToNext === 1;

  show($('songHeader'), !!song);
  if (song) {
    $('songTitle').textContent = song.title;
    $('songArtist').textContent = song.artist;
  }

  if (!b) {
    const syncing = transport.running && !transportApplied;
    const ended = transport.running && transportApplied && song && now > segmentAt(transport, now).t;
    $('beatNum').textContent = transport.running && transportApplied && !ended ? '…' : '–';
    $('sectionLabel').textContent = ended ? 'FINAL' : '';
    $('barNum').textContent = syncing ? 'Sincronizare…' : song && !transport.running ? 'Gata de start' : '';
    $('songBarNum').textContent = '';
    show($('cueBanner'), false);
    lastBeat = -1;
  } else if (b.beat !== lastBeat) {
    lastBeat = b.beat;
    $('beatNum').textContent = String(b.beatInBar + 1);
    if (pos && song) {
      $('sectionLabel').textContent = pos.countIn ? 'COUNT-IN' : (pos.section ?? '');
      $('barNum').textContent = pos.countIn ? '' : `Măsura ${pos.barInSection} din ${pos.sectionBars}`;
      $('songBarNum').textContent = pos.countIn ? `de la măsura ${pos.songBar}` : `${pos.songBar} / ${song.bars}`;
      const next = pos.next;
      $('cueBanner').textContent = next
        ? `URMEAZĂ: ${[next.text, describeChange(next)].filter(Boolean).join(' · ')}`
        : '';
      show($('cueBanner'), preRoll && !!next);
    } else {
      $('sectionLabel').textContent = '';
      $('barNum').textContent = `Măsura ${b.bar + 1}`;
      $('songBarNum').textContent = '';
      show($('cueBanner'), false);
    }
    // Beat 1 amber, others grey; during the bar before a change every beat flashes red.
    const accent = b.beatInBar === 0;
    flash.style.transition = 'none';
    flash.style.backgroundColor = preRoll ? (accent ? '#f59e0b' : '#dc2626') : accent ? '#f59e0b' : '#525252';
    $('beatNum').style.color = accent ? '#000' : '#fff';
    requestAnimationFrame(() => {
      flash.style.transition = 'background-color 180ms ease-out';
      flash.style.backgroundColor = '';
      $('beatNum').style.color = '';
    });
  }
  const seg = segmentAt(transport, now);
  $('tempoInfo').textContent = `${Math.round(bpmAt(transport, now))} BPM · ${seg.beatsPerBar}/${seg.beatUnit ?? 4}`;

  if (client) {
    const s = client.sync.stats();
    $('syncInfo').textContent = client.sync.locked
      ? `sincronizat ±${fmt(s.jitter / 2)} ms · rtt ${fmt(s.minRtt)} ms`
      : `sincronizare ceas… (${s.samples})`;
  }
}

const flash = $('flash');

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : '–';
}
