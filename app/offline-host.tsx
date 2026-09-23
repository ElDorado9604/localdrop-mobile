/**
 * Offline host (initiator): create offer QR → scan answer QR → open session.
 */
import { useEffect, useRef, useState } from 'react';
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
} from 'react-native';
import { useRouter } from 'expo-router';
import { WebRTCSession } from '../src/lib/webrtcSession';
import { encodeSignal, decodeSignal } from '../src/lib/offlineSignal';
import { setOfflineSession } from '../src/lib/offlineSessionStore';

export default function OfflineHostScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<'creating' | 'show-offer' | 'paste-answer' | 'connecting' | 'failed'>(
    'creating'
  );
  const [offerPayload, setOfferPayload] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<WebRTCSession | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const session = new WebRTCSession();
        sessionRef.current = session;

        session.setHandlers({
          onOpen: () => {
            if (cancelled) return;
            setOfflineSession(session, 'peer');
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
        const payload = encodeSignal('offer', local);
        setOfferPayload(payload);
        setPhase('show-offer');
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to create offer');
          setPhase('failed');
        }
      }
    }

    void start();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function applyAnswer() {
    const decoded = decodeSignal(answerText);
    if (!decoded || decoded.type !== 'answer') {
      Alert.alert('Invalid', 'Paste the answer payload from the other device');
      return;
    }
    setPhase('connecting');
    try {
      await sessionRef.current?.handleAnswer(decoded.sdp);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply answer');
      setPhase('failed');
    }
  }

  async function shareOffer() {
    if (!offerPayload) return;
    await Share.share({
      message: offerPayload,
      title: 'LocalDrop offline offer',
    });
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Offline pair — Host</Text>
      <Text style={styles.hint}>
        Same Wi‑Fi or hotspot. Share the offer with the other phone, then paste their answer here.
      </Text>

      {phase === 'creating' && (
        <View style={styles.center}>
          <ActivityIndicator color="#3b82f6" size="large" />
          <Text style={styles.status}>Creating secure link…</Text>
        </View>
      )}

      {phase === 'show-offer' && offerPayload && (
        <View>
          <Text style={styles.label}>1. Send this offer to the other device</Text>
          <Text style={styles.payload} selectable>
            {offerPayload}
          </Text>
          <Pressable style={styles.primaryBtn} onPress={shareOffer}>
            <Text style={styles.primaryBtnText}>Share offer</Text>
          </Pressable>

          <Text style={[styles.label, { marginTop: 28 }]}>2. Paste their answer below</Text>
          <TextInput
            style={styles.input}
            value={answerText}
            onChangeText={setAnswerText}
            placeholder="Paste answer JSON…"
            placeholderTextColor="#555"
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable style={styles.primaryBtn} onPress={applyAnswer}>
            <Text style={styles.primaryBtnText}>Connect</Text>
          </Pressable>
        </View>
      )}

      {phase === 'connecting' && (
        <View style={styles.center}>
          <ActivityIndicator color="#3b82f6" size="large" />
          <Text style={styles.status}>Connecting…</Text>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable style={styles.homeBtn} onPress={() => router.back()}>
        <Text style={styles.homeText}>Back</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f0f' },
  content: { padding: 24, paddingBottom: 48 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center' },
  hint: { color: '#888', textAlign: 'center', marginTop: 8, marginBottom: 24, fontSize: 13 },
  center: { alignItems: 'center', marginVertical: 32 },
  status: { color: '#aaa', marginTop: 12 },
  label: { color: '#fff', fontWeight: '600', marginBottom: 8 },
  payload: {
    color: '#94a3b8',
    fontSize: 11,
    backgroundColor: '#1a1a1a',
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
    maxHeight: 140,
  },
  input: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 12,
    color: '#fff',
    minHeight: 100,
    textAlignVertical: 'top',
    marginBottom: 12,
    fontSize: 12,
  },
  primaryBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontWeight: '600' },
  error: { color: '#ef4444', textAlign: 'center', marginTop: 16 },
  homeBtn: {
    marginTop: 32,
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  homeText: { color: '#fff' },
});
