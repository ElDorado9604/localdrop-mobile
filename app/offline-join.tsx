/**
 * Join Room: pick NFC / BLE / QR, then continue.
 */
import { useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  TextInput,
  ScrollView,
  Alert,
  Share,
  Platform,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { WebRTCSession } from '../src/lib/webrtcSession';
import { encodeRoomAnswer, decodeRoomPayload } from '../src/lib/offlineSignal';
import { setOfflineSession } from '../src/lib/offlineSessionStore';
import { PairingMethodPicker } from '../src/components/PairingMethodPicker';

const DEVICE_NAME = Platform.OS === 'ios' ? 'iPhone' : 'Android Device';

export default function OfflineJoinScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<
    'choose-method' | 'qr-options' | 'passcode' | 'creating' | 'show-answer' | 'waiting' | 'failed'
  >('choose-method');
  const [inviteText, setInviteText] = useState('');
  const [answerPayload, setAnswerPayload] = useState<string | null>(null);
  const [hostName, setHostName] = useState('Host');
  const [roomCode, setRoomCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<WebRTCSession | null>(null);

  useFocusEffect(
    useCallback(() => {
      const pending = (global as any).__localdropPendingOffer as string | undefined;
      if (pending) {
        (global as any).__localdropPendingOffer = undefined;
        void applyOfferRaw(pending);
      }
    }, [])
  );

  async function applyOfferRaw(raw: string) {
    const decoded = decodeRoomPayload(raw);
    if (!decoded || decoded.type !== 'offer') {
      Alert.alert('Invalid QR code', 'Scan the host’s room QR code again or paste a valid invite.');
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

  function submitInvite() {
    if (!inviteText.trim()) {
      Alert.alert('Invalid invite', 'Paste the full invite from the host (or scan their QR).');
      return;
    }
    void applyOfferRaw(inviteText);
  }

  async function shareAnswer() {
    if (!answerPayload) return;
    await Share.share({
      message: answerPayload,
      title: 'LocalDrop join answer',
    });
    setPhase('waiting');
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {phase === 'choose-method' && (
        <PairingMethodPicker
          title="Join Room"
          subtitle="Both devices need the same Wi‑Fi or hotspot. Choose how to pair."
          onSelect={(m) => {
            if (m === 'qr') setPhase('qr-options');
          }}
        />
      )}

      {phase === 'qr-options' && (
        <View>
          <Text style={styles.title}>Join · QR</Text>
          <Text style={styles.hint}>Scan the host’s QR or paste their shared invite.</Text>
          <Pressable
            style={styles.primaryBtn}
            onPress={() =>
              router.push({ pathname: '/offline-scan', params: { mode: 'offer' } })
            }
          >
            <Text style={styles.primaryBtnText}>Scan QR Code</Text>
          </Pressable>
          <Pressable style={styles.secondaryBtn} onPress={() => setPhase('passcode')}>
            <Text style={styles.secondaryBtnText}>Paste invite</Text>
          </Pressable>
          <Pressable style={styles.linkBtn} onPress={() => setPhase('choose-method')}>
            <Text style={styles.linkText}>Back</Text>
          </Pressable>
        </View>
      )}

      {phase === 'passcode' && (
        <View>
          <Text style={styles.label}>Paste the full invite from the host</Text>
          <TextInput
            style={styles.input}
            value={inviteText}
            onChangeText={setInviteText}
            placeholder="Paste invite…"
            placeholderTextColor="#555"
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable style={styles.primaryBtn} onPress={submitInvite}>
            <Text style={styles.primaryBtnText}>Join</Text>
          </Pressable>
          <Pressable style={styles.linkBtn} onPress={() => setPhase('qr-options')}>
            <Text style={styles.linkText}>Back</Text>
          </Pressable>
        </View>
      )}

      {phase === 'creating' && (
        <View style={styles.center}>
          <ActivityIndicator color="#3b82f6" size="large" />
          <Text style={styles.status}>Joining room…</Text>
        </View>
      )}

      {(phase === 'show-answer' || phase === 'waiting') && answerPayload && (
        <View style={styles.center}>
          <Text style={styles.label}>
            Room with {hostName}
            {roomCode ? ` · ${roomCode}` : ''}
          </Text>
          <Text style={styles.sub}>
            Show this QR to the host (or Share). Host must Accept to finish pairing.
          </Text>
          <View style={styles.qrBox}>
            <QRCode value={answerPayload} size={220} backgroundColor="#fff" color="#000" />
          </View>
          <Pressable style={styles.primaryBtn} onPress={shareAnswer}>
            <Text style={styles.primaryBtnText}>Share answer</Text>
          </Pressable>
          {phase === 'waiting' && (
            <View style={{ marginTop: 16 }}>
              <ActivityIndicator color="#3b82f6" />
              <Text style={styles.status}>Waiting for host to accept…</Text>
            </View>
          )}
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
  hint: { color: '#888', textAlign: 'center', marginTop: 8, marginBottom: 24, fontSize: 13 },
  center: { alignItems: 'center' },
  label: { color: '#fff', fontWeight: '600', marginBottom: 8, textAlign: 'center' },
  sub: { color: '#94a3b8', fontSize: 13, textAlign: 'center', marginBottom: 16 },
  qrBox: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 16,
    marginBottom: 16,
  },
  input: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 12,
    color: '#fff',
    minHeight: 120,
    textAlignVertical: 'top',
    marginBottom: 12,
    fontSize: 12,
  },
  primaryBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 12,
    minWidth: 220,
  },
  primaryBtnText: { color: '#fff', fontWeight: '600' },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  secondaryBtnText: { color: '#fff', fontWeight: '600' },
  linkBtn: { marginTop: 12, alignItems: 'center' },
  linkText: { color: '#3b82f6' },
  status: { color: '#aaa', marginTop: 12, textAlign: 'center' },
  error: { color: '#ef4444', textAlign: 'center', marginTop: 16 },
});
