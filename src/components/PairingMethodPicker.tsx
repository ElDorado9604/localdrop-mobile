/**
 * Three equal offline pairing options: NFC, Nearby (auto), QR.
 */
import { View, Text, StyleSheet, Pressable, Alert } from 'react-native';

export type PairingMethod = 'nfc' | 'ble' | 'qr';

type Props = {
  title?: string;
  subtitle?: string;
  onSelect: (method: PairingMethod) => void;
};

export function PairingMethodPicker({ title, subtitle, onSelect }: Props) {
  function select(method: PairingMethod) {
    if (method === 'nfc') {
      Alert.alert(
        'Tap to pair (NFC)',
        'Coming in a next update. For now use Connect nearby or Scan QR.',
        [{ text: 'OK' }]
      );
      return;
    }
    onSelect(method);
  }

  return (
    <View style={styles.wrap}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      {subtitle ? <Text style={styles.sub}>{subtitle}</Text> : null}

      <Text style={styles.label}>How do you want to connect?</Text>

      <Pressable style={styles.card} onPress={() => select('nfc')}>
        <Text style={styles.cardTitle}>Tap phones (NFC)</Text>
        <Text style={styles.cardBody}>Hold devices together to pair</Text>
        <Text style={styles.badge}>Soon</Text>
      </Pressable>

      <Pressable style={[styles.card, styles.cardLive]} onPress={() => select('ble')}>
        <Text style={styles.cardTitle}>Connect nearby</Text>
        <Text style={styles.cardBody}>
          Automatic pair on the same Wi‑Fi or hotspot (no QR)
        </Text>
        <Text style={[styles.badge, styles.badgeLive]}>Available</Text>
      </Pressable>

      <Pressable style={[styles.card, styles.cardLive]} onPress={() => select('qr')}>
        <Text style={styles.cardTitle}>Scan QR code</Text>
        <Text style={styles.cardBody}>Show or scan a code to pair</Text>
        <Text style={[styles.badge, styles.badgeLive]}>Available</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%' },
  title: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  sub: {
    color: '#888',
    textAlign: 'center',
    fontSize: 13,
    marginBottom: 20,
    lineHeight: 18,
  },
  label: {
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
  },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  cardLive: {
    borderColor: '#3b82f6',
    backgroundColor: '#152033',
  },
  cardTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cardBody: { color: '#94a3b8', fontSize: 13, marginTop: 4 },
  badge: {
    marginTop: 10,
    alignSelf: 'flex-start',
    color: '#fbbf24',
    fontSize: 11,
    fontWeight: '700',
  },
  badgeLive: { color: '#22c55e' },
});
