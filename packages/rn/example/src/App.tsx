import { useEffect, useMemo, useRef } from 'react';
import { ScrollView, Text, View, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import {
  DashOtaProvider,
  useOtaUpdate,
  type OtaConfig,
  type OtaStorage,
} from 'react-native-dash-ota';

/**
 * In-memory storage for the demo (resets per launch → re-enrolls each cold start). Swap for
 * AsyncStorage / secure storage in a real app via the same {@link OtaStorage} interface.
 */
function makeMemoryStorage(): OtaStorage {
  const map = new Map<string, string>();
  return {
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => {
      map.set(k, v);
    },
  };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

function Button({ title, onPress, kind = 'primary' }: { title: string; onPress: () => void; kind?: 'primary' | 'danger' }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.btn, kind === 'danger' && styles.btnDanger, pressed && styles.btnPressed]}
    >
      <Text style={styles.btnText}>{title}</Text>
    </Pressable>
  );
}

/** Distinct colour per flavour so the running channel is obvious in a screenshot. */
function channelStyle(channel: string) {
  switch (channel) {
    case 'prod':
      return { backgroundColor: '#dc2626' };
    case 'uat':
      return { backgroundColor: '#d97706' };
    default:
      return { backgroundColor: '#16a34a' }; // dev
  }
}

function Dashboard() {
  const ota = useOtaUpdate();
  const busy = ota.status === 'checking' || ota.status === 'downloading';

  // Mark the running bundle healthy once the app is genuinely usable (here: ~1.5s after the
  // first screen mounts). This is the realistic pattern — without it, the native crash-loop
  // safety net reverts every applied bundle after a couple of launches.
  const markHealthyRef = useRef(ota.markHealthy);
  markHealthyRef.current = ota.markHealthy;
  useEffect(() => {
    const t = setTimeout(() => markHealthyRef.current(), 1500);
    return () => clearTimeout(t);
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>dash-ota ⚡ OTA v1</Text>

      <View style={[styles.channelBadge, channelStyle(ota.channel)]}>
        <Text style={styles.channelText}>{ota.channel.toUpperCase()} FLAVOUR</Text>
      </View>

      <View style={styles.card}>
        <Row label="status" value={ota.status} />
        <Row label="bundle" value={ota.currentBundle ? `v${ota.currentBundle.bundleVersion} ${ota.currentBundle.isEmbedded ? '(embedded)' : ''}` : '—'} />
        <Row label="runtimeVersion" value={ota.currentBundle?.runtimeVersion ?? '—'} />
        <Row label="update" value={ota.availableUpdate ? `v${ota.availableUpdate.bundleVersion}${ota.availableUpdate.mandatory ? ' (mandatory)' : ''}` : 'none'} />
        <Row label="native policy" value={ota.nativePolicy ? `${ota.nativePolicy.severity}` : '—'} />
        {ota.error ? <Row label="error" value={ota.error} /> : null}
      </View>

      {ota.nativePolicy?.severity === 'hard' ? (
        <View style={[styles.card, styles.gate]}>
          <Text style={styles.gateText}>Update required from the store to continue.</Text>
        </View>
      ) : null}

      {ota.availableUpdate?.releaseNotes ? (
        <View style={styles.card}>
          <Text style={styles.label}>What's New</Text>
          <Text style={styles.notes}>{ota.availableUpdate.releaseNotes}</Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        {busy ? <ActivityIndicator /> : null}
        <Button title="Check now" onPress={() => void ota.checkNow()} />
        <Button title="Apply & restart" onPress={() => void ota.applyUpdate(true)} />
        <Button title="Mark healthy" onPress={() => ota.markHealthy()} />
        <Button title="Rollback" kind="danger" onPress={() => void ota.rollback()} />
      </View>
    </ScrollView>
  );
}

export default function App() {
  const config = useMemo<OtaConfig>(
    () => ({ storage: makeMemoryStorage(), appVersion: '1.0.0', autoCheckOnLaunch: true, autoStage: true }),
    []
  );
  return (
    <DashOtaProvider config={config}>
      <Dashboard />
    </DashOtaProvider>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingTop: 64, gap: 16 },
  title: { fontSize: 22, fontWeight: '700' },
  channelBadge: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  channelText: { color: 'white', fontWeight: '800', letterSpacing: 1 },
  card: { backgroundColor: '#f2f3f5', borderRadius: 12, padding: 14, gap: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  label: { color: '#666', fontWeight: '600' },
  value: { color: '#111', flexShrink: 1, textAlign: 'right' },
  notes: { color: '#222' },
  gate: { backgroundColor: '#ffe5e5' },
  gateText: { color: '#a40000', fontWeight: '700' },
  actions: { gap: 10 },
  btn: { backgroundColor: '#2563eb', padding: 14, borderRadius: 10, alignItems: 'center' },
  btnDanger: { backgroundColor: '#dc2626' },
  btnPressed: { opacity: 0.7 },
  btnText: { color: 'white', fontWeight: '700' },
});
