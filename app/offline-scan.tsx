/**
 * Camera QR scanner — scan only (no share/paste).
 * Handler always attached; lockedRef prevents double-fire.
 */
import { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Dimensions,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { decodeRoomPayload } from '../src/lib/offlineSignal';
import { logInfo, logWarn } from '../src/lib/logger';

const { width: SCREEN_W } = Dimensions.get('window');
const FRAME = Math.min(SCREEN_W * 0.72, 280);

export default function OfflineScanScreen() {
  const { mode } = useLocalSearchParams<{ mode: string }>();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraKey, setCameraKey] = useState(0);
  const [hint, setHint] = useState<string | null>(null);

  const lockedRef = useRef(false);
  const expectType = mode === 'answer' ? 'answer' : 'offer';

  useFocusEffect(
    useCallback(() => {
      lockedRef.current = false;
      setHint(null);
      setCameraKey((k) => k + 1);
      logInfo('qr', `scan screen open expect=${expectType}`);
    }, [expectType])
  );

  const onBarcodeScanned = useCallback(
    (result: { data?: string }) => {
      if (lockedRef.current) return;
      const data = result?.data;
      if (!data || typeof data !== 'string') return;

      const decoded = decodeRoomPayload(data);
      if (!decoded || decoded.type !== expectType) {
        if (data.includes('{') || data.length > 40) {
          logWarn(
            'qr',
            `scan mismatch expect=${expectType} got=${decoded?.type || 'invalid'} len=${data.length}`
          );
          setHint(
            expectType === 'offer'
              ? 'Not a host room QR — try the other phone’s code.'
              : 'Not a guest answer QR — try the other phone’s code.'
          );
        }
        return;
      }

      lockedRef.current = true;
      setHint(null);
      logInfo(
        'qr',
        `scan ok type=${decoded.type} code=${decoded.code || '-'} name=${decoded.name || '-'}`
      );

      if (expectType === 'offer') {
        (global as any).__localdropPendingOffer = data;
        router.back();
        return;
      }

      const handler = (global as any).__localdropOnAnswerScanned as
        | ((raw: string) => void)
        | undefined;
      if (handler) {
        handler(data);
      } else {
        (global as any).__localdropPendingAnswer = data;
      }
      router.back();
    },
    [expectType, router]
  );

  if (!permission) {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>Checking camera permission…</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>Camera permission is required to scan QR codes.</Text>
        <Pressable style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Allow camera</Text>
        </Pressable>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.link}>Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        key={cameraKey}
        style={styles.camera}
        facing="back"
        barcodeScannerSettings={{
          barcodeTypes: ['qr'],
        }}
        onBarcodeScanned={onBarcodeScanned}
      />

      <View style={styles.mask} pointerEvents="none">
        <View style={styles.maskRow} />
        <View style={styles.maskMid}>
          <View style={styles.maskSide} />
          <View style={styles.frame} />
          <View style={styles.maskSide} />
        </View>
        <View style={styles.maskRow} />
      </View>

      <View style={styles.overlay}>
        <Text style={styles.overlayText}>
          {expectType === 'offer' ? 'Scan host room QR' : 'Scan guest answer QR'}
        </Text>
        <Text style={styles.tip}>Point at the QR on the other phone</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        <Pressable
          style={styles.btn}
          onPress={() => {
            lockedRef.current = false;
            setHint(null);
            setCameraKey((k) => k + 1);
            logInfo('qr', 'retry scan');
          }}
        >
          <Text style={styles.btnText}>Retry scan</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnSecondary]} onPress={() => router.back()}>
          <Text style={styles.btnText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1, width: '100%' },
  center: {
    flex: 1,
    backgroundColor: '#0f0f0f',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  text: { color: '#fff', textAlign: 'center', marginBottom: 16 },
  btn: {
    backgroundColor: '#3b82f6',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
    marginTop: 12,
  },
  btnSecondary: {
    backgroundColor: '#333',
  },
  btnText: { color: '#fff', fontWeight: '600' },
  link: { color: '#93c5fd', marginTop: 16 },
  mask: { ...StyleSheet.absoluteFillObject },
  maskRow: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  maskMid: { height: FRAME, flexDirection: 'row' },
  maskSide: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  frame: {
    width: FRAME,
    height: FRAME,
    borderWidth: 2,
    borderColor: '#3b82f6',
    borderRadius: 12,
    backgroundColor: 'transparent',
  },
  overlay: {
    position: 'absolute',
    bottom: Platform.OS === 'android' ? 36 : 48,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  overlayText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    overflow: 'hidden',
  },
  tip: {
    color: '#cbd5e1',
    fontSize: 12,
    marginBottom: 4,
    textAlign: 'center',
  },
  hint: {
    color: '#fbbf24',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 12,
  },
});
