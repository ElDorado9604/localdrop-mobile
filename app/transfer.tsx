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
  CHUNK_SIZE,
  ProtocolMessage,
  FileMeta,
  formatBytes,
  formatSpeed,
  MAX_FILE_SIZE,
} from '../src/lib/transferProtocol';
import {
  createStreamingWriter,
  ensureAppLocalDropDir,
  hasSaveDirectory,
  setupPublicSaveFolder,
} from '../src/lib/saveReceivedFile';
import { streamFileChunks } from '../src/lib/fileStream';
import type { ReceivedFileWriter } from '../src/lib/fileStream';

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
        received: number;
        totalChunks: number;
      }
    >
  >(new Map());

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

  const runSend = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;

    const pending = queueRef.current.filter((f) => f.status === 'pending' && f.uri);
    if (pending.length === 0) {
      setError('No files to send (list empty). Go back and pick files again.');
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
        const totalChunks = Math.ceil(item.size / CHUNK_SIZE) || 1;
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
            });
            setBytesDone(done);
            const elapsed = (Date.now() - startTimeRef.current) / 1000;
            if (elapsed > 0.2) setSpeed(done / elapsed);
          },
          { cancelled: cancelledRef.current }
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

    if (!cancelledRef.current) {
      session.sendJson({ type: 'transfer-complete' });
      setPhase('completed');
      session.markCompleted();
      emitRoomComplete();
    }
  }, [updateFile]);

  const sendTransferOffer = useCallback(() => {
    const session = sessionRef.current;
    if (!session || !session.isChannelOpen()) return;
    if (offerSentRef.current) return;

    const pending = queueRef.current.filter((f) => f.status === 'pending');
    if (pending.length === 0) return;

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
      senderName: 'Android Device',
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
          if (entry.received < entry.totalChunks) {
            activeId = id;
            break;
          }
        }
        if (!activeId) return;
        const entry = writersRef.current.get(activeId)!;
        try {
          await entry.writer.writeChunk(data);
          entry.received++;
          const progress = Math.min(99, Math.round((entry.received / entry.totalChunks) * 100));
          updateFile(activeId, { progress, status: 'receiving' });
          setBytesDone((prev) => {
            const next = prev + data.byteLength;
            const elapsed = (Date.now() - startTimeRef.current) / 1000;
            if (elapsed > 0.2) setSpeed(next / elapsed);
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
        setPhase('failed');
        setError('Receiver declined the transfer.');
      } else if (msg.type === 'file-start') {
        const totalChunks = Math.ceil(msg.size / CHUNK_SIZE) || 1;

        if (!(await hasSaveDirectory())) {
          const ok = await setupPublicSaveFolder();
          if (!ok) {
            updateFile(msg.fileId, { status: 'error', error: 'Save folder not set' });
            return;
          }
        }

        try {
          const writer = await createStreamingWriter(msg.name, msg.mime, msg.size);
          writersRef.current.set(msg.fileId, {
            meta: { id: msg.fileId, name: msg.name, size: msg.size, type: msg.mime },
            writer,
            received: 0,
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
        setPhase('completed');
        sessionRef.current?.markCompleted();
        emitRoomComplete();
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
    [updateFile, runSend]
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
          setTimeout(() => sendTransferOffer(), 400);
        }
      },
      onMessage: (data) => void handleProtocol(data),
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
            <Pressable style={styles.primaryBtn} onPress={sendTransferOffer}>
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
              <View style={{ flex: 1 }}>
                <Text style={styles.fileName} numberOfLines={1}>
                  {f.name}
                </Text>
                <Text style={styles.fileMeta}>
                  {f.status === 'completed'
                    ? `Saved · ${f.displayPath || 'LocalDrop/' + f.name}`
                    : `${f.status} · ${f.progress}% · ${formatBytes(f.size)}`}
                </Text>
              </View>
              {f.status === 'completed' && <Text style={styles.savedBadge}>Saved</Text>}
            </View>
          ))}
        </View>
      )}

      {phase === 'completed' && (
        <>
          <Text style={styles.done}>
            {role === 'receiver' ? 'Saved to LocalDrop folder' : 'Transfer complete'}
          </Text>
          {role === 'receiver' && (
            <Pressable
              style={styles.receivedBtn}
              onPress={() => router.replace('/received')}
            >
              <Text style={styles.receivedBtnText}>View Files Received</Text>
            </Pressable>
          )}
        </>
      )}
      {saveHint && role === 'receiver' && (
        <Text style={styles.saveHint}>{saveHint}</Text>
      )}
      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable style={styles.homeBtn} onPress={() => router.replace('/')}>
        <Text style={styles.homeText}>Back to Home</Text>
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
  status: { color: '#aaa', marginTop: 12 },
  ready: { color: '#22c55e', fontWeight: '600', marginBottom: 16 },
  hint: { color: '#888', marginTop: 8 },
  primaryBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 32,
    alignItems: 'center',
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
  fileName: { color: '#fff', fontSize: 14 },
  fileMeta: { color: '#888', fontSize: 12, marginTop: 2 },
  savedBadge: { color: '#22c55e', fontWeight: '600', fontSize: 12 },
  done: { color: '#22c55e', fontWeight: '700', fontSize: 18, textAlign: 'center', marginTop: 16 },
  receivedBtn: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#3b82f6',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  receivedBtnText: { color: '#3b82f6', fontWeight: '600' },
  saveHint: { color: '#888', textAlign: 'center', marginTop: 8, fontSize: 13 },
  error: { color: '#ef4444', textAlign: 'center', marginTop: 16 },
  homeBtn: { marginTop: 32, alignItems: 'center' },
  homeText: { color: '#888' },
});
