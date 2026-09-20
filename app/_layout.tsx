import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function RootLayout() {
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
        <Stack.Screen name="index" options={{ title: 'LocalDrop' }} />
        <Stack.Screen name="send" options={{ title: 'Send Files' }} />
        <Stack.Screen name="receive" options={{ title: 'Receive Files' }} />
        <Stack.Screen name="transfer" options={{ title: 'Transfer' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
