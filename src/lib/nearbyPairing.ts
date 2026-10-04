/**
 * Connect nearby — UDP signaling on same Wi‑Fi / hotspot.
 * Simple reliable strategy: broadcast offers on 255.255.255.255;
 * guest replies with unicast (+ broadcast fallback).
 * Avoid flooding many directed addresses (that broke same-WiFi discovery).
 */
import dgram from 'react-native-udp';
import { logError, logInfo, logWarn } from './logger';
import { decodeRoomPayload } from './offlineSignal';
import { extractPrivateIPv4, broadcastFor, gatewayGuess, COMMON_GATEWAYS } from './netUtil';
import { getLocalPrivateIPv4s } from './localAddresses';

const PORT = 47831;
const MAGIC = 'LDN1';
const CHUNK = 700;
type NearbySocket = ReturnType<typeof dgram.createSocket>;

/** Guest → network: "is anyone hosting a room?" Host answers with unicast offer chunks. */
type ProbeMsg = { m: typeof MAGIC; kind: 'probe'; id: string; name?: string };

export type ChunkMsg = {
  m: typeof MAGIC;
  id: string;
  kind: 'offer' | 'answer';
  i: number;
  n: number;
  p: string;
  name?: string;
  code?: string;
};

export function splitPayload(
  id: string,
  kind: 'offer' | 'answer',
  raw: string,
  meta: { name?: string; code?: string }
): ChunkMsg[] {
  const parts: ChunkMsg[] = [];
  const n = Math.max(1, Math.ceil(raw.length / CHUNK));
  for (let i = 0; i < n; i++) {
    parts.push({
      m: MAGIC,
      id,
      kind,
      i,
      n,
      p: raw.slice(i * CHUNK, (i + 1) * CHUNK),
      ...(i === 0 ? meta : {}),
    });
  }
  return parts;
}

export function reassemble(buf: Map<number, string>, n: number): string | null {
  if (buf.size < n) return null;
  let out = '';
  for (let i = 0; i < n; i++) {
    const part = buf.get(i);
    if (part == null) return null;
    out += part;
  }
  return out;
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeName(n?: string): string {
  const t = (n || '').trim();
  return t.length > 0 ? t.slice(0, 40) : 'Device';
}

function mergeAnswerMeta(
  prev: { n: number; name: string } | undefined,
  data: ChunkMsg
): { n: number; name: string } {
  const n = data.n != null ? data.n : prev?.n ?? 0;
  const hasName = typeof data.name === 'string' && data.name.trim().length > 0;
  const name = hasName ? safeName(data.name) : prev?.name ?? 'Device';
  return { n, name };
}

function mergeOfferMeta(
  prev:
    | { n: number; name: string; code: string; rinfo: { address: string } }
    | undefined,
  data: ChunkMsg,
  rinfo: { address: string }
): { n: number; name: string; code: string; rinfo: { address: string } } {
  const n = data.n != null ? data.n : prev?.n ?? 0;
  const hasName = typeof data.name === 'string' && data.name.trim().length > 0;
  const name = hasName ? safeName(data.name) : prev?.name ?? 'Device';
  const hasCode = typeof data.code === 'string' && data.code.length > 0;
  const code = hasCode ? String(data.code) : String(prev?.code ?? '');
  const addr = prev?.rinfo?.address || rinfo.address;
  return { n, name, code, rinfo: { address: addr } };
}

/** Thrown (as the rejection) when the caller cancels a pending host/guest search. */
export class NearbyCancelledError extends Error {
  constructor() {
    super('Nearby pairing cancelled');
    this.name = 'NearbyCancelledError';
  }
}

export function isNearbyCancelled(e: unknown): boolean {
  return e instanceof Error && e.name === 'NearbyCancelledError';
}

function friendlySocketError(e: unknown): Error {
  const raw = e instanceof Error ? e.message : String(e);
  if (/EADDRINUSE|address already in use/i.test(raw)) {
    return new Error(
      'Nearby pairing is still busy from a previous try. Wait a few seconds and try again.'
    );
  }
  return new Error(`Nearby pairing failed: ${raw}`);
}

/**
 * Directed-broadcast targets (x.y.z.255, /24 assumed) derived from the private IPv4
 * host candidates inside our own offer SDP. Covers hotspots/routers that are not on
 * 192.168.43.x and networks where 255.255.255.255 is not routed out of the right
 * interface. Pure function (unit-tested).
 */
export function deriveBroadcastAddresses(offerRaw: string): string[] {
  try {
    const decoded = decodeRoomPayload(offerRaw);
    const sdpText: string = decoded?.sdp?.sdp ?? '';
    return extractPrivateIPv4(sdpText).map(broadcastFor).slice(0, 2);
  } catch {
    return [];
  }
}

export type NearbyHostResult = {
  answerRaw: string;
  peerName: string;
  stop: () => void;
};

/**
 * Host: broadcast offer until a valid answer arrives.
 * `onReady` is called synchronously with a cancel() so callers can abort a pending
 * search (the returned promise then rejects with NearbyCancelledError).
 * `validateAnswer` lets the caller drop answers for another room.
 */
export function startNearbyHost(opts: {
  offerRaw: string;
  name: string;
  code: string;
  onStatus?: (s: string) => void;
  onReady?: (cancel: () => void) => void;
  validateAnswer?: (answerRaw: string) => boolean;
}): Promise<NearbyHostResult> {
  return new Promise((resolve, reject) => {
    let socket: NearbySocket | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const id = makeId();
    const hostName = safeName(opts.name);
    const chunks = splitPayload(id, 'offer', opts.offerRaw, {
      name: hostName,
      code: opts.code,
    });
    const derived = deriveBroadcastAddresses(opts.offerRaw);
    logInfo(
      'nearby',
      `host start code=${opts.code} name=${hostName} chunks=${chunks.length} targets=255.255.255.255,${derived.join(',') || '(none)'},192.168.43.255`
    );

    const stop = () => {
      if (timer) clearInterval(timer);
      if (timeout) clearTimeout(timeout);
      timer = null;
      timeout = null;
      try {
        socket?.close();
      } catch {
        /* */
      }
      socket = null;
    };

    const cancel = () => {
      if (done) return;
      done = true;
      stop();
      logInfo('nearby', 'host cancelled');
      reject(new NearbyCancelledError());
    };
    opts.onReady?.(cancel);

    /** Guests that probed us: reply with the offer by unicast (works when broadcast doesn't). */
    const guestAddrs = new Set<string>();

    const sendTo = (buf: string, addr: string) => {
      try {
        socket?.send(buf, 0, buf.length, PORT, addr);
      } catch {
        /* */
      }
    };

    try {
      socket = dgram.createSocket({ type: 'udp4' });
      socket.bind(PORT);
      (socket as any).on('listening', () => {
        if (done) return;
        try {
          socket?.setBroadcast?.(true);
        } catch {
          /* */
        }
        opts.onStatus?.('Broadcasting to nearby devices…');
        let tick = 0;
        timer = setInterval(() => {
          tick++;
          for (const c of chunks) {
            const buf = JSON.stringify(c);
            sendTo(buf, '255.255.255.255');
            for (const addr of derived) sendTo(buf, addr);
            for (const addr of guestAddrs) sendTo(buf, addr);
            if (tick % 3 === 0 && !derived.includes('192.168.43.255')) {
              sendTo(buf, '192.168.43.255');
            }
          }
          if (tick === 10) {
            opts.onStatus?.('Still waiting… Keep both screens on. Try QR if this fails.');
          }
        }, 500);

        timeout = setTimeout(() => {
          if (!done) {
            done = true;
            stop();
            logWarn('nearby', 'host timeout — no answer');
            reject(
              new Error(
                'No device joined. Same Wi‑Fi/hotspot required. Keep screens on, or use QR.'
              )
            );
          }
        }, 50000);
      });

      const answerParts = new Map<string, Map<number, string>>();
      const answerMeta = new Map<string, { n: number; name: string }>();
      const rejectedIds = new Set<string>();

      (socket as any).on('message', (msg: any, rinfo: any) => {
        if (done) return;
        try {
          const text = typeof msg === 'string' ? msg : msg.toString();
          const raw = JSON.parse(text) as ChunkMsg | ProbeMsg;
          if (raw.m !== MAGIC) return;

          if (raw.kind === 'probe') {
            const addr = rinfo?.address as string | undefined;
            if (addr && !guestAddrs.has(addr) && guestAddrs.size < 4) {
              guestAddrs.add(addr);
              logInfo('nearby', `host got probe → unicasting offer to ${addr}`);
              for (const c of chunks) sendTo(JSON.stringify(c), addr);
            }
            return;
          }

          const data = raw as ChunkMsg;
          if (data.kind !== 'answer' || !data.id) return;
          if (rejectedIds.has(data.id)) return;

          if (!answerParts.has(data.id)) answerParts.set(data.id, new Map());
          answerParts.get(data.id)!.set(data.i, data.p);

          if (data.n != null || data.name != null) {
            answerMeta.set(data.id, mergeAnswerMeta(answerMeta.get(data.id), data));
          }

          const meta = answerMeta.get(data.id);
          const parts = answerParts.get(data.id)!;
          if (!meta || !meta.n) return;
          const full = reassemble(parts, meta.n);
          if (!full) return;

          if (opts.validateAnswer && !opts.validateAnswer(full)) {
            rejectedIds.add(data.id);
            answerParts.delete(data.id);
            answerMeta.delete(data.id);
            logWarn('nearby', `host ignored answer from ${meta.name}: wrong room / invalid`);
            return;
          }

          done = true;
          stop();
          logInfo('nearby', `host got answer peer=${meta.name}`);
          resolve({
            answerRaw: full,
            peerName: meta.name,
            stop,
          });
        } catch {
          /* ignore bad packets */
        }
      });

      (socket as any).on('error', (e: any) => {
        if (!done) {
          done = true;
          stop();
          logError('nearby', `host socket error: ${e}`);
          reject(friendlySocketError(e));
        }
      });
    } catch (e) {
      done = true;
      stop();
      logError('nearby', `host setup error: ${e}`);
      reject(friendlySocketError(e));
    }
  });
}

export type NearbyGuestResult = {
  offerRaw: string;
  hostName: string;
  code: string;
  sendAnswer: (answerRaw: string, name: string) => void;
  stop: () => void;
};

/**
 * Guest: listen for offer broadcasts, then send answer (unicast + broadcast).
 * `onReady` receives a cancel() immediately (see startNearbyHost).
 */
export function startNearbyGuest(opts: {
  /** Shown to the host in probes (optional). */
  name?: string;
  onStatus?: (s: string) => void;
  onReady?: (cancel: () => void) => void;
}): Promise<NearbyGuestResult> {
  return new Promise((resolve, reject) => {
    let socket: NearbySocket | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let answerTimer: ReturnType<typeof setInterval> | null = null;
    let probeTimer: ReturnType<typeof setInterval> | null = null;
    let done = false;
    logInfo('nearby', 'guest listening');

    const stop = () => {
      if (timeout) clearTimeout(timeout);
      if (answerTimer) clearInterval(answerTimer);
      if (probeTimer) clearInterval(probeTimer);
      timeout = null;
      answerTimer = null;
      probeTimer = null;
      try {
        socket?.close();
      } catch {
        /* */
      }
      socket = null;
    };

    const cancel = () => {
      if (done) return;
      done = true;
      stop();
      logInfo('nearby', 'guest cancelled');
      reject(new NearbyCancelledError());
    };
    opts.onReady?.(cancel);

    try {
      socket = dgram.createSocket({ type: 'udp4' });
      socket.bind(PORT);
      (socket as any).on('listening', () => {
        // Needed so the 255.255.255.255 fallback in sendAnswer is allowed to send.
        try {
          socket?.setBroadcast?.(true);
        } catch {
          /* */
        }
        if (done) return;

        // A phone that hosts a hotspot does NOT push 255.255.255.255 out of its hotspot
        // interface, so the guest also actively probes: unicast to the likely gateway
        // (= the hotspot phone) and the subnet broadcast. The host answers by unicast.
        let targets: string[] = [...COMMON_GATEWAYS, '255.255.255.255'];
        const probe: ProbeMsg = {
          m: MAGIC,
          kind: 'probe',
          id: makeId(),
          name: safeName(opts.name),
        };
        const sendProbes = () => {
          const buf = JSON.stringify(probe);
          for (const addr of targets) {
            try {
              socket?.send(buf, 0, buf.length, PORT, addr);
            } catch {
              /* */
            }
          }
        };
        sendProbes();
        probeTimer = setInterval(sendProbes, 700);
        void getLocalPrivateIPv4s().then((ips) => {
          if (done || ips.length === 0) {
            logInfo('nearby', `guest probe targets unchanged (local IPv4 unknown)`);
            return;
          }
          const learned = ips.slice(0, 2).flatMap((ip) => [gatewayGuess(ip), broadcastFor(ip)]);
          targets = Array.from(new Set([...learned, ...targets]));
          logInfo('nearby', `guest probing ${targets.length} targets (own subnet learned: ${ips.length})`);
        });
      });
      opts.onStatus?.('Looking for nearby room…');

      timeout = setTimeout(() => {
        if (!done) {
          done = true;
          stop();
          logWarn('nearby', 'guest timeout — no offer');
          reject(
            new Error(
              'No room found. Same Wi‑Fi/hotspot required. Keep screens on, or use QR.'
            )
          );
        }
      }, 45000);

      const offerParts = new Map<string, Map<number, string>>();
      const offerMeta = new Map<
        string,
        { n: number; name: string; code: string; rinfo: { address: string } }
      >();

      (socket as any).on('message', (msg: any, rinfo: any) => {
        if (done) return;
        try {
          const text = typeof msg === 'string' ? msg : msg.toString();
          const data = JSON.parse(text) as ChunkMsg;
          if (data.m !== MAGIC || data.kind !== 'offer' || !data.id) return;

          if (!offerParts.has(data.id)) offerParts.set(data.id, new Map());
          offerParts.get(data.id)!.set(data.i, data.p);

          if (data.n != null || data.name != null || data.code != null) {
            offerMeta.set(
              data.id,
              mergeOfferMeta(offerMeta.get(data.id), data, {
                address: rinfo.address,
              })
            );
          }

          const meta = offerMeta.get(data.id);
          const parts = offerParts.get(data.id)!;
          if (!meta || !meta.n) return;
          const full = reassemble(parts, meta.n);
          if (!full) return;

          done = true;
          if (timeout) clearTimeout(timeout);
          timeout = null;
          if (probeTimer) clearInterval(probeTimer); // found a host — stop probing, keep socket for the answer
          probeTimer = null;
          const hostAddr = meta.rinfo.address;
          logInfo(
            'nearby',
            `guest found offer host=${meta.name} code=${meta.code} addr=${hostAddr}`
          );

          resolve({
            offerRaw: full,
            hostName: meta.name,
            code: meta.code,
            stop,
            sendAnswer: (answerRaw: string, name: string) => {
              const guestName = safeName(name);
              const aid = makeId();
              const chunks = splitPayload(aid, 'answer', answerRaw, { name: guestName });
              logInfo('nearby', `guest sendAnswer name=${guestName} chunks=${chunks.length}`);
              let rounds = 0;
              if (answerTimer) clearInterval(answerTimer);
              answerTimer = setInterval(() => {
                rounds++;
                for (const c of chunks) {
                  const buf = JSON.stringify(c);
                  try {
                    socket?.send(buf, 0, buf.length, PORT, hostAddr);
                  } catch {
                    /* */
                  }
                  try {
                    socket?.send(buf, 0, buf.length, PORT, '255.255.255.255');
                  } catch {
                    /* */
                  }
                }
                if (rounds >= 15) {
                  if (answerTimer) clearInterval(answerTimer);
                  answerTimer = null;
                  logInfo('nearby', 'guest answer repeats finished');
                }
              }, 250);
            },
          });
        } catch {
          /* */
        }
      });

      (socket as any).on('error', (e: any) => {
        if (!done) {
          done = true;
          stop();
          logError('nearby', `guest socket error: ${e}`);
          reject(friendlySocketError(e));
        }
      });
    } catch (e) {
      done = true;
      stop();
      logError('nearby', `guest setup error: ${e}`);
      reject(friendlySocketError(e));
    }
  });
}
