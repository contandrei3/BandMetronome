import Peer, { type DataConnection, type PeerOptions } from 'peerjs';
import { ClockSync } from '../sync/clockSync';
import type { Transport } from '../timeline';

const ID_PREFIX = 'bandmetro-v1-';

export type Message =
  | { t: 'ping'; id: number; c0: number }
  | { t: 'pong'; id: number; c0: number; m: number }
  | { t: 'state'; transport: Transport }
  | { t: 'status'; name: string; minRtt: number; jitter: number; latencyMs: number };

export interface MemberStatus {
  peer: string;
  name: string;
  minRtt: number;
  jitter: number;
  latencyMs: number;
  lastSeen: number;
}

export type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'error';

/**
 * Signaling server. Defaults to the free PeerJS cloud; set VITE_PEER_HOST (and
 * optionally VITE_PEER_PORT, VITE_PEER_PATH, VITE_PEER_SECURE) at build time to
 * use a self-hosted `peerjs-server`.
 */
function peerOptions(): PeerOptions {
  const env = import.meta.env;
  if (!env.VITE_PEER_HOST) return {};
  return {
    host: env.VITE_PEER_HOST,
    port: env.VITE_PEER_PORT ? Number(env.VITE_PEER_PORT) : undefined,
    path: env.VITE_PEER_PATH || '/',
    secure: env.VITE_PEER_SECURE !== 'false',
  };
}

export function randomCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/** Master: owns the clock and the transport, answers pings, broadcasts state. */
export class MasterSession {
  private peer: Peer | null = null;
  private conns = new Map<string, DataConnection>();
  readonly members = new Map<string, MemberStatus>();
  code = '';
  onMembersChange: () => void = () => {};
  onState: (s: ConnState, detail?: string) => void = () => {};

  constructor(private transport: Transport) {}

  /** Resolves with the 4-digit code once the signaling server has accepted it. */
  open(code = randomCode(), attempts = 5): Promise<string> {
    return new Promise((resolve, reject) => {
      const peer = new Peer(ID_PREFIX + code, peerOptions());
      const timeout = setTimeout(() => {
        if (this.peer) return;
        peer.destroy();
        reject({ type: 'serverul de sesiuni nu răspunde' });
      }, 15000);
      peer.on('open', () => {
        clearTimeout(timeout);
        this.peer = peer;
        this.code = code;
        this.onState('connected');
        resolve(code);
      });
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id' && !this.peer) {
          clearTimeout(timeout);
          peer.destroy();
          if (attempts > 1) this.open(randomCode(), attempts - 1).then(resolve, reject);
          else reject(err);
          return;
        }
        if (!this.peer) {
          clearTimeout(timeout);
          peer.destroy();
          reject(err);
        }
        else this.onState('error', err.type);
      });
      // Losing the signaling server does not drop existing data channels; just re-register.
      peer.on('disconnected', () => {
        this.onState('reconnecting');
        setTimeout(() => !peer.destroyed && peer.reconnect(), 2000);
      });
      peer.on('connection', (conn) => this.accept(conn));
    });
  }

  setTransport(t: Transport): void {
    this.transport = t;
    for (const c of this.conns.values()) if (c.open) c.send({ t: 'state', transport: t } satisfies Message);
  }

  private accept(conn: DataConnection): void {
    conn.on('open', () => {
      this.conns.set(conn.peer, conn);
      conn.send({ t: 'state', transport: this.transport } satisfies Message);
    });
    conn.on('data', (raw) => {
      const msg = raw as Message;
      if (msg.t === 'ping') {
        conn.send({ t: 'pong', id: msg.id, c0: msg.c0, m: performance.now() } satisfies Message);
      } else if (msg.t === 'status') {
        this.members.set(conn.peer, { peer: conn.peer, ...msg, lastSeen: performance.now() });
        this.onMembersChange();
      }
    });
    const drop = () => {
      this.conns.delete(conn.peer);
      this.members.delete(conn.peer);
      this.onMembersChange();
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }
}

/** Member: follows the master's clock and transport. */
export class ClientSession {
  readonly sync = new ClockSync();
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private pingTimer: number | undefined;
  private statusTimer: number | undefined;
  private pingId = 0;
  private closed = false;
  transport: Transport | null = null;
  onTransport: (t: Transport) => void = () => {};
  onState: (s: ConnState, detail?: string) => void = () => {};
  getStatus: () => { name: string; latencyMs: number } = () => ({ name: '', latencyMs: 0 });

  constructor(readonly code: string) {}

  open(): void {
    const peer = new Peer(peerOptions());
    this.peer = peer;
    peer.on('open', () => this.connect());
    peer.on('error', (err) => {
      // The master is not (yet) registered: keep retrying, it may be restarting.
      if (err.type === 'peer-unavailable') this.scheduleReconnect();
      else this.onState('error', err.type);
    });
    peer.on('disconnected', () => {
      setTimeout(() => !peer.destroyed && peer.reconnect(), 2000);
    });
  }

  close(): void {
    this.closed = true;
    this.stopTimers();
    this.peer?.destroy();
  }

  masterNow(): number {
    return performance.now() + this.sync.offset;
  }

  private connect(): void {
    if (!this.peer || this.closed) return;
    this.onState(this.transport ? 'reconnecting' : 'connecting');
    const conn = this.peer.connect(ID_PREFIX + this.code, { serialization: 'json', reliable: true });
    this.conn = conn;
    conn.on('open', () => {
      this.onState('connected');
      this.startTimers();
    });
    conn.on('data', (raw) => this.handle(raw as Message));
    conn.on('close', () => {
      if (this.conn === conn) this.scheduleReconnect();
    });
  }

  private reconnectTimer: number | undefined;
  private scheduleReconnect(): void {
    this.stopTimers();
    if (this.closed || this.reconnectTimer !== undefined) return;
    this.onState('reconnecting');
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 2000);
  }

  private handle(msg: Message): void {
    if (msg.t === 'pong') {
      this.sync.addSample(msg.c0, msg.m, performance.now());
    } else if (msg.t === 'state') {
      this.transport = msg.transport;
      this.onTransport(msg.transport);
    }
  }

  private startTimers(): void {
    this.stopTimers();
    // Ping fast until locked, then settle to 2 Hz to track drift.
    const ping = () => {
      if (this.conn?.open) this.conn.send({ t: 'ping', id: ++this.pingId, c0: performance.now() } satisfies Message);
      this.pingTimer = window.setTimeout(ping, this.sync.locked ? 500 : 100);
    };
    ping();
    this.statusTimer = window.setInterval(() => {
      const s = this.sync.stats();
      if (this.conn?.open)
        this.conn.send({ t: 'status', ...this.getStatus(), minRtt: s.minRtt, jitter: s.jitter } satisfies Message);
    }, 2000);
  }

  private stopTimers(): void {
    clearTimeout(this.pingTimer);
    clearInterval(this.statusTimer);
  }
}
