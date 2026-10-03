import { trackPositionAt, trackStartAt } from '../tracks';
import type { Transport } from '../timeline';

/** Converts between master time (ms) and this AudioContext's time (s), Bluetooth latency included. */
export interface AudioTimeMap {
  ctxForMaster(masterMs: number): number;
  masterForCtx(ctxS: number): number;
}

/** Errors above this restart the track at the right spot instead of nudging it. */
const RESYNC_S = 0.04;
/** Max playback-rate deviation used to pull the track back in time (0.2%: inaudible). */
const MAX_RATE_DEV = 0.002;

interface Playing {
  id: string;
  src: AudioBufferSourceNode;
  startCtx: number;
  /** Track position (s) at `lastCtx`, integrated from the playback rate. */
  pos: number;
  lastCtx: number;
  rate: number;
}

/**
 * Plays the song's backing track locally, locked to the master clock.
 * The track runs on this device's audio clock, which drifts against the
 * master's by tens of ppm (~15 ms over five minutes), so its position is
 * compared with where it should be on every tick and the playback rate is
 * nudged by up to 0.2% to stay within a few ms of the click.
 */
export class TrackPlayer {
  private buffers = new Map<string, AudioBuffer>();
  private playing: Playing | null = null;
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

  /** Keeps only the latest track decoded: a decoded song takes tens of MB. */
  add(id: string, buffer: AudioBuffer): void {
    if (this.buffers.has(id)) return;
    this.buffers.clear();
    this.buffers.set(id, buffer);
  }

  stop(): void {
    if (!this.playing) return;
    try {
      this.playing.src.stop();
    } catch {
      // Not started yet.
    }
    this.playing.src.disconnect();
    this.playing = null;
  }

  /** Called on every scheduler tick and whenever timing inputs change. */
  update(t: Transport | null): void {
    const now = this.ctx.currentTime;
    const song = t?.running ? t.song : undefined;
    const buffer = song?.track ? this.buffers.get(song.track.id) : undefined;
    const expected = song ? trackPositionAt(song, this.time.masterForCtx(now)) : null;
    if (!song?.track || !buffer || expected === null || expected / 1000 >= buffer.duration) return this.stop();

    const p = this.playing;
    if (p && p.id === song.track.id) {
      if (now < p.startCtx) {
        const due = trackPositionAt(song, this.time.masterForCtx(p.startCtx))! / 1000;
        if (Math.abs(due - p.pos) <= 0.005) return;
        this.stop();
        return this.start(song.track.id, buffer, t!);
      }
      p.pos += (now - Math.max(p.lastCtx, p.startCtx)) * p.rate;
      p.lastCtx = now;
      const err = expected / 1000 - p.pos;
      if (Math.abs(err) <= RESYNC_S) {
        p.rate = 1 + Math.max(-MAX_RATE_DEV, Math.min(MAX_RATE_DEV, err * 0.5));
        p.src.playbackRate.setValueAtTime(p.rate, now);
        return;
      }
    }
    this.stop();
    this.start(song.track.id, buffer, t!);
  }

  private start(id: string, buffer: AudioBuffer, t: Transport): void {
    const song = t.song!;
    const now = this.ctx.currentTime;
    const earliest = this.time.masterForCtx(now + 0.05);
    const startMaster = Math.max(trackStartAt(song, t.segments[0].t)!, earliest);
    const pos = trackPositionAt(song, startMaster)! / 1000;
    if (pos >= buffer.duration) return;
    const when = this.time.ctxForMaster(startMaster);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);
    src.start(when, Math.max(0, pos));
    this.playing = { id, src, startCtx: when, pos: Math.max(0, pos), lastCtx: when, rate: 1 };
  }
}
