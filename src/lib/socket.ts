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
  if (!s.connected) {
    s.connect();
  }
  return s;
}

export function disconnectSocket() {
  if (socket?.connected) {
    socket.disconnect();
  }
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
    s.emit('room:create', { deviceName }, (res: CreateRoomResult) => {
      resolve(res);
    });
  });
}

export function joinRoom(pairingCode: string, deviceName: string): Promise<JoinRoomResult> {
  return new Promise((resolve) => {
    const s = connectSocket();
    s.emit('room:join', { pairingCode, deviceName }, (res: JoinRoomResult) => {
      resolve(res);
    });
  });
}

export function cancelRoom() {
  const s = getSocket();
  if (s.connected) {
    s.emit('room:cancel');
  }
}
