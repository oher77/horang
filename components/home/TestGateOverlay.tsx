import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HANDWRITING_FONT, HANDWRITING_METRICS } from '../../lib/fonts';
import { skipTestToday, snoozeTest, SNOOZE_LIMIT, type TestGateState } from '../../lib/testSchedule';

/**
 * 예약 테스트 덮개 — 홈 화면 전용, 홈의 절대좌표 체계(`mockupLayout.ts`)에
 * 참여하지 않는다. 평범한 flex + 안전영역으로 짠다.
 *
 * 배경: 딸(중2)이 "시험 보는 게 무서워서 테스트 버튼을 회피하게 된다"고 했다.
 * 무서운 건 시험이 아니라 **버튼을 누르는 결정**이므로, 예약 시각이 되면 이
 * 덮개가 떠서 그 결정 자체를 없앤다. 단 완전히 가두지 않는다 — [30분 뒤에]/
 * [오늘은 넘어가기] 탈출구가 항상 있다(탈출구가 "앱 강제 종료"뿐이면 회피가
 * 버튼에서 앱 전체로 옮겨간다).
 *
 * ── 문구 톤 (2026-08-25 실기기 확인 후 사용자 결정으로 전환) ────────────
 * 처음에는 "시험·테스트·점수"를 아예 쓰지 않고 달래는 톤("틀려도 아무 일 없어")으로
 * 짰다. 실기기에서 보니 **어르고 달래는 느낌이 오히려 이 일을 큰일처럼 만들었다** —
 * 안심시킬 게 많다는 건 무서운 일이라는 뜻이 된다. 그래서 반대로 갔다: "테스트 타임!"
 * 한 줄로 짧고 신나게, 달래는 본문은 삭제. **금지어 규칙은 폐기됐다** — 이름을 피하는
 * 것보다 가볍게 부르는 쪽이 공포를 더 줄인다는 판단.
 */

interface Props {
  gate: Extract<TestGateState, { kind: 'due' }>;
  /** snooze/skip 처리 후 게이트를 다시 조회해 닫으라고 부모에 알린다. */
  onResolved: () => void;
}

// 덮개는 flex 흐름이라 `handwritingTop()`(절대좌표 전용)을 쓰지 않는다 — 폰트
// 패밀리만 앱 전체와 맞추고, 세로 위치는 flex가 알아서 정렬한다. 단 `lineHeight`는
// `fontSize`와 같게 두면 iOS가 베이스라인을 재배치해 글자가 아래로 밀리므로
// (lib/fonts.ts 기록된 실제 사고) 반드시 `lineHeightEm`을 곱해 명시한다.
//
// ⚠ 이 숫자들은 **시스템 폰트 기준으로 잡으면 안 된다.** 손글씨(NanumJungHagSaeng)는
// 같은 fontSize에서 시스템 폰트보다 글자가 눈에 띄게 작게 찍힌다. 처음에 20/15/16/12
// (시스템 폰트 감각)로 잡았다가 실기기에서 전부 작아 보여 약 1.4~1.7배로 올렸다.
// 홈·스플래시는 절대좌표라 각자 실측값을 쓰므로 여기 값과 무관하다 — 전역 손잡이
// (HANDWRITING_TUNED_SCALE)를 건드리면 그쪽 레이아웃이 통째로 깨지니 쓰지 말 것.
const TITLE_FONT_SIZE = 34;
const BUTTON_FONT_SIZE = 24;
const HINT_FONT_SIZE = 17;

/**
 * 테스트 진입은 **길게 눌러야** 한다(2026-08-25 사용자 결정). 한 번 탭으로 들어가면
 * 그 탭이 다시 "내가 심판받기를 선택했다"는 결정이 되는데, 이 덮개는 바로 그 결정을
 * 없애려고 만든 것이라 앞뒤가 안 맞았다. 꾹 누르는 동안 게이지가 차오르는 방식은
 * 결정이 아니라 **의식(ritual)** 에 가까워서, 같은 진입인데 부담이 덜하다.
 *
 * 1.2초: 실수로 눌리기엔 충분히 길고, 지루하다고 느끼기엔 짧다(실기기 확인 완료).
 * 누르는 순간부터 200ms마다 톡톡 울리고(총 6번), 다 차는 순간에만 성격이 다른 햅틱이 온다.
 */
const HOLD_MS = 1200;
/** 손을 떼면 되감기는 시간. 채우기보다 빨라야 "취소됐다"가 즉시 읽힌다. */
const HOLD_RESET_MS = 180;
/**
 * 게이지가 차는 동안 울리는 햅틱 간격(ms).
 *
 * **연속 진동을 흉내내려던 걸 포기하고 리듬으로 갔다** (2026-08-25 실기기, 사용자 결정).
 * 처음엔 60ms(약 17Hz)로 촘촘히 때려 "떨림"처럼 이어 붙였는데, 이어 붙일수록 세기가
 * 누적돼 거슬렸다. 200ms는 개별 박자가 또렷이 갈리는 영역이고 — HOLD_MS 1.2초 동안
 * 정확히 여섯 번 — 그래서 "떨림"이 아니라 **차오르는 박자**로 읽힌다. 세기를 낮추는
 * 대신 횟수를 줄인 셈이라 손에 남는 총량이 훨씬 가볍다.
 *
 * 이 값을 다시 촘촘하게(<100ms) 만들 거라면 세기도 같이 내려야 한다. 그 조합은 이미
 * 시도했고 사용자가 반려했으니, 되돌리기 전에 아래 "폐기한 안"을 먼저 읽을 것.
 */
const HOLD_BUZZ_INTERVAL_MS = 200;

/**
 * 게이지가 차는 동안의 한 박자. **`Soft`로 확정** (2026-08-25 실기기, 사용자 선택).
 * 세기 사다리(약→강): selectionAsync < Soft < Light < Rigid ≈ Medium < Heavy.
 *
 * ── 폐기한 안 (2026-08-25 실기기, 전부 사용자가 직접 만져보고 반려) ──────
 * ⓐ RN 코어 `Vibration.vibrate(pattern, true)`로 시스템 진동을 이어붙인 "징—" 연속음:
 *    **너무 강했다.** iOS는 duration을 무시하고 약 400ms로 고정이라 세기 조절이 원천적으로
 *    불가능하고 진동음까지 난다.
 * ⓑ `selectionAsync()`(가장 약함)를 60ms로 촘촘히: 너무 여려서 존재감이 없었다.
 * → 결론은 **약하게 많이가 아니라 적당히 드물게**였다. 세기와 밀도는 따로 못 고른다 —
 *   손에 남는 건 둘의 곱이다.
 *
 * 진짜 연속 햅틱(CoreHaptics `hapticContinuous` — 세기·날카로움을 실시간으로 미는 것)은
 * expo-haptics가 노출하지 않고 Expo Go 번들에도 없다. 쓰려면 네이티브 모듈 = dev build라
 * 프로젝트 가드레일에 걸린다(CLAUDE.md 가드레일).
 */
function pulse(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => {});
}

export default function TestGateOverlay({ gate, onResolved }: Props) {
  const insets = useSafeAreaInsets();

  /** 0 → 1. 게이지 폭이자 진입 타이머 그 자체다(별도 setTimeout을 두지 않는 이유는 아래). */
  const hold = useSharedValue(0);

  /** 진동 유지용 반복 타이머. 화면을 떠날 때까지 살아 있으면 테스트 화면에서 계속 떨린다. */
  const buzzTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopBuzz = useCallback(() => {
    if (buzzTimer.current === null) return;
    clearInterval(buzzTimer.current);
    buzzTimer.current = null;
  }, []);

  const startBuzz = useCallback(() => {
    stopBuzz();
    // 누르는 즉시 첫 박자를 준다 — setInterval은 첫 발이 한 주기 뒤에 나가는데, 200ms면
    // 그 공백이 "안 눌렸나?" 하는 침묵으로 느껴진다. 첫 박자가 곧 "받았다"는 응답이다.
    pulse();
    buzzTimer.current = setInterval(pulse, HOLD_BUZZ_INTERVAL_MS);
  }, [stopBuzz]);

  // 언마운트 안전망 — 다 채워 이동하는 경로는 enterTest가 직접 끄지만, 그 외에
  // (게이트가 풀려 덮개가 사라지는 등) 손을 뗀 적 없이 사라지는 경로가 있다.
  useEffect(() => stopBuzz, [stopBuzz]);

  const enterTest = useCallback(() => {
    // 진동을 **먼저** 끊는다. 반복 임팩트가 겹친 채로 성공 햅틱을 주면 뭉개져서
    // "다 찼다"는 신호가 안 읽힌다.
    stopBuzz();
    // 완료 햅틱은 종류를 바꿔 성격을 구분한다 — 채우는 동안은 impact(떨림),
    // 다 찬 순간은 notification(사건).
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    router.push({ pathname: '/test', params: { locked: '1' } });
  }, [stopBuzz]);

  const handlePressIn = useCallback(() => {
    // 첫 박자를 누르는 즉시 준다. 한때는 "누름 햅틱을 빼야 이어지는 떨림과 성격이 안
    // 갈린다"고 봤지만, 연속 흉내를 포기하고 리듬으로 가면서 전제가 사라졌다 — 이제
    // 첫 박자는 이질적인 사건이 아니라 여섯 박자 중 첫 번째다.
    startBuzz();

    hold.value = 0;
    // 완료 판정을 애니메이션 콜백에 맡긴다 — setTimeout을 따로 두면 JS 스레드가 밀릴 때
    // 게이지(UI 스레드)와 타이머가 어긋나 "다 찼는데 안 들어가는" 순간이 생긴다.
    hold.value = withTiming(1, { duration: HOLD_MS, easing: Easing.linear }, (finished) => {
      if (finished) runOnJS(enterTest)();
    });
  }, [enterTest, hold, startBuzz]);

  const handlePressOut = useCallback(() => {
    stopBuzz();
    cancelAnimation(hold);
    hold.value = withTiming(0, { duration: HOLD_RESET_MS, easing: Easing.out(Easing.quad) });
  }, [hold, stopBuzz]);

  const handleSnooze = async () => {
    await snoozeTest();
    onResolved();
  };

  const handleSkip = async () => {
    await skipTestToday();
    onResolved();
  };

  // scaleX + 왼쪽 기준점으로 채운다. width를 %로 애니메이션하면 매 프레임 레이아웃이
  // 다시 계산되지만, transform은 레이아웃을 건드리지 않아 UI 스레드에서만 돈다.
  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: hold.value }] }));

  const isLastSnooze = gate.snoozeCount === SNOOZE_LIMIT - 1;

  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
      ]}
    >
      <View style={styles.card}>
        <Text maxFontSizeMultiplier={1.2} style={styles.title}>
          테스트 타임!
        </Text>

        <Pressable
          style={[styles.button, styles.primaryButton]}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          accessibilityRole="button"
          accessibilityLabel="길게 눌러서 테스트 시작하기"
        >
          {/* 게이지가 먼저, 글자가 나중 — 나중에 그린 형제가 위에 온다. */}
          <Animated.View style={[styles.holdFill, fillStyle]} pointerEvents="none" />
          <Text maxFontSizeMultiplier={1.2} style={styles.primaryButtonText}>
            길게 눌러서 테스트 시작하기
          </Text>
        </Pressable>

        {gate.canSnooze ? (
          <>
            <Pressable style={[styles.button, styles.secondaryButton]} onPress={handleSnooze}>
              <Text maxFontSizeMultiplier={1.2} style={styles.secondaryButtonText}>
                30분 뒤에 할래
              </Text>
            </Pressable>
            {isLastSnooze && (
              <Text maxFontSizeMultiplier={1.2} style={styles.hint}>
                미룰 수 있는 건 이번이 마지막이야.
              </Text>
            )}
          </>
        ) : (
          <Pressable style={[styles.button, styles.secondaryButton]} onPress={handleSkip}>
            <Text maxFontSizeMultiplier={1.2} style={styles.secondaryButtonText}>
              오늘은 넘어갈래
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1000,
    elevation: 1000,
    backgroundColor: 'rgba(30, 26, 20, 0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#fffaf0',
    borderRadius: 24,
    paddingVertical: 32,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  title: {
    fontSize: TITLE_FONT_SIZE,
    lineHeight: TITLE_FONT_SIZE * HANDWRITING_METRICS.lineHeightEm,
    fontFamily: HANDWRITING_FONT,
    color: '#e8590c',
    textAlign: 'center',
  },
  button: {
    marginTop: 24,
    width: '100%',
    paddingVertical: 16,
    /**
     * 양끝이 반원인 스타디움(순서도의 시작/끝 단자) 모양. 999는 매직넘버가 아니라
     * **어떤 높이의 절반보다도 큰 값**이라는 뜻이다 — RN이 높이의 절반으로 잘라주므로
     * 글자 크기를 바꿔 버튼 높이가 달라져도 항상 정확한 반원이 된다. 높이의 절반을
     * 직접 계산해 박으면 폰트를 손대는 순간 어긋난다.
     */
    borderRadius: 999,
    alignItems: 'center',
    // 게이지가 모서리를 삐져나오지 않게. 이게 없으면 채워질수록 각진 사각형이 드러난다.
    // 스타디움이 되면서 더 중요해졌다 — 잘라내지 않으면 양끝 반원이 통째로 메워진다.
    overflow: 'hidden',
  },
  primaryButton: {
    backgroundColor: '#ff8a34',
  },
  /**
   * 길게 누르기 게이지. `scaleX: 0`에서 시작해 오른쪽으로 자란다 —
   * `transformOrigin: 'left'`가 없으면 가운데서 양쪽으로 벌어져 "차오른다"로 안 읽힌다.
   */
  holdFill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#c2540d',
    transformOrigin: 'left',
  },
  primaryButtonText: {
    fontSize: BUTTON_FONT_SIZE,
    lineHeight: BUTTON_FONT_SIZE * HANDWRITING_METRICS.lineHeightEm,
    fontFamily: HANDWRITING_FONT,
    color: '#fff',
  },
  secondaryButton: {
    marginTop: 12,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#ddd',
  },
  secondaryButtonText: {
    fontSize: BUTTON_FONT_SIZE - 2,
    lineHeight: (BUTTON_FONT_SIZE - 2) * HANDWRITING_METRICS.lineHeightEm,
    fontFamily: HANDWRITING_FONT,
    color: '#888',
  },
  hint: {
    marginTop: 10,
    fontSize: HINT_FONT_SIZE,
    lineHeight: HINT_FONT_SIZE * HANDWRITING_METRICS.lineHeightEm,
    fontFamily: HANDWRITING_FONT,
    color: '#aaa',
    textAlign: 'center',
  },
});
