import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Platform,
  Alert,
} from 'react-native';
import { Link, useFocusEffect, useRouter } from 'expo-router';
import {
  listReceivedFiles,
  requestPublicLocalDropFolder,
  hasPublicLocalDropFolder,
  initLocalDropStorage,
  type ReceivedFileRecord,
} from '../src/lib/saveReceivedFile';

type Mode = 'online' | 'offline';

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function HomeScreen() {
  const [mode, setMode] = useState<Mode>('online');
  const [recent, setRecent] = useState<ReceivedFileRecord[]>([]);
  const [hasPublic, setHasPublic] = useState(false);
  const router = useRouter();

  const refreshReceived = useCallback(async () => {
    await initLocalDropStorage();
    const list = await listReceivedFiles();
    setRecent(list.slice(0, 5));
    setHasPublic(await hasPublicLocalDropFolder());
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refreshReceived();
    }, [refreshReceived])
  );

  async function chooseFolder() {
    // Only from home — never during an active transfer (avoids disconnect)
    const ok = await requestPublicLocalDropFolder();
    if (ok) {
      Alert.alert(
        'Folder set',
        'New received files will also be saved to the folder you selected.'
      );
      setHasPublic(true);
    }
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <Text style={styles.title}>LocalDrop</Text>
      <Text style={styles.subtitle}>
        Fast peer-to-peer file transfer on the same network
      </Text>

      <View style={styles.modeContainer}>
        <Text style={styles.modeLabel}>Connection Mode</Text>
        <View style={styles.modeButtons}>
          <Pressable
            style={[styles.modeButton, mode === 'online' && styles.modeActive]}
            onPress={() => setMode('online')}
          >
            <Text style={[styles.modeText, mode === 'online' && styles.modeTextActive]}>
              Online
            </Text>
          </Pressable>
          <Pressable
            style={[styles.modeButton, mode === 'offline' && styles.modeActive]}
            onPress={() => setMode('offline')}
          >
            <Text style={[styles.modeText, mode === 'offline' && styles.modeTextActive]}>
              Offline
            </Text>
          </Pressable>
        </View>
        <Text style={styles.modeHint}>
          {mode === 'online'
            ? 'Uses signaling server for code / QR pairing'
            : 'No internet — share offer/answer on same Wi‑Fi, then send both ways'}
        </Text>
      </View>

      <View style={styles.actions}>
        <Link href={{ pathname: '/send', params: { mode } }} asChild>
          <Pressable style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>
              {mode === 'offline' ? 'Host offline session' : 'Send Files'}
            </Text>
          </Pressable>
        </Link>

        <Link href={{ pathname: '/receive', params: { mode } }} asChild>
          <Pressable style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>
              {mode === 'offline' ? 'Join offline session' : 'Receive Files'}
            </Text>
          </Pressable>
        </Link>
      </View>

      {/* Files Received */}
      <View style={styles.receivedSection}>
        <View style={styles.receivedHeader}>
          <Text style={styles.receivedTitle}>Files Received</Text>
          <Pressable onPress={() => router.push('/received')}>
            <Text style={styles.seeAll}>See all</Text>
          </Pressable>
        </View>

        {recent.length === 0 ? (
          <Text style={styles.receivedEmpty}>No files received yet</Text>
        ) : (
          recent.map((f) => (
            <Pressable
              key={f.id}
              style={styles.receivedRow}
              onPress={() => router.push('/received')}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.receivedName} numberOfLines={1}>
                  {f.name}
                </Text>
                <Text style={styles.receivedMeta}>
                  {formatBytes(f.size)} · LocalDrop
                </Text>
              </View>
            </Pressable>
          ))
        )}

        {Platform.OS === 'android' && (
          <Pressable style={styles.folderBtn} onPress={chooseFolder}>
            <Text style={styles.folderBtnText}>
              {hasPublic
                ? 'Change public LocalDrop folder'
                : 'Choose public LocalDrop folder'}
            </Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#0f0f0f' },
  container: {
    padding: 24,
    paddingBottom: 48,
  },
  title: {
    fontSize: 36,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
    marginBottom: 8,
    marginTop: 12,
  },
  subtitle: {
    fontSize: 16,
    color: '#a0a0a0',
    textAlign: 'center',
    marginBottom: 32,
  },
  modeContainer: {
    marginBottom: 28,
  },
  modeLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
  },
  modeButtons: {
    flexDirection: 'row',
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 4,
  },
  modeButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  modeActive: {
    backgroundColor: '#3b82f6',
  },
  modeText: {
    color: '#a0a0a0',
    fontWeight: '600',
  },
  modeTextActive: {
    color: '#fff',
  },
  modeHint: {
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 10,
  },
  actions: {
    gap: 12,
    marginBottom: 32,
  },
  primaryButton: {
    backgroundColor: '#3b82f6',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: '#1a1a1a',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  secondaryButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  receivedSection: {
    backgroundColor: '#141414',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#222',
  },
  receivedHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  receivedTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  seeAll: {
    color: '#3b82f6',
    fontSize: 13,
    fontWeight: '600',
  },
  receivedEmpty: {
    color: '#666',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 16,
  },
  receivedRow: {
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#222',
  },
  receivedName: { color: '#fff', fontSize: 14 },
  receivedMeta: { color: '#888', fontSize: 12, marginTop: 2 },
  folderBtn: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  folderBtnText: { color: '#3b82f6', fontSize: 12 },
});
