import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { initDatabases } from '../lib/db';
import { loadSettings } from '../lib/settings';

type InitState = 'loading' | 'ready' | 'error';

export default function RootLayout() {
  const [state, setState] = useState<InitState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    initDatabases()
      .then(() => loadSettings())
      .then(() => {
        if (!cancelled) setState('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setState('error');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.statusText}>단어장을 준비하고 있어요...</Text>
      </View>
    );
  }

  if (state === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>초기화 중 문제가 발생했어요</Text>
        <Text style={styles.errorMessage}>{errorMessage}</Text>
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      {/* headerBackButtonDisplayMode: 뒤로가기에서 이전 화면 이름 텍스트를 빼고 < 화살표만 */}
      <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }} />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    padding: 24,
    gap: 12,
  },
  statusText: {
    fontSize: 15,
    color: '#666',
  },
  errorTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#c0392b',
  },
  errorMessage: {
    fontSize: 13,
    color: '#999',
    textAlign: 'center',
  },
});
