/**
 * 점수 확인 애니메이션 — "코끼리가 북을 두드리는 애니메이션이 3초 진행되고 점수가
 * 짠 하고 나온다" (단어장 앱 만들기.md "테스트 화면 구성").
 *
 * 네이티브 이미지/스프라이트 에셋 없이(Expo Go 가드레일 — 새 에셋·서드파티 모듈 없이
 * 구현) 이모지(🐘)를 reanimated로 좌우 흔들며 "북 치는" 느낌의 리듬 애니메이션을
 * 3초간 반복한 뒤 onComplete를 호출한다. 화면에는 취소 버튼이 있어 애니메이션 도중
 * 클릭하면 채점 화면으로 되돌아간다(onCancel).
 */

import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

const DURATION_MS = 3000;

interface ScoreRevealAnimationProps {
  onComplete: () => void;
  onCancel: () => void;
}

export default function ScoreRevealAnimation({ onComplete, onCancel }: ScoreRevealAnimationProps) {
  const rotate = useSharedValue(0);
  const bounce = useSharedValue(0);

  useEffect(() => {
    // 북 치는 리듬: 좌우로 까딱까딱 흔들리며 살짝 위아래로 튐
    rotate.value = withRepeat(
      withSequence(
        withTiming(-12, { duration: 180, easing: Easing.inOut(Easing.quad) }),
        withTiming(12, { duration: 180, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
      true,
    );
    bounce.value = withRepeat(
      withSequence(
        withTiming(-8, { duration: 180, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 180, easing: Easing.in(Easing.quad) }),
      ),
      -1,
      true,
    );

    const timer = setTimeout(() => {
      cancelAnimation(rotate);
      cancelAnimation(bounce);
      runOnJS(onComplete)();
    }, DURATION_MS);

    return () => {
      clearTimeout(timer);
      cancelAnimation(rotate);
      cancelAnimation(bounce);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const elephantStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotate.value}deg` }, { translateY: bounce.value }],
  }));

  return (
    <View style={styles.container}>
      <Animated.Text style={[styles.elephant, elephantStyle]}>🐘</Animated.Text>
      <Text style={styles.drumHint}>둥! 둥! 둥!</Text>
      <Text style={styles.waitText}>점수를 채점하는 중...</Text>

      <Pressable style={styles.cancelButton} onPress={onCancel}>
        <Text style={styles.cancelButtonText}>취소</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  elephant: {
    fontSize: 96,
  },
  drumHint: {
    marginTop: 16,
    fontSize: 18,
    fontWeight: '700',
    color: '#ff8a34',
  },
  waitText: {
    marginTop: 8,
    fontSize: 13,
    color: '#999',
  },
  cancelButton: {
    marginTop: 40,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
  },
});
