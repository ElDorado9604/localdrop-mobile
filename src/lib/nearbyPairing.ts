/**
 * Connect nearby — UDP signaling on same Wi‑Fi / hotspot.
 * Simple reliable strategy: broadcast offers on 255.255.255.255;
 * guest replies with unicast (+ broadcast fallback).
 * Avoid flooding many directed addresses (that broke same-WiFi discovery).
 */
import dgram from 'react-native-udp';
import type { Socket } from 'react-native-udp';

const PORT = 47831;
const MAGIC = 'LDN1';
const CHUNK = 700;

type ChunkMsg = {
  m: typeof MAGIC;
  id: string;
  kind: 'offer' | 'answer';
  i: number;
  n: number;
  p: string;
  name?: string;
  code?: string;
};

function splitPayload(
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

function reassemble(buf: Map<number, string>, n: number): string | null {
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

/**
 * Merge chunk meta without wiping a real name/code when later chunks
 * (which omit name/code) arrive out of order.
 */
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
  const code = hasCode ? data.code : prev?.code ?? '';
  // Prefer the first address we saw; unicast answer back to host
  const addr = prev?.rinfo?.address || rinfo.address;
  return { n, name, code, rinfo: { address: addr } };
}

export type NearbyHostResult = {
  answerRaw: string;
  peerName: string;
  stop: () => void;
};

/** Host: broadcast offer until an answer arrives. */
export function startNearbyHost(opts: {
  offerRaw: string;
  name: string;
  code: string;
  onStatus?: (s: string) => void;
}): Promise<NearbyHostResult> {
  return new Promise((resolve, reject) => {
    let socket: Socket | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const id = makeId();
    const hostName = safeName(opts.name);
    const chunks = splitPayload(id, 'offer', opts.offerRaw, {
      name: hostName,
      code: opts.code,
    });

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

    try {
      socket = dgram.createSocket({ type: 'udp4' });
      socket.bind(PORT);
      socket.on('listening', () => {
        try {
          // @ts-expect-error RN udp
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
            try {
              // Primary: global broadcast (works on most same-WiFi LANs)
              socket?.send(buf, 0, buf.length, PORT, '255.255.255.255');
            } catch {
              /* */
            }
            // Light hotspot help: try Android soft-AP subnet occasionally
            if (tick % 3 === 0) {
              try {
                socket?.send(buf, 0, buf.length, PORT, '192.168.43.255');
              } catch {
                /* */
              }
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

      socket.on('message', (msg) => {
        if (done) return;
        try {
          const text = typeof msg === 'string' ? msg : msg.toString();
          const data = JSON.parse(text) as ChunkMsg;
          if (data.m !== MAGIC || data.kind !== 'answer' || !data.id) return;

          if (!answerParts.has(data.id)) answerParts.set(data.id, new Map());
          answerParts.get(data.id)!.set(data.i, data.p);

          // Merge meta: name only on chunk 0 — never overwrite a real name with "Device"
          if (data.n != null || data.name != null) {
            answerMeta.set(data.id, mergeAnswerMeta(answerMeta.get(data.id), data));
          }

          const meta = answerMeta.get(data.id);
          const parts = answerParts.get(data.id)!;
          if (!meta || !meta.n) return;
          const full = reassemble(parts, meta.n);
          if (!full) return;

          done = true;
          stop();
          resolve({
            answerRaw: full,
            peerName: meta.name,
            stop,
          });
        } catch {
          /* ignore bad packets */
        }
      });

      socket.on('error', (e) => {
        if (!done) {
          done = true;
          stop();
          reject(e);
        }
      });
    } catch (e) {
      stop();
      reject(e);
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

/** Guest: listen for offer broadcasts, then send answer (unicast preferred). */
export function startNearbyGuest(opts: {
  onStatus?: (s: string) => void;
}): Promise<NearbyGuestResult> {
  return new Promise((resolve, reject) => {
    let socket: Socket | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let done = false;

    const stop = () => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      try {
        socket?.close();
      } catch {
        /* */
      }
      socket = null;
    };

    try {
      socket = dgram.createSocket({ type: 'udp4' });
      socket.bind(PORT);
      opts.onStatus?.('Looking for nearby room…');

      timeout = setTimeout(() => {
        if (!done) {
          done = true;
          stop();
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

      socket.on('message', (msg, rinfo) => {
        if (done) return;
        try {
          const text = typeof msg === 'string' ? msg : msg.toString();
          const data = JSON.parse(text) as ChunkMsg;
          if (data.m !== MAGIC || data.kind !== 'offer' || !data.id) return;

          if (!offerParts.has(data.id)) offerParts.set(data.id, new Map());
          offerParts.get(data.id)!.set(data.i, data.p);

          // Merge meta: name/code only on chunk 0 — never wipe with defaults
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
          const hostAddr = meta.rinfo.address;

          resolve({
            offerRaw: full,
            hostName: meta.name,
            code: meta.code,
            stop,
            sendAnswer: (answerRaw: string, name: string) => {
              const guestName = safeName(name);
              const aid = makeId();
              const chunks = splitPayload(aid, 'answer', answerRaw, { name: guestName });
              let rounds = 0;
              const t = setInterval(() => {
                rounds++;
                for (const c of chunks) {
                  const buf = JSON.stringify(c);
                  try {
                    // Unicast to host first (critical for hotspot)
                    socket?.send(buf, 0, buf.length, PORT, hostAddr);
                    // Broadcast fallback
                    socket?.send(buf, 0, buf.length, PORT, '255.255.255.255');
                  } catch {
                    /* */
                  }
                }
                if (rounds >= 15) clearInterval(t);
              }, 250);
            },
          });
        } catch {
          /* */
        }
      });

      socket.on('error', (e) => {
        if (!done) {
          done = true;
          stop();
          reject(e);
        }
      });
    } catch (e) {
      stop();
      reject(e);
    }
  });
}
