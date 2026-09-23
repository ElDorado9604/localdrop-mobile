import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  RefreshControl,
  Alert,
  Platform,
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

export default function ReceivedScreen() {
  const [files, setFiles] = useState<ReceivedFileRecord[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [hasFolder, setHasFolder] = useState(false);
  const [label, setLabel] = useState('LocalDrop');

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

  return (
    <View style={styles.container}>
      <Text style={styles.subtitle}>
        {hasFolder
          ? `Only LocalDrop receives · ${label}`
          : 'Set a save folder to store received files in the system Files app'}
      </Text>

      <Pressable style={styles.folderBtn} onPress={setFolder}>
        <Text style={styles.folderBtnText}>
          {hasFolder ? 'Change save folder' : 'Choose save folder'}
        </Text>
      </Pressable>

      <FlatList
        data={files}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#3b82f6" />
        }
        ListEmptyComponent={
          <Text style={styles.empty}>No files received via LocalDrop yet</Text>
        }
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => openOrShare(item)}>
            <View style={{ flex: 1 }}>
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
        )}
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
  folderBtn: {
    marginHorizontal: 24,
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  folderBtnText: { color: '#3b82f6', fontSize: 13 },
  list: { padding: 16, paddingBottom: 40 },
  empty: { color: '#666', textAlign: 'center', marginTop: 48 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  name: { color: '#fff', fontWeight: '600' },
  meta: { color: '#888', fontSize: 12, marginTop: 4 },
  path: { color: '#64748b', fontSize: 11, marginTop: 2 },
  open: { color: '#3b82f6', fontWeight: '600', marginLeft: 12 },
});
