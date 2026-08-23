import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState, type ReactNode } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ReducedMotionConfig, ReduceMotion } from 'react-native-reanimated';

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

  // 본체는 초기화 단계에 따라 갈리지만, **early return을 쓰지 않고 body에 담아 두는 이유**가
  // 있다: 아래 ReducedMotionConfig가 어느 분기에서도 **한 번만, 계속 마운트된 채로** 있어야
  // 하기 때문이다. 이 컴포넌트는 언마운트될 때 이전 값으로 되돌리므로
  // (`setEnabled(wasEnabled)`), 분기마다 따로 넣으면 분기가 바뀔 때마다 껐다 켜지고,
  // 분기를 새로 추가하면서 빠뜨리면 동작 줄이기가 조용히 되살아난다.
  let body: ReactNode;

  if (state === 'error') {
    body = (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>초기화 중 문제가 발생했어요</Text>
        <Text style={styles.errorMessage}>{errorMessage}</Text>
      </View>
    );
  } else if (!fontsSettled) {
    // 폰트 대기 중에는 **아무것도 그리지 않는다.** 네이티브 스플래시가 화면을 덮고 있어
    // 빈 화면이 보이지 않는다. 여기서 뭔가 그리면 기본 글꼴로 그려져 글자가 튄다.
    // (폰트 로딩 실패는 앱을 막지 않는다 — 시스템 기본 글꼴로 떨어질 뿐이다.)
    body = null;
  } else if (state === 'loading' || !minSplashElapsed) {
    // 폰트는 됐고 DB 초기화만 남은 구간 — 글씨 쓰는 호랑이가 그동안을 채운다.
    // 진행률 막대를 두지 않는 이유: DB 복사·폰트 로드 어느 쪽도 진행률을 알려주지 않아
    // 실제 진행과 무관한 가짜 애니메이션이 된다. 애니메이션 자체가 인디케이터다.
    body = <AnimatedSplash />;
  } else {
    body = (
      <GestureHandlerRootView style={styles.root}>
        {/* headerBackButtonDisplayMode: 뒤로가기에서 이전 화면 이름 텍스트를 빼고 < 화살표만 */}
        <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }} />
      </GestureHandlerRootView>
    );
  }

  return (
    <>
      {/* 시스템 "동작 줄이기(Reduce Motion)"를 앱 전체에서 무력화한다. 이 앱의 애니메이션은
          장식이 아니라 피드백 그 자체다(작은 반응 연출뿐 — 큰 화면 전환·확대 이동 없음).
          실기기 QA에서 Reduce Motion이 켜진 테스터 폰은 호랑이 터치 반응과 자랑하기
          로켓 축포가 전부 최종값으로 즉시 점프해 "아무 일도 안 일어나는" 것처럼 보였다
          (2026-08-22). */}
      <ReducedMotionConfig mode={ReduceMotion.Never} />
      {body}
    </>
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
