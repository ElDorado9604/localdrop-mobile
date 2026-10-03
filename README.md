# LocalDrop Mobile

Peer-to-peer local file transfer app built with **Expo SDK 57 / React Native**.

Supports both **Online** (Socket.IO signaling) and **Offline** modes.

Related web + backend repo: [localdrop](https://github.com/ElDorado9604/localdrop)

---

## Current Status

| Feature                    | Status                       |
|---------------------------|------------------------------|
| Online / Offline switcher | Done                         |
| File picker (Send)        | Done                         |
| Create / Join pairing     | Done (Socket.IO)             |
| Transfer progress UI      | Done                         |
| WebRTC data channel       | Done – needs dev build       |
| Offline pairing (QR / Connect nearby over UDP) | Done    |
| Diagnostics log (Settings)| Done                         |

---

## 1. First-time Setup

```bash
# Clone the repo
git clone https://github.com/ElDorado9604/localdrop-mobile.git
cd localdrop-mobile

# Install dependencies
npm install --legacy-peer-deps

# (Optional) Install ngrok helper for tunnel mode
npm install @expo/ngrok --save-dev --legacy-peer-deps
```

---

## 2. Login to Expo / EAS

```bash
# Login to your Expo account (opens browser)
npx eas-cli@latest login

# Check who you are logged in as
npx eas-cli@latest whoami
```

---

## 3. Run the app in Expo Go (development)

### Option A – Tunnel mode (recommended on ChromeOS / Crostini)

```bash
npx expo start --tunnel
```

Scan the QR code with the **Expo Go** app on your phone.

> If you see a prompt asking to install `@expo/ngrok`, type `Y`.
> If global install fails, use the local install shown in section 1.

### Option B – LAN mode

```bash
npx expo start --lan
```

Then manually enter the `exp://192.168.x.x:8081` URL in Expo Go.

### Option C – Normal start

```bash
npx expo start
```

---

## 4. Create an Android APK (EAS Build)

WebRTC and native modules **do not work inside Expo Go**.  
You need a real APK for full functionality.

### Configure EAS (first time only)

```bash
npx eas-cli@latest build:configure
```

Choose **Android** when asked.

### Start a preview build (APK)

```bash
npx eas-cli@latest build --platform android --profile preview
```

- The build runs in the cloud (usually 10–20 minutes).
- When finished you get a download link for the `.apk`.
- Install the APK on your Android phone.

### Check previous builds

```bash
npx eas-cli@latest build:list
```

Or visit: https://expo.dev/accounts/ashishburges-team/projects/localdrop-mobile/builds

---

## 5. Fix package-lock issues (if EAS build fails)

If the build fails with `npm ci` / lockfile errors:

```bash
rm -rf node_modules package-lock.json
npm install --legacy-peer-deps

git add package-lock.json package.json
git commit -m "Regenerate package-lock.json"
git push origin main
```

Then restart the build:

```bash
npx eas-cli@latest build --platform android --profile preview
```

---

## 6. Backend URL

Set your Render (or other) backend URL in `src/lib/config.ts`:

```ts
SOCKET_URL: process.env.EXPO_PUBLIC_SOCKET_URL || 'https://your-backend.onrender.com',
```

Or create a `.env` file:

```
EXPO_PUBLIC_SOCKET_URL=https://your-backend.onrender.com
```

---

## 7. Useful Commands Cheat-sheet

| Action                        | Command                                              |
|-------------------------------|------------------------------------------------------|
| Install deps                  | `npm install --legacy-peer-deps`                     |
| Start with tunnel             | `npx expo start --tunnel`                            |
| Start with LAN                | `npx expo start --lan`                               |
| EAS login                     | `npx eas-cli@latest login`                           |
| Configure EAS                 | `npx eas-cli@latest build:configure`                 |
| Build Android APK             | `npx eas-cli@latest build --platform android --profile preview` |
| List builds                   | `npx eas-cli@latest build:list`                      |
| Install ngrok helper          | `npm install @expo/ngrok --save-dev --legacy-peer-deps` |
| Pull latest code              | `git pull origin main`                               |

---

## Notes for ChromeOS / Crostini users

- Tunnel mode (`--tunnel`) is the most reliable way to connect Expo Go.
- Direct LAN often fails because the Linux container IP is not reachable from the phone.
- Global `npm install -g` may fail with permission errors — always prefer `npx` or local install.

---

## Project Structure

```
localdrop-mobile/
├── app/                 # Expo Router screens
│   ├── index.tsx        # Home (Online/Offline switch)
│   ├── send.tsx         # Send files + create room
│   ├── receive.tsx      # Join room by code
│   └── transfer.tsx     # Transfer progress UI
├── src/lib/
│   ├── config.ts        # Backend URL & constants
│   ├── socket.ts        # Socket.IO client
│   └── webrtc.ts        # WebRTC helpers (dev build only)
├── app.json
├── eas.json
└── package.json
```
