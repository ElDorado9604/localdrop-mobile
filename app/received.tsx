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
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  listReceivedFiles,
  removeFromReceivedIndex,
  removeManyFromReceivedIndex,
  setupPublicSaveFolder,
  hasSaveDirectory,
  getSaveDirectoryLabel,
  resolveShareableUri,
  type ReceivedFileRecord,
} from '../src/lib/saveReceivedFile';

type ViewMode = 'list' | 'grid';

const VIEW_MODE_KEY = 'localdrop_received_view_mode';
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

function FileThumb({
  item,
  size,
  showVideoBadge,
}: {
  item: ReceivedFileRecord;
  size: number;
  showVideoBadge?: boolean;
}) {
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
      {showVideoBadge && isVideo(item) && (
        <View style={styles.playBadge}>
          <Text style={styles.playBadgeText}>▶</Text>
        </View>
      )}
    </View>
  );
}

function CheckBox({ checked }: { checked: boolean }) {
  return (
    <View style={[styles.check, checked && styles.checkOn]}>
      {checked ? <Text style={styles.checkMark}>✓</Text> : null}
    </View>
  );
}

export default function ReceivedScreen() {
  const [files, setFiles] = useState<ReceivedFileRecord[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [hasFolder, setHasFolder] = useState(false);
  const [label, setLabel] = useState('LocalDrop');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setFiles(await listReceivedFiles());
    setHasFolder(await hasSaveDirectory());
    setLabel(await getSaveDirectoryLabel());
    try {
      const saved = await AsyncStorage.getItem(VIEW_MODE_KEY);
      if (saved === 'list' || saved === 'grid') setViewMode(saved);
    } catch {
      /* */
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  async function changeViewMode(mode: ViewMode) {
    setViewMode(mode);
    await AsyncStorage.setItem(VIEW_MODE_KEY, mode).catch(() => {});
  }

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    if (selected.size === files.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(files.map((f) => f.id)));
    }
  }

  function clearSelected() {
    if (selected.size === 0) return;
    Alert.alert(
      'Clear from app list?',
      `${selected.size} file(s) will be hidden in LocalDrop. Files stay in your folder (system Files app).`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear selected',
          style: 'destructive',
          onPress: async () => {
            await removeManyFromReceivedIndex([...selected]);
            exitSelectMode();
            await load();
          },
        },
      ]
    );
  }

  async function openOrShare(item: ReceivedFileRecord) {
    try {
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Saved at', item.displayPath);
        return;
      }
      const shareUri = await resolveShareableUri(item.path, item.name);
      await Sharing.shareAsync(shareUri, {
        mimeType: item.mime || undefined,
        dialogTitle: item.name,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not open file';
      if (/no longer|not exist|ENOENT|missing/i.test(msg)) {
        Alert.alert('Missing', 'File is no longer on this device.');
        await removeFromReceivedIndex(item.id);
        await load();
        return;
      }
      Alert.alert('Error', msg);
    }
  }

  function onItemPress(item: ReceivedFileRecord) {
    if (selectMode) {
      toggleSelect(item.id);
      return;
    }
    void openOrShare(item);
  }

  async function setFolder() {
    const ok = await setupPublicSaveFolder();
    if (ok) {
      Alert.alert('Folder set', 'New files will be saved there (visible in Files).');
      await load();
    }
  }

  function renderListItem({ item }: { item: ReceivedFileRecord }) {
    const checked = selected.has(item.id);
    return (
      <Pressable
        style={[styles.row, selectMode && checked && styles.rowSelected]}
        onPress={() => onItemPress(item)}
        onLongPress={() => {
          if (!selectMode) {
            setSelectMode(true);
            setSelected(new Set([item.id]));
          }
        }}
      >
        {selectMode && <CheckBox checked={checked} />}
        <FileThumb item={item} size={52} />
        <View style={styles.rowBody}>
          <Text style={styles.name} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.meta}>
            {formatBytes(item.size)} · {formatWhen(item.receivedAt)}
          </Text>
          <Text style={styles.path} numberOfLines={2}>
            {item.displayPath}
          </Text>
        </View>
        {!selectMode && <Text style={styles.open}>Open</Text>}
      </Pressable>
    );
  }

  function renderGridItem({ item }: { item: ReceivedFileRecord }) {
    const checked = selected.has(item.id);
    return (
      <Pressable
        style={[styles.gridItem, selectMode && checked && styles.gridSelected]}
        onPress={() => onItemPress(item)}
        onLongPress={() => {
          if (!selectMode) {
            setSelectMode(true);
            setSelected(new Set([item.id]));
          }
        }}
      >
        <View>
          <FileThumb item={item} size={GRID_SIZE} showVideoBadge />
          {selectMode && (
            <View style={styles.gridCheck}>
              <CheckBox checked={checked} />
            </View>
          )}
        </View>
        <Text style={styles.gridName} numberOfLines={2}>
          {item.name}
        </Text>
        <Text style={styles.gridMeta}>{formatBytes(item.size)}</Text>
      </Pressable>
    );
  }

  const allSelected = files.length > 0 && selected.size === files.length;

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
            onPress={() => void changeViewMode('list')}
          >
            <Text style={[styles.toggleText, viewMode === 'list' && styles.toggleTextActive]}>
              List
            </Text>
          </Pressable>
          <Pressable
            style={[styles.toggleBtn, viewMode === 'grid' && styles.toggleActive]}
            onPress={() => void changeViewMode('grid')}
          >
            <Text style={[styles.toggleText, viewMode === 'grid' && styles.toggleTextActive]}>
              Grid
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Select toolbar */}
      <View style={styles.selectBar}>
        {!selectMode ? (
          <Pressable
            style={styles.selectBtn}
            onPress={() => setSelectMode(true)}
            disabled={files.length === 0}
          >
            <Text style={[styles.selectBtnText, files.length === 0 && styles.disabled]}>
              Select
            </Text>
          </Pressable>
        ) : (
          <>
            <Pressable style={styles.selectBtn} onPress={selectAll}>
              <Text style={styles.selectBtnText}>
                {allSelected ? 'Deselect all' : 'Select all'}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.clearBtn, selected.size === 0 && styles.clearBtnDisabled]}
              onPress={clearSelected}
              disabled={selected.size === 0}
            >
              <Text style={styles.clearBtnText}>
                Clear selected{selected.size > 0 ? ` (${selected.size})` : ''}
              </Text>
            </Pressable>
            <Pressable style={styles.selectBtn} onPress={exitSelectMode}>
              <Text style={styles.selectBtnText}>Done</Text>
            </Pressable>
          </>
        )}
      </View>

      {files.length > 0 && (
        <Text style={styles.count}>
          {files.length} file{files.length === 1 ? '' : 's'}
          {selectMode && selected.size > 0 ? ` · ${selected.size} selected` : ''}
        </Text>
      )}

      <FlatList
        key={viewMode + (selectMode ? '-s' : '')}
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
  selectBar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    marginTop: 12,
  },
  selectBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#333',
  },
  selectBtnText: { color: '#3b82f6', fontSize: 13, fontWeight: '600' },
  disabled: { color: '#555' },
  clearBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#3f1d1d',
    borderWidth: 1,
    borderColor: '#7f1d1d',
  },
  clearBtnDisabled: { opacity: 0.4 },
  clearBtnText: { color: '#f87171', fontSize: 13, fontWeight: '600' },
  count: {
    color: '#64748b',
    fontSize: 12,
    paddingHorizontal: 16,
    marginTop: 10,
  },
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
  rowSelected: {
    borderWidth: 1,
    borderColor: '#3b82f6',
    backgroundColor: '#152033',
  },
  rowBody: { flex: 1, marginLeft: 12 },
  name: { color: '#fff', fontWeight: '600' },
  meta: { color: '#888', fontSize: 12, marginTop: 4 },
  path: { color: '#64748b', fontSize: 11, marginTop: 2 },
  open: { color: '#3b82f6', fontWeight: '600', marginLeft: 8 },
  check: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#555',
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: {
    backgroundColor: '#3b82f6',
    borderColor: '#3b82f6',
  },
  checkMark: { color: '#fff', fontSize: 14, fontWeight: '700' },
  iconBox: {
    borderRadius: 8,
    backgroundColor: '#2a2a2a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconVideo: { backgroundColor: '#1e3a5f' },
  iconText: { color: '#94a3b8', fontWeight: '700', fontSize: 12 },
  playBadge: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: 10,
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBadgeText: { color: '#fff', fontSize: 9 },
  gridRow: { gap: GRID_GAP },
  gridItem: {
    width: GRID_SIZE,
    marginBottom: GRID_GAP,
  },
  gridSelected: { opacity: 0.95 },
  gridCheck: {
    position: 'absolute',
    top: 6,
    left: 6,
  },
  gridName: {
    color: '#fff',
    fontSize: 11,
    marginTop: 6,
    fontWeight: '500',
  },
  gridMeta: { color: '#666', fontSize: 10, marginTop: 2 },
});
