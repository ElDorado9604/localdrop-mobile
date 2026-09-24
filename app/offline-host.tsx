/**
 * Create Room: NFC / Nearby / QR.
 */
import { useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  ScrollView,
  Alert,
  Platform,
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
import { startNearbyHost } from '../src/lib/nearbyPairing';

const DEVICE_NAME = Platform.OS === 'ios' ? 'iPhone' : 'Android Device';

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
  const sessionRef = useRef<WebRTCSession | null>(null);
  const codeRef = useRef('');
  const peerNameRef = useRef('peer');
  const startedRef = useRef(false);
  const nearbyStopRef = useRef<(() => void) | null>(null);

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
    peerNameRef.current = decoded.name;
    setPendingJoin({ name: decoded.name, sdp: decoded.sdp, code: decoded.code });
    setPhase('review-join');
  }, []);

  useFocusEffect(
    useCallback(() => {
      (global as any).__localdropOnAnswerScanned = onAnswerScanned;
      const pending = (global as any).__localdropPendingAnswer as string | undefined;
      if (pending) {
        (global as any).__localdropPendingAnswer = undefined;
        onAnswerScanned(pending);
      }
      return () => {
        if ((global as any).__localdropOnAnswerScanned === onAnswerScanned) {
          (global as any).__localdropOnAnswerScanned = undefined;
        }
        nearbyStopRef.current?.();
      };
    }, [onAnswerScanned])
  );

  async function startQrRoom() {
    if (startedRef.current) return;
    startedRef.current = true;
    setPhase('creating');
    setError(null);

    try {
      const code = generateRoomCode();
      codeRef.current = code;
      setRoomCode(code);

      const session = new WebRTCSession();
      sessionRef.current = session;

      session.setHandlers({
        onOpen: () => {
          setOfflineSession(session, {
            peerName: peerNameRef.current,
            roomCode: codeRef.current,
            isHost: true,
          });
          router.replace({ pathname: '/offline-session', params: { role: 'host' } });
        },
        onFailed: (reason) => {
          setError(reason);
          setPhase('failed');
        },
      });

      const local = await session.createOfferForQr();
      const payload = encodeRoomOffer({
        code,
        name: DEVICE_NAME,
        sdp: local,
      });
      setOfferPayload(payload);
      setPhase('waiting');
    } catch (e) {
      startedRef.current = false;
      setError(e instanceof Error ? e.message : 'Failed to create room');
      setPhase('failed');
    }
  }

  async function startNearbyRoom() {
    if (startedRef.current) return;
    startedRef.current = true;
    setPhase('creating');
    setError(null);
    setStatus('Creating room…');

    try {
      const code = generateRoomCode();
      codeRef.current = code;
      setRoomCode(code);

      const session = new WebRTCSession();
      sessionRef.current = session;

      session.setHandlers({
        onOpen: () => {
          nearbyStopRef.current?.();
          setOfflineSession(session, {
            peerName: peerNameRef.current,
            roomCode: codeRef.current,
            isHost: true,
          });
          router.replace({ pathname: '/offline-session', params: { role: 'host' } });
        },
        onFailed: (reason) => {
          setError(reason);
          setPhase('failed');
        },
      });

      const local = await session.createOfferForQr();
      const payload = encodeRoomOffer({
        code,
        name: DEVICE_NAME,
        sdp: local,
      });

      setPhase('nearby-wait');
      setStatus('Waiting for nearby device…');

      const result = await startNearbyHost({
        offerRaw: payload,
        name: DEVICE_NAME,
        code,
        onStatus: setStatus,
      });
      nearbyStopRef.current = result.stop;

      const decoded = decodeRoomPayload(result.answerRaw);
      if (!decoded || decoded.type !== 'answer') {
        throw new Error('Invalid answer from nearby device');
      }
      peerNameRef.current = result.peerName || decoded.name;
      setPendingJoin({
        name: peerNameRef.current,
        sdp: decoded.sdp,
        code: decoded.code,
      });
      setPhase('review-join');
    } catch (e) {
      startedRef.current = false;
      nearbyStopRef.current?.();
      setError(
        e instanceof Error
          ? e.message
          : 'Nearby pairing failed. Stay on the same Wi‑Fi or hotspot.'
      );
      setPhase('failed');
    }
  }

  async function acceptJoin() {
    if (!pendingJoin || !sessionRef.current) return;
    setPhase('connecting');
    peerNameRef.current = pendingJoin.name;
    try {
      setOfflineSession(sessionRef.current, {
        peerName: pendingJoin.name,
        roomCode: codeRef.current,
        isHost: true,
      });
      await sessionRef.current.handleAnswer(pendingJoin.sdp);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to connect');
      setPhase('failed');
    }
  }

  function rejectJoin() {
    setPendingJoin(null);
    setPhase(offerPayload ? 'waiting' : 'nearby-wait');
    Alert.alert('Rejected', 'Waiting for another device.');
  }

  function cancelRoom() {
    Alert.alert('Cancel room?', 'Other devices will not be able to join.', [
      { text: 'Keep waiting', style: 'cancel' },
      {
        text: 'Cancel room',
        style: 'destructive',
        onPress: () => {
          clearOfflineSession();
          nearbyStopRef.current?.();
          sessionRef.current?.close();
          startedRef.current = false;
          router.replace('/offline');
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
          <Text style={styles.waiting}>{status || 'Broadcasting…'}</Text>
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
          <Text style={styles.deviceName}>Host: {DEVICE_NAME}</Text>
          {!!roomCode && <Text style={styles.codeLabel}>Room {roomCode}</Text>}
          <Text style={styles.waiting}>Waiting for the other device…</Text>
          <Pressable
            style={styles.primaryBtn}
            onPress={() =>
              router.push({
                pathname: '/offline-scan',
                params: { mode: 'answer' },
              })
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
            <Text style={{ fontWeight: '700' }}>{pendingJoin.name}</Text> wants to join.
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
  deviceName: { color: '#3b82f6', marginBottom: 4 },
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
