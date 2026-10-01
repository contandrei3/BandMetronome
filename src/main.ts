import './style.css';
import QRCode from 'qrcode';
import { IDENTITY_TIME, MetronomeEngine, type TimeSource } from './audio/engine';
import { SOUND_LABELS, type SoundKind } from './audio/sounds';
import { analyzeTaps, CALIBRATION_PERIOD_MS, CALIBRATION_TAPS } from './calibration';
import { firebaseConfig } from './firebaseConfig';
import { clearMaster, loadMaster, saveMaster } from './masterState';
import { ClientSession, MasterSession, type ConnState } from './net/session';
import { cueIsFor, roleInfo, ROLES, type Role } from './roles';
import { parseRoute, routeHash, type Route } from './route';
import { loadSettings, saveSettings } from './settings';
import { describeChange, songPosition, songTransport, type Song } from './song';
import { LocalLibraryStore, type Library, type LibraryStore } from './store';
import {
  beatAt,
  bpmAt,
  changeTransport,
  idleTransport,
  isFinished,
  lastSegment,
  segmentAt,
  startTransport,
  stopTransport,
  type Segment,
  type Subdivision,
  type Transport,
} from './timeline';
import { openEditor, parseMeter } from './ui/editor';
import { renderLiveSetlist, renderSetlist, renderSongList, type LibraryHandlers } from './ui/library';
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
let engine: MetronomeEngine | null = null;
let master: MasterSession | null = null;
let client: ClientSession | null = null;
/** Transport as known locally; for a member it is only applied once the clock is locked. */
let transport: Transport = idleTransport();
let transportApplied = false;

$('version').textContent = `versiune ${__BUILD__}`;

// Any unexpected error is shown on screen: there is no console on a phone at rehearsal.
const reportError = (msg: string) => {
  const box = $('errors');
  box.classList.remove('hidden');
  box.textContent = `${box.textContent}\n${new Date().toLocaleTimeString()} ${msg}`.trim();
};
window.addEventListener('error', (e) => reportError(e.message));
window.addEventListener('unhandledrejection', (e) => reportError(String(e.reason?.message ?? e.reason)));

// ---------- Navigation ----------

type View = 'session' | 'songs' | 'setlist' | 'settings';
const VIEW_TITLES: Record<View, string> = { session: 'Sesiune', songs: 'Piese', setlist: 'Setlist', settings: 'Setări' };
const VIEW_KEY = 'bandmetro.view';

function setView(v: View) {
  for (const el of document.querySelectorAll<HTMLElement>('.view')) show(el, el.id === `view-${v}`);
  for (const b of document.querySelectorAll<HTMLElement>('.navBtn')) b.classList.toggle('active', b.dataset.view === v);
  $('topTitle').textContent = VIEW_TITLES[v];
  try {
    sessionStorage.setItem(VIEW_KEY, v);
  } catch {
    // Only a convenience.
  }
  setDrawer(false);
}

function setDrawer(open: boolean) {
  $('sidebar').classList.toggle('-translate-x-full', !open);
  $('sidebar').classList.toggle('translate-x-0', open);
  $('scrim').classList.toggle('hidden', !open);
}

for (const b of document.querySelectorAll<HTMLElement>('.navBtn')) b.addEventListener('click', () => setView(b.dataset.view as View));
$('menuBtn').addEventListener('click', () => setDrawer(true));
$('scrim').addEventListener('click', () => setDrawer(false));

// ---------- Role ----------

function renderRole() {
  const r = roleInfo(settings.role);
  $('roleIcon').textContent = r?.icon ?? '❔';
  $('roleLabel').textContent = r?.label ?? 'Alege rolul';
  for (const b of document.querySelectorAll<HTMLElement>('[data-pick-role]')) {
    const on = b.dataset.pickRole === settings.role;
    b.classList.toggle('bg-amber-500', on);
    b.classList.toggle('text-black', on);
    b.classList.toggle('bg-neutral-900', !on);
  }
}

function setRole(role: Role) {
  settings.role = role;
  saveSettings(settings);
  show($('rolePicker'), false);
  renderRole();
  lastBeat = -1; // redraw role-specific instructions
}

function roleButton(r: (typeof ROLES)[number], big: boolean): HTMLButtonElement {
  const b = document.createElement('button');
  b.dataset.pickRole = r.id;
  b.className = big
    ? 'flex flex-col items-center gap-2 rounded-3xl bg-neutral-900 p-6 text-lg font-bold ring-1 ring-neutral-800 active:bg-amber-500 active:text-black'
    : 'flex items-center justify-center gap-2 rounded-xl bg-neutral-900 px-3 py-3 font-bold';
  b.innerHTML = `<span class="${big ? 'text-5xl' : 'text-xl'}">${r.icon}</span><span>${r.label}</span>`;
  b.addEventListener('click', () => setRole(r.id));
  return b;
}

for (const r of ROLES) {
  $('roleGrid').append(roleButton(r, true));
  $('settingsRoles').append(roleButton(r, false));
}
$('roleCard').addEventListener('click', () => show($('rolePicker')));
if (!settings.role) show($('rolePicker'));
renderRole();

// ---------- Song library (Firebase or this device) ----------

let store: LibraryStore = new LocalLibraryStore();
let library: Library = { songs: [], setlist: [] };
let currentSong: Song | null = null;
let songQuery = '';
let unsubscribe = store.subscribe(onLibrary);

function onLibrary(lib: Library) {
  library = lib;
  // Keep the loaded song in step with edits made on other phones.
  if (currentSong) currentSong = library.songs.find((s) => s.id === currentSong!.id) ?? currentSong;
  renderSongs();
}

function setStoreState(text: string) {
  $('storeState').textContent = text;
}

if (firebaseConfig) {
  setStoreState('☁️ Firebase: conectare…');
  import('./firebaseStore')
    .then(({ createFirebaseStore }) => createFirebaseStore(firebaseConfig!))
    .then((cloud) => {
      unsubscribe();
      store = cloud;
      unsubscribe = store.subscribe(onLibrary);
      setStoreState('☁️ Piese sincronizate (Firebase)');
    })
    .catch((e) => {
      setStoreState('💾 Piese doar pe acest dispozitiv');
      reportError(`Firebase: ${e?.code ?? e?.message ?? e}`);
    });
} else {
  setStoreState('💾 Piese doar pe acest dispozitiv');
}

$('newSong').addEventListener('click', () => openEditor(null, editorHandlers));
$<HTMLInputElement>('songSearch').addEventListener('input', (e) => {
  songQuery = (e.target as HTMLInputElement).value;
  renderSongs();
});

const editorHandlers = {
  onSave(song: Song) {
    store.saveSong(song).catch((e) => reportError(`Salvare: ${e?.message ?? e}`));
    if (master && currentSong?.id === song.id && !transport.running) selectSong(song);
  },
  onDelete(id: string) {
    store.deleteSong(id).catch((e) => reportError(`Ștergere: ${e?.message ?? e}`));
    if (currentSong?.id === id) currentSong = null;
  },
};

function updateSetlist(ids: string[]) {
  store.saveSetlist(ids).catch((e) => reportError(`Setlist: ${e?.message ?? e}`));
}

function renderSongs() {
  const h: LibraryHandlers = {
    load: master
      ? (song) => {
          if (mode !== 'songs') setMode('songs');
          selectSong(song);
          setView('session');
        }
      : undefined,
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
  };
  const id = currentSong?.id ?? null;
  renderSongList(library, songQuery, id, h);
  renderSetlist(library, id, h);
  if (master) {
    renderLiveSetlist(library, id, selectSong);
    const cs = $('currentSong');
    cs.textContent = currentSong
      ? `${currentSong.title}${currentSong.artist ? ' — ' + currentSong.artist : ''}`
      : 'Alege o piesă din setlist (mai jos) sau din pagina „Piese”';
    cs.classList.toggle('text-neutral-400', !currentSong);
    cs.classList.toggle('font-bold', !!currentSong);
    renderMasterState();
  }
}

// ---------- Session start / resume ----------

const codeInput = $<HTMLInputElement>('code');
const initialRoute = parseRoute(location.hash, location.search);

if (initialRoute) {
  // A refresh inside a session: same session, one tap to unlock audio.
  show($('resume'));
  $('resumeRole').textContent = initialRoute.role === 'master' ? 'Sesiunea ta (Master)' : 'Intri în sesiunea';
  $('resumeCode').textContent = initialRoute.code;
  $('resumeGo').addEventListener('click', () => {
    if (initialRoute.role === 'master') void startMaster(initialRoute.code);
    else void startMember(initialRoute.code);
  });
  setView('session');
} else {
  show($('lobby'));
  let saved: string | null = null;
  try {
    saved = sessionStorage.getItem(VIEW_KEY);
  } catch {
    // Default view.
  }
  setView((saved as View | null) ?? 'session');
}
$('resumeExit').addEventListener('click', exitSession);
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
  history.replaceState(null, '', location.pathname);
  location.reload();
}

/** Creates the audio engine; must run inside a tap (browser autoplay rules). */
async function boot(): Promise<MetronomeEngine> {
  if (engine) return engine;
  const e = new MetronomeEngine();
  engine = e;
  await e.start();
  e.sound = settings.sound;
  e.volume = settings.volume;
  e.subdivision = settings.subdivision;
  e.latencyMs = settings.latencyMs;
  keepScreenOn();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void e.resume();
  });
  return e;
}

/** `preferred` is the code from the URL after a refresh; the master tries to keep it. */
async function startMaster(preferred?: string) {
  try {
    setBusy('Pornesc sunetul…');
    const e = await boot();
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
    e.setTimeSource(IDENTITY_TIME);
    e.setTransport(transport);
    transportApplied = true;
    enterSession({ role: 'master', code });
    show($('masterPanel'));
    initMasterControls();
    if (preferred && code !== preferred) reportError(`Codul ${preferred} era ocupat; sesiunea nouă are codul ${code}.`);
    const url = `${location.origin}${location.pathname}${routeHash({ role: 'join', code })}`;
    $('joinUrl').textContent = url;
    void QRCode.toCanvas($('qr'), url, { width: 220, margin: 1 });
  } catch (err) {
    setBusy(null);
    master = null;
    startError(`Nu s-a putut crea sesiunea (${(err as { type?: string }).type ?? err}). Verifică internetul și mai încearcă.`);
  }
}

function memberTime(c: ClientSession): TimeSource {
  return { masterToLocal: (m) => m - c.sync.offset, localToMaster: (l) => l + c.sync.offset };
}

async function startMember(code: string) {
  setBusy('Pornesc sunetul…');
  const e = await boot();
  setBusy(null);
  const c = new ClientSession(code);
  client = c;
  c.onState = setConnState;
  c.getStatus = () => {
    const r = roleInfo(settings.role);
    return { name: r ? `${r.icon} ${r.label}` : 'fără rol', latencyMs: settings.latencyMs };
  };
  c.onTransport = (t) => {
    transport = t;
    if (transportApplied) e.setTransport(t);
  };
  // The master's clock restarted: stay silent until it is locked again (see frame()).
  c.onMasterRestart = () => {
    transportApplied = false;
    e.setTransport(null);
  };
  e.setTimeSource(memberTime(c));
  c.open();
  enterSession({ role: 'join', code });
}

function enterSession(route: Route) {
  show($('lobby'), false);
  show($('resume'), false);
  show($('live'));
  show($('sessionBox'));
  const label = route.role === 'master' ? 'Master' : 'Membru';
  $('sbRole').textContent = label;
  $('sbCode').textContent = route.code;
  $('topSession').textContent = `${label} · ${route.code}`;
  history.replaceState(null, '', location.pathname + routeHash(route));
  renderSongs();
}

function setConnState(s: ConnState, detail?: string) {
  const labels: Record<ConnState, string> = {
    connecting: '⏳ conectare…',
    connected: '🟢 conectat',
    reconnecting: `🟠 reconectare… ${detail ?? ''}`,
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
let mode: Mode = 'free';

function initMasterControls() {
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

  // A refreshed master comes back in the mode it was in, with the same song loaded.
  if (transport.song) currentSong = library.songs.find((s) => s.id === settings.lastSongId) ?? null;
  setMode(transport.song ? 'songs' : settings.masterMode, true);
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
  if (!restoring) {
    // Switching mode stops the click and shows the band what is loaded now.
    if (m === 'free') publish(changeTransport({ ...transport, running: false }, 0, 0, {}));
    else if (currentSong) selectSong(currentSong);
    else if (transport.running) publish(stopTransport(transport));
  }
  renderSongs();
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
  engine?.setTransport(t);
  if (master) {
    master.setTransport(t);
    saveMaster(master.code, t);
  }
  renderMasterState();
}

function renderMasterState() {
  if (!master) return;
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
    li.className = 'flex justify-between gap-2';
    li.innerHTML = '<span class="truncate font-bold text-neutral-300"></span><span class="font-mono"></span>';
    (li.children[0] as HTMLElement).textContent = m.name;
    (li.children[1] as HTMLElement).textContent = `±${fmt(m.jitter / 2)} ms · BT ${m.latencyMs} ms`;
    $('members').append(li);
  }
}

// ---------- Personal mix & latency ----------

function initPersonal() {
  const sound = $<HTMLSelectElement>('sound');
  for (const [k, label] of Object.entries(SOUND_LABELS)) sound.add(new Option(label, k));
  sound.value = settings.sound;
  sound.addEventListener('change', () => {
    settings.sound = sound.value as SoundKind;
    if (engine) engine.sound = settings.sound;
    saveSettings(settings);
  });

  const vol = $<HTMLInputElement>('volume');
  vol.value = String(settings.volume);
  vol.addEventListener('input', () => {
    settings.volume = Number(vol.value);
    if (engine) engine.volume = settings.volume;
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
      if (engine) engine.subdivision = n;
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
  $('calibrate').addEventListener('click', () => void startCalibration());
}
initPersonal();

function setLatency(ms: number) {
  settings.latencyMs = Math.max(0, Math.min(1000, Math.round(ms)));
  if (engine) engine.latencyMs = settings.latencyMs;
  $('latency').textContent = String(settings.latencyMs);
  saveSettings(settings);
}

// ---------- Tap calibration ----------

let calResult: number | null = null;

async function startCalibration() {
  const e = await boot(); // works outside a session too
  const overlay = $('calOverlay');
  show(overlay);
  const savedSub = e.subdivision;
  // Play locally, uncompensated, at a fixed slow tempo.
  const t0 = performance.now() + 1000;
  const taps: number[] = [];
  calResult = null;
  e.setTimeSource(IDENTITY_TIME);
  e.latencyMs = 0;
  e.subdivision = 1;
  e.setTransport({
    running: true,
    rev: -1,
    segments: [{ t: t0, beat: 0, bar: 0, bpm: 60000 / CALIBRATION_PERIOD_MS, beatsPerBar: 4 }],
  });
  $('calCount').textContent = '0';
  $('calResult').textContent = '';
  $<HTMLButtonElement>('calApply').disabled = true;

  const pad = $('calPad');
  const onTap = (ev: PointerEvent) => {
    ev.preventDefault();
    taps.push(ev.timeStamp);
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
    e.subdivision = savedSub;
    e.latencyMs = settings.latencyMs;
    e.setTimeSource(client ? memberTime(client) : IDENTITY_TIME);
    e.setTransport(transportApplied ? transport : null);
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
const flash = $('flash');

function frame() {
  requestAnimationFrame(frame);
  if (!engine || (!master && !client)) return;

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
  const pos = b && song ? songPosition(song, b.bar, settings.role) : null;
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
      const text = next && cueIsFor(next.roles, settings.role) ? next.text : undefined;
      $('cueBanner').textContent = next ? `URMEAZĂ: ${[text, describeChange(next)].filter(Boolean).join(' · ')}` : '';
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
    flash.style.backgroundColor = accent ? '#f59e0b' : preRoll ? '#dc2626' : '#525252';
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
requestAnimationFrame(frame);

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : '–';
}
