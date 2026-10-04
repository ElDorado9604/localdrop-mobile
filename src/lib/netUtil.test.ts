import { describe, it, expect } from 'vitest';
import {
  summarizeCandidates,
  extractPrivateIPv4,
  broadcastFor,
  gatewayGuess,
  isPrivateIPv4,
} from './netUtil';

const CELL_ONLY =
  'a=candidate:1 1 udp 2122262783 2401:4900:1c2a:5b::7 41000 typ host\r\n' +
  'a=candidate:2 1 udp 2122262527 2401:4900:1c2a:5b::8 41001 typ host\r\n' +
  'a=candidate:3 1 udp 1686052607 100.72.4.9 41002 typ host\r\n';

const LAN =
  'a=candidate:1 1 udp 2122260223 192.168.43.1 54321 typ host\r\n' +
  'a=candidate:2 1 tcp 1518280447 192.168.43.1 9 typ host tcptype active\r\n';

describe('netUtil', () => {
  it('summarizes a cellular-only offer (the hotspot-owner case) as having no LAN IPv4', () => {
    const s = summarizeCandidates(CELL_ONLY);
    expect(s.hostIpv4Private).toBe(0);
    expect(s.hostIpv6).toBe(2);
    expect(s.hostIpv4Other).toBe(1); // 100.64/10 CGNAT is not RFC1918
  });
  it('summarizes a LAN offer and masks the last octet', () => {
    const s = summarizeCandidates(LAN);
    expect(s.hostIpv4Private).toBe(1);
    expect(s.tcp).toBe(1);
    expect(s.maskedPrivate).toEqual(['192.168.43.x']);
  });
  it('extracts, broadcasts and guesses gateways', () => {
    expect(extractPrivateIPv4(LAN)).toEqual(['192.168.43.1']);
    expect(broadcastFor('10.20.30.40')).toBe('10.20.30.255');
    expect(gatewayGuess('10.20.30.40')).toBe('10.20.30.1');
  });
  it('classifies private ranges', () => {
    expect(isPrivateIPv4('172.16.0.1')).toBe(true);
    expect(isPrivateIPv4('172.32.0.1')).toBe(false);
    expect(isPrivateIPv4('100.72.4.9')).toBe(false);
    expect(isPrivateIPv4('nope')).toBe(false);
  });
});
