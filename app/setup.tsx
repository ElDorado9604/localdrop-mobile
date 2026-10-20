/**
 * First-launch setup: ask once for the permissions that keep background transfers reliable,
 * so no system dialog ever appears in the middle of a transfer.
 */
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { BackgroundPermissions } from '../src/components/BackgroundPermissions';
import { markSetupDone } from '../src/lib/appPermissions';
import { allGranted, type PermKey } from '../src/lib/permissionUi';
import { logInfo } from '../src/lib/logger';

export default function SetupScreen() {
  const router = useRouter();
  const [states, setStates] = useState<Record<PermKey, boolean> | null>(null);

  useEffect(() => {
    // Shown once, even if the user leaves with the back button.
    void markSetupDone();
    logInfo('setup', 'first-launch setup shown');
  }, []);

  function finish() {
    logInfo(
      'setup',
      `setup finished: notifications=${states?.notifications} battery=${states?.battery} camera=${states?.camera}`
    );
    router.back();
  }

  const done = states ? allGranted(states) : false;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Set up background transfers</Text>
      <Text style={styles.intro}>
        Allow these once so large transfers keep running while you use other apps, and you are
        never interrupted by a permission prompt in the middle of a transfer. None of them is
        required — you can change them later in Settings.
      </Text>
      <View style={styles.card}>
        <BackgroundPermissions onChange={setStates} />
      </View>
      <Pressable style={styles.primary} onPress={finish}>
        <Text style={styles.primaryText}>{done ? 'Continue' : 'Skip for now'}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f0f' },
  content: { padding: 24, paddingBottom: 48 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700', marginBottom: 12 },
  intro: { color: '#94a3b8', fontSize: 14, lineHeight: 20, marginBottom: 20 },
  card: {
    backgroundColor: '#141414',
    borderRadius: 14,
    padding: 16,
    paddingTop: 2,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    marginBottom: 24,
  },
  primary: {
    backgroundColor: '#1d4ed8',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
