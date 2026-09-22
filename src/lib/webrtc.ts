/**
 * WebRTC helpers for React Native (react-native-webrtc).
 * Works only in development / production builds — NOT in Expo Go.
 */

import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
} from 'react-native-webrtc';
import { CHUNK_SIZE } from './transferProtocol';

export { CHUNK_SIZE };
export const BUFFERED_LOW_THRESHOLD = 256 * 1024;

export const LOCAL_ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 2,
};

export function createPeerConnection(
  onIceCandidate: (candidate: any) => void,
  onConnectionStateChange: (state: string) => void
): any {
  const pc = new RTCPeerConnection(LOCAL_ICE_CONFIG);

  // @ts-expect-error RN event style
  pc.onicecandidate = (event: any) => {
    if (event.candidate) onIceCandidate(event.candidate);
  };

  // @ts-expect-error
  pc.onconnectionstatechange = () => {
    onConnectionStateChange(pc.connectionState);
  };

  return pc;
}

export function createDataChannel(pc: any): any {
  const channel = pc.createDataChannel('localdrop', { ordered: true });
  channel.binaryType = 'arraybuffer';
  try {
    channel.bufferedAmountLowThreshold = BUFFERED_LOW_THRESHOLD;
  } catch {
    /* older RN webrtc */
  }
  return channel;
}

export function waitForBuffer(channel: any): Promise<void> {
  if (!channel) return Promise.resolve();
  if ((channel.bufferedAmount ?? 0) <= BUFFERED_LOW_THRESHOLD) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if ((channel.bufferedAmount ?? 0) <= BUFFERED_LOW_THRESHOLD) {
        clearInterval(t);
        resolve();
      }
    }, 40);
  });
}

export { RTCPeerConnection, RTCIceCandidate, RTCSessionDescription };

export function isWebRTCAvailable(): boolean {
  try {
    return typeof RTCPeerConnection !== 'undefined';
  } catch {
    return false;
  }
}
