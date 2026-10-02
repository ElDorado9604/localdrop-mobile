/**
 * Settings — transfer options.
 */
import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Switch,
  ScrollView,
  Pressable,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import {
  getCacheCopySmallFiles,
  setCacheCopySmallFiles,
  CACHE_COPY_MAX_BYTES,
} from '../src/lib/settings';

export default function SettingsScreen() {
  const router = useRouter();
  const [cacheCopy, setCacheCopy] = useState(true);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        const v = await getCacheCopySmallFiles();
        if (alive) {
          setCacheCopy(v);
          setLoading(false);
        }
      })();
      return () => {
        alive = false;
      };
    }, [])
  );

  async function onToggle(next: boolean) {
    setCacheCopy(next);
    await setCacheCopySmallFiles(next);
  }

  const maxMb = Math.round(CACHE_COPY_MAX_BYTES / (1024 * 1024));

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settings</Text>

      <View style={styles.card}>
        <View style={styles.row}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={styles.rowTitle}>Cache copy for small files</Text>
            <Text style={styles.rowBody}>
              If reading a picked file fails (common for Downloads), temporarily
              copy files up to {maxMb} MB into app storage, send, then delete the
              copy. Large files never use full-file cache — they always stream.
            </Text>
          </View>
          <Switch
            value={cacheCopy}
            onValueChange={(v) => void onToggle(v)}
            disabled={loading}
            trackColor={{ false: '#333', true: '#1d4ed8' }}
            thumbColor={cacheCopy ? '#3b82f6' : '#888'}
          />
        </View>
        <Text style={styles.status}>
          {cacheCopy
            ? `On — fallback copy allowed ≤ ${maxMb} MB`
            : 'Off — stream only (no full-file cache)'}
        </Text>
      </View>

      <Text style={styles.note}>
        Streaming itself never keeps the whole file in memory. A 5 MB sliding
        buffer cannot bypass Android permission denial — open must succeed first.
        This toggle only helps when native open fails and the file is small enough
        to copy once.
      </Text>

      <Pressable style={styles.back} onPress={() => router.back()}>
        <Text style={styles.backText}>Back</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f0f' },
  content: { padding: 24, paddingBottom: 48 },
  title: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 20,
    textAlign: 'center',
  },
  card: {
    backgroundColor: '#141414',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    marginBottom: 16,
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowTitle: { color: '#fff', fontWeight: '700', fontSize: 16, marginBottom: 6 },
  rowBody: { color: '#94a3b8', fontSize: 13, lineHeight: 18 },
  status: { color: '#64748b', fontSize: 12, marginTop: 12 },
  note: {
    color: '#666',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 24,
  },
  back: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  backText: { color: '#93c5fd', fontWeight: '600' },
});
