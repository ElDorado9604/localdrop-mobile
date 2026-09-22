import { io, Socket } from 'socket.io-client';
import { CONFIG } from './config';

let socket: Socket | null = null;

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

export type CreateRoomResult =
  | { roomId: string; pairingCode: string; expiresAt: number }
  | { error: string };

export type JoinRoomResult =
  | { roomId: string; pairingCode: string; peerName: string }
  | { error: string };

export function createRoom(deviceName: string): Promise<CreateRoomResult> {
  return new Promise((resolve) => {
    const s = connectSocket();
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
