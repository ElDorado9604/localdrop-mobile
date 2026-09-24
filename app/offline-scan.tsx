/**
 * Camera QR scanner — Android-safe remount + onCameraReady to avoid black preview.
 */
import { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Alert,
  Dimensions,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { decodeRoomPayload } from '../src/lib/offlineSignal';

const { width: SCREEN_W } = Dimensions.get('window');
const FRAME = Math.min(SCREEN_W * 0.72, 280);

export default function OfflineScanScreen() {
  const { mode } = useLocalSearchParams<{ mode: string }>();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraKey, setCameraKey] = useState(0);

  const expectType = mode === 'answer' ? 'answer' : 'offer';

  // Remount camera every time this screen is focused (fixes Android black screen)
  useFocusEffect(
    useCallback(() => {
      setScanned(false);
      setCameraReady(false);
      setCameraKey((k) => k + 1);
      return () => {
        setCameraReady(false);
      };
    }, [])
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
        <Text style={[styles.tip, { marginTop: 24 }]}>
          Or go back and use Share invite / Paste invite instead of the camera.
        </Text>
      </View>
    );
  }

  function onBarcode({ data }: { data: string }) {
    if (scanned || !cameraReady || !data) return;
    const decoded = decodeRoomPayload(data);
    if (!decoded || decoded.type !== expectType) {
      if (data.includes('{') || data.length > 40) {
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
      <CameraView
        key={cameraKey}
        style={styles.camera}
        facing="back"
        active
        onCameraReady={() => setCameraReady(true)}
        barcodeScannerSettings={{
          barcodeTypes: ['qr'],
        }}
        onBarcodeScanned={scanned || !cameraReady ? undefined : onBarcode}
      />

      {!cameraReady && (
        <View style={styles.loadingOverlay}>
          <Text style={styles.text}>Starting camera…</Text>
        </View>
      )}

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
        <Pressable style={styles.btn} onPress={() => router.back()}>
          <Text style={styles.btnText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={styles.linkBtn}
          onPress={() => {
            router.back();
          }}
        >
          <Text style={styles.link}>Use Share / Paste invite instead</Text>
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
    flex: 1,
    width: '100%',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#111',
    alignItems: 'center',
    justifyContent: 'center',
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
  link: { color: '#93c5fd', marginTop: 8 },
  linkBtn: { marginTop: 8 },
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
});
