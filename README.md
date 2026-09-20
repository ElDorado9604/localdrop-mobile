# LocalDrop Mobile

Peer-to-peer local file transfer app built with **Expo / React Native**.

Supports both **Online** and **Offline** modes.

## Features (planned)

- Online mode → uses the existing Socket.IO signaling backend (same as web version)
- Offline mode → local network discovery (no internet required)
- Multi-file queue with progress, speed & ETA
- QR code + 6-digit pairing
- Works great on low-RAM Android devices

## Architecture

| Mode     | Discovery / Pairing              | File Transfer      |
|----------|----------------------------------|--------------------|
| Online   | Socket.IO signaling server       | WebRTC DataChannel |
| Offline  | Local network (mDNS / NSD)       | WebRTC DataChannel |

The backend is **signaling only**. File bytes never touch the server.

## Getting Started

```bash
# Clone
git clone https://github.com/ElDorado9604/localdrop-mobile.git
cd localdrop-mobile

# Install
npm install

# Start
npx expo start
```

### Environment

Create a `.env` file (optional):

```
EXPO_PUBLIC_SOCKET_URL=https://your-render-backend.onrender.com
```

## Project Structure

```
app/                  # Expo Router screens
  index.tsx           # Home (mode selector)
  send.tsx            # Send files
  receive.tsx         # Receive files
  transfer.tsx        # Transfer progress
src/lib/
  socket.ts           # Socket.IO client (online mode)
  config.ts           # Shared config
```

## Related

- Web + Backend: [localdrop](https://github.com/ElDorado9604/localdrop)

## License

MIT
