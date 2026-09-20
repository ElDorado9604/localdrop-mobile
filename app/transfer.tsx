import { View, Text, StyleSheet } from 'react-native';

export default function TransferScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Transfer in Progress</Text>
      <Text style={styles.placeholder}>
        Progress, speed, and ETA will appear here.
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
  placeholder: {
    color: '#666',
    textAlign: 'center',
  },
});
