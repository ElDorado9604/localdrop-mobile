/** Pure networking helpers (no React Native imports → unit-testable). */

export type CandidateSummary = {
  hostIpv4Private: number;
  hostIpv4Other: number;
  hostIpv6: number;
  srflx: number;
  relay: number;
  tcp: number;
  /** Private IPv4 addresses with the last octet masked, e.g. 192.168.43.x (safe to log). */
  maskedPrivate: string[];
};

const CAND_RE =
  /^a=candidate:\S+\s+\d+\s+(udp|tcp)\s+\d+\s+(\S+)\s+\d+\s+typ\s+(host|srflx|prflx|relay)/gim;

export function isPrivateIPv4(ip: string): boolean {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !(n >= 0 && n <= 255))) return false;
  return (
    o[0] === 10 ||
    (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
    (o[0] === 192 && o[1] === 168)
  );
}

export function summarizeCandidates(sdpText: string): CandidateSummary {
  const out: CandidateSummary = {
    hostIpv4Private: 0,
    hostIpv4Other: 0,
    hostIpv6: 0,
    srflx: 0,
    relay: 0,
    tcp: 0,
    maskedPrivate: [],
  };
  let m: RegExpExecArray | null;
  CAND_RE.lastIndex = 0;
  while ((m = CAND_RE.exec(sdpText || ''))) {
    const [, proto, addr, typ] = m;
    if (proto.toLowerCase() === 'tcp') out.tcp++;
    if (typ === 'srflx' || typ === 'prflx') out.srflx++;
    else if (typ === 'relay') out.relay++;
    else if (proto.toLowerCase() === 'udp') {
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) {
        if (isPrivateIPv4(addr)) {
          out.hostIpv4Private++;
          const masked = addr.split('.').slice(0, 3).join('.') + '.x';
          if (!out.maskedPrivate.includes(masked)) out.maskedPrivate.push(masked);
        } else out.hostIpv4Other++;
      } else if (addr.includes(':')) out.hostIpv6++;
    }
  }
  return out;
}

/** Private IPv4 UDP host-candidate addresses found in SDP text (deduped, in order). */
export function extractPrivateIPv4(sdpText: string): string[] {
  const out: string[] = [];
  const re = /^a=candidate:\S+\s+\d+\s+udp\s+\d+\s+(\d{1,3}(?:\.\d{1,3}){3})\s+\d+\s+typ\s+host/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sdpText || ''))) {
    if (isPrivateIPv4(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** /24 directed-broadcast address for an IPv4 address. */
export function broadcastFor(ip: string): string {
  const o = ip.split('.');
  return `${o[0]}.${o[1]}.${o[2]}.255`;
}

/** Android/iOS hotspots (and most routers) use .1 as the gateway on a /24. */
export function gatewayGuess(ip: string): string {
  const o = ip.split('.');
  return `${o[0]}.${o[1]}.${o[2]}.1`;
}

/** Gateway addresses of common hotspots/routers, probed when our own IP is unknown. */
export const COMMON_GATEWAYS = [
  '192.168.43.1', // Android hotspot (classic)
  '192.168.49.1', // Wi‑Fi Direct group owner
  '172.20.10.1', // iPhone hotspot
  '192.168.0.1',
  '192.168.1.1',
  '10.0.0.1',
];
