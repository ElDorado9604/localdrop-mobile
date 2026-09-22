import { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { joinRoom, cancelRoom, getSocket } from '../src/lib/socket';

export default function ReceiveScreen() {
  const { mode } = useLocalSearchParams<{ mode: string }>();
  const isOffline = mode === 'offline';

  const [code, setCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'joining' | 'connected'>('idle');
  const [peerName, setPeerName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const s = getSocket();

    const onPeerLeft = () => {
      setStatus('idle');
      setPeerName(null);
      Alert.alert('Peer left', 'The sender disconnected.');
    };

    const onCancelled = () => {
      setStatus('idle');
      setPeerName(null);
    };

    s.on('room:peer-left', onPeerLeft);
    s.on('room:cancelled', onCancelled);

    return () => {
      s.off('room:peer-left', onPeerLeft);
      s.off('room:cancelled', onCancelled);
      if (status === 'connected') {
        cancelRoom();
      }
    };
  }, [status]);

  async function handleJoin() {
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length < 4) {
      Alert.alert('Invalid code', 'Please enter the pairing code');
      return;
    }

    if (isOffline) {
      Alert.alert('Coming soon', 'Offline mode (local discovery) will be added next.');
      return;
    }

    setError(null);
    setStatus('joining');

    const res = await joinRoom(trimmed, 'Android Device');

    if ('error' in res) {
      setError(res.error);
      setStatus('idle');
      return;
    }

    setPeerName(res.peerName);
    setStatus('connected');
  }

  function cancel() {
    cancelRoom();
    setStatus('idle');
    setPeerName(null);
    setCode('');
  }

  return (
    <View style={styles.container}>
      <Text style={styles.modeLabel}>
        Mode: {isOffline ? 'Offline (Local Discovery)' : 'Online (Signaling Server)'}
      </Text>

      {status === 'idle' && (
        <>
          <Text style={styles.title}>Enter Pairing Code</Text>
          <Text style={styles.hint}>Ask the sender for the 6-digit code</Text>

          <TextInput
            style={styles.input}
            value={code}
            onChangeText={setCode}
            placeholder="ABC123"
            placeholderTextColor="#555"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={8}
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
          <Text style={styles.connectedTitle}>Connected!</Text>
          <Text style={styles.peerText}>Sender: {peerName || 'Unknown'}</Text>
          <Text style={styles.hint}>Waiting for files...</Text>

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
  connectedTitle: { color: '#22c55e', fontSize: 24, fontWeight: '700' },
  peerText: { color: '#fff', marginTop: 12, fontSize: 16 },
  cancelBtn: { marginTop: 32 },
  cancelText: { color: '#ef4444' },
  error: { color: '#ef4444', textAlign: 'center', marginTop: 16 },
});
