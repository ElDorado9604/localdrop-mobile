/**
 * Offline WebRTC signaling via QR codes (no server).
 * Payload is compact JSON; SDP is base64-encoded.
 */

export type OfflineSignal = {
  v: 1;
  t: 'offer' | 'answer';
  s: string; // base64 of SDP json string
};

function btoaUtf8(str: string): string {
  // RN has global btoa for binary strings; SDP is ASCII-safe
  try {
    return btoa(str);
  } catch {
    const bytes = unescape(encodeURIComponent(str));
    return btoa(bytes);
  }
}

function atobUtf8(b64: string): string {
  try {
    return atob(b64);
  } catch {
    return decodeURIComponent(escape(atob(b64)));
  }
}

export function encodeSignal(type: 'offer' | 'answer', sdp: object): string {
  const payload: OfflineSignal = {
    v: 1,
    t: type,
    s: btoaUtf8(JSON.stringify(sdp)),
  };
  return JSON.stringify(payload);
}

export function decodeSignal(raw: string): { type: 'offer' | 'answer'; sdp: any } | null {
  try {
    const text = raw.trim();
    // Allow prefix noise from some scanners
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < 0) return null;
    const obj = JSON.parse(text.slice(start, end + 1)) as OfflineSignal;
    if (obj.v !== 1 || (obj.t !== 'offer' && obj.t !== 'answer') || !obj.s) return null;
    const sdp = JSON.parse(atobUtf8(obj.s));
    return { type: obj.t, sdp };
  } catch {
    return null;
  }
}

/** Wait until ICE gathering is complete (or timeout) so SDP can be put in one QR. */
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
