/**
 * Camera QR scanner for offline offer or answer.
 */
import { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { decodeRoomPayload } from '../src/lib/offlineSignal';

export default function OfflineScanScreen() {
  const { mode } = useLocalSearchParams<{ mode: string }>();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);

  const expectType = mode === 'answer' ? 'answer' : 'offer';

  if (!permission) {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>Requesting camera…</Text>
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
    if (scanned) return;
    const decoded = decodeRoomPayload(data);
    if (!decoded || decoded.type !== expectType) {
      Alert.alert(
        expectType === 'offer' ? 'Invalid QR code' : 'Invalid QR code',
        expectType === 'offer'
          ? 'Scan the host’s room QR code.'
          : 'Scan the guest’s answer QR code.'
      );
      return;
    }
    setScanned(true);

    if (expectType === 'offer') {
      (global as any).__localdropPendingOffer = data;
      router.back();
      return;
    }

    // Answer path: host screen should pick this up
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
        style={StyleSheet.absoluteFillObject}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : onBarcode}
      />
      <View style={styles.overlay}>
        <Text style={styles.overlayText}>
          {expectType === 'offer'
            ? 'Scan host room QR'
            : 'Scan guest answer QR'}
        </Text>
        <Pressable style={styles.btn} onPress={() => router.back()}>
          <Text style={styles.btnText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
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
  overlay: {
    position: 'absolute',
    bottom: 48,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  overlayText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
});
