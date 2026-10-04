import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./localAddresses', () => ({
  getLocalPrivateIPv4s: vi.fn(async () => ['192.168.77.23']),
}));

vi.mock('./logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logVerbose: vi.fn(),
}));

// Fake react-native-udp: EventEmitter socket that records what is sent.
vi.mock('react-native-udp', async () => {
  const sockets: any[] = [];
  class Emitter {
    private l = new Map<string, ((...a: any[]) => void)[]>();
    on(ev: string, fn: (...a: any[]) => void) {
      this.l.set(ev, [...(this.l.get(ev) ?? []), fn]);
      return this;
    }
    emit(ev: string, ...a: any[]) {
      (this.l.get(ev) ?? []).forEach((fn) => fn(...a));
      return true;
    }
  }
  class FakeSocket extends Emitter {
    sent: { buf: string; addr: string }[] = [];
    closed = false;
    broadcast = false;
    bind() {
      queueMicrotask(() => this.emit('listening'));
    }
    setBroadcast(v: boolean) {
      this.broadcast = v;
    }
    send(buf: string, _o: number, _l: number, _p: number, addr: string) {
      if (this.closed) return;
      this.sent.push({ buf, addr });
    }
    close() {
      this.closed = true;
    }
  }
  return {
    default: {
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    },
    __sockets: sockets,
  };
});

import * as udp from 'react-native-udp';
import {
  splitPayload,
  reassemble,
  deriveBroadcastAddresses,
  startNearbyHost,
  startNearbyGuest,
  isNearbyCancelled,
} from './nearbyPairing';
import { encodeRoomOffer, encodeRoomAnswer } from './offlineSignal';

const sockets = (udp as any).__sockets as any[];

const SDP =
  'v=0\r\n' +
  'a=candidate:1 1 udp 2122260223 192.168.1.23 54321 typ host generation 0\r\n' +
  'a=candidate:2 1 udp 2122194687 10.0.0.5 54322 typ host generation 0\r\n' +
  'a=candidate:3 1 udp 1686052607 8.8.8.8 54323 typ srflx raddr 192.168.1.23 rport 54321\r\n' +
  'a=candidate:4 1 udp 2122129151 34.1.2.3 54324 typ host generation 0\r\n' +
  'a=candidate:5 1 tcp 1518280447 192.168.7.7 9 typ host tcptype active\r\n';

const offerRaw = (sdpText = SDP, code = '123456') =>
  encodeRoomOffer({ code, name: 'Host', sdp: { type: 'offer', sdp: sdpText } });
const answerRaw = (code = '123456') =>
  encodeRoomAnswer({ code, name: 'Guest', sdp: { type: 'answer', sdp: 'v=0\r\n' } });

function deliver(socket: any, chunks: any[], rinfo = { address: '192.168.1.50' }) {
  for (const c of chunks) socket.emit('message', JSON.stringify(c), rinfo);
}

beforeEach(() => {
  sockets.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('splitPayload / reassemble', () => {
  it('round-trips a large payload delivered out of order', () => {
    const raw = 'x'.repeat(3100) + 'END';
    const chunks = splitPayload('id1', 'offer', raw, { name: 'A', code: '1' });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].name).toBe('A');
    expect(chunks[1].name).toBeUndefined();
    const buf = new Map<number, string>();
    [...chunks].reverse().forEach((c) => buf.set(c.i, c.p));
    expect(reassemble(buf, chunks[0].n)).toBe(raw);
  });

  it('returns null while a chunk is missing', () => {
    const chunks = splitPayload('id2', 'answer', 'y'.repeat(2000), {});
    const buf = new Map<number, string>();
    chunks.slice(0, -1).forEach((c) => buf.set(c.i, c.p));
    expect(reassemble(buf, chunks[0].n)).toBeNull();
  });
});

describe('deriveBroadcastAddresses', () => {
  it('derives /24 broadcasts from private IPv4 host candidates only', () => {
    expect(deriveBroadcastAddresses(offerRaw())).toEqual(['192.168.1.255', '10.0.0.255']);
  });
  it('ignores srflx, public host and tcp candidates; caps at 2', () => {
    const only = offerRaw(
      'a=candidate:3 1 udp 1 8.8.8.8 1 typ srflx\r\na=candidate:4 1 udp 1 34.1.2.3 1 typ host\r\n'
    );
    expect(deriveBroadcastAddresses(only)).toEqual([]);
    const many = offerRaw(
      [1, 2, 3, 4].map((n) => `a=candidate:${n} 1 udp 1 192.168.${n}.9 1 typ host`).join('\r\n')
    );
    expect(deriveBroadcastAddresses(many)).toHaveLength(2);
  });
  it('is safe on garbage', () => {
    expect(deriveBroadcastAddresses('not json')).toEqual([]);
  });
});

describe('startNearbyHost', () => {
  it('enables broadcast and sends to limited + derived broadcast addresses', async () => {
    const p = startNearbyHost({ offerRaw: offerRaw(), name: 'Host', code: '123456' });
    p.catch(() => {});
    await Promise.resolve();
    const s = sockets[0];
    expect(s.broadcast).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    const addrs = new Set(s.sent.map((x: any) => x.addr));
    expect(addrs.has('255.255.255.255')).toBe(true);
    expect(addrs.has('192.168.1.255')).toBe(true);
    expect(addrs.has('10.0.0.255')).toBe(true);
  });

  it('cancel() immediately stops broadcasting, closes the socket and rejects as cancelled', async () => {
    let cancel: () => void = () => {};
    const p = startNearbyHost({
      offerRaw: offerRaw(),
      name: 'Host',
      code: '123456',
      onReady: (c) => (cancel = c),
    });
    const assertion = expect(p).rejects.toSatisfy((e) => isNearbyCancelled(e));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    const before = sockets[0].sent.length;
    cancel();
    await assertion;
    expect(sockets[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sockets[0].sent.length).toBe(before);
  });

  it('ignores an answer for another room and accepts the right one', async () => {
    const validate = (raw: string) => raw.includes('"code":"123456"');
    let resolved: any = null;
    const p = startNearbyHost({
      offerRaw: offerRaw(),
      name: 'Host',
      code: '123456',
      validateAnswer: validate,
    });
    p.then((r) => (resolved = r)).catch(() => {});
    await Promise.resolve();
    const s = sockets[0];

    deliver(s, splitPayload('bad', 'answer', answerRaw('999999'), { name: 'Intruder' }));
    await Promise.resolve();
    expect(resolved).toBeNull();
    expect(s.closed).toBe(false);

    deliver(s, splitPayload('good', 'answer', answerRaw('123456'), { name: 'Guest' }));
    await Promise.resolve();
    expect(resolved?.peerName).toBe('Guest');
    expect(resolved?.answerRaw).toBe(answerRaw('123456'));
    expect(s.closed).toBe(true);
  });

  it('maps EADDRINUSE to a friendly error', async () => {
    const p = startNearbyHost({ offerRaw: offerRaw(), name: 'Host', code: '1' });
    const assertion = expect(p).rejects.toThrow(/still busy/i);
    sockets[0].emit('error', new Error('bind EADDRINUSE'));
    await assertion;
  });
});

describe('startNearbyGuest', () => {
  it('enables broadcast, resolves on a complete offer, and answers via unicast + broadcast', async () => {
    const raw = offerRaw();
    const p = startNearbyGuest({});
    await Promise.resolve();
    const s = sockets[0];
    expect(s.broadcast).toBe(true);

    deliver(s, splitPayload('o1', 'offer', raw, { name: 'Host', code: '123456' }), {
      address: '192.168.1.50',
    });
    const r = await p;
    expect(r.offerRaw).toBe(raw);
    expect(r.code).toBe('123456');
    expect(r.hostName).toBe('Host');

    r.sendAnswer(answerRaw(), 'Guest');
    await vi.advanceTimersByTimeAsync(250);
    const addrs = new Set(s.sent.map((x: any) => x.addr));
    expect(addrs.has('192.168.1.50')).toBe(true);
    expect(addrs.has('255.255.255.255')).toBe(true);
  });

  it('stop() also halts the repeating answer sender', async () => {
    const p = startNearbyGuest({});
    await Promise.resolve();
    const s = sockets[0];
    deliver(s, splitPayload('o2', 'offer', offerRaw(), { name: 'Host', code: '123456' }));
    const r = await p;
    r.sendAnswer(answerRaw(), 'Guest');
    await vi.advanceTimersByTimeAsync(250);
    r.stop();
    const before = s.sent.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.sent.length).toBe(before);
    expect(s.closed).toBe(true);
  });

  it('cancel() rejects as cancelled and frees the socket', async () => {
    let cancel: () => void = () => {};
    const p = startNearbyGuest({ onReady: (c) => (cancel = c) });
    const assertion = expect(p).rejects.toSatisfy((e) => isNearbyCancelled(e));
    cancel();
    await assertion;
    expect(sockets[0].closed).toBe(true);
  });
});

describe('hotspot discovery (guest probes, host unicasts)', () => {
  it('guest immediately probes common gateways + broadcast, then its own subnet gateway', async () => {
    const p = startNearbyGuest({ name: 'Guest' });
    p.catch(() => {});
    await Promise.resolve();
    const s = sockets[0];
    await vi.advanceTimersByTimeAsync(0);
    const first = new Set(s.sent.map((x: any) => x.addr));
    expect(first.has('192.168.43.1')).toBe(true); // classic Android hotspot gateway
    expect(first.has('255.255.255.255')).toBe(true);
    expect(JSON.parse(s.sent[0].buf).kind).toBe('probe');

    await vi.advanceTimersByTimeAsync(800);
    const later = new Set(s.sent.map((x: any) => x.addr));
    expect(later.has('192.168.77.1')).toBe(true); // learned gateway guess
    expect(later.has('192.168.77.255')).toBe(true); // learned subnet broadcast
  });

  it('guest stops probing once an offer is received', async () => {
    const p = startNearbyGuest({});
    await Promise.resolve();
    const s = sockets[0];
    deliver(s, splitPayload('o9', 'offer', offerRaw(), { name: 'Host', code: '123456' }));
    await p;
    const before = s.sent.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.sent.length).toBe(before);
  });

  it('host answers a probe by unicasting the offer to the prober, and keeps doing so', async () => {
    const p = startNearbyHost({ offerRaw: offerRaw(), name: 'Host', code: '123456' });
    p.catch(() => {});
    await Promise.resolve();
    const s = sockets[0];
    s.emit(
      'message',
      JSON.stringify({ m: 'LDN1', kind: 'probe', id: 'g1', name: 'Guest' }),
      { address: '192.168.43.57' }
    );
    const direct = s.sent.filter((x: any) => x.addr === '192.168.43.57');
    expect(direct.length).toBeGreaterThan(0);
    expect(JSON.parse(direct[0].buf).kind).toBe('offer');

    const n = direct.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(s.sent.filter((x: any) => x.addr === '192.168.43.57').length).toBeGreaterThan(n);
  });
});
