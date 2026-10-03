import type { DataConnection } from 'peerjs';
import { getTrack, putTrack, trackId } from '../tracks';

/**
 * Passing backing-track files between the phones of a session.
 *
 * Files travel on their own data connection (label "tracks"), separate from
 * the clock-sync channel, so a transfer of several MB never delays the pings.
 * Members ask the master for files they miss; if the master does not have a
 * file either, it asks the other members and relays it.
 */

export const TRACK_LABEL = 'tracks';
const CHUNK = 64 * 1024;
/** Pause sending while this much is still queued in the channel. */
const MAX_BUFFERED = 2 * 1024 * 1024;

type FileMsg =
  | { t: 'want'; id: string }
  | { t: 'have'; id: string; size: number }
  | { t: 'chunk'; id: string; i: number; data: ArrayBuffer };

export interface TrackEvents {
  /** A complete, verified file is now stored on this device. */
  onStored(id: string, data: ArrayBuffer): void;
  onProgress(id: string, fraction: number): void;
}

/** One file connection to another phone. */
class TrackLink {
  private incoming = new Map<string, { buf: Uint8Array; got: Set<number>; chunks: number }>();

  constructor(
    readonly conn: DataConnection,
    private readonly onWant: (id: string, link: TrackLink) => void,
    private readonly onComplete: (id: string, data: ArrayBuffer) => void,
    private readonly onProgress: (id: string, f: number) => void,
  ) {
    conn.on('data', (raw) => this.handle(raw as FileMsg));
  }

  want(id: string): void {
    if (this.conn.open) this.conn.send({ t: 'want', id } satisfies FileMsg);
  }

  async send(id: string, data: ArrayBuffer): Promise<void> {
    this.conn.send({ t: 'have', id, size: data.byteLength } satisfies FileMsg);
    for (let i = 0; i * CHUNK < data.byteLength; i++) {
      while ((this.conn.dataChannel?.bufferedAmount ?? 0) > MAX_BUFFERED) {
        if (!this.conn.open) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      this.conn.send({ t: 'chunk', id, i, data: data.slice(i * CHUNK, (i + 1) * CHUNK) } satisfies FileMsg);
    }
  }

  private handle(msg: FileMsg): void {
    if (msg.t === 'want') return this.onWant(msg.id, this);
    if (msg.t === 'have') {
      // A second copy of a file already arriving fills the same buffer.
      if (this.incoming.get(msg.id)?.buf.byteLength !== msg.size) {
        this.incoming.set(msg.id, { buf: new Uint8Array(msg.size), got: new Set(), chunks: Math.ceil(msg.size / CHUNK) });
      }
      return this.onProgress(msg.id, 0);
    }
    const f = this.incoming.get(msg.id);
    if (!f || msg.i >= f.chunks) return;
    f.buf.set(new Uint8Array(msg.data), msg.i * CHUNK);
    f.got.add(msg.i);
    this.onProgress(msg.id, f.got.size / f.chunks);
    if (f.got.size >= f.chunks) {
      this.incoming.delete(msg.id);
      this.onComplete(msg.id, f.buf.buffer as ArrayBuffer);
    }
  }
}

/** Stores a received file if its content matches the id it was requested under. */
async function verifyAndStore(id: string, data: ArrayBuffer): Promise<boolean> {
  if ((await trackId(data)) !== id) return false;
  await putTrack(id, data);
  return true;
}

/** Master side: serves files to members and fetches missing ones from them. */
export class MasterTracks {
  private links = new Map<string, TrackLink>();
  /** Members waiting for a file the master is still fetching. */
  private waiting = new Map<string, Set<TrackLink>>();
  private asked = new Set<string>();

  constructor(private readonly events: TrackEvents) {}

  accept(conn: DataConnection): void {
    const link = new TrackLink(
      conn,
      (id, from) => void this.serve(id, from),
      (id, data) => void this.received(id, data),
      this.events.onProgress,
    );
    conn.on('open', () => {
      this.links.set(conn.peer, link);
      // Someone who just joined may have what the master is missing.
      for (const id of this.asked) link.want(id);
    });
    conn.on('close', () => this.links.delete(conn.peer));
  }

  /** Makes sure the master has a file, asking members for it if needed. */
  async fetch(id: string): Promise<void> {
    const data = await getTrack(id);
    if (data) return this.events.onStored(id, data);
    this.askMembers(id);
  }

  private async serve(id: string, to: TrackLink): Promise<void> {
    const data = await getTrack(id);
    if (data) return to.send(id, data);
    if (!this.waiting.has(id)) this.waiting.set(id, new Set());
    this.waiting.get(id)!.add(to);
    this.askMembers(id, to);
  }

  private askMembers(id: string, except?: TrackLink): void {
    if (this.asked.has(id)) return;
    this.asked.add(id);
    for (const l of this.links.values()) if (l !== except) l.want(id);
  }

  private async received(id: string, data: ArrayBuffer): Promise<void> {
    if (!(await verifyAndStore(id, data))) return;
    this.asked.delete(id);
    this.events.onStored(id, data);
    for (const l of this.waiting.get(id) ?? []) void l.send(id, data);
    this.waiting.delete(id);
  }
}

/** Member side: asks the master for missing files and shares its own on request. */
export class MemberTracks {
  private link: TrackLink | null = null;
  private wanted = new Set<string>();

  constructor(private readonly events: TrackEvents) {}

  attach(conn: DataConnection): void {
    this.link = new TrackLink(
      conn,
      (id, from) => void getTrack(id).then((d) => d && from.send(id, d)),
      (id, data) => void this.received(id, data),
      this.events.onProgress,
    );
    conn.on('open', () => {
      for (const id of this.wanted) this.link?.want(id);
    });
  }

  /** Loads a file from this device, or asks the master for it. */
  async need(id: string): Promise<void> {
    const data = await getTrack(id);
    if (data) return this.events.onStored(id, data);
    if (this.wanted.has(id)) return;
    this.wanted.add(id);
    if (this.link?.conn.open) this.link.want(id);
  }

  private async received(id: string, data: ArrayBuffer): Promise<void> {
    const ok = await verifyAndStore(id, data);
    // Either way the request is over; a corrupt copy is asked for again next time it is needed.
    this.wanted.delete(id);
    if (ok) this.events.onStored(id, data);
  }
}
