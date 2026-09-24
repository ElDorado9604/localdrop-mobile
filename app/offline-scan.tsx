/**
 * Camera QR scanner for offline offer or answer.
 */
import { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Alert,
  Dimensions,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { decodeRoomPayload } from '../src/lib/offlineSignal';

const { width: SCREEN_W } = Dimensions.get('window');
const FRAME = Math.min(SCREEN_W * 0.72, 280);

export default function OfflineScanScreen() {
  const { mode } = useLocalSearchParams<{ mode: string }>();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [ready, setReady] = useState(false);

  const expectType = mode === 'answer' ? 'answer' : 'offer';

  // Mount camera only after permission is confirmed (avoids black preview on some devices)
  useEffect(() => {
    if (permission?.granted) {
      const t = setTimeout(() => setReady(true), 300);
      return () => clearTimeout(t);
    }
    setReady(false);
  }, [permission?.granted]);

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

  function onBarcode({ data }: { data: string }) {
    if (scanned || !data) return;
    const decoded = decodeRoomPayload(data);
    if (!decoded || decoded.type !== expectType) {
      // Ignore non-matching codes silently while scanning; only alert on clear bad payload once
      if (data.includes('{') || data.length > 20) {
        Alert.alert(
          'Invalid QR code',
          expectType === 'offer'
            ? 'Scan the host’s room QR code.'
            : 'Scan the guest’s answer QR code.'
        );
      }
      return;
    }
    setScanned(true);

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
  }

  return (
    <View style={styles.container}>
      {ready ? (
        <CameraView
          style={styles.camera}
          facing="back"
          active={!scanned}
          barcodeScannerSettings={{
            barcodeTypes: ['qr'],
          }}
          onBarcodeScanned={scanned ? undefined : onBarcode}
        />
      ) : (
        <View style={[styles.camera, styles.cameraPlaceholder]}>
          <Text style={styles.text}>Starting camera…</Text>
        </View>
      )}

      {/* Dim overlay with clear scan window */}
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
        <Text style={styles.tip}>Point the camera at the QR code on the other phone</Text>
        <Pressable style={styles.btn} onPress={() => router.back()}>
          <Text style={styles.btnText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  camera: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  cameraPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111',
  },
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
  btnText: { color: '#fff', fontWeight: '600' },
  link: { color: '#3b82f6', marginTop: 16 },
  mask: {
    ...StyleSheet.absoluteFillObject,
  },
  maskRow: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  maskMid: {
    height: FRAME,
    flexDirection: 'row',
  },
  maskSide: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
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
    bottom: Platform.OS === 'android' ? 40 : 48,
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
    marginBottom: 8,
    textAlign: 'center',
  },
});
