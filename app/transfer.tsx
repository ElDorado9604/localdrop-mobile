import { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  getSocket,
  sendSignal,
  emitTransferStarted,
  emitRoomComplete,
  takePendingSignals,
} from '../src/lib/socket';
import { WebRTCSession } from '../src/lib/webrtcSession';
import {
  ONLINE_CHUNK_SIZE,
  ProtocolMessage,
  FileMeta,
  formatBytes,
  formatSpeed,
  MAX_FILE_SIZE,
} from '../src/lib/transferProtocol';
import {
  createStreamingWriter,
  ensureAppLocalDropDir,
  ensureWritableSaveDirectory,
  setupPublicSaveFolder,
} from '../src/lib/saveReceivedFile';
import { streamFileChunks } from '../src/lib/fileStream';
import type { ReceivedFileWriter } from '../src/lib/fileStream';
import { getDisplayName } from '../src/lib/deviceName';

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

export default function TransferScreen() {
  const params = useLocalSearchParams<{
    role?: string;
    peerName?: string;
    mode?: string;
    filesJson?: string;
  }>();
  const router = useRouter();
  const role = (params.role as 'sender' | 'receiver') || 'sender';
  const peerName = params.peerName || 'peer';
  const mode = params.mode || 'online';

  const [phase, setPhase] = useState<
    'connecting' | 'ready' | 'offering' | 'transferring' | 'completed' | 'failed'
  >('connecting');
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
  const [saveHint, setSaveHint] = useState<string | null>(null);

  const sessionRef = useRef<WebRTCSession | null>(null);
  const startTimeRef = useRef(0);
  const queueRef = useRef<QueuedFile[]>([]);
  const offerSentRef = useRef(false);
  const cancelledRef = useRef(false);
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
  /** Serialize data-channel handling so file-complete never races ahead of writes */
  const msgQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    void ensureAppLocalDropDir();
  }, []);

  useEffect(() => {
    if (role === 'sender' && params.filesJson) {
      try {
        const files = JSON.parse(params.filesJson as string) as QueuedFile[];
        const normalized = files.map((f) => ({
          ...f,
          status: 'pending' as const,
          progress: 0,
        }));
        setQueue(normalized);
        queueRef.current = normalized;
      } catch {
        setError('Could not load file list');
      }
    }
  }, [role, params.filesJson]);

  const updateFile = useCallback((id: string, patch: Partial<QueuedFile>) => {
    setQueue((prev) => {
      const next = prev.map((f) => (f.id === id ? { ...f, ...patch } : f));
      queueRef.current = next;
      return next;
    });
  }, []);

  const allFilesOk = useCallback(() => {
    const q = queueRef.current;
    return q.length > 0 && q.every((f) => f.status === 'completed');
  }, []);

  const runSend = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;

    const pending = queueRef.current.filter((f) => f.status === 'pending' && f.uri);
    if (pending.length === 0) {
      setError('No files to send');
      setPhase('failed');
      return;
    }

    for (const f of pending) {
      if (f.size > MAX_FILE_SIZE) {
        setError(`File "${f.name}" exceeds the 200 GB limit.`);
        setPhase('failed');
        return;
      }
    }

    setPhase('transferring');
    emitTransferStarted();
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
        const totalChunks = Math.ceil(item.size / ONLINE_CHUNK_SIZE) || 1;
        let sent = 0;

        await streamFileChunks(
          item.uri!,
          item.size,
          async (chunk) => {
            if (cancelledRef.current) throw new Error('Transfer cancelled');
            await session.sendBinary(chunk);
            sent++;
            done += chunk.byteLength;
            updateFile(item.id, {
              progress: Math.min(99, Math.round((sent / totalChunks) * 100)),
              status: 'sending',
            });
            setBytesDone(Math.min(total, done));
            const elapsed = (Date.now() - startTimeRef.current) / 1000;
            if (elapsed > 0.25) setSpeed(done / elapsed);
          },
          { cancelled: cancelledRef.current },
          ONLINE_CHUNK_SIZE
        );

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

    if (!cancelledRef.current && allFilesOk()) {
      session.sendJson({ type: 'transfer-complete' });
      setPhase('completed');
      session.markCompleted();
      emitRoomComplete();
    } else if (!cancelledRef.current) {
      setPhase('failed');
      setError('Transfer did not complete successfully');
    }
  }, [updateFile, allFilesOk]);

  const sendTransferOffer = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || !session.isChannelOpen()) return;
    if (offerSentRef.current) return;

    const pending = queueRef.current.filter((f) => f.status === 'pending');
    if (pending.length === 0) return;

    const displayName = await getDisplayName();
    const metas: FileMeta[] = pending.map((q) => ({
      id: q.id,
      name: q.name,
      size: q.size,
      type: q.type || 'application/octet-stream',
    }));
    const totalSize = metas.reduce((s, m) => s + m.size, 0);
    setBytesTotal(totalSize);
    offerSentRef.current = true;

    const ok = session.sendJson({
      type: 'transfer-offer',
      files: metas,
      totalSize,
      senderName: displayName,
    });
    if (!ok) {
      offerSentRef.current = false;
      setError('Data channel not ready');
      return;
    }
    setPhase('transferring');
  }, []);

  const handleProtocol = useCallback(
    async (data: ArrayBuffer | string) => {
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
            const next = prev + data.byteLength;
            const elapsed = (Date.now() - startTimeRef.current) / 1000;
            if (elapsed > 0.25) setSpeed(next / elapsed);
            return next;
          });
        } catch (e) {
          updateFile(activeId, {
            status: 'error',
            error: e instanceof Error ? e.message : 'Write failed',
          });
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
        setPhase('failed');
        setError('Receiver declined the transfer.');
      } else if (msg.type === 'file-start') {
        const totalChunks = Math.ceil(msg.size / ONLINE_CHUNK_SIZE) || 1;

        if (!(await ensureWritableSaveDirectory())) {
          const ok = await setupPublicSaveFolder();
          if (!ok) {
            updateFile(msg.fileId, {
              status: 'error',
              error: 'Save folder is not writable. Open Home and choose the LocalDrop folder again.',
            });
            setPhase('failed');
            setError('Save folder is not writable. Open Home and choose the LocalDrop folder again.');
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
          updateFile(msg.fileId, {
            status: 'error',
            error: e instanceof Error ? e.message : 'Could not create writer',
          });
          return;
        }

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
        const entry = writersRef.current.get(msg.fileId);
        if (!entry) return;

        const target = entry.meta.size;
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const written = Math.max(
            entry.receivedBytes,
            entry.writer.getWrittenBytes?.() ?? 0
          );
          entry.receivedBytes = written;
          if (written >= target) break;
          if (target > 0 && written / target >= 0.999) break;
          await new Promise((r) => setTimeout(r, 40));
        }

        const finalBytes = Math.max(
          entry.receivedBytes,
          entry.writer.getWrittenBytes?.() ?? 0
        );
        entry.receivedBytes = finalBytes;

        if (finalBytes < target * 0.995) {
          const errMsg = `Incomplete: ${formatBytes(finalBytes)} of ${formatBytes(target)}`;
          updateFile(msg.fileId, { status: 'error', error: errMsg });
          try {
            await entry.writer.abort();
          } catch {
            /* */
          }
          writersRef.current.delete(msg.fileId);
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
          setSaveHint(`Saved to ${saved.displayPath}`);
          writersRef.current.delete(msg.fileId);
        } catch (e) {
          updateFile(msg.fileId, {
            status: 'error',
            error: e instanceof Error ? e.message : 'Save failed',
          });
          try {
            await entry.writer.abort();
          } catch {
            /* */
          }
          writersRef.current.delete(msg.fileId);
        }
      } else if (msg.type === 'transfer-complete') {
        if (allFilesOk()) {
          setPhase('completed');
          sessionRef.current?.markCompleted();
          emitRoomComplete();
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
        setPhase('failed');
        setError('Transfer cancelled.');
      } else if (msg.type === 'transfer-error') {
        setPhase('failed');
        setError(msg.message);
      }
    },
    [updateFile, runSend, allFilesOk]
  );

  useEffect(() => {
    let available = false;
    try {
      require('react-native-webrtc');
      available = true;
    } catch {
      available = false;
    }

    if (!available) {
      setError('WebRTC is not available. Use the latest development APK, not Expo Go.');
      setPhase('failed');
      return;
    }

    const session = new WebRTCSession((type, payload) => {
      if (mode === 'online') {
        if (type === 'offer') sendSignal('offer', { sdp: payload });
        else if (type === 'answer') sendSignal('answer', { sdp: payload });
        else sendSignal('ice-candidate', { candidate: payload });
      }
    });

    session.setHandlers({
      onOpen: () => {
        setPhase('ready');
        setError(null);
        if (role === 'sender') {
          setTimeout(() => void sendTransferOffer(), 400);
        }
      },
      onMessage: (data) => {
        msgQueueRef.current = msgQueueRef.current
          .then(() => handleProtocol(data))
          .catch(() => {});
      },
      onClose: () => {},
      onFailed: (reason) => {
        setError(reason);
        setPhase('failed');
      },
    });

    sessionRef.current = session;

    const s = getSocket();
    if (mode === 'online' && !s.connected) s.connect();

    const onOffer = (p: { sdp: any }) => void session.handleOffer(p.sdp);
    const onAnswer = (p: { sdp: any }) => void session.handleAnswer(p.sdp);
    const onIce = (p: { candidate: any }) => void session.handleIce(p.candidate);

    if (mode === 'online') {
      s.off('signal:offer');
      s.off('signal:answer');
      s.off('signal:ice-candidate');
      s.on('signal:offer', onOffer);
      s.on('signal:answer', onAnswer);
      s.on('signal:ice-candidate', onIce);

      const pending = takePendingSignals();
      for (const sig of pending) {
        if (sig.type === 'offer') void session.handleOffer(sig.sdp);
        else if (sig.type === 'answer') void session.handleAnswer(sig.sdp);
        else void session.handleIce(sig.candidate);
      }
    }

    if (role === 'sender') {
      setTimeout(() => void session.createOffer(), 500);
    } else if (role === 'receiver' && mode === 'online') {
      const fallback = setTimeout(() => {
        if (!session.isChannelOpen() && sessionRef.current) {
          void session.createOffer();
        }
      }, 3000);
      return () => {
        clearTimeout(fallback);
        if (mode === 'online') {
          s.off('signal:offer', onOffer);
          s.off('signal:answer', onAnswer);
          s.off('signal:ice-candidate', onIce);
        }
        session.close();
      };
    }

    return () => {
      if (mode === 'online') {
        s.off('signal:offer', onOffer);
        s.off('signal:answer', onAnswer);
        s.off('signal:ice-candidate', onIce);
      }
      session.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function acceptOffer() {
    sessionRef.current?.sendJson({ type: 'transfer-accepted' });
    setOffer(null);
    setPhase('transferring');
    startTimeRef.current = Date.now();
  }

  function rejectOffer() {
    sessionRef.current?.sendJson({ type: 'transfer-rejected', reason: 'declined' });
    setOffer(null);
    setPhase('ready');
  }

  const progress =
    bytesTotal > 0 ? Math.min(100, Math.round((bytesDone / bytesTotal) * 100)) : 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{role === 'sender' ? 'Sending' : 'Receiving'}</Text>
      <Text style={styles.peer}>Peer: {peerName}</Text>
      <Text style={styles.wifiHint}>Both devices must be on the same Wi‑Fi (not 4G/5G).</Text>

      {phase === 'connecting' && (
        <View style={styles.center}>
          <ActivityIndicator color="#3b82f6" size="large" />
          <Text style={styles.status}>Connecting WebRTC...</Text>
        </View>
      )}

      {phase === 'ready' && (
        <View style={styles.center}>
          <Text style={styles.ready}>Connected — ready to transfer</Text>
          {role === 'sender' && (
            <Pressable style={styles.primaryBtn} onPress={() => void sendTransferOffer()}>
              <Text style={styles.primaryBtnText}>Send Files</Text>
            </Pressable>
          )}
          {role === 'receiver' && (
            <Text style={styles.hint}>Waiting for sender to start...</Text>
          )}
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

      {(phase === 'transferring' || phase === 'completed') && (
        <View style={styles.progressBox}>
          <View style={styles.barBg}>
            <View style={[styles.barFill, { width: `${progress}%` }]} />
          </View>
          <Text style={styles.stats}>
            {progress}% · {formatBytes(bytesDone)} / {formatBytes(bytesTotal)}
          </Text>
          {speed > 0 && phase === 'transferring' && (
            <Text style={styles.speed}>{formatSpeed(speed)}</Text>
          )}
        </View>
      )}

      {queue.length > 0 && (
        <View style={styles.list}>
          {queue.map((f) => (
            <View key={f.id} style={styles.fileRow}>
              <Text style={styles.fileName} numberOfLines={1}>
                {f.name}
              </Text>
              <Text style={styles.fileMeta}>
                {f.status}
                {f.progress > 0 ? ` · ${f.progress}%` : ''}
                {` · ${formatBytes(f.size)}`}
              </Text>
              {f.error ? <Text style={styles.fileErr}>{f.error}</Text> : null}
              {f.displayPath ? (
                <Text style={styles.filePath} numberOfLines={1}>
                  {f.displayPath}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      )}

      {phase === 'completed' && (
        <Text style={styles.done}>Transfer complete</Text>
      )}
      {saveHint ? <Text style={styles.saveHint}>{saveHint}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable style={styles.backBtn} onPress={() => router.back()}>
        <Text style={styles.primaryBtnText}>Go Back</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f0f' },
  content: { padding: 24, paddingBottom: 48 },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
    marginBottom: 6,
  },
  peer: { color: '#3b82f6', textAlign: 'center', marginBottom: 6 },
  wifiHint: {
    color: '#eab308',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 20,
  },
  center: { alignItems: 'center', paddingVertical: 24 },
  status: { color: '#a0a0a0', marginTop: 12 },
  ready: { color: '#fff', fontSize: 16, marginBottom: 16 },
  hint: { color: '#888', marginTop: 8 },
  offerBox: {
    backgroundColor: '#1a1a1a',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#333',
    marginBottom: 16,
  },
  offerTitle: { color: '#ccc', marginBottom: 12 },
  fileLine: { color: '#fff', marginBottom: 4 },
  total: { color: '#a0a0a0', marginTop: 8, marginBottom: 14 },
  row: { flexDirection: 'row', gap: 10 },
  acceptBtn: {
    flex: 1,
    backgroundColor: '#3b82f6',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  rejectBtn: {
    flex: 1,
    backgroundColor: '#222',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#444',
  },
  cancelText: { color: '#fff', fontWeight: '600' },
  progressBox: { marginBottom: 16 },
  barBg: {
    height: 8,
    backgroundColor: '#222',
    borderRadius: 4,
    overflow: 'hidden',
  },
  barFill: { height: 8, backgroundColor: '#3b82f6' },
  stats: { color: '#ccc', marginTop: 8, textAlign: 'center' },
  speed: { color: '#888', textAlign: 'center', marginTop: 4 },
  list: { gap: 10, marginBottom: 16 },
  fileRow: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  fileName: { color: '#fff', fontWeight: '600' },
  fileMeta: { color: '#888', fontSize: 12, marginTop: 4 },
  fileErr: { color: '#f87171', fontSize: 12, marginTop: 4 },
  filePath: { color: '#64748b', fontSize: 11, marginTop: 4 },
  done: {
    color: '#4ade80',
    textAlign: 'center',
    fontWeight: '700',
    marginBottom: 8,
  },
  saveHint: { color: '#94a3b8', textAlign: 'center', marginBottom: 8 },
  error: { color: '#f87171', textAlign: 'center', marginBottom: 12 },
  primaryBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  backBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
});
