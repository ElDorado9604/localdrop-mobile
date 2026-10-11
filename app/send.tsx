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
import { createRoom, cancelRoom, getSocket } from '../src/lib/socket';
import { buildJoinUrl } from '../src/lib/config';
import { getDisplayName } from '../src/lib/deviceName';
import { clearPendingFiles } from '../src/lib/pendingFilesStore';

export default function SendScreen() {
  const { mode } = useLocalSearchParams<{ mode: string }>();
  const router = useRouter();
  const isOffline = mode === 'offline';

  const [status, setStatus] = useState<'idle' | 'creating' | 'waiting' | 'connected'>('idle');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [peerName, setPeerName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const statusRef = useRef(status);
  statusRef.current = status;
  const activeRoomRef = useRef(false);

  useEffect(() => {
    if (isOffline) return;

    const s = getSocket();

    // Same as the web app: once the receiver joins, go straight to the transfer
    // screen (WebRTC connects there); files are picked AFTER the link is up.
    const onPeerJoined = (data: { peerName: string }) => {
      setPeerName(data.peerName);
      setStatus('connected');
      activeRoomRef.current = false;
      clearPendingFiles();
      router.push({
        pathname: '/transfer' as any,
        params: { role: 'sender', peerName: data.peerName || 'peer', mode: 'online' },
      });
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

  async function startSending() {
    if (isOffline) {
      router.push('/offline-host' as any);
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
      <Text style={styles.offlineNote}>
        Create a pairing code, let the other device join, then choose the files to send.
      </Text>

      {status === 'idle' && (
        <Pressable style={styles.primaryBtn} onPress={startSending}>
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
