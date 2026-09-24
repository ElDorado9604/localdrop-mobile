/**
 * Create Room: show QR + passcode, wait for join, accept/reject, then session.
 */
import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  ScrollView,
  Alert,
  Share,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { WebRTCSession } from '../src/lib/webrtcSession';
import {
  encodeRoomOffer,
  decodeRoomPayload,
  generateRoomCode,
} from '../src/lib/offlineSignal';
import { setOfflineSession, clearOfflineSession } from '../src/lib/offlineSessionStore';

const DEVICE_NAME = Platform.OS === 'ios' ? 'iPhone' : 'Android Device';

export default function OfflineHostScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<
    'creating' | 'waiting' | 'review-join' | 'connecting' | 'failed'
  >('creating');
  const [roomCode, setRoomCode] = useState('');
  const [offerPayload, setOfferPayload] = useState<string | null>(null);
  const [pendingJoin, setPendingJoin] = useState<{ name: string; sdp: any; code: string } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<WebRTCSession | null>(null);
  const codeRef = useRef('');

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const code = generateRoomCode();
        codeRef.current = code;
        setRoomCode(code);

        const session = new WebRTCSession();
        sessionRef.current = session;

        session.setHandlers({
          onOpen: () => {
            if (cancelled) return;
            setOfflineSession(session, {
              peerName: pendingJoin?.name || 'peer',
              roomCode: codeRef.current,
              isHost: true,
            });
            router.replace({ pathname: '/offline-session', params: { role: 'host' } });
          },
          onFailed: (reason) => {
            if (!cancelled) {
              setError(reason);
              setPhase('failed');
            }
          },
        });

        const local = await session.createOfferForQr();
        if (cancelled) return;
        const payload = encodeRoomOffer({
          code,
          name: DEVICE_NAME,
          sdp: local,
        });
        setOfferPayload(payload);
        setPhase('waiting');
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to create room');
          setPhase('failed');
        }
      }
    }

    void start();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  function onAnswerScanned(raw: string) {
    const decoded = decodeRoomPayload(raw);
    if (!decoded || decoded.type !== 'answer') {
      Alert.alert('Invalid QR code', 'Scan the answer QR from the other device, or enter the passcode invite.');
      return;
    }
    if (codeRef.current && decoded.code && decoded.code !== codeRef.current) {
      Alert.alert('Invalid room passcode', 'This answer is for a different room.');
      return;
    }
    setPendingJoin({ name: decoded.name, sdp: decoded.sdp, code: decoded.code });
    setPhase('review-join');
  }

  async function acceptJoin() {
    if (!pendingJoin || !sessionRef.current) return;
    setPhase('connecting');
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
    setPhase('waiting');
    Alert.alert('Rejected', 'Join request was rejected. Waiting for another device.');
  }

  async function shareInvite() {
    if (!offerPayload) return;
    await Share.share({
      message: offerPayload,
      title: `LocalDrop room ${roomCode}`,
    });
  }

  function cancelRoom() {
    Alert.alert('Cancel room?', 'The QR code and passcode will become invalid.', [
      { text: 'Keep waiting', style: 'cancel' },
      {
        text: 'Cancel room',
        style: 'destructive',
        onPress: () => {
          clearOfflineSession();
          sessionRef.current?.close();
          router.replace('/offline');
        },
      },
    ]);
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Create Room</Text>
      <Text style={styles.hint}>
        Ask the other device to scan this QR code or share the invite. Same Wi‑Fi or hotspot required.
      </Text>

      {phase === 'creating' && (
        <View style={styles.center}>
          <ActivityIndicator color="#3b82f6" size="large" />
          <Text style={styles.status}>Creating room…</Text>
        </View>
      )}

      {phase === 'waiting' && offerPayload && (
        <View style={styles.center}>
          <View style={styles.qrBox}>
            <QRCode value={offerPayload} size={220} backgroundColor="#fff" color="#000" />
          </View>

          <Text style={styles.codeLabel}>Room passcode</Text>
          <Text style={styles.code}>{roomCode}</Text>
          <Text style={styles.deviceName}>Host: {DEVICE_NAME}</Text>
          <Text style={styles.waiting}>Waiting for another device to join…</Text>

          <Pressable style={styles.primaryBtn} onPress={shareInvite}>
            <Text style={styles.primaryBtnText}>Share invite</Text>
          </Pressable>

          <Pressable
            style={[styles.primaryBtn, styles.outlineBtn]}
            onPress={() =>
              router.push({
                pathname: '/offline-scan',
                params: { mode: 'answer' },
              })
            }
          >
            <Text style={[styles.primaryBtnText, { color: '#3b82f6' }]}>
              Scan answer QR
            </Text>
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
            <Text style={{ fontWeight: '700' }}>{pendingJoin.name}</Text> wants to join this room.
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

// Allow scan screen to call back via global (simple bridge without context)
(global as any).__localdropOnAnswerScanned = undefined;

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
  codeLabel: { color: '#94a3b8', fontSize: 13 },
  code: {
    color: '#fff',
    fontSize: 36,
    fontWeight: '700',
    letterSpacing: 6,
    marginVertical: 8,
  },
  deviceName: { color: '#3b82f6', marginBottom: 8 },
  waiting: { color: '#fbbf24', fontSize: 13, marginBottom: 20 },
  status: { color: '#aaa', marginTop: 12 },
  primaryBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 28,
    alignItems: 'center',
    marginBottom: 10,
    minWidth: 220,
  },
  outlineBtn: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#3b82f6',
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

export function registerAnswerHandler(fn: (raw: string) => void) {
  (global as any).__localdropOnAnswerScanned = fn;
}
