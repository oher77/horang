/**
 * 가림 오버레이 — "유령이 왼쪽으로 지나가며 글자가 먼지처럼 사라진다" (단어장 앱 만들기.md,
 * 단어장 화면 구성 항목). 설계.md §4.5 성능 주석: 텍스트 자체를 파티클화하지 않고,
 * 오버레이 레이어의 translateX(우→좌 스윕) + opacity만 애니메이션한다.
 *
 * 사용법: 셀 콘텐츠를 이 컴포넌트로 감싸고 `hidden` prop을 토글하면
 * hidden=false→true 전환 시 스윕 애니메이션이 재생된 뒤 콘텐츠가 사라지고,
 * hidden=true→false 전환 시 즉시(애니메이션 없이) 다시 보인다(짧게 보기용).
 *
 * stagger: 컬럼 일괄 가림 시 호출부가 `delayMs`를 index*15ms로 넘겨준다.
 * FlatList가 화면 밖 행을 언마운트하므로 보이는 행에만 stagger가 적용된다(설계.md §4.5).
 */

import { memo, useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

interface DustCoverOverlayProps {
  hidden: boolean;
  delayMs?: number;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

const SWEEP_DURATION = 260;
const FADE_DURATION = 220;

function DustCoverOverlayImpl({ hidden, delayMs = 0, children, style }: DustCoverOverlayProps) {
  const contentOpacity = useSharedValue(hidden ? 0 : 1);
  const sweepX = useSharedValue(hidden ? 0 : 100); // % 단위: 100(오른쪽 밖) → 0(정위치) → -100(왼쪽 밖)
  const sweepOpacity = useSharedValue(0);

  useEffect(() => {
    if (hidden) {
      // 유령 스윕: 오른쪽 밖에서 등장 → 셀 위를 가로질러 왼쪽 밖으로. 텍스트는 그 사이 먼지처럼 opacity 0.
      sweepOpacity.value = withDelay(delayMs, withTiming(1, { duration: 40 }));
      sweepX.value = withDelay(
        delayMs,
        withTiming(-100, { duration: SWEEP_DURATION, easing: Easing.out(Easing.cubic) }),
      );
      contentOpacity.value = withDelay(
        delayMs + SWEEP_DURATION * 0.35,
        withTiming(0, { duration: FADE_DURATION }),
      );
    } else {
      // 다시 보이기: 애니메이션 없이 즉시 복원(§4.5 "셀 클릭 개별 가림도 동일 오버레이 재사용,
      // stagger 없이 단발" — 재노출은 학습 흐름상 즉시 확인이 목적이라 지연 불필요).
      sweepOpacity.value = 0;
      sweepX.value = 100;
      contentOpacity.value = 1;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, delayMs]);

  const contentStyle = useAnimatedStyle(() => ({
    opacity: contentOpacity.value,
  }));

  const sweepStyle = useAnimatedStyle(() => ({
    opacity: sweepOpacity.value,
    transform: [{ translateX: `${sweepX.value}%` }],
  }));

  return (
    <View style={[styles.container, style]}>
      <Animated.View style={contentStyle}>{children}</Animated.View>
      <Animated.View pointerEvents="none" style={[styles.sweepLayer, sweepStyle]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    overflow: 'hidden',
  },
  sweepLayer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#c9c2b8',
    opacity: 0,
  },
});

export default memo(DustCoverOverlayImpl);
