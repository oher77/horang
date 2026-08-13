import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { initDatabases } from '../lib/db';
import { FONT_ASSETS } from '../lib/fonts';
import { rescheduleSlotNotifications } from '../lib/notifications';
import { loadSettings } from '../lib/settings';

type InitState = 'loading' | 'ready' | 'error';

export default function RootLayout() {
  const [state, setState] = useState<InitState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // 손글씨 폰트는 기존 초기화 게이트와 함께 기다린다 — 따로 기다리면 기본 폰트로
  // 한 프레임 그려졌다가 바뀌면서 글자가 깜빡인다 (가이드 §5).
  const [fontsLoaded, fontError] = useFonts(FONT_ASSETS);

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

  // 시간대 미션 알림 재예약: DB 초기화 완료 직후(앱 시작) + 포그라운드 복귀마다.
  // rescheduleSlotNotifications()는 내부에서 활성화 여부를 판단하므로 무조건 호출한다.
  useEffect(() => {
    if (state !== 'ready') return;

    rescheduleSlotNotifications();

    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        rescheduleSlotNotifications();
      }
    });
    return () => subscription.remove();
  }, [state]);

  // 폰트 로딩 실패는 앱을 막지 않는다 — 시스템 기본 글꼴로 떨어질 뿐이다.
  if (state === 'loading' || (!fontsLoaded && !fontError)) {
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
