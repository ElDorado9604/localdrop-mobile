/**
 * Join Room: NFC / Nearby / QR.
 */
import { useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Alert,
  Platform,
  Pressable,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { WebRTCSession } from '../src/lib/webrtcSession';
import { encodeRoomAnswer, decodeRoomPayload } from '../src/lib/offlineSignal';
import { setOfflineSession } from '../src/lib/offlineSessionStore';
import { PairingMethodPicker } from '../src/components/PairingMethodPicker';
import { startNearbyGuest } from '../src/lib/nearbyPairing';

const DEVICE_NAME = Platform.OS === 'ios' ? 'iPhone' : 'Android Device';

export default function OfflineJoinScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<
    'choose-method' | 'nearby' | 'creating' | 'show-answer' | 'waiting' | 'failed'
  >('choose-method');
  const [status, setStatus] = useState('');
  const [answerPayload, setAnswerPayload] = useState<string | null>(null);
  const [hostName, setHostName] = useState('Host');
  const [roomCode, setRoomCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<WebRTCSession | null>(null);
  const nearbyStopRef = useRef<(() => void) | null>(null);

  useFocusEffect(
    useCallback(() => {
      const pending = (global as any).__localdropPendingOffer as string | undefined;
      if (pending) {
        (global as any).__localdropPendingOffer = undefined;
        void applyOfferRaw(pending);
      }
      return () => {
        nearbyStopRef.current?.();
      };
    }, [])
  );

  async function applyOfferRaw(raw: string) {
    const decoded = decodeRoomPayload(raw);
    if (!decoded || decoded.type !== 'offer') {
      Alert.alert('Invalid QR code', 'Scan the host’s room QR code.');
      setPhase('choose-method');
      return;
    }

    setPhase('creating');
    setError(null);
    setHostName(decoded.name);
    setRoomCode(decoded.code);

    try {
      const session = new WebRTCSession();
      sessionRef.current = session;

      session.setHandlers({
        onOpen: () => {
          setOfflineSession(session, {
            peerName: decoded.name,
            roomCode: decoded.code,
            isHost: false,
          });
          router.replace({ pathname: '/offline-session', params: { role: 'join' } });
        },
        onFailed: (reason) => {
          setError(reason);
          setPhase('failed');
        },
      });

      const answer = await session.handleOfferForQr(decoded.sdp);
      const payload = encodeRoomAnswer({
        code: decoded.code,
        name: DEVICE_NAME,
        sdp: answer,
      });
      setAnswerPayload(payload);
      setPhase('show-answer');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to join room');
      setPhase('failed');
    }
  }

  async function startNearbyJoin() {
    setPhase('nearby');
    setError(null);
    setStatus('Looking for nearby room…');

    try {
      const guest = await startNearbyGuest({ onStatus: setStatus });
      nearbyStopRef.current = guest.stop;

      setStatus('Room found — connecting…');
      setHostName(guest.hostName);
      setRoomCode(guest.code);

      const decoded = decodeRoomPayload(guest.offerRaw);
      if (!decoded || decoded.type !== 'offer') {
        throw new Error('Invalid offer from host');
      }

      const session = new WebRTCSession();
      sessionRef.current = session;

      session.setHandlers({
        onOpen: () => {
          nearbyStopRef.current?.();
          setOfflineSession(session, {
            peerName: decoded.name,
            roomCode: decoded.code,
            isHost: false,
          });
          router.replace({ pathname: '/offline-session', params: { role: 'join' } });
        },
        onFailed: (reason) => {
          setError(reason);
          setPhase('failed');
        },
      });

      const answer = await session.handleOfferForQr(decoded.sdp);
      const payload = encodeRoomAnswer({
        code: decoded.code,
        name: DEVICE_NAME,
        sdp: answer,
      });

      guest.sendAnswer(payload, DEVICE_NAME);
      setStatus('Answer sent — waiting for host to accept…');
      setPhase('waiting');
    } catch (e) {
      nearbyStopRef.current?.();
      setError(
        e instanceof Error
          ? e.message
          : 'Could not find a nearby room. Same Wi‑Fi or hotspot required.'
      );
      setPhase('failed');
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {phase === 'choose-method' && (
        <PairingMethodPicker
          title="Join Room"
          subtitle="Both devices need the same Wi‑Fi or hotspot. Choose how to pair."
          onSelect={(m) => {
            if (m === 'qr') {
              router.push({ pathname: '/offline-scan', params: { mode: 'offer' } });
            }
            if (m === 'ble') void startNearbyJoin();
          }}
        />
      )}

      {(phase === 'nearby' || phase === 'creating') && (
        <View style={styles.center}>
          <ActivityIndicator color="#3b82f6" size="large" />
          <Text style={styles.status}>{status || 'Working…'}</Text>
          <Pressable
            style={{ marginTop: 24 }}
            onPress={() => {
              nearbyStopRef.current?.();
              setPhase('choose-method');
            }}
          >
            <Text style={{ color: '#3b82f6' }}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {phase === 'waiting' && (
        <View style={styles.center}>
          <ActivityIndicator color="#3b82f6" size="large" />
          <Text style={styles.title}>Waiting for host</Text>
          <Text style={styles.sub}>
            {hostName}
            {roomCode ? ` · Room ${roomCode}` : ''}
            {'\n'}Host should Accept the join request.
          </Text>
          <Text style={styles.status}>{status}</Text>
        </View>
      )}

      {phase === 'show-answer' && answerPayload && (
        <View style={styles.center}>
          <Text style={styles.title}>Show this QR to the host</Text>
          <Text style={styles.sub}>
            {hostName}
            {roomCode ? ` · Room ${roomCode}` : ''}
            {'\n'}Host scans this code, then taps Accept.
          </Text>
          <View style={styles.qrBox}>
            <QRCode value={answerPayload} size={220} backgroundColor="#fff" color="#000" />
          </View>
          <ActivityIndicator color="#3b82f6" style={{ marginTop: 16 }} />
          <Text style={styles.status}>Waiting for host to accept…</Text>
        </View>
      )}

      {error && (
        <View>
          <Text style={styles.error}>{error}</Text>
          <Pressable style={{ marginTop: 16, alignItems: 'center' }} onPress={() => setPhase('choose-method')}>
            <Text style={{ color: '#3b82f6' }}>Try again</Text>
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
  center: { alignItems: 'center' },
  sub: {
    color: '#94a3b8',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 16,
    lineHeight: 20,
  },
  qrBox: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 16,
    marginBottom: 8,
  },
  status: { color: '#aaa', marginTop: 12, textAlign: 'center' },
  error: { color: '#ef4444', textAlign: 'center', marginTop: 16 },
});
