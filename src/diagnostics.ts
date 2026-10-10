/**
 * A small journal of what happened to timing on this phone: clock-sync
 * quality, reconnects, audio interruptions, stalls. It is uploaded to
 * Firebase (`diagnostics`) so that after a rehearsal we can see who drifted,
 * when, and why. Kept in memory and in localStorage (survives a refresh).
 */
export interface DiagEvent {
  /** Wall-clock time (Date.now()). */
  at: number;
  kind: string;
  value?: number;
  detail?: string;
}

export interface DiagUpload {
  device: string;
  role: string;
  session: string;
  build: string;
  userAgent: string;
  events: DiagEvent[];
}

const KEY = 'bandmetro.diag.v1';
const MAX_EVENTS = 400;
/** Events that point to a problem the band might hear. */
const PROBLEMS = new Set(['sync-jump', 'reconnect', 'master-restart', 'audio-jump', 'stall', 'late', 'track-resync', 'audio-state']);

function deviceId(): string {
  try {
    let id = localStorage.getItem('bandmetro.device');
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      localStorage.setItem('bandmetro.device', id);
    }
    return id;
  } catch {
    return 'unknown';
  }
}

class Diagnostics {
  readonly device = deviceId();
  private events: DiagEvent[] = [];
  /** Index (in a running count) of the first event not uploaded yet. */
  private uploaded = 0;
  private count = 0;

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { events?: DiagEvent[]; pending?: number };
      // Only what was not uploaded before the refresh.
      this.events = (saved.events ?? []).slice(-(saved.pending ?? 0));
      this.count = this.events.length;
    } catch {
      // Corrupt or unavailable storage: start empty.
    }
  }

  log(kind: string, value?: number, detail?: string): void {
    const e: DiagEvent = { at: Date.now(), kind };
    if (value !== undefined && Number.isFinite(value)) e.value = Math.round(value * 10) / 10;
    if (detail) e.detail = detail.slice(0, 200);
    this.events.push(e);
    this.count++;
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.save();
  }

  /** Problems in the last `ms` milliseconds (for the on-screen warning and the master's list). */
  problems(ms: number): number {
    const since = Date.now() - ms;
    return this.events.filter((e) => e.at >= since && PROBLEMS.has(e.kind)).length;
  }

  recent(ms: number): DiagEvent[] {
    const since = Date.now() - ms;
    return this.events.filter((e) => e.at >= since && PROBLEMS.has(e.kind));
  }

  /** Takes the events not uploaded yet; call `done` once they are stored. */
  pending(): { events: DiagEvent[]; done: () => void } {
    const n = Math.min(this.count - this.uploaded, this.events.length);
    const events = this.events.slice(this.events.length - n);
    const upTo = this.count;
    return {
      events,
      done: () => {
        this.uploaded = Math.max(this.uploaded, upTo);
        this.save();
      },
    };
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ events: this.events, pending: this.count - this.uploaded }));
    } catch {
      // Storage full or disabled.
    }
  }
}

export const diag = new Diagnostics();
