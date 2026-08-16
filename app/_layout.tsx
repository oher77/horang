import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import AnimatedSplash from '../components/AnimatedSplash';
import { initDatabases } from '../lib/db';
import { FONT_ASSETS } from '../lib/fonts';
import { rescheduleSlotNotifications } from '../lib/notifications';
import { loadSettings } from '../lib/settings';

// 네이티브 스플래시(iOS storyboard)를 **우리가 내릴 때까지** 붙잡아 둔다.
// 자동으로 내려가면 폰트가 준비되기 전에 JS 화면이 드러나, 기본 글꼴로 한 프레임
// 그려졌다가 손글씨로 바뀌면서 글자가 튄다.
// Expo Go에는 우리 storyboard가 없어 이 호출이 무의미할 수 있다 — 실패해도 무시한다.
SplashScreen.preventAutoHideAsync().catch(() => {});
// 200ms 크로스페이드. 네이티브 스플래시에는 줄·글자가 없으므로(storyboard는 커스텀
// 폰트를 못 그린다) 이 페이드 동안 줄과 "호랑잉글리시"가 함께 떠오른다. 호랑이는
// 양쪽이 같은 크기·같은 자리라 제자리에 머문다.
SplashScreen.setOptions({ duration: 200, fade: true });

type InitState = 'loading' | 'ready' | 'error';

/**
 * 애니메이션 스플래시 최소 표시 시간(ms). **0으로 두면 안 되는 이유가 있다.**
 * 초기화는 보통 0.2~0.3초에 끝나는데(content.db 복사는 첫 실행에만 있다), 그러면 호랑이가
 * 한 획 긋다 말고 사라져 화면이 고장 난 것처럼 보인다. 끄적임 한 바퀴가 780ms
 * (components/AnimatedSplash.tsx의 `SEQUENCE` 6장 × `FRAME_MS` 130)이므로
 * 그보다 조금 길게 잡아 **최소 한 바퀴는 돌게** 한다.
 * 시간은 폰트가 준비돼 화면이 실제로 보이기 시작한 시점부터 잰다.
 */
// `: number`는 필수다 — 없으면 리터럴 900으로 좁혀져 아래 `=== 0` 비교가 타입 오류가 난다.
const SPLASH_MIN_MS: number = 900;

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

  // 네이티브 스플래시를 내리는 시점 = **손글씨 폰트가 준비된 순간.**
  // (초기화 실패 시에도 내려야 한다 — 안 그러면 오류 화면이 스플래시에 덮여 안 보인다.)
  const fontsSettled = fontsLoaded || Boolean(fontError);
  useEffect(() => {
    if (fontsSettled || state === 'error') {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsSettled, state]);

  // 최소 표시 시간은 **폰트가 준비된 시점부터** 잰다 — 마운트 시점부터 재면 폰트 로딩이
  // 오래 걸린 만큼 깎여서, 정작 애니메이션은 잠깐만 보이는 일이 생긴다.
  const [minSplashElapsed, setMinSplashElapsed] = useState(SPLASH_MIN_MS === 0);
  useEffect(() => {
    if (!fontsSettled) return;
    const id = setTimeout(() => setMinSplashElapsed(true), SPLASH_MIN_MS);
    return () => clearTimeout(id);
  }, [fontsSettled]);

  if (state === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>초기화 중 문제가 발생했어요</Text>
        <Text style={styles.errorMessage}>{errorMessage}</Text>
      </View>
    );
  }

  // 폰트 대기 중에는 **아무것도 그리지 않는다.** 네이티브 스플래시가 화면을 덮고 있어
  // 빈 화면이 보이지 않는다. 여기서 뭔가 그리면 기본 글꼴로 그려져 글자가 튄다.
  // (폰트 로딩 실패는 앱을 막지 않는다 — 시스템 기본 글꼴로 떨어질 뿐이다.)
  if (!fontsSettled) return null;

  // 폰트는 됐고 DB 초기화만 남은 구간 — 글씨 쓰는 호랑이가 그동안을 채운다.
  // 진행률 막대를 두지 않는 이유: DB 복사·폰트 로드 어느 쪽도 진행률을 알려주지 않아
  // 실제 진행과 무관한 가짜 애니메이션이 된다. 애니메이션 자체가 인디케이터다.
  if (state === 'loading' || !minSplashElapsed) {
    return <AnimatedSplash />;
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
