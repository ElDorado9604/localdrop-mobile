# LocalDrop Mobile

Peer-to-peer local file transfer app built with **Expo SDK 57 / React Native**.

Supports both **Online** and **Offline** modes.

## Current Status

| Feature                    | Status                          |
|---------------------------|---------------------------------|
| Online / Offline switcher | Done                            |
| File picker (Send)        | Done                            |
| Create / Join pairing     | Done (Socket.IO)                |
| Transfer progress UI      | Done (skeleton)                 |
| WebRTC data channel       | Code ready – needs dev build    |
| Offline local discovery   | Pending                         |

## Important: WebRTC requires a Development Build

`react-native-webrtc` does **not** work inside Expo Go.

To test real file transfer you must create a new Android APK:

```bash
npx eas-cli@latest build --platform android --profile preview
```

## Getting Started (Expo Go – pairing only)

```bash
git pull origin main
npm install --legacy-peer-deps
npx expo start --tunnel
```

## Backend URL

Set in `src/lib/config.ts` or via environment:

```
EXPO_PUBLIC_SOCKET_URL=https://your-backend.onrender.com
```

## Related

- Web + Backend: [localdrop](https://github.com/ElDorado9604/localdrop)
