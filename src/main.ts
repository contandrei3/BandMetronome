import './style.css';
import QRCode from 'qrcode';
import { IDENTITY_TIME, MetronomeEngine } from './audio/engine';
import { SOUND_LABELS, type SoundKind } from './audio/sounds';
import { analyzeTaps, CALIBRATION_PERIOD_MS, CALIBRATION_TAPS } from './calibration';
import { ClientSession, MasterSession, type ConnState } from './net/session';
import { loadSettings, saveSettings } from './settings';
import {
  beatAt,
  changeTransport,
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

// ---------- Start screen ----------

const nameInput = $<HTMLInputElement>('name');
const codeInput = $<HTMLInputElement>('code');
nameInput.value = settings.name;
codeInput.value = new URLSearchParams(location.search).get('join') ?? '';

$('version').textContent = `versiune ${__BUILD__}`;

function startError(msg: string) {
  const el = $('startError');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

/** Shows progress on the start screen and blocks double taps while connecting. */
function setBusy(label: string | null) {
  for (const id of ['create', 'join']) $<HTMLButtonElement>(id).disabled = label !== null;
  $('startStatus').textContent = label ?? '';
  if (label) startError('');
}

// Any unexpected error is shown on screen: there is no console on a phone at rehearsal.
const reportError = (msg: string) => {
  const box = $('errors');
  box.classList.remove('hidden');
  box.textContent = `${box.textContent}\n${new Date().toLocaleTimeString()} ${msg}`.trim();
};
window.addEventListener('error', (e) => reportError(e.message));
window.addEventListener('unhandledrejection', (e) => reportError(String(e.reason?.message ?? e.reason)));

let booted = false;
async function boot(): Promise<void> {
  settings.name = nameInput.value.trim();
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

$('create').addEventListener('click', async () => {
  try {
    setBusy('Pornesc sunetul…');
    await boot();
    setBusy('Mă conectez la serverul de sesiuni…');
    master = new MasterSession(transport);
    master.onState = setConnState;
    master.onMembersChange = renderMembers;
    const code = await master.open();
    setBusy(null);
    engine.setTimeSource(IDENTITY_TIME);
    engine.setTransport(transport);
    transportApplied = true;
    enterSession('Master', code);
    show($('masterPanel'));
    renderMasterControls();
    const url = `${location.origin}${location.pathname}?join=${code}`;
    $('joinUrl').textContent = url;
    void QRCode.toCanvas($('qr'), url, { width: 220, margin: 1 });
  } catch (e) {
    setBusy(null);
    master = null;
    startError(`Nu s-a putut crea sesiunea (${(e as { type?: string }).type ?? e}). Verifică internetul și mai încearcă.`);
  }
});

$('join').addEventListener('click', async () => {
  const code = codeInput.value.trim();
  if (!/^\d{4}$/.test(code)) return startError('Introdu codul de 4 cifre al sesiunii.');
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
  engine.setTimeSource({
    masterToLocal: (m) => m - c.sync.offset,
    localToMaster: (l) => l + c.sync.offset,
  });
  c.open();
  enterSession('Membru', code);
});

function enterSession(role: string, code: string) {
  show($('start'), false);
  show($('session'));
  $('role').textContent = role;
  $('sessionCode').textContent = code;
  history.replaceState(null, '', location.pathname);
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
let pendingChange: number | undefined;

function renderMasterControls() {
  const sel = $<HTMLSelectElement>('beatsPerBar');
  for (let n = 1; n <= 12; n++) sel.add(new Option(`${n}/4`, String(n)));
  sel.value = String(lastSegment(transport).beatsPerBar);
  sel.addEventListener('change', () => updateMasterTransport({ beatsPerBar: Number(sel.value) }));

  for (const b of document.querySelectorAll<HTMLButtonElement>('.bpmBtn')) {
    b.addEventListener('click', () => {
      const current = { ...lastSegment(transport), ...pendingPatch }.bpm;
      const bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, current + Number(b.dataset.bpm)));
      updateMasterTransport({ bpm });
    });
  }

  $('startStop').addEventListener('click', () => {
    flushPending();
    publish(transport.running ? stopTransport(transport) : startTransport(transport, performance.now() + START_LEAD_MS));
  });
  renderMasterState();
}

/**
 * Tempo and meter edits while playing take effect on the next downbeat.
 * Rapid button presses are batched so the band does not hear several restarts.
 */
type Patch = Partial<Pick<Segment, 'bpm' | 'beatsPerBar'>>;
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
  master?.setTransport(t);
  renderMasterState();
}

function renderMasterState() {
  $('bpm').textContent = String({ ...lastSegment(transport), ...pendingPatch }.bpm);
  const btn = $('startStop');
  btn.textContent = transport.running ? 'STOP' : 'START';
  const r = transport.running;
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
  const b = calibrating || !transportApplied ? null : beatAt(transport, now);
  const flash = $('flash');

  if (!b) {
    $('beatNum').textContent = transport.running && transportApplied ? '…' : '–';
    $('barNum').textContent = transport.running && !transportApplied ? 'Sincronizare…' : '';
    lastBeat = -1;
  } else if (b.beat !== lastBeat) {
    lastBeat = b.beat;
    $('beatNum').textContent = String(b.beatInBar + 1);
    $('barNum').textContent = `Măsura ${b.bar + 1}`;
    const accent = b.beatInBar === 0;
    flash.style.transition = 'none';
    flash.style.backgroundColor = accent ? '#f59e0b' : '#525252';
    $('beatNum').style.color = accent ? '#000' : '#fff';
    requestAnimationFrame(() => {
      flash.style.transition = 'background-color 180ms ease-out';
      flash.style.backgroundColor = '';
      $('beatNum').style.color = '';
    });
  }
  const seg = segmentAt(transport, now);
  $('tempoInfo').textContent = `${seg.bpm} BPM · ${seg.beatsPerBar}/4`;

  if (client) {
    const s = client.sync.stats();
    $('syncInfo').textContent = client.sync.locked
      ? `sincronizat ±${fmt(s.jitter / 2)} ms · rtt ${fmt(s.minRtt)} ms`
      : `sincronizare ceas… (${s.samples})`;
  }
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : '–';
}
