/**
 * Persistent offline session: send / receive / send more / swap direction.
 * Saves received files to the public LocalDrop folder (same as online).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import {
  getOfflineSession,
  getOfflinePeerName,
  clearOfflineSession,
} from '../src/lib/offlineSessionStore';
import {
  CHUNK_SIZE,
  ProtocolMessage,
  FileMeta,
  formatBytes,
  formatSpeed,
  randomId,
} from '../src/lib/transferProtocol';
import {
  saveReceivedFile,
  hasSaveDirectory,
  setupPublicSaveFolder,
} from '../src/lib/saveReceivedFile';

type QueuedFile = {
  id: string;
  name: string;
  size: number;
  type: string;
  uri?: string;
  status: 'pending' | 'sending' | 'receiving' | 'completed' | 'error';
  progress: number;
  error?: string;
  localPath?: string;
  displayPath?: string;
};

export default function OfflineSessionScreen() {
  const router = useRouter();
  const peerName = getOfflinePeerName();

  const [phase, setPhase] = useState<
    'ready' | 'offering' | 'transferring' | 'completed' | 'failed'
  >('ready');
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [bytesDone, setBytesDone] = useState(0);
  const [bytesTotal, setBytesTotal] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [offer, setOffer] = useState<{
    files: FileMeta[];
    totalSize: number;
    senderName: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const queueRef = useRef<QueuedFile[]>([]);
  const startTimeRef = useRef(0);
  const cancelledRef = useRef(false);
  const incomingRef = useRef<
    Map<string, { meta: FileMeta; chunks: ArrayBuffer[]; received: number; totalChunks: number }>
  >(new Map());

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  const updateFile = useCallback((id: string, patch: Partial<QueuedFile>) => {
    setQueue((prev) => {
      const next = prev.map((f) => (f.id === id ? { ...f, ...patch } : f));
      queueRef.current = next;
      return next;
    });
  }, []);

  const runSend = useCallback(async () => {
    const session = getOfflineSession();
    if (!session?.isChannelOpen()) {
      setError('Connection lost');
      setPhase('failed');
      return;
    }

    const pending = queueRef.current.filter((f) => f.status === 'pending' && f.uri);
    if (pending.length === 0) return;

    setPhase('transferring');
    cancelledRef.current = false;
    startTimeRef.current = Date.now();
    let done = 0;
    const total = pending.reduce((s, f) => s + f.size, 0);
    setBytesTotal(total);
    setBytesDone(0);

    for (let i = 0; i < pending.length; i++) {
      if (cancelledRef.current) break;
      const item = pending[i];
      updateFile(item.id, { status: 'sending', progress: 0 });

      session.sendJson({
        type: 'file-start',
        fileId: item.id,
        name: item.name,
        mime: item.type || 'application/octet-stream',
        size: item.size,
        lastModified: Date.now(),
        index: i,
        totalFiles: pending.length,
      });

      try {
        const base64 = await FileSystem.readAsStringAsync(item.uri!, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const binary = atob(base64);
        const totalChunks = Math.ceil(binary.length / CHUNK_SIZE) || 1;
        let sent = 0;

        for (let offset = 0; offset < binary.length; offset += CHUNK_SIZE) {
          if (cancelledRef.current) break;
          const slice = binary.slice(offset, offset + CHUNK_SIZE);
          const buf = new Uint8Array(slice.length);
          for (let j = 0; j < slice.length; j++) buf[j] = slice.charCodeAt(j);
          await session.sendBinary(buf.buffer);
          sent++;
          done += buf.byteLength;
          updateFile(item.id, { progress: Math.round((sent / totalChunks) * 100) });
          setBytesDone(done);
          const elapsed = (Date.now() - startTimeRef.current) / 1000;
          if (elapsed > 0.2) setSpeed(done / elapsed);
        }

        session.sendJson({ type: 'file-complete', fileId: item.id });
        updateFile(item.id, { status: 'completed', progress: 100 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Send failed';
        updateFile(item.id, { status: 'error', error: msg });
        session.sendJson({ type: 'transfer-error', message: msg });
        setPhase('failed');
        setError(msg);
        return;
      }
    }

    if (!cancelledRef.current) {
      session.sendJson({ type: 'transfer-complete' });
      session.prepareForMore();
      setPhase('completed');
    }
  }, [updateFile]);

  const handleProtocol = useCallback(
    async (data: ArrayBuffer | string) => {
      const session = getOfflineSession();
      if (typeof data !== 'string') {
        let activeId: string | null = null;
        for (const [id, buf] of incomingRef.current) {
          if (buf.received < buf.totalChunks) {
            activeId = id;
            break;
          }
        }
        if (!activeId) return;
        const buf = incomingRef.current.get(activeId)!;
        buf.chunks.push(data);
        buf.received++;
        const progress = Math.min(99, Math.round((buf.received / buf.totalChunks) * 100));
        updateFile(activeId, { progress, status: 'receiving' });
        setBytesDone((prev) => {
          const next = prev + data.byteLength;
          const elapsed = (Date.now() - startTimeRef.current) / 1000;
          if (elapsed > 0.2) setSpeed(next / elapsed);
          return next;
        });
        return;
      }

      let msg: ProtocolMessage;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      if (msg.type === 'transfer-offer') {
        setOffer({
          files: msg.files,
          totalSize: msg.totalSize,
          senderName: msg.senderName,
        });
        setBytesTotal(msg.totalSize);
        setPhase('offering');
        setQueue(
          msg.files.map((f) => ({
            id: f.id,
            name: f.name,
            size: f.size,
            type: f.type,
            status: 'pending',
            progress: 0,
          }))
        );
      } else if (msg.type === 'transfer-accepted') {
        void runSend();
      } else if (msg.type === 'transfer-rejected') {
        setPhase('ready');
        setError('Peer declined the transfer.');
      } else if (msg.type === 'file-start') {
        const totalChunks = Math.ceil(msg.size / CHUNK_SIZE) || 1;
        incomingRef.current.set(msg.fileId, {
          meta: { id: msg.fileId, name: msg.name, size: msg.size, type: msg.mime },
          chunks: [],
          received: 0,
          totalChunks,
        });
        setQueue((prev) => {
          if (prev.some((f) => f.id === msg.fileId)) {
            return prev.map((f) =>
              f.id === msg.fileId ? { ...f, status: 'receiving', progress: 0 } : f
            );
          }
          return [
            ...prev,
            {
              id: msg.fileId,
              name: msg.name,
              size: msg.size,
              type: msg.mime,
              status: 'receiving',
              progress: 0,
            },
          ];
        });
        setPhase('transferring');
        if (!startTimeRef.current) startTimeRef.current = Date.now();
      } else if (msg.type === 'file-complete') {
        const buf = incomingRef.current.get(msg.fileId);
        if (!buf) return;
        try {
          if (!(await hasSaveDirectory())) {
            const ok = await setupPublicSaveFolder();
            if (!ok) throw new Error('Save folder not set');
          }

          const full = buf.chunks.reduce((acc, c) => {
            const u = new Uint8Array(acc.byteLength + c.byteLength);
            u.set(new Uint8Array(acc), 0);
            u.set(new Uint8Array(c), acc.byteLength);
            return u.buffer;
          }, new ArrayBuffer(0));

          const bytes = new Uint8Array(full);
          let bin = '';
          const step = 0x8000;
          for (let i = 0; i < bytes.length; i += step) {
            bin += String.fromCharCode(...bytes.subarray(i, i + step));
          }
          const b64 = btoa(bin);

          const saved = await saveReceivedFile(
            buf.meta.name,
            b64,
            buf.meta.type,
            buf.meta.size
          );
          updateFile(msg.fileId, {
            status: 'completed',
            progress: 100,
            localPath: saved.path,
            displayPath: saved.displayPath,
          });
          incomingRef.current.delete(msg.fileId);
        } catch (e) {
          updateFile(msg.fileId, {
            status: 'error',
            error: e instanceof Error ? e.message : 'Save failed',
          });
        }
      } else if (msg.type === 'transfer-complete') {
        session?.prepareForMore();
        setPhase('completed');
      } else if (msg.type === 'transfer-cancelled') {
        cancelledRef.current = true;
        setPhase('ready');
        setError('Transfer cancelled');
      } else if (msg.type === 'transfer-error') {
        setPhase('failed');
        setError(msg.message);
      }
    },
    [updateFile, runSend]
  );

  useEffect(() => {
    const session = getOfflineSession();
    if (!session || !session.isChannelOpen()) {
      setError('No offline session. Pair devices first.');
      setPhase('failed');
      return;
    }

    session.prepareForMore();
    session.setHandlers({
      onMessage: (data) => void handleProtocol(data),
      onClose: () => {
        setError('Connection closed');
        setPhase('failed');
      },
      onFailed: (reason) => {
        setError(reason);
        setPhase('failed');
      },
    });
  }, [handleProtocol]);

  async function pickAndOffer() {
    const session = getOfflineSession();
    if (!session?.isChannelOpen()) {
      Alert.alert('Not connected', 'Pair devices again');
      return;
    }

    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;

      const files: QueuedFile[] = result.assets.map((a) => ({
        id: randomId(),
        name: a.name,
        size: a.size ?? 0,
        type: a.mimeType || 'application/octet-stream',
        uri: a.uri,
        status: 'pending',
        progress: 0,
      }));

      setQueue(files);
      queueRef.current = files;
      setError(null);

      const metas: FileMeta[] = files.map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        type: f.type,
      }));
      const totalSize = metas.reduce((s, m) => s + m.size, 0);
      setBytesTotal(totalSize);

      const ok = session.sendJson({
        type: 'transfer-offer',
        files: metas,
        totalSize,
        senderName: 'Android Device',
      });
      if (!ok) {
        setError('Channel not ready');
        return;
      }
      setPhase('transferring');
    } catch {
      Alert.alert('Error', 'Could not pick files');
    }
  }

  function acceptOffer() {
    getOfflineSession()?.sendJson({ type: 'transfer-accepted' });
    setOffer(null);
    setPhase('transferring');
    startTimeRef.current = Date.now();
  }

  function rejectOffer() {
    getOfflineSession()?.sendJson({ type: 'transfer-rejected', reason: 'declined' });
    setOffer(null);
    setPhase('ready');
  }

  function resetForMore() {
    setQueue([]);
    queueRef.current = [];
    setOffer(null);
    setBytesDone(0);
    setBytesTotal(0);
    setSpeed(0);
    setError(null);
    cancelledRef.current = false;
    incomingRef.current.clear();
    getOfflineSession()?.prepareForMore();
    setPhase('ready');
  }

  function endSession() {
    clearOfflineSession();
    router.replace('/');
  }

  const progress =
    bytesTotal > 0 ? Math.min(100, Math.round((bytesDone / bytesTotal) * 100)) : 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Offline session</Text>
      <Text style={styles.peer}>Peer: {peerName}</Text>
      <Text style={styles.wifiHint}>Same Wi‑Fi / hotspot · no internet needed</Text>

      {phase === 'ready' && (
        <View style={styles.center}>
          <Text style={styles.ready}>Connected — ready</Text>
          <Pressable style={styles.primaryBtn} onPress={pickAndOffer}>
            <Text style={styles.primaryBtnText}>Send files</Text>
          </Pressable>
          <Text style={styles.hint}>Or wait — the other device can send to you</Text>
        </View>
      )}

      {phase === 'offering' && offer && (
        <View style={styles.offerBox}>
          <Text style={styles.offerTitle}>{offer.senderName} wants to send:</Text>
          {offer.files.map((f) => (
            <Text key={f.id} style={styles.fileLine}>
              {f.name} ({formatBytes(f.size)})
            </Text>
          ))}
          <Text style={styles.total}>Total: {formatBytes(offer.totalSize)}</Text>
          <View style={styles.row}>
            <Pressable style={styles.acceptBtn} onPress={acceptOffer}>
              <Text style={styles.primaryBtnText}>Accept</Text>
            </Pressable>
            <Pressable style={styles.rejectBtn} onPress={rejectOffer}>
              <Text style={styles.cancelText}>Decline</Text>
            </Pressable>
          </View>
        </View>
      )}

      {phase === 'transferring' && (
        <View style={styles.progressBox}>
          <ActivityIndicator color="#3b82f6" style={{ marginBottom: 8 }} />
          <View style={styles.barBg}>
            <View style={[styles.barFill, { width: `${progress}%` }]} />
          </View>
          <Text style={styles.stats}>
            {progress}% · {formatBytes(bytesDone)} / {formatBytes(bytesTotal)}
          </Text>
          {speed > 0 && <Text style={styles.speed}>{formatSpeed(speed)}</Text>}
        </View>
      )}

      {phase === 'completed' && (
        <View style={styles.center}>
          <Text style={styles.done}>Transfer complete</Text>
          <Pressable style={styles.primaryBtn} onPress={resetForMore}>
            <Text style={styles.primaryBtnText}>Send more files</Text>
          </Pressable>
          <Pressable
            style={[styles.primaryBtn, { marginTop: 12, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#3b82f6' }]}
            onPress={() => router.push('/received')}
          >
            <Text style={[styles.primaryBtnText, { color: '#3b82f6' }]}>View Files Received</Text>
          </Pressable>
          <Text style={styles.hint}>Or wait for the other side to send</Text>
        </View>
      )}

      {queue.length > 0 && (
        <View style={styles.list}>
          {queue.map((f) => (
            <View key={f.id} style={styles.fileRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fileName} numberOfLines={1}>{f.name}</Text>
                <Text style={styles.fileMeta}>
                  {f.status === 'completed'
                    ? `Saved · ${f.displayPath || f.name}`
                    : `${f.status} · ${f.progress}% · ${formatBytes(f.size)}`}
                </Text>
              </View>
              {f.status === 'completed' && (
                <Text style={styles.savedBadge}>Saved</Text>
              )}
            </View>
          ))}
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable style={styles.endBtn} onPress={endSession}>
        <Text style={styles.endText}>End session</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f0f' },
  content: { padding: 24, paddingBottom: 48 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center' },
  peer: { color: '#3b82f6', textAlign: 'center', marginBottom: 8 },
  wifiHint: { color: '#fbbf24', fontSize: 12, textAlign: 'center', marginBottom: 20 },
  center: { alignItems: 'center', marginVertical: 24 },
  ready: { color: '#22c55e', fontWeight: '600', marginBottom: 16 },
  hint: { color: '#888', marginTop: 12, textAlign: 'center', fontSize: 13 },
  primaryBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 32,
    alignItems: 'center',
    minWidth: 200,
  },
  primaryBtnText: { color: '#fff', fontWeight: '600' },
  offerBox: {
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  offerTitle: { color: '#fff', fontWeight: '600', marginBottom: 12 },
  fileLine: { color: '#ccc', marginBottom: 4 },
  total: { color: '#888', marginTop: 8, marginBottom: 16 },
  row: { flexDirection: 'row', gap: 12 },
  acceptBtn: {
    flex: 1,
    backgroundColor: '#22c55e',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  rejectBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#444',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  cancelText: { color: '#ef4444' },
  progressBox: { marginVertical: 16, alignItems: 'center' },
  barBg: {
    height: 8,
    backgroundColor: '#333',
    borderRadius: 4,
    overflow: 'hidden',
    width: '100%',
  },
  barFill: { height: '100%', backgroundColor: '#3b82f6' },
  stats: { color: '#fff', marginTop: 8, textAlign: 'center' },
  speed: { color: '#888', textAlign: 'center', marginTop: 4 },
  list: { marginTop: 16 },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  fileName: { color: '#fff' },
  fileMeta: { color: '#888', fontSize: 12, marginTop: 2 },
  savedBadge: { color: '#22c55e', fontWeight: '700', fontSize: 12 },
  done: { color: '#22c55e', fontSize: 18, fontWeight: '700', marginBottom: 16 },
  error: { color: '#ef4444', textAlign: 'center', marginTop: 12 },
  endBtn: {
    marginTop: 32,
    borderWidth: 1,
    borderColor: '#ef4444',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  endText: { color: '#ef4444' },
});
