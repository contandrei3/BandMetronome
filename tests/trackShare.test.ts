import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { DataConnection } from 'peerjs';
import { MasterTracks, MemberTracks } from '../src/net/trackShare';
import { getTrack, putTrack, trackId } from '../src/tracks';

type Handler = (x?: unknown) => void;

/** In-memory stand-in for a PeerJS DataConnection pair. */
class FakeConn {
  open = true;
  other!: FakeConn;
  dataChannel = { bufferedAmount: 0 };
  sent: unknown[] = [];
  private handlers = new Map<string, Handler[]>();
  constructor(readonly peer: string) {}
  on(ev: string, cb: Handler) {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), cb]);
    if (ev === 'open' && this.open) queueMicrotask(() => cb());
  }
  emit(ev: string, x?: unknown) {
    for (const cb of this.handlers.get(ev) ?? []) cb(x);
  }
  send(msg: unknown) {
    this.sent.push(msg);
    setTimeout(() => this.other.emit('data', structuredClone(msg)));
  }
  close() {}
}

/** [member side, master side]; each side's `peer` is the id of the phone at the other end. */
function pair(name: string): [DataConnection, DataConnection] {
  const a = new FakeConn('master');
  const b = new FakeConn(name);
  a.other = b;
  b.other = a;
  return [a as unknown as DataConnection, b as unknown as DataConnection];
}

function file(size: number, seed: number): ArrayBuffer {
  const u = new Uint8Array(size);
  for (let i = 0; i < size; i++) u[i] = (i * 31 + seed) & 255;
  return u.buffer;
}

const until = async (cond: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timeout');
};

const events = (stored: string[]) => ({ onStored: (id: string) => stored.push(id), onProgress: () => {} });

describe('track sharing', () => {
  it('sends a file from the master to a member in chunks and verifies it', async () => {
    const data = file(200_000, 1);
    const id = await trackId(data);
    await putTrack(id, data);
    const masterStored: string[] = [];
    const memberStored: string[] = [];
    const master = new MasterTracks(events(masterStored));
    const member = new MemberTracks(events(memberStored));
    const [toMaster, fromMember] = pair('bass');
    master.accept(fromMember);
    member.attach(toMaster);
    await new Promise((r) => setTimeout(r, 10));
    // Ask over the wire (need() would find the copy in this test's shared IndexedDB).
    toMaster.send({ t: 'want', id });
    await until(() => memberStored.includes(id));
    const chunks = ((fromMember as unknown as FakeConn).sent as { t: string }[]).filter((m) => m.t === 'chunk');
    expect(chunks.length).toBe(Math.ceil(data.byteLength / 65536));
  });

  it('relays a file the master lacks from one member to another', async () => {
    const data = file(150_000, 7);
    const id = await trackId(data);
    const stored: string[] = [];
    const master = new MasterTracks(events(stored));
    const [aToM, mFromA] = pair('lead');
    const [bToM, mFromB] = pair('bass');
    master.accept(mFromA);
    master.accept(mFromB);
    const bStored: string[] = [];
    const b = new MemberTracks(events(bStored));
    b.attach(bToM);
    // Lead has the file but only answers when asked; simulate its side by hand.
    (aToM as unknown as FakeConn).on('data', (msg) => {
      const m = msg as { t: string; id: string };
      if (m.t === 'want' && m.id === id) {
        aToM.send({ t: 'have', id, size: data.byteLength });
        for (let i = 0; i * 65536 < data.byteLength; i++) aToM.send({ t: 'chunk', id, i, data: data.slice(i * 65536, (i + 1) * 65536) });
      }
    });
    await new Promise((r) => setTimeout(r, 10));
    // B asks the master, which does not have it yet (not in IndexedDB).
    expect(await getTrack(id)).toBeUndefined();
    (bToM as unknown as FakeConn).send({ t: 'want', id });
    await until(async () => !!(await getTrack(id)) && stored.includes(id));
    // The master now serves B.
    const sentToB = (mFromB as unknown as FakeConn).sent as { t: string }[];
    await until(() => sentToB.some((m) => m.t === 'have'));
    expect(sentToB.filter((m) => m.t === 'chunk').length).toBe(Math.ceil(data.byteLength / 65536));
  });

  it('ignores corrupt data and survives a duplicated transfer', async () => {
    const good = file(100_000, 3);
    const id = await trackId(good);
    const stored: string[] = [];
    const member = new MemberTracks(events(stored));
    const [toMaster, fromMember] = pair('voce');
    member.attach(toMaster);
    void member.need(id);
    await new Promise((r) => setTimeout(r, 10));
    const send = (buf: ArrayBuffer) => {
      fromMember.send({ t: 'have', id, size: buf.byteLength });
      for (let i = 0; i * 65536 < buf.byteLength; i++) fromMember.send({ t: 'chunk', id, i, data: buf.slice(i * 65536, (i + 1) * 65536) });
    };
    const bad = good.slice(0);
    new Uint8Array(bad)[5] ^= 1;
    send(bad);
    await new Promise((r) => setTimeout(r, 50));
    expect(stored).toEqual([]);
    expect(await getTrack(id)).toBeUndefined();
    // Asked again, the right file arrives twice at once: still stored once and intact.
    void member.need(id);
    send(good);
    send(good);
    await until(() => stored.length > 0);
    expect(new Uint8Array((await getTrack(id))!)).toEqual(new Uint8Array(good));
  });
});
