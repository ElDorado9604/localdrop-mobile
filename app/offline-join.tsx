/**
 * Offline joiner: paste offer → create answer → share answer → wait for channel.
 */
import { useRef, useState } from 'react';
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

export default function OfflineJoinScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<'paste-offer' | 'creating' | 'show-answer' | 'waiting' | 'failed'>(
    'paste-offer'
  );
  const [offerText, setOfferText] = useState('');
  const [answerPayload, setAnswerPayload] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<WebRTCSession | null>(null);

  async function applyOffer() {
    const decoded = decodeSignal(offerText);
    if (!decoded || decoded.type !== 'offer') {
      Alert.alert('Invalid', 'Paste the offer payload from the host device');
      return;
    }

    setPhase('creating');
    setError(null);

    try {
      const session = new WebRTCSession();
      sessionRef.current = session;

      session.setHandlers({
        onOpen: () => {
          setOfflineSession(session, 'peer');
          router.replace({ pathname: '/offline-session', params: { role: 'join' } });
        },
        onFailed: (reason) => {
          setError(reason);
          setPhase('failed');
        },
      });

      const answer = await session.handleOfferForQr(decoded.sdp);
      const payload = encodeSignal('answer', answer);
      setAnswerPayload(payload);
      setPhase('show-answer');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create answer');
      setPhase('failed');
    }
  }

  async function shareAnswer() {
    if (!answerPayload) return;
    await Share.share({
      message: answerPayload,
      title: 'LocalDrop offline answer',
    });
    setPhase('waiting');
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Offline pair — Join</Text>
      <Text style={styles.hint}>
        Paste the host’s offer, share your answer back, then wait for the link.
      </Text>

      {phase === 'paste-offer' && (
        <View>
          <Text style={styles.label}>Paste offer from host</Text>
          <TextInput
            style={styles.input}
            value={offerText}
            onChangeText={setOfferText}
            placeholder="Paste offer JSON…"
            placeholderTextColor="#555"
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable style={styles.primaryBtn} onPress={applyOffer}>
            <Text style={styles.primaryBtnText}>Create answer</Text>
          </Pressable>
        </View>
      )}

      {phase === 'creating' && (
        <View style={styles.center}>
          <ActivityIndicator color="#3b82f6" size="large" />
          <Text style={styles.status}>Creating answer…</Text>
        </View>
      )}

      {(phase === 'show-answer' || phase === 'waiting') && answerPayload && (
        <View>
          <Text style={styles.label}>Send this answer to the host</Text>
          <Text style={styles.payload} selectable>
            {answerPayload}
          </Text>
          <Pressable style={styles.primaryBtn} onPress={shareAnswer}>
            <Text style={styles.primaryBtnText}>Share answer</Text>
          </Pressable>
          {phase === 'waiting' && (
            <View style={[styles.center, { marginTop: 24 }]}>
              <ActivityIndicator color="#3b82f6" />
              <Text style={styles.status}>Waiting for host to connect…</Text>
            </View>
          )}
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
  center: { alignItems: 'center', marginVertical: 24 },
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
