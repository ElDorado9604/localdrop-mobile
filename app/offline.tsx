/**
 * Offline File Transfer hub — Create Room / Join Room
 * Pairing methods (NFC / Bluetooth / QR) are chosen on the next screen.
 */
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useRouter } from 'expo-router';

export default function OfflineHomeScreen() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Offline File Transfer</Text>
      <Text style={styles.helper}>
        Connect both devices to the same Wi‑Fi or hotspot. No internet required.
      </Text>

      <Pressable style={styles.primaryBtn} onPress={() => router.push('/offline-host')}>
        <Text style={styles.primaryBtnText}>Create Room</Text>
      </Pressable>

      <Pressable style={styles.secondaryBtn} onPress={() => router.push('/offline-join')}>
        <Text style={styles.secondaryBtnText}>Join Room</Text>
      </Pressable>

      <Text style={styles.note}>
        On the next screen you can choose: Tap (NFC), Connect nearby (Bluetooth), or Scan QR.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f0f',
    padding: 24,
    justifyContent: 'center',
  },
  title: {
    color: '#fff',
    fontSize: 26,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  helper: {
    color: '#94a3b8',
    textAlign: 'center',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 36,
  },
  primaryBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
  primaryBtnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  secondaryBtn: {
    backgroundColor: '#1a1a1a',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  secondaryBtnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  note: {
    color: '#64748b',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 28,
    lineHeight: 18,
  },
});
