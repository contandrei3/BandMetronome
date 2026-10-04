import { trackPositionAt, trackStartAt } from '../tracks';
import type { Transport } from '../timeline';

/** Converts between master time (ms) and this AudioContext's time (s), Bluetooth latency included. */
export interface AudioTimeMap {
  ctxForMaster(masterMs: number): number;
  masterForCtx(ctxS: number): number;
}

/** Errors above this restart a file at the right spot instead of nudging it. */
const RESYNC_S = 0.04;
/** Max playback-rate deviation used to pull a file back in time (0.2%: inaudible). */
const MAX_RATE_DEV = 0.002;

interface Voice {
  src: AudioBufferSourceNode;
  startCtx: number;
  /** File position (s) at `lastCtx`, integrated from the playback rate. */
  pos: number;
  lastCtx: number;
  rate: number;
}

/**
 * Plays a song's audio files locally, locked to the master clock, each
 * through its own volume. A file runs on this device's audio clock, which
 * drifts against the master's by tens of ppm (~15 ms over five minutes), so
 * on every tick its position is compared with where it should be and the
 * playback rate is nudged by up to 0.2% to stay within a few ms of the click.
 */
export class TrackPlayer {
  private buffers = new Map<string, AudioBuffer>();
  private voices = new Map<string, Voice>();
  private gains = new Map<string, GainNode>();
  /** All files together ("Volum negative"). */
  readonly gain: GainNode;

  constructor(
    private readonly ctx: AudioContext,
    private readonly time: AudioTimeMap,
  ) {
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
  }

  has(id: string): boolean {
    return this.buffers.has(id);
  }

  add(id: string, buffer: AudioBuffer): void {
    this.buffers.set(id, buffer);
  }

  /** Frees decoded audio of files no longer needed (a decoded song takes tens of MB). */
  keepOnly(ids: Set<string>): void {
    for (const id of [...this.buffers.keys()]) {
      if (ids.has(id)) continue;
      this.buffers.delete(id);
      this.stopVoice(id);
    }
  }

  setVolume(id: string, v: number): void {
    this.gainFor(id).gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  stop(): void {
    for (const id of [...this.voices.keys()]) this.stopVoice(id);
  }

  /** Called on every scheduler tick and whenever timing inputs change. */
  update(t: Transport | null): void {
    const song = t?.running ? t.song : undefined;
    const files = song?.track?.files ?? [];
    for (const id of [...this.voices.keys()]) if (!files.some((f) => f.id === id)) this.stopVoice(id);
    if (!song?.track) return;
    for (const f of files) {
      const buffer = this.buffers.get(f.id);
      if (buffer) this.updateVoice(f.id, buffer, t!);
      else this.stopVoice(f.id);
    }
  }

  private updateVoice(id: string, buffer: AudioBuffer, t: Transport): void {
    const song = t.song!;
    const now = this.ctx.currentTime;
    const expected = trackPositionAt(song, this.time.masterForCtx(now))! / 1000;
    if (expected >= buffer.duration) return this.stopVoice(id);

    const v = this.voices.get(id);
    if (v) {
      if (now < v.startCtx) {
        // Not started yet: re-time it if latency or the clock changed meanwhile.
        const due = trackPositionAt(song, this.time.masterForCtx(v.startCtx))! / 1000;
        if (Math.abs(due - v.pos) <= 0.005) return;
      } else {
        v.pos += (now - Math.max(v.lastCtx, v.startCtx)) * v.rate;
        v.lastCtx = now;
        const err = expected - v.pos;
        if (Math.abs(err) <= RESYNC_S) {
          v.rate = 1 + Math.max(-MAX_RATE_DEV, Math.min(MAX_RATE_DEV, err * 0.5));
          v.src.playbackRate.setValueAtTime(v.rate, now);
          return;
        }
      }
    }
    this.stopVoice(id);
    this.startVoice(id, buffer, t);
  }

  private startVoice(id: string, buffer: AudioBuffer, t: Transport): void {
    const song = t.song!;
    const now = this.ctx.currentTime;
    const earliest = this.time.masterForCtx(now + 0.05);
    const startMaster = Math.max(trackStartAt(song, t.segments[0].t)!, earliest);
    const pos = trackPositionAt(song, startMaster)! / 1000;
    if (pos >= buffer.duration) return;
    const when = this.time.ctxForMaster(startMaster);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gainFor(id));
    src.start(when, Math.max(0, pos));
    this.voices.set(id, { src, startCtx: when, pos: Math.max(0, pos), lastCtx: when, rate: 1 });
  }

  private stopVoice(id: string): void {
    const v = this.voices.get(id);
    if (!v) return;
    try {
      v.src.stop();
    } catch {
      // Not started yet.
    }
    v.src.disconnect();
    this.voices.delete(id);
  }

  private gainFor(id: string): GainNode {
    let g = this.gains.get(id);
    if (!g) {
      g = this.ctx.createGain();
      g.connect(this.gain);
      this.gains.set(id, g);
    }
    return g;
  }
}
