/**
 * Holds the active offline WebRTC session so it survives navigation
 * and supports send-more + bidirectional transfer without re-pairing.
 */

import type { WebRTCSession } from './webrtcSession';

let session: WebRTCSession | null = null;
let peerName = 'peer';

export function setOfflineSession(s: WebRTCSession, name?: string) {
  session = s;
  if (name) peerName = name;
}

export function getOfflineSession(): WebRTCSession | null {
  return session;
}

export function getOfflinePeerName(): string {
  return peerName;
}

export function clearOfflineSession() {
  try {
    session?.close();
  } catch {
    /* */
  }
  session = null;
  peerName = 'peer';
}

export function isOfflineSessionOpen(): boolean {
  return !!session?.isChannelOpen();
}
