export const CONFIG = {
  // Online mode – same backend as the web app
  SOCKET_URL: process.env.EXPO_PUBLIC_SOCKET_URL || 'http://localhost:3001',

  // Chunk size for WebRTC data channel (same as web version)
  CHUNK_SIZE: 64 * 1024, // 64 KB

  // Room expiry (matches backend)
  ROOM_EXPIRY_MS: 5 * 60 * 1000, // 5 minutes
};
