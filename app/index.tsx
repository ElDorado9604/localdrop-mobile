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
} from 'react-native';
import { Link, useFocusEffect, useRouter } from 'expo-router';
import {
  listReceivedFiles,
  setupPublicSaveFolder,
  hasSaveDirectory,
  getSaveDirectoryLabel,
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
  const [folderLabel, setFolderLabel] = useState('LocalDrop');
  const router = useRouter();

  const refresh = useCallback(async () => {
    setHasFolder(await hasSaveDirectory());
    setFolderLabel(await getSaveDirectoryLabel());
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
      'In the system picker, create a folder named LocalDrop (or pick an existing one). We will save files only into the folder you select — we do not create folders ourselves.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Choose',
          onPress: async () => {
            const ok = await setupPublicSaveFolder();
            if (ok) {
              Alert.alert('Ready', 'Received files will be saved to the folder you selected.');
              await refresh();
            } else {
              Alert.alert('Not set', 'Folder permission was not granted.');
            }
          },
        },
      ]
    );
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <Text style={styles.title}>LocalDrop</Text>
      <Text style={styles.subtitle}>
        Fast peer-to-peer file transfer on the same network
      </Text>

      <View style={[styles.folderBanner, !hasFolder && styles.folderBannerWarn]}>
        <Text style={styles.folderBannerTitle}>
          {hasFolder ? `Saving to: ${folderLabel}` : 'Save folder not set'}
        </Text>
        <Text style={styles.folderBannerBody}>
          {hasFolder
            ? 'Files appear in the system Files app. No duplicate copies.'
            : 'Create or select a folder in the system picker (e.g. LocalDrop under Downloads). Required before receiving.'}
        </Text>
        <Pressable style={styles.folderBtn} onPress={chooseFolder}>
          <Text style={styles.folderBtnText}>
            {hasFolder ? 'Change folder' : 'Choose save folder'}
          </Text>
        </Pressable>
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
          <Pressable
            style={styles.secondaryButton}
            onPress={(e) => {
              if (!hasFolder && Platform.OS === 'android') {
                e.preventDefault?.();
                Alert.alert(
                  'Set save folder first',
                  'Create or select a folder in the system picker so received files appear in Files.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Choose folder', onPress: () => void chooseFolder() },
                  ]
                );
              }
            }}
          >
            <Text style={styles.secondaryButtonText}>
              {mode === 'offline' ? 'Join offline session' : 'Receive Files'}
            </Text>
          </Pressable>
        </Link>
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
    backgroundColor: '#1a2332',
    borderRadius: 14,
    padding: 16,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#334155',
  },
  folderBannerWarn: {
    backgroundColor: '#2a2010',
    borderColor: '#854d0e',
  },
  folderBannerTitle: { color: '#fff', fontWeight: '700', marginBottom: 6 },
  folderBannerBody: { color: '#94a3b8', fontSize: 13, marginBottom: 12, lineHeight: 18 },
  folderBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  folderBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
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
