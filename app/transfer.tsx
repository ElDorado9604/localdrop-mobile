import { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
// SDK 54+: old API moved to legacy — required for readAsStringAsync / writeAsStringAsync
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { getSocket, sendSignal, emitTransferStarted, emitRoomComplete } from '../src/lib/socket';
import { WebRTCSession } from '../src/lib/webrtcSession';
import {
  CHUNK_SIZE,
  ProtocolMessage,
  FileMeta,
  formatBytes,
  formatSpeed,
} from '../src/lib/transferProtocol';

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

  const sessionRef = useRef<WebRTCSession | null>(null);
  const startTimeRef = useRef(0);
  const queueRef = useRef<QueuedFile[]>([]);
  const offerSentRef = useRef(false);
  const cancelledRef = useRef(false);
  const incomingRef = useRef<
    Map<string, { meta: FileMeta; chunks: ArrayBuffer[]; received: number; totalChunks: number }>
  >(new Map());

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

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
        setPhase('failed');
        setError('Receiver declined the transfer.');
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
          const dir = (FileSystem.cacheDirectory || '') + 'localdrop/';
          await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
          const path = dir + buf.meta.name.replace(/[^a-zA-Z0-9._-]/g, '_');

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
          await FileSystem.writeAsStringAsync(path, b64, {
            encoding: FileSystem.EncodingType.Base64,
          });

          updateFile(msg.fileId, { status: 'completed', progress: 100, localPath: path });
          incomingRef.current.delete(msg.fileId);
        } catch (e) {
          updateFile(msg.fileId, {
            status: 'error',
            error: e instanceof Error ? e.message : 'Save failed',
          });
        }
      } else if (msg.type === 'transfer-complete') {
        setPhase('completed');
        sessionRef.current?.markCompleted();
        emitRoomComplete();
      } else if (msg.type === 'transfer-cancelled') {
        cancelledRef.current = true;
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
      s.on('signal:offer', onOffer);
      s.on('signal:answer', onAnswer);
      s.on('signal:ice-candidate', onIce);
    }

    if (role === 'sender') {
      setTimeout(() => void session.createOffer(), 500);
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

  async function shareFile(path: string) {
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(path);
    } else {
      Alert.alert('Saved', path);
    }
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
                <Text style={styles.fileName} numberOfLines={1}>{f.name}</Text>
                <Text style={styles.fileMeta}>
                  {f.status} · {f.progress}% · {formatBytes(f.size)}
                </Text>
              </View>
              {f.status === 'completed' && f.localPath && (
                <Pressable onPress={() => shareFile(f.localPath!)}>
                  <Text style={styles.share}>Share</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      )}

      {phase === 'completed' && <Text style={styles.done}>Transfer complete</Text>}
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
  progressBox: { marginVertical: 16 },
  barBg: { height: 8, backgroundColor: '#333', borderRadius: 4, overflow: 'hidden' },
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
  share: { color: '#3b82f6', fontWeight: '600' },
  done: { color: '#22c55e', textAlign: 'center', fontSize: 18, fontWeight: '700', marginTop: 16 },
  error: { color: '#ef4444', textAlign: 'center', marginTop: 12 },
  homeBtn: {
    marginTop: 32,
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  homeText: { color: '#fff' },
});
