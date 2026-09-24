/**
 * Offline room signaling via QR / shared payload (no internet server).
 * SDP is base64; room includes passcode + device name.
 */

export type OfflineRoomOffer = {
  v: 2;
  t: 'offer';
  code: string;
  name: string;
  s: string;
};

export type OfflineRoomAnswer = {
  v: 2;
  t: 'answer';
  code: string;
  name: string;
  s: string;
};

export type OfflineRoomPayload = OfflineRoomOffer | OfflineRoomAnswer;

function btoaUtf8(str: string): string {
  try {
    return btoa(str);
  } catch {
    return btoa(unescape(encodeURIComponent(str)));
  }
}

function atobUtf8(b64: string): string {
  try {
    return atob(b64);
  } catch {
    return decodeURIComponent(escape(atob(b64)));
  }
}

export function generateRoomCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function encodeRoomOffer(opts: {
  code: string;
  name: string;
  sdp: object;
}): string {
  const payload: OfflineRoomOffer = {
    v: 2,
    t: 'offer',
    code: opts.code,
    name: opts.name,
    s: btoaUtf8(JSON.stringify(opts.sdp)),
  };
  return JSON.stringify(payload);
}

export function encodeRoomAnswer(opts: {
  code: string;
  name: string;
  sdp: object;
}): string {
  const payload: OfflineRoomAnswer = {
    v: 2,
    t: 'answer',
    code: opts.code,
    name: opts.name,
    s: btoaUtf8(JSON.stringify(opts.sdp)),
  };
  return JSON.stringify(payload);
}

export function decodeRoomPayload(raw: string): {
  type: 'offer' | 'answer';
  code: string;
  name: string;
  sdp: any;
} | null {
  try {
    const text = raw.trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < 0) return null;
    const obj = JSON.parse(text.slice(start, end + 1)) as any;

    // v2 room format
    if (obj.v === 2 && (obj.t === 'offer' || obj.t === 'answer') && obj.s) {
      return {
        type: obj.t,
        code: String(obj.code || ''),
        name: String(obj.name || 'Device'),
        sdp: JSON.parse(atobUtf8(obj.s)),
      };
    }

    // legacy v1
    if (obj.v === 1 && (obj.t === 'offer' || obj.t === 'answer') && obj.s) {
      return {
        type: obj.t,
        code: '',
        name: 'Device',
        sdp: JSON.parse(atobUtf8(obj.s)),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** @deprecated use encodeRoomOffer / encodeRoomAnswer */
export function encodeSignal(type: 'offer' | 'answer', sdp: object): string {
  if (type === 'offer') {
    return encodeRoomOffer({ code: '', name: 'Device', sdp });
  }
  return encodeRoomAnswer({ code: '', name: 'Device', sdp });
}

/** @deprecated use decodeRoomPayload */
export function decodeSignal(raw: string): { type: 'offer' | 'answer'; sdp: any } | null {
  const d = decodeRoomPayload(raw);
  if (!d) return null;
  return { type: d.type, sdp: d.sdp };
}

export function waitForIceComplete(pc: any, timeoutMs = 8000): Promise<void> {
  if (!pc) return Promise.resolve();
  if (pc.iceGatheringState === 'complete') return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      try {
        pc.removeEventListener?.('icegatheringstatechange', onChange);
      } catch {
        /* */
      }
      // @ts-expect-error RN
      pc.onicegatheringstatechange = null;
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    // @ts-expect-error RN
    pc.onicegatheringstatechange = onChange;
    setTimeout(done, timeoutMs);
  });
}
