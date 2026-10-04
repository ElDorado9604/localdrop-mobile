/**
 * Join Room: NFC / Nearby / QR.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Alert,
  Pressable,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { WebRTCSession } from '../src/lib/webrtcSession';
import { encodeRoomAnswer, decodeRoomPayload } from '../src/lib/offlineSignal';
import { setOfflineSession, clearOfflineSession } from '../src/lib/offlineSessionStore';
import { PairingMethodPicker } from '../src/components/PairingMethodPicker';
import { startNearbyGuest, isNearbyCancelled } from '../src/lib/nearbyPairing';
import { logInfo, logWarn, logError, describeError } from '../src/lib/logger';
import { summarizeCandidates } from '../src/lib/netUtil';
import { getDisplayName } from '../src/lib/deviceName';

/** How long the guest waits for the host to tap Accept before giving up. */
const HOST_ACCEPT_TIMEOUT_MS = 120_000;

export default function OfflineJoinScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<
    'choose-method' | 'nearby' | 'creating' | 'show-answer' | 'waiting' | 'failed'
  >('choose-method');
  const [status, setStatus] = useState('');
  const [answerPayload, setAnswerPayload] = useState<string | null>(null);
  const [hostName, setHostName] = useState('Host');
  const [roomCode, setRoomCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<WebRTCSession | null>(null);
  /** Cancel (while searching) or stop (after offer found) for the nearby UDP socket. */
  const nearbyStopRef = useRef<(() => void) | null>(null);
  /** Bumped on cancel/retry/unmount so late async results from an old attempt are ignored. */
  const attemptRef = useRef(0);
  const handedOffRef = useRef(false);
  const acceptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAcceptTimer = useCallback(() => {
    if (acceptTimerRef.current) clearTimeout(acceptTimerRef.current);
    acceptTimerRef.current = null;
  }, []);

  /** Stop searching, close the peer connection and forget this attempt. */
  const teardown = useCallback(() => {
    attemptRef.current++;
    clearAcceptTimer();
    nearbyStopRef.current?.();
    nearbyStopRef.current = null;
    if (!handedOffRef.current) {
      clearOfflineSession();
      try {
        sessionRef.current?.close();
      } catch {
        /* */
      }
    }
    sessionRef.current = null;
  }, [clearAcceptTimer]);

  useEffect(() => {
    return () => teardown();
  }, [teardown]);

  const backToMethods = useCallback(() => {
    teardown();
    setError(null);
    setStatus('');
    setAnswerPayload(null);
    setPhase('choose-method');
  }, [teardown]);

  /** Creates the session for this attempt and wires open/failed (with stale-attempt guards). */
  const makeSession = useCallback(
    (attempt: number, peer: { name: string; code: string }) => {
      const session = new WebRTCSession(undefined, { offline: true });
      sessionRef.current = session;
      session.setHandlers({
        onOpen: () => {
          if (attempt !== attemptRef.current) return;
          clearAcceptTimer();
          nearbyStopRef.current?.();
          handedOffRef.current = true;
          setOfflineSession(session, {
            peerName: peer.name,
            roomCode: peer.code,
            isHost: false,
          });
          router.replace({ pathname: '/offline-session' as any, params: { role: 'join' } } as any);
        },
        onFailed: (reason) => {
          if (attempt !== attemptRef.current) return;
          clearAcceptTimer();
          nearbyStopRef.current?.();
          logWarn('offline-join', `session failed: ${reason}`);
          setError(reason);
          setPhase('failed');
        },
      });
      return session;
    },
    [router, clearAcceptTimer]
  );

  const armAcceptTimeout = useCallback(
    (attempt: number) => {
      clearAcceptTimer();
      acceptTimerRef.current = setTimeout(() => {
        if (attempt !== attemptRef.current) return;
        logWarn('offline-join', `host did not accept within ${HOST_ACCEPT_TIMEOUT_MS / 1000}s`);
        nearbyStopRef.current?.();
        try {
          sessionRef.current?.close();
        } catch {
          /* */
        }
        setError('The host did not accept the request. Ask the host to try again, then retry.');
        setPhase('failed');
      }, HOST_ACCEPT_TIMEOUT_MS);
    },
    [clearAcceptTimer]
  );

  const applyOfferRaw = useCallback(
    async (raw: string) => {
      const decoded = decodeRoomPayload(raw);
      if (!decoded || decoded.type !== 'offer') {
        Alert.alert('Invalid QR code', 'Scan the host’s room QR code.');
        setPhase('choose-method');
        return;
      }

      const attempt = ++attemptRef.current;
      setPhase('creating');
      setError(null);
      setHostName(decoded.name || 'Host');
      setRoomCode(decoded.code);

      try {
        const displayName = await getDisplayName();
        const session = makeSession(attempt, {
          name: decoded.name || 'Host',
          code: decoded.code,
        });

        const answer = await session.handleOfferForQr(decoded.sdp);
        if (attempt !== attemptRef.current) {
          session.close();
          return;
        }
        const payload = encodeRoomAnswer({
          code: decoded.code,
          name: displayName,
          sdp: answer,
        });
        setAnswerPayload(payload);
        setPhase('show-answer');
        armAcceptTimeout(attempt);
      } catch (e) {
        if (attempt !== attemptRef.current) return;
        logError('offline-join', `qr join failed: ${describeError(e)}`);
        setError(e instanceof Error ? e.message : 'Failed to join room');
        setPhase('failed');
      }
    },
    [makeSession, armAcceptTimeout]
  );

  useFocusEffect(
    useCallback(() => {
      const pending = (globalThis as any).__localdropPendingOffer as string | undefined;
      if (pending) {
        (globalThis as any).__localdropPendingOffer = undefined;
        void applyOfferRaw(pending);
      }
    }, [applyOfferRaw])
  );

  async function startNearbyJoin() {
    const attempt = ++attemptRef.current;
    setPhase('nearby');
    setError(null);
    setStatus('Looking for nearby room…');

    try {
      const displayName = await getDisplayName();
      const guest = await startNearbyGuest({
        name: displayName,
        onStatus: setStatus,
        onReady: (cancel) => {
          nearbyStopRef.current = cancel;
        },
      });
      if (attempt !== attemptRef.current) {
        guest.stop();
        return;
      }
      nearbyStopRef.current = guest.stop;

      setStatus('Room found — connecting…');
      setHostName(guest.hostName || 'Host');
      setRoomCode(guest.code);

      const decoded = decodeRoomPayload(guest.offerRaw);
      if (!decoded || decoded.type !== 'offer') {
        throw new Error('Invalid offer from host');
      }

      const session = makeSession(attempt, {
        name: decoded.name || guest.hostName || 'Host',
        code: decoded.code,
      });

      const answer = await session.handleOfferForQr(decoded.sdp);
      if (attempt !== attemptRef.current) {
        session.close();
        guest.stop();
        return;
      }
      {
        const sum = summarizeCandidates(answer?.sdp ?? '');
        logInfo(
          'offline-join',
          `answer candidates: lanIPv4=${sum.hostIpv4Private} [${sum.maskedPrivate.join(',')}] ipv6=${sum.hostIpv6} tcp=${sum.tcp}`
        );
      }
      const payload = encodeRoomAnswer({
        code: decoded.code,
        name: displayName,
        sdp: answer,
      });

      guest.sendAnswer(payload, displayName);
      setStatus('Answer sent — waiting for host to accept…');
      setPhase('waiting');
      armAcceptTimeout(attempt);
    } catch (e) {
      if (isNearbyCancelled(e) || attempt !== attemptRef.current) return;
      nearbyStopRef.current?.();
      logError('offline-join', `nearby join failed: ${describeError(e)}`);
      setError(
        e instanceof Error
          ? e.message
          : 'Could not find a nearby room. Same Wi‑Fi or hotspot required.'
      );
      setPhase('failed');
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {phase === 'choose-method' && (
        <PairingMethodPicker
          title="Join Room"
          subtitle="Both devices need the same Wi‑Fi or hotspot. Choose how to pair."
          onSelect={(m) => {
            if (m === 'qr') {
              router.push({ pathname: '/offline-scan' as any, params: { mode: 'offer' } } as any);
            }
            if (m === 'ble') void startNearbyJoin();
          }}
        />
      )}

      {(phase === 'nearby' || phase === 'creating') && (
        <View style={styles.center}>
          <ActivityIndicator color="#3b82f6" size="large" />
          <Text style={styles.status}>{status || 'Working…'}</Text>
          <Pressable style={{ marginTop: 24 }} onPress={backToMethods}>
            <Text style={{ color: '#3b82f6' }}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {phase === 'waiting' && (
        <View style={styles.center}>
          <ActivityIndicator color="#3b82f6" size="large" />
          <Text style={styles.title}>Waiting for host</Text>
          <Text style={styles.sub}>
            {hostName}
            {roomCode ? ` · Room ${roomCode}` : ''}
            {'\n'}Host should Accept the join request.
          </Text>
          <Text style={styles.status}>{status}</Text>
          <Pressable style={{ marginTop: 24 }} onPress={backToMethods}>
            <Text style={{ color: '#3b82f6' }}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {phase === 'show-answer' && answerPayload && (
        <View style={styles.center}>
          <Text style={styles.title}>Show this QR to the host</Text>
          <Text style={styles.sub}>
            {hostName}
            {roomCode ? ` · Room ${roomCode}` : ''}
            {'\n'}Host scans this code, then taps Accept.
          </Text>
          <View style={styles.qrBox}>
            <QRCode value={answerPayload} size={220} backgroundColor="#fff" color="#000" />
          </View>
          <ActivityIndicator color="#3b82f6" style={{ marginTop: 16 }} />
          <Text style={styles.status}>Waiting for host to accept…</Text>
          <Pressable style={{ marginTop: 24 }} onPress={backToMethods}>
            <Text style={{ color: '#3b82f6' }}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {error && (
        <View>
          <Text style={styles.error}>{error}</Text>
          <Pressable style={{ marginTop: 16, alignItems: 'center' }} onPress={backToMethods}>
            <Text style={{ color: '#3b82f6' }}>Try again</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f0f' },
  content: { padding: 24, paddingBottom: 48 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center' },
  center: { alignItems: 'center' },
  sub: {
    color: '#94a3b8',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 16,
    lineHeight: 20,
  },
  qrBox: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 16,
    marginBottom: 8,
  },
  status: { color: '#aaa', marginTop: 12, textAlign: 'center' },
  error: { color: '#ef4444', textAlign: 'center', marginTop: 16 },
});
