import { io, Socket } from 'socket.io-client';
import { CONFIG } from './config';

let socket: Socket | null = null;

/** Signals received before the transfer screen mounts (common for Web→Mobile). */
type PendingSignal =
  | { type: 'offer'; sdp: any }
  | { type: 'answer'; sdp: any }
  | { type: 'ice-candidate'; candidate: any };

let pendingSignals: PendingSignal[] = [];
let buffering = false;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(CONFIG.SOCKET_URL, {
      autoConnect: false,
      transports: ['websocket'],
    });
  }
  return socket;
}

export function connectSocket(): Socket {
  const s = getSocket();
  if (!s.connected) s.connect();
  return s;
}

export function disconnectSocket() {
  if (socket?.connected) socket.disconnect();
}

/**
 * Start capturing offer/answer/ICE into a buffer BEFORE joining a room.
 * Web sender creates an offer ~400ms after peer-joined; if transfer UI
 * is not listening yet, those events are lost without this buffer.
 */
export function startSignalBuffer() {
  if (buffering) return;
  buffering = true;
  pendingSignals = [];
  const s = connectSocket();

  const onOffer = (p: { sdp: any }) => {
    pendingSignals.push({ type: 'offer', sdp: p.sdp });
  };
  const onAnswer = (p: { sdp: any }) => {
    pendingSignals.push({ type: 'answer', sdp: p.sdp });
  };
  const onIce = (p: { candidate: any }) => {
    pendingSignals.push({ type: 'ice-candidate', candidate: p.candidate });
  };

  // Remove any previous buffer listeners then attach
  s.off('signal:offer');
  s.off('signal:answer');
  s.off('signal:ice-candidate');
  s.on('signal:offer', onOffer);
  s.on('signal:answer', onAnswer);
  s.on('signal:ice-candidate', onIce);
}

/** Drain buffered signals (call once when transfer screen is ready). */
export function takePendingSignals(): PendingSignal[] {
  const out = pendingSignals.slice();
  pendingSignals = [];
  return out;
}

export function stopSignalBuffer() {
  buffering = false;
  // Do not remove listeners here — transfer screen will re-bind its own
}

export type CreateRoomResult =
  | { roomId: string; pairingCode: string; expiresAt: number }
  | { error: string };

export type JoinRoomResult =
  | { roomId: string; pairingCode: string; peerName: string }
  | { error: string };

export function createRoom(deviceName: string): Promise<CreateRoomResult> {
  return new Promise((resolve) => {
    const s = connectSocket();
    startSignalBuffer(); // sender also benefits if peer signals early
    const timer = setTimeout(() => resolve({ error: 'Connection timeout' }), 15000);
    s.emit('room:create', { deviceName }, (res: CreateRoomResult) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

export function joinRoom(pairingCode: string, deviceName: string): Promise<JoinRoomResult> {
  return new Promise((resolve) => {
    const s = connectSocket();
    // CRITICAL: listen for offer before join completes — web fires offer ~400ms after peer-joined
    startSignalBuffer();
    const timer = setTimeout(() => resolve({ error: 'Connection timeout' }), 15000);
    s.emit('room:join', { pairingCode, deviceName }, (res: JoinRoomResult) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

export function cancelRoom() {
  const s = getSocket();
  if (s.connected) s.emit('room:cancel');
}

export function sendSignal(
  type: 'offer' | 'answer' | 'ice-candidate',
  payload: { sdp?: any; candidate?: any }
) {
  const s = getSocket();
  if (!s.connected) return;
  if (type === 'offer') s.emit('signal:offer', { sdp: payload.sdp });
  else if (type === 'answer') s.emit('signal:answer', { sdp: payload.sdp });
  else s.emit('signal:ice-candidate', { candidate: payload.candidate });
}

export function emitTransferStarted() {
  const s = getSocket();
  if (s.connected) s.emit('transfer:started');
}

export function emitRoomComplete() {
  const s = getSocket();
  if (s.connected) s.emit('room:complete');
}
