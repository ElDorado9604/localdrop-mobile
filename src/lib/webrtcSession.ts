/**
 * Manages a single WebRTC peer connection + data channel for LocalDrop.
 * Signaling is done externally (Socket.IO for online, or QR for offline).
 */

import {
  createPeerConnection,
  createDataChannel,
  RTCSessionDescription,
  RTCIceCandidate,
  isWebRTCAvailable,
} from './webrtc';
import { waitForIceComplete } from './offlineSignal';

type SignalHandler = (type: 'offer' | 'answer' | 'ice-candidate', payload: any) => void;

export class WebRTCSession {
  private pc: any = null;
  private channel: any = null;
  private pendingIce: any[] = [];
  private remoteSet = false;
  private completed = false;
  private onSignal: SignalHandler;
  private onOpen: (() => void) | null = null;
  private onMessage: ((data: ArrayBuffer | string) => void) | null = null;
  private onClose: (() => void) | null = null;
  private onFailed: ((reason: string) => void) | null = null;

  constructor(onSignal: SignalHandler = () => {}) {
    this.onSignal = onSignal;
  }

  setHandlers(h: {
    onOpen?: () => void;
    onMessage?: (data: ArrayBuffer | string) => void;
    onClose?: () => void;
    onFailed?: (reason: string) => void;
  }) {
    this.onOpen = h.onOpen ?? null;
    this.onMessage = h.onMessage ?? null;
    this.onClose = h.onClose ?? null;
    this.onFailed = h.onFailed ?? null;
    // Re-bind if channel already open
    if (this.channel) this.wireChannel(this.channel);
  }

  isAvailable() {
    return isWebRTCAvailable();
  }

  private wireChannel(channel: any) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => this.onOpen?.();
    channel.onclose = () => this.onClose?.();
    channel.onerror = () => {
      if (!this.completed) this.onFailed?.('Data channel error');
    };
    channel.onmessage = (event: any) => {
      this.onMessage?.(event.data);
    };

    if (channel.readyState === 'open') this.onOpen?.();
  }

  private ensurePc(asInitiator: boolean) {
    if (this.pc) return this.pc;

    this.pc = createPeerConnection(
      (candidate) => {
        this.onSignal('ice-candidate', candidate.toJSON ? candidate.toJSON() : candidate);
      },
      (state) => {
        if (state === 'failed' && !this.completed) {
          this.onFailed?.(
            'Could not establish a direct link. Put both devices on the same Wi-Fi and try again.'
          );
        }
      }
    );

    if (asInitiator) {
      const ch = createDataChannel(this.pc);
      this.wireChannel(ch);
    } else {
      this.pc.ondatachannel = (event: any) => this.wireChannel(event.channel);
    }

    return this.pc;
  }

  async createOffer() {
    const pc = this.ensurePc(true);
    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    this.onSignal('offer', offer);
    return offer;
  }

  /** Offline: create offer and wait for ICE so full SDP fits in one QR. */
  async createOfferForQr(): Promise<any> {
    const pc = this.ensurePc(true);
    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    await waitForIceComplete(pc);
    return pc.localDescription;
  }

  async handleOffer(sdp: any) {
    const pc = this.ensurePc(false);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    this.remoteSet = true;
    await this.flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.onSignal('answer', answer);
    return answer;
  }

  /** Offline: handle offer, wait for ICE, return answer SDP for QR. */
  async handleOfferForQr(sdp: any): Promise<any> {
    const pc = this.ensurePc(false);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    this.remoteSet = true;
    await this.flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceComplete(pc);
    return pc.localDescription;
  }

  async handleAnswer(sdp: any) {
    if (!this.pc) return;
    if (this.pc.signalingState === 'stable') return;
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    this.remoteSet = true;
    await this.flushIce();
  }

  async handleIce(candidate: any) {
    if (!candidate || (!candidate.candidate && !candidate.sdpMid && candidate.sdpMLineIndex == null)) {
      return;
    }
    if (!this.pc || !this.remoteSet) {
      this.pendingIce.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      /* ignore */
    }
  }

  private async flushIce() {
    for (const c of this.pendingIce) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(c));
      } catch {
        /* ignore */
      }
    }
    this.pendingIce = [];
  }

  getChannel() {
    return this.channel;
  }

  isChannelOpen() {
    return this.channel?.readyState === 'open';
  }

  sendJson(msg: object): boolean {
    const ch = this.channel;
    if (!ch || ch.readyState !== 'open') return false;
    ch.send(JSON.stringify(msg));
    return true;
  }

  async sendBinary(data: ArrayBuffer) {
    const ch = this.channel;
    if (!ch || ch.readyState !== 'open') throw new Error('Channel closed');
    while ((ch.bufferedAmount ?? 0) > 256 * 1024) {
      await new Promise((r) => setTimeout(r, 30));
    }
    ch.send(data);
  }

  markCompleted() {
    this.completed = true;
  }

  /** Offline: allow more transfers — clear completed flag but keep channel. */
  prepareForMore() {
    this.completed = false;
  }

  close() {
    this.completed = true;
    try {
      this.channel?.close();
    } catch {
      /* */
    }
    try {
      this.pc?.close();
    } catch {
      /* */
    }
    this.channel = null;
    this.pc = null;
    this.pendingIce = [];
    this.remoteSet = false;
  }
}
