import { useEffect } from 'react';
import { Pressable, Text } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { initLocalDropStorage } from '../src/lib/saveReceivedFile';
import { initLogger } from '../src/lib/logger';

function SettingsHeaderButton() {
  const router = useRouter();
  return (
    <Pressable onPress={() => router.push('/settings')} style={{ marginRight: 8, padding: 6 }}>
      <Text style={{ color: '#3b82f6', fontWeight: '600' }}>Settings</Text>
    </Pressable>
  );
}

export default function RootLayout() {
  useEffect(() => {
    void initLocalDropStorage();
    void initLogger();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#0f0f0f' },
          headerTintColor: '#fff',
          headerTitleStyle: { fontWeight: '600' },
          contentStyle: { backgroundColor: '#0f0f0f' },
        }}
      >
        <Stack.Screen
          name="index"
          options={{
            title: 'LocalDrop',
            headerRight: () => <SettingsHeaderButton />,
          }}
        />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="send" options={{ title: 'Send Files' }} />
        <Stack.Screen name="receive" options={{ title: 'Receive Files' }} />
        <Stack.Screen name="transfer" options={{ title: 'Transfer' }} />
        <Stack.Screen name="offline" options={{ title: 'Offline File Transfer' }} />
        <Stack.Screen name="offline-host" options={{ title: 'Create Room' }} />
        <Stack.Screen name="offline-join" options={{ title: 'Join Room' }} />
        <Stack.Screen name="offline-scan" options={{ title: 'Scan QR', headerShown: false }} />
        <Stack.Screen name="offline-session" options={{ title: 'Connected Room' }} />
        <Stack.Screen name="received" options={{ title: 'Files Received' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
