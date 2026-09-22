import { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  ScrollView,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { createRoom, cancelRoom, getSocket } from '../src/lib/socket';

type FileInfo = {
  name: string;
  size: number;
  uri: string;
  mimeType?: string;
};

export default function SendScreen() {
  const { mode } = useLocalSearchParams<{ mode: string }>();
  const router = useRouter();
  const isOffline = mode === 'offline';

  const [files, setFiles] = useState<FileInfo[]>([]);
  const [status, setStatus] = useState<'idle' | 'creating' | 'waiting' | 'connected'>('idle');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [peerName, setPeerName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keep a ref so cleanup does NOT cancel the room on every status change
  const statusRef = useRef(status);
  statusRef.current = status;
  const activeRoomRef = useRef(false);

  useEffect(() => {
    const s = getSocket();

    const onPeerJoined = (data: { peerName: string }) => {
      setPeerName(data.peerName);
      setStatus('connected');
    };

    const onPeerLeft = () => {
      if (statusRef.current === 'connected' || statusRef.current === 'waiting') {
        setPeerName(null);
        setStatus('waiting');
        Alert.alert('Peer left', 'The other device disconnected.');
      }
    };

    const onCancelled = () => {
      activeRoomRef.current = false;
      setStatus('idle');
      setPairingCode(null);
      setPeerName(null);
      setError('Room was cancelled.');
    };

    s.on('room:peer-joined', onPeerJoined);
    s.on('room:peer-left', onPeerLeft);
    s.on('room:cancelled', onCancelled);

    // Cleanup ONLY on unmount — never on status change
    return () => {
      s.off('room:peer-joined', onPeerJoined);
      s.off('room:peer-left', onPeerLeft);
      s.off('room:cancelled', onCancelled);
      if (activeRoomRef.current) {
        cancelRoom();
        activeRoomRef.current = false;
      }
    };
  }, []); // empty deps — run once

  async function pickFiles() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });

      if (result.canceled) return;

      const picked: FileInfo[] = result.assets.map((a) => ({
        name: a.name,
        size: a.size ?? 0,
        uri: a.uri,
        mimeType: a.mimeType,
      }));

      setFiles((prev) => [...prev, ...picked]);
    } catch {
      Alert.alert('Error', 'Could not pick files');
    }
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function startSending() {
    if (files.length === 0) {
      Alert.alert('No files', 'Please select at least one file');
      return;
    }

    if (isOffline) {
      Alert.alert('Coming soon', 'Offline mode (local discovery) will be added next.');
      return;
    }

    setError(null);
    setStatus('creating');

    const res = await createRoom('Android Device');

    if ('error' in res) {
      setError(res.error);
      setStatus('idle');
      return;
    }

    activeRoomRef.current = true;
    setPairingCode(res.pairingCode);
    setStatus('waiting');
  }

  function cancel() {
    cancelRoom();
    activeRoomRef.current = false;
    setStatus('idle');
    setPairingCode(null);
    setPeerName(null);
    setError(null);
  }

  function goToTransfer() {
    router.push({
      pathname: '/transfer',
      params: {
        role: 'sender',
        peerName: peerName || 'peer',
        fileCount: String(files.length),
      },
    });
  }

  function formatSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.modeLabel}>
        Mode: {isOffline ? 'Offline (Local Discovery)' : 'Online (Signaling Server)'}
      </Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Files to send</Text>

        {files.length === 0 ? (
          <Text style={styles.empty}>No files selected</Text>
        ) : (
          files.map((f, i) => (
            <View key={i} style={styles.fileRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fileName} numberOfLines={1}>{f.name}</Text>
                <Text style={styles.fileSize}>{formatSize(f.size)}</Text>
              </View>
              {status === 'idle' && (
                <Pressable onPress={() => removeFile(i)} style={styles.removeBtn}>
                  <Text style={styles.removeText}>✕</Text>
                </Pressable>
              )}
            </View>
          ))
        )}

        {status === 'idle' && (
          <Pressable style={styles.secondaryBtn} onPress={pickFiles}>
            <Text style={styles.secondaryBtnText}>+ Add Files</Text>
          </Pressable>
        )}
      </View>

      {status === 'idle' && (
        <Pressable
          style={[styles.primaryBtn, files.length === 0 && styles.btnDisabled]}
          onPress={startSending}
          disabled={files.length === 0}
        >
          <Text style={styles.primaryBtnText}>Create Pairing Code</Text>
        </Pressable>
      )}

      {status === 'creating' && (
        <View style={styles.center}>
          <ActivityIndicator color="#3b82f6" size="large" />
          <Text style={styles.statusText}>Creating room...</Text>
        </View>
      )}

      {(status === 'waiting' || status === 'connected') && pairingCode && (
        <View style={styles.pairingBox}>
          <Text style={styles.pairingLabel}>Share this code with the receiver</Text>
          <Text style={styles.pairingCode}>{pairingCode}</Text>

          {status === 'waiting' && (
            <>
              <ActivityIndicator color="#3b82f6" style={{ marginTop: 16 }} />
              <Text style={styles.statusText}>Waiting for receiver to join...</Text>
            </>
          )}

          {status === 'connected' && (
            <>
              <Text style={styles.connectedText}>
                Connected to {peerName || 'peer'}
              </Text>
              <Pressable style={[styles.primaryBtn, { marginTop: 20, width: '100%' }]} onPress={goToTransfer}>
                <Text style={styles.primaryBtnText}>Start Transfer</Text>
              </Pressable>
            </>
          )}

          <Pressable style={styles.cancelBtn} onPress={cancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f0f' },
  content: { padding: 24, paddingBottom: 48 },
  modeLabel: { color: '#3b82f6', marginBottom: 24, textAlign: 'center' },
  section: { marginBottom: 24 },
  sectionTitle: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 12 },
  empty: { color: '#666', marginBottom: 12 },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  fileName: { color: '#fff', fontSize: 14 },
  fileSize: { color: '#888', fontSize: 12, marginTop: 2 },
  removeBtn: { padding: 8 },
  removeText: { color: '#ef4444', fontSize: 16 },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  secondaryBtnText: { color: '#fff', fontWeight: '600' },
  primaryBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.4 },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  center: { alignItems: 'center', marginTop: 24 },
  statusText: { color: '#aaa', marginTop: 12 },
  pairingBox: {
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
  },
  pairingLabel: { color: '#aaa', marginBottom: 12 },
  pairingCode: {
    color: '#fff',
    fontSize: 36,
    fontWeight: '700',
    letterSpacing: 6,
  },
  connectedText: { color: '#22c55e', marginTop: 16, fontWeight: '600' },
  cancelBtn: { marginTop: 20 },
  cancelText: { color: '#ef4444' },
  error: { color: '#ef4444', textAlign: 'center', marginTop: 16 },
});
