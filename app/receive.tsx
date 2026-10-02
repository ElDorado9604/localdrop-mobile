import { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { joinRoom, cancelRoom, getSocket } from '../src/lib/socket';
import { hasSaveDirectory, setupPublicSaveFolder } from '../src/lib/saveReceivedFile';
import { getDisplayName } from '../src/lib/deviceName';

export default function ReceiveScreen() {
  const { mode } = useLocalSearchParams<{ mode: string }>();
  const router = useRouter();
  const isOffline = mode === 'offline';

  const [code, setCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'joining' | 'connected'>('idle');
  const [peerName, setPeerName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const statusRef = useRef(status);
  statusRef.current = status;
  const activeRoomRef = useRef(false);
  const navigatedRef = useRef(false);

  useEffect(() => {
    if (isOffline) return;

    const s = getSocket();

    const onPeerLeft = () => {
      if (statusRef.current === 'connected' && !navigatedRef.current) {
        activeRoomRef.current = false;
        setStatus('idle');
        setPeerName(null);
        Alert.alert('Peer left', 'The sender disconnected.');
      }
    };

    const onCancelled = () => {
      if (navigatedRef.current) return;
      activeRoomRef.current = false;
      setStatus('idle');
      setPeerName(null);
      setError('Room was cancelled by the sender.');
    };

    s.on('room:peer-left', onPeerLeft);
    s.on('room:cancelled', onCancelled);

    return () => {
      s.off('room:peer-left', onPeerLeft);
      s.off('room:cancelled', onCancelled);
      if (activeRoomRef.current && !navigatedRef.current) {
        cancelRoom();
        activeRoomRef.current = false;
      }
    };
  }, [isOffline]);

  function goToTransfer(name: string) {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    activeRoomRef.current = false;
    router.replace({
      pathname: '/transfer',
      params: {
        role: 'receiver',
        peerName: name || 'sender',
        mode: mode || 'online',
      },
    });
  }

  async function ensureFolder(): Promise<boolean> {
    if (await hasSaveDirectory()) return true;
    if (Platform.OS !== 'android') {
      return setupPublicSaveFolder();
    }
    return new Promise((resolve) => {
      Alert.alert(
        'Set save folder',
        'In the system picker, create a folder (e.g. LocalDrop) or select an existing one. Do this before connecting so the transfer stays stable.',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          {
            text: 'Choose',
            onPress: async () => {
              const ok = await setupPublicSaveFolder();
              resolve(ok);
            },
          },
        ]
      );
    });
  }

  async function handleJoin() {
    const trimmed = code.replace(/\D/g, '').slice(0, 6);
    if (trimmed.length !== 6) {
      Alert.alert('Invalid code', 'Enter the 6-digit pairing code from the sender');
      return;
    }

    const folderOk = await ensureFolder();
    if (!folderOk) {
      setError('Save folder is required before receiving files.');
      return;
    }

    setError(null);
    setStatus('joining');

    const displayName = await getDisplayName();
    const res = await joinRoom(trimmed, displayName);

    if ('error' in res) {
      setError(res.error);
      setStatus('idle');
      return;
    }

    activeRoomRef.current = true;
    setPeerName(res.peerName);
    setStatus('connected');
    setTimeout(() => goToTransfer(res.peerName || 'sender'), 50);
  }

  function cancel() {
    if (navigatedRef.current) return;
    cancelRoom();
    activeRoomRef.current = false;
    setStatus('idle');
    setPeerName(null);
    setCode('');
    setError(null);
  }

  if (isOffline) {
    return (
      <View style={styles.container}>
        <Text style={styles.modeLabel}>Mode: Offline (no internet)</Text>
        <Text style={styles.hint}>
          Join a host on the same Wi‑Fi or hotspot. You will paste their offer and share your answer.
        </Text>
        <Pressable style={styles.primaryBtn} onPress={() => router.push('/offline-join')}>
          <Text style={styles.primaryBtnText}>Join offline host</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.modeLabel}>Mode: Online (Signaling Server)</Text>

      {status === 'idle' && (
        <>
          <Text style={styles.title}>Enter Pairing Code</Text>
          <Text style={styles.hint}>Ask the sender for the 6-digit code</Text>

          <TextInput
            style={styles.input}
            value={code}
            onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
            placeholder="123456"
            placeholderTextColor="#555"
            keyboardType="number-pad"
            autoCorrect={false}
            maxLength={6}
          />

          <Pressable style={styles.primaryBtn} onPress={handleJoin}>
            <Text style={styles.primaryBtnText}>Join</Text>
          </Pressable>
        </>
      )}

      {status === 'joining' && (
        <View style={styles.center}>
          <ActivityIndicator color="#3b82f6" size="large" />
          <Text style={styles.statusText}>Joining room...</Text>
        </View>
      )}

      {status === 'connected' && (
        <View style={styles.center}>
          <ActivityIndicator color="#3b82f6" size="large" />
          <Text style={styles.connectedTitle}>Connected!</Text>
          <Text style={styles.peerText}>Sender: {peerName || 'Unknown'}</Text>
          <Text style={styles.hint}>Opening transfer…</Text>

          <Pressable
            style={[styles.primaryBtn, { marginTop: 24, width: '100%' }]}
            onPress={() => goToTransfer(peerName || 'sender')}
          >
            <Text style={styles.primaryBtnText}>Continue</Text>
          </Pressable>

          <Pressable style={styles.cancelBtn} onPress={cancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f0f',
    padding: 24,
    justifyContent: 'center',
  },
  modeLabel: { color: '#3b82f6', marginBottom: 32, textAlign: 'center' },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center' },
  hint: { color: '#888', textAlign: 'center', marginTop: 8, marginBottom: 24 },
  input: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 16,
    color: '#fff',
    fontSize: 24,
    textAlign: 'center',
    letterSpacing: 4,
    fontWeight: '600',
    marginBottom: 24,
  },
  primaryBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  center: { alignItems: 'center' },
  statusText: { color: '#aaa', marginTop: 16 },
  connectedTitle: { color: '#22c55e', fontSize: 24, fontWeight: '700', marginTop: 16 },
  peerText: { color: '#fff', marginTop: 12, fontSize: 16 },
  cancelBtn: { marginTop: 24 },
  cancelText: { color: '#ef4444' },
  error: { color: '#ef4444', textAlign: 'center', marginTop: 16 },
});
