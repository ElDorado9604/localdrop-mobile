import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Platform,
  Alert,
  Image,
  ActivityIndicator,
} from 'react-native';
import { Link, useFocusEffect, useRouter } from 'expo-router';
import {
  listReceivedFiles,
  setupPublicSaveFolder,
  hasSaveDirectory,
  getSaveDirectoryLabel,
  ensureWritableSaveDirectory,
  testSaveFolder,
  type ReceivedFileRecord,
} from '../src/lib/saveReceivedFile';

type Mode = 'online' | 'offline';

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(item: ReceivedFileRecord): boolean {
  const m = (item.mime || '').toLowerCase();
  if (m.startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(item.name);
}

function isVideo(item: ReceivedFileRecord): boolean {
  const m = (item.mime || '').toLowerCase();
  if (m.startsWith('video/')) return true;
  return /\.(mp4|mov|webm|mkv|avi|3gp)$/i.test(item.name);
}

function typeLabel(item: ReceivedFileRecord): string {
  if (isVideo(item)) return '▶';
  const n = item.name.toLowerCase();
  if (n.endsWith('.pdf')) return 'PDF';
  if (n.endsWith('.zip') || n.endsWith('.rar')) return 'ZIP';
  return 'FILE';
}

function MiniThumb({ item }: { item: ReceivedFileRecord }) {
  if (isImage(item) && item.path) {
    return (
      <Image
        source={{ uri: item.path }}
        style={styles.miniThumb}
        resizeMode="cover"
      />
    );
  }
  return (
    <View style={[styles.miniIcon, isVideo(item) && styles.miniIconVideo]}>
      <Text style={styles.miniIconText}>{typeLabel(item)}</Text>
    </View>
  );
}

export default function HomeScreen() {
  const [mode, setMode] = useState<Mode>('online');
  const [recent, setRecent] = useState<ReceivedFileRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasFolder, setHasFolder] = useState(false);
  const [folderOk, setFolderOk] = useState(false);
  const [folderLabel, setFolderLabel] = useState('LocalDrop');
  const [testing, setTesting] = useState(false);
  const router = useRouter();

  const refresh = useCallback(async () => {
    const has = await hasSaveDirectory();
    setHasFolder(has);
    setFolderLabel(await getSaveDirectoryLabel());
    if (has) {
      const writable = await ensureWritableSaveDirectory();
      setFolderOk(writable);
      if (!writable) {
        setHasFolder(false);
        setFolderLabel('LocalDrop');
      }
    } else {
      setFolderOk(false);
    }
    const list = await listReceivedFiles();
    setTotalCount(list.length);
    setRecent(list.slice(0, 5));
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh])
  );

  async function chooseFolder() {
    Alert.alert(
      'Save folder',
      'In the system picker, create a folder named LocalDrop (or pick an existing one). We only save into the folder you select.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Choose',
          onPress: async () => {
            const ok = await setupPublicSaveFolder();
            if (ok) {
              Alert.alert('Folder OK', 'Write test passed. Ready to receive files.');
              await refresh();
            } else {
              Alert.alert(
                'Not writable',
                'Could not write to that folder. Pick LocalDrop again and allow access.'
              );
              await refresh();
            }
          },
        },
      ]
    );
  }

  async function runFolderTest() {
    setTesting(true);
    try {
      const result = await testSaveFolder();
      if (result.ok) {
        Alert.alert('Folder OK', result.message);
      } else {
        Alert.alert('Folder test failed', result.message);
      }
      await refresh();
    } finally {
      setTesting(false);
    }
  }

  function requireFolderOrAlert(): boolean {
    if (folderOk) return true;
    Alert.alert(
      'Set a writable save folder',
      'Choose a folder and confirm the write test passes before receiving files.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Choose folder', onPress: () => void chooseFolder() },
      ]
    );
    return false;
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <Text style={styles.title}>LocalDrop</Text>
      <Text style={styles.subtitle}>
        Fast peer-to-peer file transfer on the same network
      </Text>

      <View
        style={[
          styles.folderBanner,
          !hasFolder || !folderOk ? styles.folderBannerWarn : styles.folderBannerOk,
        ]}
      >
        <Text style={styles.folderBannerTitle}>
          {!hasFolder
            ? 'Save folder not set'
            : folderOk
              ? `Folder OK · ${folderLabel}`
              : `Cannot write · ${folderLabel}`}
        </Text>
        <Text style={styles.folderBannerBody}>
          {!hasFolder
            ? 'Create or select LocalDrop (e.g. under Downloads). Required before receiving.'
            : folderOk
              ? 'Write test passed. Received files go here in the system Files app.'
              : 'Permission may have expired. Choose the folder again.'}
        </Text>
        <View style={styles.folderBtnRow}>
          <Pressable style={styles.folderBtn} onPress={chooseFolder}>
            <Text style={styles.folderBtnText}>
              {hasFolder ? 'Change folder' : 'Choose save folder'}
            </Text>
          </Pressable>
          {hasFolder && (
            <Pressable
              style={[styles.folderBtnSecondary, testing && { opacity: 0.6 }]}
              onPress={() => void runFolderTest()}
              disabled={testing}
            >
              {testing ? (
                <ActivityIndicator color="#3b82f6" size="small" />
              ) : (
                <Text style={styles.folderBtnSecondaryText}>Test save folder</Text>
              )}
            </Pressable>
          )}
        </View>
      </View>

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
            : 'No internet — Create/Join room with QR or nearby on same Wi‑Fi'}
        </Text>
      </View>

      <View style={styles.actions}>
        {mode === 'offline' ? (
          <Pressable
            style={styles.primaryButton}
            onPress={() => {
              if (Platform.OS === 'android' && !requireFolderOrAlert()) return;
              router.push('/offline');
            }}
          >
            <Text style={styles.primaryButtonText}>Open Offline Transfer</Text>
          </Pressable>
        ) : (
          <>
            <Link href={{ pathname: '/send', params: { mode: 'online' } }} asChild>
              <Pressable style={styles.primaryButton}>
                <Text style={styles.primaryButtonText}>Send Files</Text>
              </Pressable>
            </Link>

            <Link href={{ pathname: '/receive', params: { mode: 'online' } }} asChild>
              <Pressable
                style={styles.secondaryButton}
                onPress={(e) => {
                  if (Platform.OS === 'android' && !folderOk) {
                    e.preventDefault?.();
                    requireFolderOrAlert();
                  }
                }}
              >
                <Text style={styles.secondaryButtonText}>Receive Files</Text>
              </Pressable>
            </Link>
          </>
        )}
      </View>

      <View style={styles.receivedSection}>
        <View style={styles.receivedHeader}>
          <Text style={styles.receivedTitle}>
            Files Received{totalCount > 0 ? ` (${totalCount})` : ''}
          </Text>
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
              <MiniThumb item={f} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.receivedName} numberOfLines={1}>
                  {f.name}
                </Text>
                <Text style={styles.receivedMeta}>
                  {formatBytes(f.size)} · {f.displayPath}
                </Text>
              </View>
            </Pressable>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#0f0f0f' },
  container: { padding: 24, paddingBottom: 48 },
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
    marginBottom: 20,
  },
  folderBanner: {
    borderRadius: 14,
    padding: 16,
    marginBottom: 24,
    borderWidth: 1,
  },
  folderBannerOk: {
    backgroundColor: '#0f1f14',
    borderColor: '#166534',
  },
  folderBannerWarn: {
    backgroundColor: '#2a2010',
    borderColor: '#854d0e',
  },
  folderBannerTitle: { color: '#fff', fontWeight: '700', marginBottom: 6 },
  folderBannerBody: { color: '#94a3b8', fontSize: 13, marginBottom: 12, lineHeight: 18 },
  folderBtnRow: { gap: 8 },
  folderBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  folderBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  folderBtnSecondary: {
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#3b82f6',
  },
  folderBtnSecondaryText: { color: '#3b82f6', fontWeight: '600', fontSize: 14 },
  modeContainer: { marginBottom: 28 },
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
  modeActive: { backgroundColor: '#3b82f6' },
  modeText: { color: '#a0a0a0', fontWeight: '600' },
  modeTextActive: { color: '#fff' },
  modeHint: {
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 10,
  },
  actions: { gap: 12, marginBottom: 32 },
  primaryButton: {
    backgroundColor: '#3b82f6',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  secondaryButton: {
    backgroundColor: '#1a1a1a',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  secondaryButtonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
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
  receivedTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  seeAll: { color: '#3b82f6', fontSize: 13, fontWeight: '600' },
  receivedEmpty: {
    color: '#666',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 16,
  },
  receivedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#222',
  },
  receivedName: { color: '#fff', fontSize: 14 },
  receivedMeta: { color: '#888', fontSize: 12, marginTop: 2 },
  miniThumb: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: '#222',
  },
  miniIcon: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: '#2a2a2a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniIconVideo: { backgroundColor: '#1e3a5f' },
  miniIconText: { color: '#94a3b8', fontSize: 10, fontWeight: '700' },
});
