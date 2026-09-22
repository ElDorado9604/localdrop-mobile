/**
 * LocalDrop WebRTC helpers for React Native.
 * Requires react-native-webrtc (development build only — does not work in Expo Go).
 */

import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  mediaDevices,
} from 'react-native-webrtc';

export const CHUNK_SIZE = 64 * 1024;
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

  // @ts-ignore - react-native-webrtc event style
  pc.onicecandidate = (event: any) => {
    if (event.candidate) {
      onIceCandidate(event.candidate);
    }
  };

  // @ts-ignore
  pc.onconnectionstatechange = () => {
    onConnectionStateChange(pc.connectionState);
  };

  return pc;
}

export function createDataChannel(pc: any): any {
  const channel = pc.createDataChannel('localdrop', { ordered: true });
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = BUFFERED_LOW_THRESHOLD;
  return channel;
}

export function waitForBuffer(channel: any): Promise<void> {
  if (channel.bufferedAmount <= BUFFERED_LOW_THRESHOLD) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const check = () => {
      if (channel.bufferedAmount <= BUFFERED_LOW_THRESHOLD) {
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

export { RTCPeerConnection, RTCIceCandidate, RTCSessionDescription, mediaDevices };
