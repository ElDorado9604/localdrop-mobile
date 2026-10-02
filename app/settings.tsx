/**
 * Settings — transfer options + diagnostics.
 */
import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Switch,
  ScrollView,
  Pressable,
  Alert,
  Share,
  Platform,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import {
  getCacheCopySmallFiles,
  setCacheCopySmallFiles,
  CACHE_COPY_MAX_BYTES,
} from '../src/lib/settings';
import {
  clearLogs,
  formatLogsForExport,
  getLogEntries,
  initLogger,
  isVerboseLogging,
  setVerboseLogging,
  logInfo,
} from '../src/lib/logger';

export default function SettingsScreen() {
  const router = useRouter();
  const [cacheCopy, setCacheCopy] = useState(true);
  const [verbose, setVerbose] = useState(false);
  const [loading, setLoading] = useState(true);
  const [logText, setLogText] = useState('');
  const [logCount, setLogCount] = useState(0);
  const [showLogs, setShowLogs] = useState(false);

  const refreshLogs = useCallback(() => {
    const entries = getLogEntries();
    setLogCount(entries.length);
    setLogText(formatLogsForExport(entries));
  }, []);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        await initLogger();
        const [v, verb] = await Promise.all([
          getCacheCopySmallFiles(),
          Promise.resolve(isVerboseLogging()),
        ]);
        if (alive) {
          setCacheCopy(v);
          setVerbose(verb);
          setLoading(false);
          refreshLogs();
        }
      })();
      return () => {
        alive = false;
      };
    }, [refreshLogs])
  );

  async function onToggleCache(next: boolean) {
    setCacheCopy(next);
    await setCacheCopySmallFiles(next);
    logInfo('settings', `cache-copy ${next ? 'on' : 'off'}`);
  }

  async function onToggleVerbose(next: boolean) {
    setVerbose(next);
    await setVerboseLogging(next);
  }

  async function copyLogs() {
    refreshLogs();
    const text = formatLogsForExport(getLogEntries());
    try {
      // expo-clipboard may not be installed — fall back to Share
      try {
        // @ts-expect-error optional
        const ClipboardMod = require('expo-clipboard');
        if (ClipboardMod?.setStringAsync) {
          await ClipboardMod.setStringAsync(text);
          Alert.alert('Copied', 'Diagnostics copied to clipboard.');
          return;
        }
      } catch {
        /* */
      }
      await Share.share({ message: text });
    } catch {
      Alert.alert('Error', 'Could not copy logs');
    }
  }

  async function shareLogs() {
    refreshLogs();
    const text = formatLogsForExport(getLogEntries());
    try {
      await Share.share({
        message: text,
        title: 'LocalDrop diagnostics',
      });
      logInfo('settings', 'logs shared');
    } catch {
      Alert.alert('Error', 'Could not share logs');
    }
  }

  function onClearLogs() {
    Alert.alert('Clear logs?', 'This removes the in-app diagnostic history.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          await clearLogs();
          refreshLogs();
        },
      },
    ]);
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
            onValueChange={(v) => void onToggleCache(v)}
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

      <Text style={styles.section}>Diagnostics</Text>
      <View style={styles.card}>
        <Text style={styles.rowBody}>
          Records pairing and transfer steps on this device. Nothing is uploaded.
          Share or copy after a failure so we can see where it stopped.
        </Text>
        <Text style={styles.status}>{logCount} lines in buffer</Text>

        <View style={styles.row}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={styles.rowTitle}>Verbose WebRTC</Text>
            <Text style={styles.rowBody}>Extra ICE / channel detail (noisier).</Text>
          </View>
          <Switch
            value={verbose}
            onValueChange={(v) => void onToggleVerbose(v)}
            trackColor={{ false: '#333', true: '#1d4ed8' }}
            thumbColor={verbose ? '#3b82f6' : '#888'}
          />
        </View>

        <Pressable
          style={styles.diagBtn}
          onPress={() => {
            refreshLogs();
            setShowLogs((s) => !s);
          }}
        >
          <Text style={styles.diagBtnText}>{showLogs ? 'Hide logs' : 'View logs'}</Text>
        </Pressable>

        {showLogs && (
          <ScrollView
            style={styles.logBox}
            nestedScrollEnabled
            showsVerticalScrollIndicator
          >
            <Text style={styles.logMono} selectable>
              {logText || '(empty)'}
            </Text>
          </ScrollView>
        )}

        <View style={styles.diagRow}>
          <Pressable style={styles.diagBtnHalf} onPress={() => void copyLogs()}>
            <Text style={styles.diagBtnText}>Copy</Text>
          </Pressable>
          <Pressable style={styles.diagBtnHalf} onPress={() => void shareLogs()}>
            <Text style={styles.diagBtnText}>Share</Text>
          </Pressable>
        </View>
        <Pressable style={[styles.diagBtn, styles.diagDanger]} onPress={onClearLogs}>
          <Text style={[styles.diagBtnText, { color: '#f87171' }]}>Clear logs</Text>
        </Pressable>
      </View>

      <Text style={styles.note}>
        Platform: {Platform.OS}. Logs stay on device until you copy or share them.
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
  section: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
    marginBottom: 10,
    marginTop: 8,
  },
  card: {
    backgroundColor: '#141414',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    marginBottom: 16,
  },
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  rowTitle: { color: '#fff', fontWeight: '700', fontSize: 16, marginBottom: 6 },
  rowBody: { color: '#94a3b8', fontSize: 13, lineHeight: 18 },
  status: { color: '#64748b', fontSize: 12, marginTop: 12 },
  note: {
    color: '#666',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 24,
  },
  diagBtn: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  diagBtnHalf: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  diagRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  diagBtnText: { color: '#93c5fd', fontWeight: '600' },
  diagDanger: { borderColor: '#7f1d1d' },
  logBox: {
    marginTop: 12,
    maxHeight: 280,
    backgroundColor: '#0a0a0a',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#222',
  },
  logMono: {
    color: '#cbd5e1',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 16,
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
