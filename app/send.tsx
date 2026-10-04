import { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  ScrollView,
  Alert,
  Image,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { createRoom, cancelRoom, getSocket } from '../src/lib/socket';
import { randomId } from '../src/lib/transferProtocol';
import { buildJoinUrl } from '../src/lib/config';
import { getDisplayName } from '../src/lib/deviceName';
import { logInfo, describeUri, redactName } from '../src/lib/logger';
import { setPendingFiles } from '../src/lib/pendingFilesStore';

type FileInfo = {
  id: string;
  name: string;
  size: number;
  uri: string;
  type?: string;
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

  const statusRef = useRef(status);
  statusRef.current = status;
  const activeRoomRef = useRef(false);
  const pickedAtRef = useRef<number>(0);

  useEffect(() => {
    if (isOffline) return;

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

    return () => {
      s.off('room:peer-joined', onPeerJoined);
      s.off('room:peer-left', onPeerLeft);
      s.off('room:cancelled', onCancelled);
      if (activeRoomRef.current) {
        cancelRoom();
        activeRoomRef.current = false;
      }
    };
  }, [isOffline]);

  async function pickFiles() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: false,
      });
      if (result.canceled) {
        logInfo('send', 'picker cancelled (send screen)');
        return;
      }
      const picked: FileInfo[] = result.assets.map((a) => ({
        id: randomId(),
        name: a.name,
        size: a.size ?? 0,
        uri: a.uri,
        type: a.mimeType,
      }));
      pickedAtRef.current = Date.now();
      logInfo('send', `picked on send screen: ${picked.length} file(s)`);
      picked.forEach((f, i) =>
        logInfo(
          'send',
          `picked[${i}] ${redactName(f.name)} size=${f.size}${f.size === 0 ? ' [NO SIZE]' : ''} mime=${f.type || '(none)'} ${describeUri(f.uri)}`
        )
      );
      setFiles((prev) => [...prev, ...picked]);
    } catch {
      Alert.alert('Error', 'Could not pick files');
    }
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function startSending() {
    if (isOffline) {
      router.push('/offline-host' as any);
      return;
    }

    if (files.length === 0) {
      Alert.alert('No files', 'Please select at least one file');
      return;
    }

    setError(null);
    setStatus('creating');

    const displayName = await getDisplayName();
    const res = await createRoom(displayName);
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
    activeRoomRef.current = false;
    logInfo(
      'send',
      `navigating to transfer with ${files.length} file(s); ms since last pick=${pickedAtRef.current ? Date.now() - pickedAtRef.current : 'n/a'}`
    );
    // File URIs must not travel through router params (they get percent-decoded and break
    // the SAF permission grant) — hand them over via an in-memory store instead.
    setPendingFiles(
      files.map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        type: f.type || 'application/octet-stream',
        uri: f.uri,
        status: 'pending' as const,
        progress: 0,
      }))
    );
    router.push({
      pathname: '/transfer' as any,
      params: {
        role: 'sender',
        peerName: peerName || 'peer',
        mode: mode || 'online',
      },
    });
  }

  function formatSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const joinUrl = pairingCode ? buildJoinUrl(pairingCode) : null;
  const qrImageUrl = joinUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(joinUrl)}`
    : null;

  if (isOffline) {
    return (
      <View style={styles.container}>
        <View style={styles.content}>
          <Text style={styles.modeLabel}>Mode: Offline (no internet)</Text>
          <Text style={styles.wifiHint}>
            Both phones on the same Wi‑Fi or hotspot. You will share a one-time link code (Share
            sheet), then transfer as many times as you want.
          </Text>
          <Pressable style={styles.primaryBtn} onPress={() => router.push('/offline-host' as any)}>
            <Text style={styles.primaryBtnText}>Start as Host</Text>
          </Pressable>
          <Text style={styles.offlineNote}>
            Host creates the link. The other phone uses Receive → Join offline.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.modeLabel}>Mode: Online (Signaling Server)</Text>
      <Text style={styles.wifiHint}>Both devices must be on the same Wi‑Fi (not mobile data).</Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Files to send</Text>
        {files.length === 0 ? (
          <Text style={styles.empty}>No files selected</Text>
        ) : (
          files.map((f, i) => (
            <View key={f.id} style={styles.fileRow}>
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

          {qrImageUrl && (
            <View style={styles.qrWrap}>
              <Image source={{ uri: qrImageUrl }} style={styles.qr} />
              <Text style={styles.qrHint}>
                Scan to open LocalDrop web with code filled in{'\n'}
                (or type the code in the mobile Receive screen)
              </Text>
            </View>
          )}

          {status === 'waiting' && (
            <>
              <ActivityIndicator color="#3b82f6" style={{ marginTop: 16 }} />
              <Text style={styles.statusText}>Waiting for receiver...</Text>
            </>
          )}
          {status === 'connected' && (
            <>
              <Text style={styles.connectedText}>Connected to {peerName || 'peer'}</Text>
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
  modeLabel: { color: '#3b82f6', marginBottom: 8, textAlign: 'center' },
  wifiHint: {
    color: '#fbbf24',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 20,
  },
  offlineNote: { color: '#888', textAlign: 'center', marginTop: 16, fontSize: 13 },
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
  qrWrap: { marginTop: 20, alignItems: 'center' },
  qr: { width: 180, height: 180, borderRadius: 8, backgroundColor: '#fff' },
  qrHint: { color: '#888', fontSize: 12, marginTop: 8, textAlign: 'center', lineHeight: 18 },
  connectedText: { color: '#22c55e', marginTop: 16, fontWeight: '600' },
  cancelBtn: { marginTop: 20 },
  cancelText: { color: '#ef4444' },
  error: { color: '#ef4444', textAlign: 'center', marginTop: 16 },
});
