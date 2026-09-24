/**
 * Active offline room session — survives navigation for send-more / bidirectional.
 */

import type { WebRTCSession } from './webrtcSession';

let session: WebRTCSession | null = null;
let peerName = 'peer';
let roomCode = '';
let isHost = false;

export function setOfflineSession(
  s: WebRTCSession,
  opts?: { peerName?: string; roomCode?: string; isHost?: boolean }
) {
  session = s;
  if (opts?.peerName) peerName = opts.peerName;
  if (opts?.roomCode) roomCode = opts.roomCode;
  if (typeof opts?.isHost === 'boolean') isHost = opts.isHost;
}

export function getOfflineSession(): WebRTCSession | null {
  return session;
}

export function getOfflinePeerName(): string {
  return peerName;
}

export function getOfflineRoomCode(): string {
  return roomCode;
}

export function getOfflineIsHost(): boolean {
  return isHost;
}

export function clearOfflineSession() {
  try {
    session?.close();
  } catch {
    /* */
  }
  session = null;
  peerName = 'peer';
  roomCode = '';
  isHost = false;
}

export function isOfflineSessionOpen(): boolean {
  return !!session?.isChannelOpen();
}
