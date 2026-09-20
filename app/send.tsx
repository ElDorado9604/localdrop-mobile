import { View, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

export default function SendScreen() {
  const { mode } = useLocalSearchParams<{ mode: string }>();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Send Files</Text>
      <Text style={styles.mode}>
        Mode: {mode === 'offline' ? 'Offline (Local Discovery)' : 'Online (Signaling Server)'}
      </Text>
      <Text style={styles.placeholder}>
        File picker + WebRTC sender will be implemented here.
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
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 12,
  },
  mode: {
    color: '#3b82f6',
    marginBottom: 24,
  },
  placeholder: {
    color: '#666',
    textAlign: 'center',
  },
});
