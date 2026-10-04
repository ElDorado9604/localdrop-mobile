/**
 * Create Room: NFC / Nearby / QR.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  ScrollView,
  Alert,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { WebRTCSession } from '../src/lib/webrtcSession';
import {
  encodeRoomOffer,
  decodeRoomPayload,
  generateRoomCode,
} from '../src/lib/offlineSignal';
import { setOfflineSession, clearOfflineSession } from '../src/lib/offlineSessionStore';
import { PairingMethodPicker } from '../src/components/PairingMethodPicker';
import { startNearbyHost, isNearbyCancelled } from '../src/lib/nearbyPairing';
import { logInfo, logWarn, logError, describeError } from '../src/lib/logger';
import { summarizeCandidates } from '../src/lib/netUtil';
import { getDisplayName } from '../src/lib/deviceName';

export default function OfflineHostScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<
    | 'choose-method'
    | 'creating'
    | 'waiting'
    | 'nearby-wait'
    | 'review-join'
    | 'connecting'
    | 'failed'
  >('choose-method');
  const [status, setStatus] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [offerPayload, setOfferPayload] = useState<string | null>(null);
  const [pendingJoin, setPendingJoin] = useState<{ name: string; sdp: any; code: string } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [myName, setMyName] = useState('Device');
  const [netHint, setNetHint] = useState<string | null>(null);
  const sessionRef = useRef<WebRTCSession | null>(null);
  const codeRef = useRef('');
  const nameRef = useRef('Device');
  const peerNameRef = useRef('peer');
  const startedRef = useRef(false);
  /** Cancel (while searching) or stop (after answer) for the nearby UDP socket. */
  const nearbyStopRef = useRef<(() => void) | null>(null);
  /** Offer payload kept so Reject can resume broadcasting the same room. */
  const offerRawRef = useRef<string | null>(null);
  /** Bumped on reset/cancel/unmount so late async results from an old attempt are ignored. */
  const attemptRef = useRef(0);
  /** True once the session was handed to /offline-session (do not close it on unmount). */
  const handedOffRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      void getDisplayName().then(setMyName);
    }, [])
  );

  const onAnswerScanned = useCallback((raw: string) => {
    const decoded = decodeRoomPayload(raw);
    if (!decoded || decoded.type !== 'answer') {
      Alert.alert('Invalid QR code', 'Scan the answer QR from the other device.');
      return;
    }
    if (codeRef.current && decoded.code && decoded.code !== codeRef.current) {
      Alert.alert('Wrong room', 'This answer is for a different room.');
      return;
    }
    peerNameRef.current = decoded.name || 'Device';
    setPendingJoin({ name: peerNameRef.current, sdp: decoded.sdp, code: decoded.code });
    setPhase('review-join');
  }, []);

  useFocusEffect(
    useCallback(() => {
      (globalThis as any).__localdropOnAnswerScanned = onAnswerScanned;
      const pending = (globalThis as any).__localdropPendingAnswer as string | undefined;
      if (pending) {
        (globalThis as any).__localdropPendingAnswer = undefined;
        onAnswerScanned(pending);
      }
      return () => {
        if ((globalThis as any).__localdropOnAnswerScanned === onAnswerScanned) {
          (globalThis as any).__localdropOnAnswerScanned = undefined;
        }
      };
    }, [onAnswerScanned])
  );

  /** Close everything this screen created and forget it (used by Try again / Cancel / unmount). */
  const teardown = useCallback(() => {
    attemptRef.current++;
    nearbyStopRef.current?.();
    nearbyStopRef.current = null;
    if (!handedOffRef.current) {
      clearOfflineSession();
      try {
        sessionRef.current?.close();
      } catch {
        /* */
      }
    }
    sessionRef.current = null;
    offerRawRef.current = null;
    startedRef.current = false;
  }, []);

  // Unmount (hardware back, swipe) — stop broadcasting and release the socket/pc.
  useEffect(() => {
    return () => teardown();
  }, [teardown]);

  const resetRoom = useCallback(() => {
    teardown();
    setOfferPayload(null);
    setPendingJoin(null);
    setRoomCode('');
    setError(null);
    setStatus('');
    setNetHint(null);
    setPhase('choose-method');
  }, [teardown]);

  /** Log what addresses WebRTC will offer; warn when none is on a Wi‑Fi/hotspot LAN. */
  const reportNetwork = useCallback((local: any) => {
    const sum = summarizeCandidates(local?.sdp ?? '');
    logInfo(
      'offline-host',
      `offer candidates: lanIPv4=${sum.hostIpv4Private} [${sum.maskedPrivate.join(',')}] otherIPv4=${sum.hostIpv4Other} ipv6=${sum.hostIpv6} srflx=${sum.srflx} relay=${sum.relay} tcp=${sum.tcp}`
    );
    if (sum.hostIpv4Private === 0) {
      logWarn('offline-host', 'no private IPv4 host candidate — LAN connection may fail (hotspot owner?)');
      setNetHint(
        'This phone reports no Wi‑Fi/hotspot address for the connection. If the other phone cannot connect, put both phones on the same Wi‑Fi router instead of using this phone’s hotspot, then try again.'
      );
    } else {
      setNetHint(null);
    }
  }, []);

  const makeSession = useCallback(
    (attempt: number) => {
      const session = new WebRTCSession(undefined, { offline: true });
      sessionRef.current = session;
      session.setHandlers({
        onOpen: () => {
          if (attempt !== attemptRef.current) return;
          nearbyStopRef.current?.();
          handedOffRef.current = true;
          setOfflineSession(session, {
            peerName: peerNameRef.current,
            roomCode: codeRef.current,
            isHost: true,
          });
          router.replace({ pathname: '/offline-session' as any, params: { role: 'host' } } as any);
        },
        onFailed: (reason) => {
          if (attempt !== attemptRef.current) return;
          nearbyStopRef.current?.();
          startedRef.current = false;
          logWarn('offline-host', `session failed: ${reason}`);
          setError(reason);
          setPhase('failed');
        },
      });
      return session;
    },
    [router]
  );

  async function startQrRoom() {
    if (startedRef.current) return;
    startedRef.current = true;
    const attempt = ++attemptRef.current;
    setPhase('creating');
    setError(null);

    try {
      const displayName = await getDisplayName();
      setMyName(displayName);
      nameRef.current = displayName;

      const code = generateRoomCode();
      codeRef.current = code;
      setRoomCode(code);

      const session = makeSession(attempt);
      const local = await session.createOfferForQr();
      if (attempt !== attemptRef.current) {
        session.close();
        return;
      }
      reportNetwork(local);
      const payload = encodeRoomOffer({
        code,
        name: displayName,
        sdp: local,
      });
      setOfferPayload(payload);
      setPhase('waiting');
    } catch (e) {
      if (attempt !== attemptRef.current) return;
      startedRef.current = false;
      logError('offline-host', `qr room failed: ${describeError(e)}`);
      setError(e instanceof Error ? e.message : 'Failed to create room');
      setPhase('failed');
    }
  }

  /** Broadcast the stored offer and wait for a (valid) answer. Safe to call again after Reject. */
  const beginNearbyBroadcast = useCallback(async (attempt: number) => {
    const payload = offerRawRef.current;
    if (!payload) return;
    setPhase('nearby-wait');
    setStatus('Waiting for nearby device…');

    try {
      const result = await startNearbyHost({
        offerRaw: payload,
        name: nameRef.current,
        code: codeRef.current,
        onStatus: setStatus,
        onReady: (cancel) => {
          nearbyStopRef.current = cancel;
        },
        validateAnswer: (raw) => {
          const d = decodeRoomPayload(raw);
          if (!d || d.type !== 'answer') return false;
          // Legacy answers carry no code; otherwise it must match this room.
          return !codeRef.current || !d.code || d.code === codeRef.current;
        },
      });
      if (attempt !== attemptRef.current) return;
      nearbyStopRef.current = result.stop;

      const decoded = decodeRoomPayload(result.answerRaw);
      if (!decoded || decoded.type !== 'answer') {
        throw new Error('Invalid answer from nearby device');
      }
      peerNameRef.current = result.peerName || decoded.name || 'Device';
      setPendingJoin({
        name: peerNameRef.current,
        sdp: decoded.sdp,
        code: decoded.code,
      });
      setPhase('review-join');
    } catch (e) {
      if (isNearbyCancelled(e) || attempt !== attemptRef.current) return;
      nearbyStopRef.current?.();
      startedRef.current = false;
      logError('offline-host', `nearby failed: ${describeError(e)}`);
      setError(
        e instanceof Error
          ? e.message
          : 'Nearby pairing failed. Stay on the same Wi‑Fi or hotspot.'
      );
      setPhase('failed');
    }
  }, []);

  async function startNearbyRoom() {
    if (startedRef.current) return;
    startedRef.current = true;
    const attempt = ++attemptRef.current;
    setPhase('creating');
    setError(null);
    setStatus('Creating room…');

    try {
      const displayName = await getDisplayName();
      setMyName(displayName);
      nameRef.current = displayName;

      const code = generateRoomCode();
      codeRef.current = code;
      setRoomCode(code);

      const session = makeSession(attempt);
      const local = await session.createOfferForQr();
      if (attempt !== attemptRef.current) {
        session.close();
        return;
      }
      reportNetwork(local);
      offerRawRef.current = encodeRoomOffer({
        code,
        name: displayName,
        sdp: local,
      });

      await beginNearbyBroadcast(attempt);
    } catch (e) {
      if (attempt !== attemptRef.current) return;
      startedRef.current = false;
      logError('offline-host', `nearby room failed: ${describeError(e)}`);
      setError(e instanceof Error ? e.message : 'Failed to create room');
      setPhase('failed');
    }
  }

  async function acceptJoin() {
    if (!pendingJoin || !sessionRef.current) return;
    setPhase('connecting');
    peerNameRef.current = pendingJoin.name;
    logInfo('offline-host', `accepted join from ${pendingJoin.name}`);
    try {
      setOfflineSession(sessionRef.current, {
        peerName: pendingJoin.name,
        roomCode: codeRef.current,
        isHost: true,
      });
      await sessionRef.current.handleAnswer(pendingJoin.sdp);
    } catch (e) {
      logError('offline-host', `accept failed: ${describeError(e)}`);
      setError(e instanceof Error ? e.message : 'Failed to connect');
      setPhase('failed');
    }
  }

  function rejectJoin() {
    setPendingJoin(null);
    logInfo('offline-host', 'join rejected');
    if (offerPayload) {
      // QR flow: keep showing the QR.
      setPhase('waiting');
      Alert.alert('Rejected', 'Waiting for another device.');
      return;
    }
    // Nearby flow: the UDP search had already stopped — resume broadcasting the same room.
    Alert.alert('Rejected', 'Looking for another device.');
    void beginNearbyBroadcast(attemptRef.current);
  }

  function cancelRoom() {
    Alert.alert('Cancel room?', 'Other devices will not be able to join.', [
      { text: 'Keep waiting', style: 'cancel' },
      {
        text: 'Cancel room',
        style: 'destructive',
        onPress: () => {
          teardown();
          router.replace('/offline' as any);
        },
      },
    ]);
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {phase === 'choose-method' && (
        <PairingMethodPicker
          title="Create Room"
          subtitle="Both devices need the same Wi‑Fi or hotspot. Choose how to pair."
          onSelect={(m) => {
            if (m === 'qr') void startQrRoom();
            if (m === 'ble') void startNearbyRoom();
          }}
        />
      )}

      {phase === 'creating' && (
        <View style={styles.center}>
          <ActivityIndicator color="#3b82f6" size="large" />
          <Text style={styles.status}>{status || 'Creating room…'}</Text>
        </View>
      )}

      {phase === 'nearby-wait' && (
        <View style={styles.center}>
          <ActivityIndicator color="#3b82f6" size="large" />
          <Text style={styles.title}>Connect nearby</Text>
          <Text style={styles.hint}>
            On the other phone: Join Room → Connect nearby. Stay on the same Wi‑Fi or hotspot.
          </Text>
          {!!roomCode && <Text style={styles.codeLabel}>Room {roomCode}</Text>}
          <Text style={styles.deviceName}>You: {myName}</Text>
          <Text style={styles.waiting}>{status || 'Broadcasting…'}</Text>
          {netHint ? <Text style={styles.hint}>{netHint}</Text> : null}
          <Pressable style={styles.cancelBtn} onPress={cancelRoom}>
            <Text style={styles.cancelText}>Cancel Room</Text>
          </Pressable>
        </View>
      )}

      {phase === 'waiting' && offerPayload && (
        <View style={styles.center}>
          <Text style={styles.title}>Show this QR</Text>
          <Text style={styles.hint}>
            Ask the other phone to scan this code, then scan their answer QR.
          </Text>
          <View style={styles.qrBox}>
            <QRCode value={offerPayload} size={220} backgroundColor="#fff" color="#000" />
          </View>
          <Text style={styles.deviceName}>You: {myName}</Text>
          {!!roomCode && <Text style={styles.codeLabel}>Room {roomCode}</Text>}
          <Text style={styles.waiting}>Waiting for the other device…</Text>
          {netHint ? <Text style={styles.hint}>{netHint}</Text> : null}
          <Pressable
            style={styles.primaryBtn}
            onPress={() =>
              router.push({
                pathname: '/offline-scan' as any,
                params: { mode: 'answer' },
              } as any)
            }
          >
            <Text style={styles.primaryBtnText}>Scan answer QR</Text>
          </Pressable>
          <Pressable style={styles.cancelBtn} onPress={cancelRoom}>
            <Text style={styles.cancelText}>Cancel Room</Text>
          </Pressable>
        </View>
      )}

      {phase === 'review-join' && pendingJoin && (
        <View style={styles.reviewBox}>
          <Text style={styles.reviewTitle}>Join request</Text>
          <Text style={styles.reviewBody}>
            <Text style={{ fontWeight: '700', color: '#fff' }}>{pendingJoin.name}</Text>
            {' wants to join.'}
          </Text>
          <View style={styles.row}>
            <Pressable style={styles.acceptBtn} onPress={acceptJoin}>
              <Text style={styles.primaryBtnText}>Accept</Text>
            </Pressable>
            <Pressable style={styles.rejectBtn} onPress={rejectJoin}>
              <Text style={styles.cancelText}>Reject</Text>
            </Pressable>
          </View>
        </View>
      )}

      {phase === 'connecting' && (
        <View style={styles.center}>
          <ActivityIndicator color="#3b82f6" size="large" />
          <Text style={styles.status}>Connecting…</Text>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {phase === 'failed' && (
        <View style={styles.center}>
          <Pressable style={[styles.primaryBtn, { marginTop: 20 }]} onPress={resetRoom}>
            <Text style={styles.primaryBtnText}>Try again</Text>
          </Pressable>
          <Pressable
            style={styles.cancelBtn}
            onPress={() => {
              teardown();
              router.replace('/offline' as any);
            }}
          >
            <Text style={styles.cancelText}>Back</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f0f' },
  content: { padding: 24, paddingBottom: 48 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center' },
  hint: { color: '#888', textAlign: 'center', marginTop: 8, marginBottom: 20, fontSize: 13 },
  center: { alignItems: 'center' },
  qrBox: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 16,
    marginBottom: 20,
  },
  codeLabel: { color: '#94a3b8', fontSize: 13, marginBottom: 8 },
  deviceName: { color: '#3b82f6', marginBottom: 8, fontWeight: '600' },
  waiting: { color: '#fbbf24', fontSize: 13, marginBottom: 20, textAlign: 'center' },
  status: { color: '#aaa', marginTop: 12, textAlign: 'center' },
  primaryBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 28,
    alignItems: 'center',
    marginBottom: 10,
    minWidth: 220,
  },
  primaryBtnText: { color: '#fff', fontWeight: '600' },
  cancelBtn: { marginTop: 16 },
  cancelText: { color: '#ef4444', fontWeight: '600' },
  reviewBox: {
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    padding: 20,
  },
  reviewTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  reviewBody: { color: '#ccc', marginBottom: 20, lineHeight: 22 },
  row: { flexDirection: 'row', gap: 12 },
  acceptBtn: {
    flex: 1,
    backgroundColor: '#22c55e',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  rejectBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#444',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  error: { color: '#ef4444', textAlign: 'center', marginTop: 16 },
});
