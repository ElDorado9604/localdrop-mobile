/**
 * Connected offline room: send / receive / send more / bidirectional.
 * Streaming I/O — supports large files. Strict completion + friendly names.
 * Sender streams from original URI (no full-file cache copy).
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
import {
  getOfflineSession,
  getOfflinePeerName,
  getOfflineRoomCode,
  clearOfflineSession,
} from '../src/lib/offlineSessionStore';
import {
  CHUNK_SIZE,
  ProtocolMessage,
  FileMeta,
  formatBytes,
  formatSpeed,
  randomId,
  MAX_FILE_SIZE,
} from '../src/lib/transferProtocol';
import {
  createStreamingWriter,
  ensureWritableSaveDirectory,
  setupPublicSaveFolder,
} from '../src/lib/saveReceivedFile';
import { streamFileChunks } from '../src/lib/fileStream';
import type { ReceivedFileWriter } from '../src/lib/fileStream';
import { getDisplayName } from '../src/lib/deviceName';
import { setTransferKeepAwake } from '../src/lib/keepTransferAwake';

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
  const roomCode = getOfflineRoomCode();

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
  const phaseRef = useRef(phase);
  const bytesDoneRef = useRef(0);
  const writersRef = useRef<
    Map<
      string,
      {
        meta: FileMeta;
        writer: ReceivedFileWriter;
        receivedBytes: number;
        totalChunks: number;
      }
    >
  >(new Map());

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    void setTransferKeepAwake(phase === 'transferring');
    return () => {
      void setTransferKeepAwake(false);
    };
  }, [phase]);

  const updateFile = useCallback((id: string, patch: Partial<QueuedFile>) => {
    const next = queueRef.current.map((f) => (f.id === id ? { ...f, ...patch } : f));
    queueRef.current = next;
    setQueue(next);
  }, []);

  const allFilesOk = useCallback(() => {
    const q = queueRef.current;
    if (q.length === 0) return false;
    return q.every((f) => f.status === 'completed');
  }, []);

  const runSend = useCallback(async () => {
    const session = getOfflineSession();
    if (!session?.isChannelOpen()) {
      setError('Connection lost. Reconnect both devices to the same Wi‑Fi or hotspot.');
      setPhase('failed');
      return;
    }

    const pending = queueRef.current.filter(
      (f) => (f.status === 'pending' || f.status === 'sending') && f.uri
    );
    if (pending.length === 0) return;

    for (const f of pending) {
      if (f.size > MAX_FILE_SIZE) {
        setError(`File "${f.name}" exceeds the 200 GB limit.`);
        setPhase('failed');
        return;
      }
    }

    setPhase('transferring');
    cancelledRef.current = false;
    startTimeRef.current = Date.now();
    bytesDoneRef.current = 0;
    setBytesDone(0);
    const total = pending.reduce((s, f) => s + f.size, 0);
    setBytesTotal(total);
    const completedIds: string[] = [];

    for (let i = 0; i < pending.length; i++) {
      if (cancelledRef.current) break;
      const item = pending[i];
      updateFile(item.id, { status: 'sending', progress: 0, error: undefined });

      const okStart = session.sendJson({
        type: 'file-start',
        fileId: item.id,
        name: item.name,
        mime: item.type || 'application/octet-stream',
        size: item.size,
        lastModified: Date.now(),
        index: i,
        totalFiles: pending.length,
      });
      if (!okStart) {
        updateFile(item.id, { status: 'error', error: 'Channel closed' });
        setPhase('failed');
        setError('Connection lost while sending');
        return;
      }

      try {
        const totalChunks = Math.ceil(item.size / CHUNK_SIZE) || 1;
        let sentChunks = 0;
        let sentBytes = 0;

        await streamFileChunks(
          item.uri!,
          item.size,
          async (chunk) => {
            if (cancelledRef.current) throw new Error('Transfer cancelled');
            await session.sendBinary(chunk);
            sentChunks++;
            sentBytes += chunk.byteLength;
            const globalDone =
              pending.slice(0, i).reduce((s, f) => s + f.size, 0) + sentBytes;
            bytesDoneRef.current = Math.min(total, globalDone);
            setBytesDone(bytesDoneRef.current);
            updateFile(item.id, {
              progress: Math.min(99, Math.round((sentChunks / totalChunks) * 100)),
              status: 'sending',
            });
            const elapsed = (Date.now() - startTimeRef.current) / 1000;
            if (elapsed > 0.25) setSpeed(bytesDoneRef.current / elapsed);
          },
          { cancelled: cancelledRef.current }
        );

        if (cancelledRef.current) break;

        session.sendJson({ type: 'file-complete', fileId: item.id });
        updateFile(item.id, { status: 'completed', progress: 100 });
        completedIds.push(item.id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'File transfer failed';
        updateFile(item.id, { status: 'error', error: msg });
        session.sendJson({ type: 'transfer-error', message: msg });
        setPhase('failed');
        setError(msg);
        return;
      }
    }

    if (cancelledRef.current) return;

    if (completedIds.length === pending.length) {
      session.sendJson({ type: 'transfer-complete' });
      session.prepareForMore();
      setPhase('completed');
      setBytesDone(total);
    } else {
      setPhase('failed');
      setError('Transfer did not complete successfully');
    }
  }, [updateFile]);

  const handleProtocol = useCallback(
    async (data: ArrayBuffer | string) => {
      const session = getOfflineSession();

      if (typeof data !== 'string') {
        let activeId: string | null = null;
        for (const [id, entry] of writersRef.current) {
          if (entry.receivedBytes < entry.meta.size) {
            activeId = id;
            break;
          }
        }
        if (!activeId) return;
        const entry = writersRef.current.get(activeId)!;
        try {
          await entry.writer.writeChunk(data);
          entry.receivedBytes += data.byteLength;
          const progress = Math.min(
            99,
            Math.round((entry.receivedBytes / Math.max(1, entry.meta.size)) * 100)
          );
          updateFile(activeId, { progress, status: 'receiving' });
          setBytesDone((prev) => {
            const next = Math.min(bytesTotal || entry.meta.size, prev + data.byteLength);
            const elapsed = (Date.now() - startTimeRef.current) / 1000;
            if (elapsed > 0.25) setSpeed(next / elapsed);
            return next;
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Write failed';
          updateFile(activeId, { status: 'error', error: msg });
          try {
            await entry.writer.abort();
          } catch {
            /* */
          }
          writersRef.current.delete(activeId);
          session?.sendJson({ type: 'transfer-error', message: msg });
          setPhase('failed');
          setError(msg);
        }
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
          senderName: msg.senderName || 'Peer',
        });
        setBytesTotal(msg.totalSize);
        setBytesDone(0);
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
        setQueue((prev) => {
          const next = prev.map((f) =>
            f.status === 'pending' && f.uri
              ? { ...f, status: 'sending' as const, progress: 0 }
              : f
          );
          queueRef.current = next;
          return next;
        });
        setPhase('transferring');
        startTimeRef.current = Date.now();
        void runSend();
      } else if (msg.type === 'transfer-rejected') {
        setPhase('ready');
        setError('File transfer was declined.');
      } else if (msg.type === 'file-start') {
        const totalChunks = Math.ceil(msg.size / CHUNK_SIZE) || 1;

        if (!(await ensureWritableSaveDirectory())) {
          const ok = await setupPublicSaveFolder();
          if (!ok) {
            const errMsg =
              'Save folder is not writable. Open Home and choose the LocalDrop folder again.';
            updateFile(msg.fileId, { status: 'error', error: errMsg });
            session?.sendJson({ type: 'transfer-error', message: errMsg });
            setPhase('failed');
            setError(errMsg);
            return;
          }
        }

        try {
          const writer = await createStreamingWriter(msg.name, msg.mime, msg.size);
          writersRef.current.set(msg.fileId, {
            meta: { id: msg.fileId, name: msg.name, size: msg.size, type: msg.mime },
            writer,
            receivedBytes: 0,
            totalChunks,
          });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : 'Could not create writer';
          updateFile(msg.fileId, { status: 'error', error: errMsg });
          session?.sendJson({ type: 'transfer-error', message: errMsg });
          setPhase('failed');
          setError(errMsg);
          return;
        }

        setQueue((prev) => {
          if (prev.some((f) => f.id === msg.fileId)) {
            return prev.map((f) =>
              f.id === msg.fileId
                ? { ...f, status: 'receiving', progress: 0, error: undefined }
                : f
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
        const entry = writersRef.current.get(msg.fileId);
        if (!entry) return;

        if (entry.receivedBytes < entry.meta.size * 0.98) {
          const errMsg = `Incomplete file: got ${formatBytes(entry.receivedBytes)} of ${formatBytes(entry.meta.size)}`;
          updateFile(msg.fileId, { status: 'error', error: errMsg });
          try {
            await entry.writer.abort();
          } catch {
            /* */
          }
          writersRef.current.delete(msg.fileId);
          session?.sendJson({ type: 'transfer-error', message: errMsg });
          setPhase('failed');
          setError(errMsg);
          return;
        }

        try {
          const saved = await entry.writer.finish();
          updateFile(msg.fileId, {
            status: 'completed',
            progress: 100,
            localPath: saved.path,
            displayPath: saved.displayPath,
          });
          writersRef.current.delete(msg.fileId);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : 'Save failed';
          updateFile(msg.fileId, { status: 'error', error: errMsg });
          try {
            await entry.writer.abort();
          } catch {
            /* */
          }
          writersRef.current.delete(msg.fileId);
          session?.sendJson({ type: 'transfer-error', message: errMsg });
          setPhase('failed');
          setError(errMsg);
        }
      } else if (msg.type === 'transfer-complete') {
        if (allFilesOk()) {
          session?.prepareForMore();
          setPhase('completed');
        } else {
          const hasError = queueRef.current.some((f) => f.status === 'error');
          if (hasError) {
            setPhase('failed');
            setError('Transfer finished with errors');
          }
        }
      } else if (msg.type === 'transfer-cancelled') {
        cancelledRef.current = true;
        for (const [, entry] of writersRef.current) {
          try {
            await entry.writer.abort();
          } catch {
            /* */
          }
        }
        writersRef.current.clear();
        setPhase('ready');
        setError('Transfer cancelled');
      } else if (msg.type === 'transfer-error') {
        cancelledRef.current = true;
        for (const [, entry] of writersRef.current) {
          entry.writer.abort().catch(() => {});
        }
        writersRef.current.clear();
        setPhase('failed');
        setError(msg.message || 'Transfer error');
      }
    },
    [updateFile, runSend, allFilesOk, bytesTotal]
  );

  useEffect(() => {
    const session = getOfflineSession();
    if (!session || !session.isChannelOpen()) {
      setError('This room is no longer active. Ask the other device to create a new room.');
      setPhase('failed');
      return;
    }

    session.prepareForMore();
    session.setHandlers({
      onMessage: (data) => void handleProtocol(data),
      onClose: () => {
        cancelledRef.current = true;
        for (const [, entry] of writersRef.current) {
          entry.writer.abort().catch(() => {});
        }
        writersRef.current.clear();
        setError('The other device has left the room.');
        setPhase('failed');
      },
      onFailed: (reason) => {
        cancelledRef.current = true;
        for (const [, entry] of writersRef.current) {
          entry.writer.abort().catch(() => {});
        }
        writersRef.current.clear();
        setError(reason);
        setPhase('failed');
      },
    });
  }, [handleProtocol]);

  async function pickAndOffer() {
    const session = getOfflineSession();
    if (!session?.isChannelOpen()) {
      Alert.alert('Not connected', 'Create or join a room again');
      return;
    }

    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: false,
      });
      if (result.canceled || !result.assets?.length) return;

      const displayName = await getDisplayName();

      const files: QueuedFile[] = result.assets.map((a) => ({
        id: randomId(),
        name: a.name,
        size: a.size ?? 0,
        type: a.mimeType || 'application/octet-stream',
        uri: a.uri,
        status: 'pending',
        progress: 0,
      }));

      const tooBig = files.find((f) => f.size > MAX_FILE_SIZE);
      if (tooBig) {
        Alert.alert('File too large', `"${tooBig.name}" exceeds the 200 GB limit.`);
        return;
      }

      setQueue(files);
      queueRef.current = files;
      setError(null);
      setBytesDone(0);
      bytesDoneRef.current = 0;

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
        senderName: displayName,
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
    setBytesDone(0);
    bytesDoneRef.current = 0;
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
    bytesDoneRef.current = 0;
    setBytesTotal(0);
    setSpeed(0);
    setError(null);
    cancelledRef.current = false;
    startTimeRef.current = 0;
    for (const [, entry] of writersRef.current) {
      entry.writer.abort().catch(() => {});
    }
    writersRef.current.clear();
    getOfflineSession()?.prepareForMore();
    setPhase('ready');
  }

  function leaveRoom() {
    const transferring = phaseRef.current === 'transferring';
    Alert.alert(
      'Leave this room?',
      transferring
        ? 'A file transfer is in progress. Leaving will cancel the transfer.'
        : 'The current connection will be closed.',
      [
        { text: 'Stay', style: 'cancel' },
        {
          text: 'Leave Room',
          style: 'destructive',
          onPress: () => {
            cancelledRef.current = true;
            try {
              getOfflineSession()?.sendJson({ type: 'transfer-cancelled' });
            } catch {
              /* */
            }
            for (const [, entry] of writersRef.current) {
              entry.writer.abort().catch(() => {});
            }
            writersRef.current.clear();
            setTimeout(() => {
              clearOfflineSession();
              router.replace('/offline');
            }, 150);
          },
        },
      ]
    );
  }

  const progress =
    bytesTotal > 0 ? Math.min(100, Math.round((bytesDone / bytesTotal) * 100)) : 0;

  const hasErrors = queue.some((f) => f.status === 'error');

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Connected</Text>
      <Text style={styles.peer}>Peer: {peerName || 'Unknown'}</Text>
      {!!roomCode && <Text style={styles.code}>Room {roomCode}</Text>}
      <Text style={styles.wifiHint}>Same Wi‑Fi / hotspot · no internet needed</Text>

      {phase === 'ready' && (
        <View style={styles.center}>
          <Text style={styles.ready}>Ready — send or receive files</Text>
          <Pressable style={styles.primaryBtn} onPress={pickAndOffer}>
            <Text style={styles.primaryBtnText}>Send Files</Text>
          </Pressable>
          <Text style={styles.hint}>Or wait — the other device can send to you</Text>
        </View>
      )}

      {phase === 'offering' && offer && (
        <View style={styles.offerBox}>
          <Text style={styles.offerTitle}>
            <Text style={{ fontWeight: '700', color: '#fff' }}>{offer.senderName}</Text>
            {' wants to send:'}
          </Text>
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
          <Text style={styles.keepHint}>Keep this screen open during transfer</Text>
        </View>
      )}

      {phase === 'completed' && !hasErrors && (
        <View style={styles.center}>
          <Text style={styles.done}>Files transferred successfully</Text>
          <Text style={styles.hint}>Send or receive more files</Text>
          <Pressable style={styles.primaryBtn} onPress={resetForMore}>
            <Text style={styles.primaryBtnText}>Send More Files</Text>
          </Pressable>
          <Pressable
            style={[styles.primaryBtn, styles.outlineBtn]}
            onPress={() => router.push('/received')}
          >
            <Text style={[styles.primaryBtnText, { color: '#3b82f6' }]}>
              View Received Files
            </Text>
          </Pressable>
        </View>
      )}

      {phase === 'failed' && (
        <View style={styles.center}>
          <Text style={styles.failedTitle}>Transfer failed</Text>
          <Pressable style={styles.primaryBtn} onPress={resetForMore}>
            <Text style={styles.primaryBtnText}>Try Again</Text>
          </Pressable>
        </View>
      )}

      {queue.length > 0 && (
        <View style={styles.list}>
          {queue.map((f) => (
            <View key={f.id} style={styles.fileRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fileName} numberOfLines={1}>
                  {f.name}
                </Text>
                <Text style={styles.fileMeta}>
                  {f.status === 'completed'
                    ? f.uri
                      ? `Sent · ${formatBytes(f.size)}`
                      : `Saved · ${f.displayPath || f.name}`
                    : f.status === 'error'
                      ? `Error · ${f.error || 'failed'}`
                      : `${f.status} · ${f.progress}% · ${formatBytes(f.size)}`}
                </Text>
              </View>
              {f.status === 'completed' && (
                <Text style={styles.savedBadge}>{f.uri ? 'Sent' : 'Saved'}</Text>
              )}
              {f.status === 'error' && <Text style={styles.errorBadge}>Error</Text>}
            </View>
          ))}
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable style={styles.endBtn} onPress={leaveRoom}>
        <Text style={styles.endText}>Leave Room</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f0f' },
  content: { padding: 24, paddingBottom: 48 },
  title: { color: '#22c55e', fontSize: 22, fontWeight: '700', textAlign: 'center' },
  peer: { color: '#3b82f6', textAlign: 'center', marginBottom: 4 },
  code: { color: '#94a3b8', textAlign: 'center', marginBottom: 8 },
  wifiHint: { color: '#fbbf24', fontSize: 12, textAlign: 'center', marginBottom: 20 },
  center: { alignItems: 'center', marginVertical: 24 },
  ready: { color: '#22c55e', fontWeight: '600', marginBottom: 16 },
  hint: { color: '#888', marginTop: 12, textAlign: 'center', fontSize: 13 },
  keepHint: { color: '#fbbf24', fontSize: 11, marginTop: 8, textAlign: 'center' },
  primaryBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 32,
    alignItems: 'center',
    minWidth: 200,
    marginTop: 8,
  },
  outlineBtn: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#3b82f6',
  },
  primaryBtnText: { color: '#fff', fontWeight: '600' },
  offerBox: {
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  offerTitle: { color: '#ccc', marginBottom: 12 },
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
  fileName: { color: '#fff', fontSize: 14 },
  fileMeta: { color: '#888', fontSize: 12, marginTop: 2 },
  savedBadge: { color: '#22c55e', fontWeight: '600', fontSize: 12 },
  errorBadge: { color: '#ef4444', fontWeight: '600', fontSize: 12 },
  error: { color: '#ef4444', textAlign: 'center', marginTop: 16 },
  endBtn: {
    marginTop: 32,
    borderWidth: 1,
    borderColor: '#ef4444',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  endText: { color: '#ef4444', fontWeight: '600' },
  done: { color: '#22c55e', fontWeight: '700', fontSize: 18, marginBottom: 8 },
  failedTitle: { color: '#ef4444', fontWeight: '700', fontSize: 18, marginBottom: 12 },
});
