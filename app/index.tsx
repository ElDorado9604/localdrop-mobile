import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Link } from 'expo-router';
import { useState } from 'react';

type Mode = 'online' | 'offline';

export default function HomeScreen() {
  const [mode, setMode] = useState<Mode>('online');

  return (
    <View style={styles.container}>
      <Text style={styles.title}>LocalDrop</Text>
      <Text style={styles.subtitle}>
        Fast peer-to-peer file transfer on the same network
      </Text>

      {/* Mode Switcher */}
      <View style={styles.modeContainer}>
        <Text style={styles.modeLabel}>Connection Mode</Text>
        <View style={styles.modeButtons}>
          <Pressable
            style={[styles.modeButton, mode === 'online' && styles.modeActive]}
            onPress={() => setMode('online')}
          >
            <Text style={[styles.modeText, mode === 'online' && styles.modeTextActive]}>
              Online
            </Text>
          </Pressable>
          <Pressable
            style={[styles.modeButton, mode === 'offline' && styles.modeActive]}
            onPress={() => setMode('offline')}
          >
            <Text style={[styles.modeText, mode === 'offline' && styles.modeTextActive]}>
              Offline
            </Text>
          </Pressable>
        </View>
        <Text style={styles.modeHint}>
          {mode === 'online'
            ? 'Uses signaling server for easy QR / code pairing'
            : 'Fully local discovery – no internet required'}
        </Text>
      </View>

      <View style={styles.actions}>
        <Link href={{ pathname: '/send', params: { mode } }} asChild>
          <Pressable style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Send Files</Text>
          </Pressable>
        </Link>

        <Link href={{ pathname: '/receive', params: { mode } }} asChild>
          <Pressable style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Receive Files</Text>
          </Pressable>
        </Link>
      </View>
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
    fontSize: 36,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#a0a0a0',
    textAlign: 'center',
    marginBottom: 40,
  },
  modeContainer: {
    marginBottom: 40,
  },
  modeLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
  },
  modeButtons: {
    flexDirection: 'row',
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 4,
  },
  modeButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  modeActive: {
    backgroundColor: '#3b82f6',
  },
  modeText: {
    color: '#a0a0a0',
    fontWeight: '600',
  },
  modeTextActive: {
    color: '#fff',
  },
  modeHint: {
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 10,
  },
  actions: {
    gap: 16,
  },
  primaryButton: {
    backgroundColor: '#3b82f6',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: '#1a1a1a',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  secondaryButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
});
