/**
 * Connect nearby — automatic WebRTC signaling on the same Wi‑Fi / hotspot.
 * Uses UDP. Prefers unicast after first contact for better hotspot support.
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
    let done = false;
    const id = makeId();
    const hostName = safeName(opts.name);
    const chunks = splitPayload(id, 'offer', opts.offerRaw, {
      name: hostName,
      code: opts.code,
    });

    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
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
        timer = setInterval(() => {
          for (const c of chunks) {
            const buf = JSON.stringify(c);
            try {
              socket?.send(buf, 0, buf.length, PORT, '255.255.255.255');
            } catch {
              /* */
            }
          }
        }, 700);
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
          if (data.n != null) {
            answerMeta.set(data.id, {
              n: data.n,
              name: safeName(data.name),
            });
          }
          const meta = answerMeta.get(data.id);
          const parts = answerParts.get(data.id)!;
          if (!meta) return;
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
    let done = false;

    const stop = () => {
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
          if (data.n != null) {
            offerMeta.set(data.id, {
              n: data.n,
              name: safeName(data.name),
              code: data.code || '',
              rinfo: { address: rinfo.address },
            });
          }
          const meta = offerMeta.get(data.id);
          const parts = offerParts.get(data.id)!;
          if (!meta) return;
          const full = reassemble(parts, meta.n);
          if (!full) return;

          done = true;
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
                    // Prefer unicast to host (works better on hotspot)
                    socket?.send(buf, 0, buf.length, PORT, hostAddr);
                    // Also broadcast as fallback
                    socket?.send(buf, 0, buf.length, PORT, '255.255.255.255');
                  } catch {
                    /* */
                  }
                }
                if (rounds >= 10) clearInterval(t);
              }, 350);
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
