import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

export default function TransferScreen() {
  const params = useLocalSearchParams<{
    role?: string;
    peerName?: string;
    fileCount?: string;
  }>();
  const router = useRouter();

  const role = params.role || 'sender';
  const peerName = params.peerName || 'peer';
  const fileCount = params.fileCount || '0';

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        {role === 'sender' ? 'Sending Files' : 'Receiving Files'}
      </Text>

      <Text style={styles.peer}>Connected to {peerName}</Text>

      <View style={styles.progressBox}>
        <Text style={styles.progressLabel}>Transfer in progress</Text>
        <View style={styles.barBg}>
          <View style={[styles.barFill, { width: '0%' }]} />
        </View>
        <Text style={styles.stats}>0% · 0 / {fileCount} files</Text>
        <Text style={styles.hint}>
          WebRTC data channel will transfer files here once a development build is installed.
        </Text>
      </View>

      <Pressable style={styles.btn} onPress={() => router.replace('/')}>
        <Text style={styles.btnText}>Back to Home</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f0f',
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 8 },
  peer: { color: '#3b82f6', marginBottom: 32 },
  progressBox: {
    width: '100%',
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
  },
  progressLabel: { color: '#aaa', marginBottom: 16 },
  barBg: {
    width: '100%',
    height: 8,
    backgroundColor: '#333',
    borderRadius: 4,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    backgroundColor: '#3b82f6',
    borderRadius: 4,
  },
  stats: { color: '#fff', marginTop: 12, fontWeight: '600' },
  hint: {
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 16,
    lineHeight: 18,
  },
  btn: {
    marginTop: 32,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#333',
  },
  btnText: { color: '#fff' },
});
