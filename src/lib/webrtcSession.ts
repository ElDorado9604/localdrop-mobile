/**
 * Manages a single WebRTC peer connection + data channel for LocalDrop.
 * Signaling is done externally (Socket.IO for online, or QR/nearby for offline).
 */

import {
  createPeerConnection,
  OFFLINE_ICE_CONFIG,
  LOCAL_ICE_CONFIG,
  createDataChannel,
  RTCSessionDescription,
  RTCIceCandidate,
  isWebRTCAvailable,
} from './webrtc';
import { waitForIceComplete } from './offlineSignal';
import { logError, logInfo, logVerbose, logWarn } from './logger';

type SignalHandler = (type: 'offer' | 'answer' | 'ice-candidate', payload: any) => void;

const BUFFER_HIGH = 1024 * 1024; // 1 MB
const BUFFER_LOW = 256 * 1024;

export class WebRTCSession {
  private pc: any = null;
  private channel: any = null;
  private pendingIce: any[] = [];
  private remoteSet = false;
  private completed = false;
  private closedNotified = false;
  private onSignal: SignalHandler;
  private offline: boolean;
  private onOpen: (() => void) | null = null;
  private onMessage: ((data: ArrayBuffer | string) => void) | null = null;
  private onClose: (() => void) | null = null;
  private onFailed: ((reason: string) => void) | null = null;

  /** `offline: true` → no STUN servers (LAN-only rooms: QR / Connect nearby). */
  constructor(onSignal: SignalHandler = () => {}, opts?: { offline?: boolean }) {
    this.onSignal = onSignal;
    this.offline = !!opts?.offline;
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
    if (this.channel) this.wireChannel(this.channel);
  }

  isAvailable() {
    return isWebRTCAvailable();
  }

  private notifyClosed() {
    if (this.closedNotified) return;
    this.closedNotified = true;
    logInfo('webrtc', 'channel/pc closed');
    this.onClose?.();
  }

  private notifyFailed(reason: string) {
    if (this.completed || this.closedNotified) return;
    this.closedNotified = true;
    logError('webrtc', `failed: ${reason}`);
    this.onFailed?.(reason);
  }

  private wireChannel(channel: any) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      logInfo('webrtc', 'data channel open');
      this.onOpen?.();
    };
    channel.onclose = () => this.notifyClosed();
    channel.onerror = () => {
      this.notifyFailed('Data channel error');
    };
    channel.onmessage = (event: any) => {
      this.onMessage?.(event.data);
    };

    if (channel.readyState === 'open') {
      logInfo('webrtc', 'data channel already open');
      this.onOpen?.();
    }
  }

  private ensurePc(asInitiator: boolean) {
    if (this.pc) return this.pc;

    logInfo('webrtc', `pc create initiator=${asInitiator} offline=${this.offline}`);
    this.pc = createPeerConnection(
      (candidate) => {
        this.onSignal('ice-candidate', candidate.toJSON ? candidate.toJSON() : candidate);
      },
      (state) => {
        logVerbose('webrtc', `iceConnectionState=${state}`);
        if (state === 'failed') {
          this.notifyFailed(
            'Could not establish a direct link. Put both devices on the same Wi-Fi and try again.'
          );
        } else if (state === 'disconnected' || state === 'closed') {
          this.notifyClosed();
        } else if (state === 'connected' || state === 'completed') {
          logInfo('webrtc', `ice ${state}`);
        }
      },
      this.offline ? OFFLINE_ICE_CONFIG : LOCAL_ICE_CONFIG
    );

    try {
      this.pc.addEventListener?.('connectionstatechange', () => {
        const st = this.pc?.connectionState;
        logVerbose('webrtc', `connectionState=${st}`);
        if (st === 'failed') {
          this.notifyFailed('Connection failed. Reconnect both devices.');
        } else if (st === 'disconnected' || st === 'closed') {
          this.notifyClosed();
        } else if (st === 'connected') {
          logInfo('webrtc', 'connectionState=connected');
        }
      });
    } catch {
      /* */
    }

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
    logInfo('webrtc', 'offer created (online)');
    this.onSignal('offer', offer);
    return offer;
  }

  async createOfferForQr(): Promise<any> {
    const pc = this.ensurePc(true);
    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    logInfo('webrtc', 'offer local set, waiting ICE for QR');
    await waitForIceComplete(pc);
    logInfo('webrtc', 'offer ICE complete for QR');
    return pc.localDescription;
  }

  async handleOffer(sdp: any) {
    const pc = this.ensurePc(false);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    this.remoteSet = true;
    await this.flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    logInfo('webrtc', 'answer created (online)');
    this.onSignal('answer', answer);
    return answer;
  }

  async handleOfferForQr(sdp: any): Promise<any> {
    const pc = this.ensurePc(false);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    this.remoteSet = true;
    await this.flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    logInfo('webrtc', 'answer local set, waiting ICE for QR');
    await waitForIceComplete(pc);
    logInfo('webrtc', 'answer ICE complete for QR');
    return pc.localDescription;
  }

  async handleAnswer(sdp: any) {
    if (!this.pc) return;
    if (this.pc.signalingState === 'stable') {
      logWarn('webrtc', 'handleAnswer skipped (already stable)');
      return;
    }
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    this.remoteSet = true;
    logInfo('webrtc', 'remote answer set');
    await this.flushIce();
  }

  async handleIce(candidate: any) {
    if (
      !candidate ||
      (!candidate.candidate && !candidate.sdpMid && candidate.sdpMLineIndex == null)
    ) {
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
    const n = this.pendingIce.length;
    if (n) logVerbose('webrtc', `flush ${n} pending ICE`);
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
    try {
      ch.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  async sendBinary(data: ArrayBuffer) {
    const ch = this.channel;
    if (!ch || ch.readyState !== 'open') throw new Error('Channel closed');

    while ((ch.bufferedAmount ?? 0) > BUFFER_HIGH) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          try {
            ch.removeEventListener?.('bufferedamountlow', done);
          } catch {
            /* */
          }
          resolve();
        };
        try {
          ch.bufferedAmountLowThreshold = BUFFER_LOW;
          ch.addEventListener?.('bufferedamountlow', done);
        } catch {
          /* */
        }
        setTimeout(done, 20);
      });
      if (ch.readyState !== 'open') throw new Error('Channel closed');
    }
    ch.send(data);
  }

  markCompleted() {
    this.completed = true;
  }

  prepareForMore() {
    this.completed = false;
    this.closedNotified = false;
    logVerbose('webrtc', 'prepareForMore');
  }

  close() {
    this.completed = true;
    logInfo('webrtc', 'session close()');
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
