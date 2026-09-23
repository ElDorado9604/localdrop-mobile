export const CONFIG = {
  // Online mode – same backend as the web app
  SOCKET_URL: process.env.EXPO_PUBLIC_SOCKET_URL || 'https://localdrop-api.onrender.com',

  // Web frontend (used for QR join links)
  WEB_APP_URL: process.env.EXPO_PUBLIC_WEB_APP_URL || 'https://localdrop-zeta.vercel.app',

  CHUNK_SIZE: 64 * 1024,
  ROOM_EXPIRY_MS: 5 * 60 * 1000,
};

/** Same format as web buildJoinUrl — opens /receive?code=XXXXXX */
export function buildJoinUrl(code: string): string {
  const normalized = String(code).replace(/\D/g, '').slice(0, 6);
  return `${CONFIG.WEB_APP_URL}/receive?code=${encodeURIComponent(normalized)}`;
}
