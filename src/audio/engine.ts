import { firstTickAtOrAfter, tickAt, type Subdivision, type Transport } from '../timeline';
import { makeNoiseBuffer, scheduleClick, type SoundKind } from './sounds';
import { TrackPlayer } from './trackPlayer';

/** Converts between master time and this device's performance.now() time, in ms. */
export interface TimeSource {
  masterToLocal(masterMs: number): number;
  localToMaster(localMs: number): number;
}

export const IDENTITY_TIME: TimeSource = { masterToLocal: (t) => t, localToMaster: (t) => t };

const TICK_INTERVAL_MS = 25;
/**
 * How far ahead clicks are handed to the audio hardware, in seconds. Long, so
 * a busy or throttled phone (a file arriving, a notification) never runs dry;
 * every change of tempo, mix or clock reschedules what is queued anyway.
 */
const HORIZON_S = 0.8;
/** A scheduler tick this late means the page was stalled. */
const STALL_MS = 250;
/** Clicks closer than this to "now" are dropped rather than played late. */
const MIN_LEAD_S = 0.003;

/**
 * Maps performance.now() milliseconds to AudioContext seconds, using the
 * browser's estimate of when a rendered frame actually leaves the device.
 * The estimate is noisy per call, so it is smoothed; the two clocks drift
 * apart slowly and the smoothing tracks that.
 */
class AudioClock {
  private delta: number | null = null;

  constructor(private readonly ctx: AudioContext) {}

  /** Returns the jump in ms when the audio clock moved abruptly (output glitch, device change). */
  update(): number {
    const d = this.measure();
    if (this.delta === null) this.delta = d;
    else if (Math.abs(d - this.delta) > 0.05) {
      const jump = (d - this.delta) * 1000;
      this.delta = d;
      return jump;
    } else this.delta += (d - this.delta) * 0.1;
    return 0;
  }

  perfToCtx(perfMs: number): number {
    return perfMs / 1000 + (this.delta ?? this.measure());
  }

  ctxToPerf(ctxS: number): number {
    return (ctxS - (this.delta ?? this.measure())) * 1000;
  }

  private measure(): number {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime && ts.contextTime !== undefined) {
      return ts.contextTime - ts.performanceTime / 1000;
    }
    // Fallback: the next rendered frame is heard after the reported latencies.
    const lat = (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
    return this.ctx.currentTime - performance.now() / 1000 - lat;
  }
}

export class MetronomeEngine {
  readonly ctx: AudioContext;
  private readonly out: GainNode;
  private readonly clock: AudioClock;
  private readonly noise: AudioBuffer;
  private timer: number | undefined;
  private nextIndex = 0;
  private scheduled: { nodes: AudioScheduledSourceNode[]; when: number }[] = [];

  private transport: Transport | null = null;
  private timeSource: TimeSource = IDENTITY_TIME;
  private _sound: SoundKind = 'click';
  private _subdivision: Subdivision = 1;
  private _latencyMs = 0;
  private readonly track: TrackPlayer;
  private lastTick = 0;
  /** Something that affects timing happened on this device (see diagnostics). */
  onEvent: (kind: 'stall' | 'late' | 'audio-jump' | 'track-resync', value: number) => void = () => {};

  constructor() {
    // iPhone: play like a music app, so the ring/silent switch does not mute the click (iOS 17+).
    const session = (navigator as { audioSession?: { type: string } }).audioSession;
    if (session) {
      try {
        session.type = 'playback';
      } catch {
        // Older Safari: the switch must be on ring.
      }
    }
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.out = this.ctx.createGain();
    this.out.connect(this.ctx.destination);
    this.clock = new AudioClock(this.ctx);
    this.noise = makeNoiseBuffer(this.ctx);
    this.track = new TrackPlayer(this.ctx, {
      ctxForMaster: (m) => this.clock.perfToCtx(this.timeSource.masterToLocal(m) - this._latencyMs),
      masterForCtx: (c) => this.timeSource.localToMaster(this.clock.ctxToPerf(c) + this._latencyMs),
    });
    this.track.onResync = (ms) => this.onEvent('track-resync', ms);
  }

  /** Volume of all backing tracks together, separate from the click. */
  set trackVolume(v: number) {
    this.track.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /** Volume of one backing-track file (this member's own mix). */
  setFileVolume(id: string, v: number): void {
    this.track.setVolume(id, v);
  }

  hasTrack(id: string): boolean {
    return this.track.has(id);
  }

  /** Releases decoded files that are not in `ids` (another song, or turned down to 0). */
  keepTracks(ids: Set<string>): void {
    this.track.keepOnly(ids);
  }

  /**
   * Decodes a backing-track file; it starts by itself when its song plays.
   * Kept as mono at 32 kHz: in-ear guide tracks lose nothing audible and a
   * five-minute file takes ~40 MB instead of ~115 MB, so several fit on a phone.
   */
  async addTrack(id: string, data: ArrayBuffer): Promise<void> {
    if (this.track.has(id)) return;
    const decoded = await new OfflineAudioContext(1, 1, 32000).decodeAudioData(data.slice(0));
    const mono = this.ctx.createBuffer(1, decoded.length, decoded.sampleRate);
    const out = mono.getChannelData(0);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const d = decoded.getChannelData(ch);
      for (let i = 0; i < d.length; i++) out[i] += d[i] / decoded.numberOfChannels;
    }
    // Another song may have been loaded while this one was decoding.
    if (!this.transport?.song?.track?.files.some((f) => f.id === id)) return;
    this.track.add(id, mono);
    this.track.update(this.transport);
  }

  /** Must be called from a user gesture (autoplay policy). */
  async start(): Promise<void> {
    // resume() can stay pending on some phones (e.g. audio device busy); never block the UI on it.
    await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 2000))]);
    this.startKeepAlive();
    this.clock.update();
    this.lastTick = performance.now();
    if (this.timer === undefined) this.timer = window.setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  set volume(v: number) {
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  set sound(s: SoundKind) {
    this._sound = s;
    this.reschedule();
  }

  set subdivision(s: Subdivision) {
    this._subdivision = s;
    this.reschedule();
  }

  /** Delay between this device scheduling a sound and the ear hearing it (Bluetooth). */
  set latencyMs(ms: number) {
    this._latencyMs = ms;
    this.reschedule();
  }

  /** Silences the click from `masterMs` on (backing tracks keep playing). */
  muteClickFrom(masterMs: number): void {
    const now = this.ctx.currentTime;
    const when = this.clock.perfToCtx(this.timeSource.masterToLocal(masterMs) - this._latencyMs);
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.setValueAtTime(0, Math.max(now, when - 0.05));
  }

  /** The master clock estimate jumped: re-place what is already queued. */
  clockChanged(): void {
    this.reschedule();
  }

  setTimeSource(ts: TimeSource): void {
    this.timeSource = ts;
    this.reschedule();
  }

  setTransport(t: Transport | null): void {
    this.transport = t;
    this.reschedule();
  }

  /** Current master time, for visuals (which are not delayed like Bluetooth audio). */
  masterNow(): number {
    return this.timeSource.localToMaster(performance.now());
  }

  get subdivision(): Subdivision {
    return this._subdivision;
  }

  get latencyMs(): number {
    return this._latencyMs;
  }

  /** Stops everything and releases the audio device (used by the editor's preview). */
  async dispose(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    this.transport = null;
    this.track.stop();
    await this.ctx.close();
  }

  /** Android suspends audio when the page is hidden; call when it becomes visible again. */
  async resume(): Promise<void> {
    await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
    this.reschedule();
  }

  /** False while the browser holds the audio (page hidden, phone call, iOS interruption). */
  get audioRunning(): boolean {
    return this.ctx.state === 'running';
  }

  private reschedule(): void {
    const now = this.ctx.currentTime;
    this.scheduled = this.scheduled.filter((s) => {
      if (s.when > now + MIN_LEAD_S) {
        for (const n of s.nodes) n.stop();
        return false;
      }
      return true;
    });
    const t = this.transport;
    this.track.update(t);
    if (!t) return;
    const fromMaster = this.timeSource.localToMaster(this.clock.ctxToPerf(now + MIN_LEAD_S) + this._latencyMs);
    this.nextIndex = firstTickAtOrAfter(t, this._subdivision, fromMaster);
    this.tick();
  }

  private tick(): void {
    const perf = performance.now();
    const gap = perf - this.lastTick;
    this.lastTick = perf;
    const jump = this.clock.update();
    if (jump !== 0 && this.ctx.state === 'running') {
      this.onEvent('audio-jump', jump);
      // Queued clicks were placed with the old audio clock.
      if (this.transport?.running) return this.reschedule();
    }
    const now = this.ctx.currentTime;
    this.scheduled = this.scheduled.filter((s) => s.when > now - 1);
    const t = this.transport;
    if (this.ctx.state === 'running') this.track.update(t);
    if (!t || !t.running || this.ctx.state !== 'running') return;
    if (gap > STALL_MS && document.visibilityState === 'visible') this.onEvent('stall', gap);

    let late = 0;
    // Bounded so a malformed transport (NaN times) can never freeze the page.
    for (let guard = 0; guard < 2000; guard++) {
      const tick = tickAt(t, this._subdivision, this.nextIndex);
      const localMs = this.timeSource.masterToLocal(tick.time) - this._latencyMs;
      const when = this.clock.perfToCtx(localMs);
      if (!(when <= now + HORIZON_S)) break;
      if (when >= now + MIN_LEAD_S && tick.audible) {
        this.scheduled.push({ when, nodes: scheduleClick(this.ctx, this.out, this._sound, tick.level, when, this.noise) });
      } else if (tick.audible) late++;
      this.nextIndex++;
    }
    if (late) this.onEvent('late', late);
  }

  /**
   * Bluetooth headphones drop the link after a few seconds of silence and
   * swallow the first clicks when it wakes up. A noise floor around -80 dBFS
   * is inaudible but keeps the stream alive.
   */
  private keepAlive: AudioBufferSourceNode | null = null;
  private startKeepAlive(): void {
    if (this.keepAlive) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0.0001;
    src.connect(g).connect(this.ctx.destination);
    src.start();
    this.keepAlive = src;
  }
}
