import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  RefreshControl,
  Alert,
  Image,
  Dimensions,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import {
  listReceivedFiles,
  removeFromReceivedIndex,
  setupPublicSaveFolder,
  hasSaveDirectory,
  getSaveDirectoryLabel,
  type ReceivedFileRecord,
} from '../src/lib/saveReceivedFile';

type ViewMode = 'list' | 'grid';

const GRID_GAP = 10;
const GRID_COLS = 3;
const GRID_SIZE =
  (Dimensions.get('window').width - 32 - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(ts: number) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
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

function fileTypeIcon(item: ReceivedFileRecord): string {
  if (isVideo(item)) return '▶';
  const m = (item.mime || '').toLowerCase();
  const n = item.name.toLowerCase();
  if (m.includes('pdf') || n.endsWith('.pdf')) return 'PDF';
  if (m.includes('zip') || n.endsWith('.zip') || n.endsWith('.rar')) return 'ZIP';
  if (m.includes('audio') || /\.(mp3|wav|m4a|aac)$/i.test(n)) return 'AUD';
  if (m.includes('text') || /\.(txt|md|csv|json)$/i.test(n)) return 'TXT';
  if (/\.(doc|docx)$/i.test(n)) return 'DOC';
  if (/\.(xls|xlsx)$/i.test(n)) return 'XLS';
  return 'FILE';
}

function FileThumb({ item, size }: { item: ReceivedFileRecord; size: number }) {
  if (isImage(item) && item.path) {
    return (
      <Image
        source={{ uri: item.path }}
        style={{ width: size, height: size, borderRadius: 8, backgroundColor: '#222' }}
        resizeMode="cover"
      />
    );
  }
  return (
    <View
      style={[
        styles.iconBox,
        { width: size, height: size },
        isVideo(item) && styles.iconVideo,
      ]}
    >
      <Text style={styles.iconText}>{fileTypeIcon(item)}</Text>
    </View>
  );
}

export default function ReceivedScreen() {
  const [files, setFiles] = useState<ReceivedFileRecord[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [hasFolder, setHasFolder] = useState(false);
  const [label, setLabel] = useState('LocalDrop');
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  const load = useCallback(async () => {
    setFiles(await listReceivedFiles());
    setHasFolder(await hasSaveDirectory());
    setLabel(await getSaveDirectoryLabel());
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function openOrShare(item: ReceivedFileRecord) {
    try {
      if (item.path.startsWith('content://') || item.path.startsWith('file://')) {
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(item.path);
          return;
        }
      }
      const info = await FileSystem.getInfoAsync(item.path);
      if (!info.exists) {
        Alert.alert('Missing', 'File is no longer on this device.');
        await removeFromReceivedIndex(item.id);
        await load();
        return;
      }
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(item.path);
      } else {
        Alert.alert('Saved', item.displayPath);
      }
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not open file');
    }
  }

  async function setFolder() {
    const ok = await setupPublicSaveFolder();
    if (ok) {
      Alert.alert('Folder set', 'New files will be saved there (visible in Files).');
      await load();
    }
  }

  function renderListItem({ item }: { item: ReceivedFileRecord }) {
    return (
      <Pressable style={styles.row} onPress={() => openOrShare(item)}>
        <FileThumb item={item} size={52} />
        <View style={styles.rowBody}>
          <Text style={styles.name} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.meta}>
            {formatBytes(item.size)} · {formatWhen(item.receivedAt)}
          </Text>
          <Text style={styles.path} numberOfLines={1}>
            {item.displayPath}
          </Text>
        </View>
        <Text style={styles.open}>Open</Text>
      </Pressable>
    );
  }

  function renderGridItem({ item }: { item: ReceivedFileRecord }) {
    return (
      <Pressable style={styles.gridItem} onPress={() => openOrShare(item)}>
        <FileThumb item={item} size={GRID_SIZE} />
        <Text style={styles.gridName} numberOfLines={2}>
          {item.name}
        </Text>
        <Text style={styles.gridMeta}>{formatBytes(item.size)}</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.subtitle}>
        {hasFolder
          ? `Only LocalDrop receives · ${label}`
          : 'Set a save folder to store received files in the system Files app'}
      </Text>

      <View style={styles.toolbar}>
        <Pressable style={styles.folderBtn} onPress={setFolder}>
          <Text style={styles.folderBtnText}>
            {hasFolder ? 'Change folder' : 'Choose folder'}
          </Text>
        </Pressable>

        <View style={styles.viewToggle}>
          <Pressable
            style={[styles.toggleBtn, viewMode === 'list' && styles.toggleActive]}
            onPress={() => setViewMode('list')}
          >
            <Text style={[styles.toggleText, viewMode === 'list' && styles.toggleTextActive]}>
              List
            </Text>
          </Pressable>
          <Pressable
            style={[styles.toggleBtn, viewMode === 'grid' && styles.toggleActive]}
            onPress={() => setViewMode('grid')}
          >
            <Text style={[styles.toggleText, viewMode === 'grid' && styles.toggleTextActive]}>
              Grid
            </Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        key={viewMode}
        data={files}
        keyExtractor={(item) => item.id}
        numColumns={viewMode === 'grid' ? GRID_COLS : 1}
        columnWrapperStyle={viewMode === 'grid' ? styles.gridRow : undefined}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#3b82f6" />
        }
        ListEmptyComponent={
          <Text style={styles.empty}>No files received via LocalDrop yet</Text>
        }
        contentContainerStyle={styles.list}
        renderItem={viewMode === 'grid' ? renderGridItem : renderListItem}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f0f' },
  subtitle: {
    color: '#888',
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 24,
    paddingTop: 12,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginTop: 12,
    gap: 12,
  },
  folderBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  folderBtnText: { color: '#3b82f6', fontSize: 13, fontWeight: '600' },
  viewToggle: {
    flexDirection: 'row',
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    padding: 3,
  },
  toggleBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  toggleActive: { backgroundColor: '#3b82f6' },
  toggleText: { color: '#888', fontSize: 13, fontWeight: '600' },
  toggleTextActive: { color: '#fff' },
  list: { padding: 16, paddingBottom: 40 },
  empty: { color: '#666', textAlign: 'center', marginTop: 48 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  rowBody: { flex: 1, marginLeft: 12 },
  name: { color: '#fff', fontWeight: '600' },
  meta: { color: '#888', fontSize: 12, marginTop: 4 },
  path: { color: '#64748b', fontSize: 11, marginTop: 2 },
  open: { color: '#3b82f6', fontWeight: '600', marginLeft: 8 },
  iconBox: {
    borderRadius: 8,
    backgroundColor: '#2a2a2a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconVideo: { backgroundColor: '#1e3a5f' },
  iconText: { color: '#94a3b8', fontWeight: '700', fontSize: 12 },
  gridRow: { gap: GRID_GAP },
  gridItem: {
    width: GRID_SIZE,
    marginBottom: GRID_GAP,
  },
  gridName: {
    color: '#fff',
    fontSize: 11,
    marginTop: 6,
    fontWeight: '500',
  },
  gridMeta: { color: '#666', fontSize: 10, marginTop: 2 },
});
