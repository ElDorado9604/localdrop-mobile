/**
 * Learns this phone's private IPv4 address(es) without extra native modules: a throw-away
 * LAN-only RTCPeerConnection gathers host candidates, which we read back from its SDP.
 */
import { createPeerConnection, createDataChannel, OFFLINE_ICE_CONFIG } from './webrtc';
import { extractPrivateIPv4 } from './netUtil';
import { logVerbose, logWarn } from './logger';

export async function getLocalPrivateIPv4s(timeoutMs = 1500): Promise<string[]> {
  let pc: any = null;
  try {
    pc = createPeerConnection(() => {}, () => {}, OFFLINE_ICE_CONFIG);
    createDataChannel(pc);
    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(t);
          resolve();
        }
      };
      pc.onicegatheringstatechange = check;
      check();
    });
    const ips = extractPrivateIPv4(pc.localDescription?.sdp ?? '');
    logVerbose('nearby', `local private IPv4 count=${ips.length}`);
    return ips;
  } catch (e) {
    logWarn('nearby', `could not read local IPv4: ${e instanceof Error ? e.message : e}`);
    return [];
  } finally {
    try {
      pc?.close();
    } catch {
      /* */
    }
  }
}
