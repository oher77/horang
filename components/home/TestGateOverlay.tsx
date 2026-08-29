import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { getPrizeRange, type PrizeRange } from '../../lib/incomeQueries';
import { snoozeTest, type TestGateState } from '../../lib/testSchedule';

/**
 * 테스트 진입 덮개 — 홈 화면 전용, 홈의 절대좌표 체계(`mockupLayout.ts`)에
 * 참여하지 않는다. 평범한 flex + 안전영역으로 짠다.
 *
 * 배경: 딸(중2)이 "시험 보는 게 무서워서 테스트 버튼을 회피하게 된다"고 했다.
 * 무서운 건 시험이 아니라 **버튼을 누르는 결정**이므로, 예약 시각이 되면 이
 * 덮개가 떠서 그 결정 자체를 없앤다. 남은 탈출구는 [30분 뒤에 할래] 하루 1회뿐이고,
 * 그마저 없으면 나가는 길은 테스트를 보는 것 하나다(아래 렌더 주석 참고).
 *
 * ── 입구가 둘이고, 둘이 같은 문을 쓴다 (2026-08-29) ──────────────────────
 * 원래 이 덮개는 예약 시각이 지났을 때만 떴고, 홈의 [테스트] 버튼은 `/test`로
 * 곧장 갔다. 그러면 **자기 발로 들어간 사람만 아무 때나 바로 나올 수 있다** —
 * 스스로 하겠다고 나선 쪽에 더 약한 계약이 걸리는 셈이라 앞뒤가 안 맞았다
 * (사용자 피드백). 그래서 버튼도 이 덮개를 거치게 하고, 진입은 양쪽 다
 * 길게 누르기 + `locked=1`로 통일했다. 다른 것은 **문구와 탈출구뿐**이다:
 * `due`는 시각이 지나 떠밀린 상황이라 미루기가 붙고, `manual`은 본인이 연 것이라
 * 그냥 닫기([쫌 있다])만 붙는다.
 *
 * ── 문구 톤 ─────────────────────────────────────────────────────────────
 * 처음에는 "시험·테스트·점수"를 아예 쓰지 않고 달래는 톤("틀려도 아무 일 없어")으로
 * 짰다. 실기기에서 보니 **어르고 달래는 느낌이 오히려 이 일을 큰일처럼 만들었다** —
 * 안심시킬 게 많다는 건 무서운 일이라는 뜻이 된다. 그래서 반대로 갔다: 짧고 신나게,
 * 달래는 본문은 삭제. **금지어 규칙은 폐기됐다**(2026-08-25) — 이름을 피하는 것보다
 * 가볍게 부르는 쪽이 공포를 더 줄인다는 판단.
 * 제목은 두 입구 모두 **"테스트"** 한 단어다(2026-08-29 사용자 지정) — 같은 화면이
 * 상황에 따라 다른 이름으로 불리면 같은 화면인 줄 모른다. 본문은 달래는 대신
 * **상금을 앞세운다**: 겁내는 마음을 반박하는 것보다 다른 것을 쳐다보게 하는 쪽이 낫다.
 */

/**
 * 덮개를 띄운 이유. `due`는 게이트 판정이 만든 상태를 그대로 받고,
 * `manual`은 홈 [테스트] 버튼이 만든 것이라 실을 데이터가 없다.
 */
export type TestGateReason = Extract<TestGateState, { kind: 'due' }> | { kind: 'manual' };

interface Props {
  gate: TestGateReason;
  /**
   * 덮개를 내려야 할 때 부모에 알린다 — `due`면 snooze/skip 후 게이트 재조회,
   * `manual`이면 그냥 닫기.
   */
  onResolved: () => void;
  /**
   * 테스트 화면으로 넘기기 **직전에** 부른다. 부모가 게이트 상태를 "모름"으로 되돌리게
   * 하는 것이 목적 — 이유는 `enterTest` 주석 참고. optional로 두지 않는다: 빼먹으면
   * 복귀할 때 덮개가 번쩍이는 버그가 조용히 되살아난다.
   */
  onEnterTest: () => void;
}

/** 1000 → "1,000원". 장부 화면들(`toLocaleString()+원`)과 같은 표기. */
function won(amount: number): string {
  return `${amount.toLocaleString()}원`;
}

/**
 * 본문 문구. 세 상황이 **문장 조각을 하나도 공유하지 않는다**(2026-08-29 사용자 결정) —
 * 한 덩어리를 고치면 그 상황만 바뀌므로 실기기를 보면서 따로따로 만질 수 있다.
 * 공통 머리말을 뽑아 쓰면 한 줄 고칠 때마다 다른 상황까지 딸려 바뀐다.
 *
 * 시각·상금 금액·구간 문턱은 데이터에서 읽어 끼운다(`gate.hour`, `getPrizeRange`) —
 * 여기에 숫자를 박으면 설정을 고친 순간 덮개만 거짓말을 한다.
 */
function bodyText(gate: TestGateReason, prize: PrizeRange): string {
  if (gate.kind === 'manual') {
    return `테스트 기회는 하루에 한 번뿐. 최고 ${won(prize.topAmount)}의 상금을 획득하세요. 화이팅!`;
  }

  // 미루기가 남아 있으면 "한 번뿐"이라는 규칙을 **미루기 전에** 알리고 최고 상금으로 당긴다.
  if (gate.canSnooze) {
    return `${gate.hour}시가 지나면 테스트를 꼭 봐야합니다~ 미룰 수 있는 기회는 딱 한 번이에요. 테스트 상금의 기회를 놓치지 마세요. 최고 ${won(prize.topAmount)}!`;
  }

  // 미룰 수 없는 마지막 기회 — **탈출구가 없는 화면이다**(아래 렌더 참고).
  // 여기 오는 경로는 둘이다: 미루기를 이미 썼거나, 미루면 자정을 넘기는 늦은 밤이거나
  // (lib/testSchedule.ts의 snoozeWouldCrossMidnight). **문구는 둘을 구분하지 않는다** —
  // 어느 쪽이든 지금 할 수 있는 일이 하나뿐이라 이유 설명은 소음이다.
  //
  // 이 문구만 **한 문장으로 짧다.** 딸 피드백으로 두 번 깎였다(2026-08-29):
  // ⓐ "마지막 기회예요."를 뺐다 — 마지막이라는 말은 재촉이지 안내가 아니었다.
  // ⓑ 상금 안내("N점만 넘어도 …")도 뺐다 — 여기까지 온 사람은 이미 들어가는 것 말고
  //    선택지가 없으므로, 무엇을 얻는지 설명하는 건 설득이 아니라 소음이다.
  //    설득이 필요한 자리는 **아직 고를 수 있는** 위 두 문구다.
  // 시각도 다시 말하지 않는다 — 이미 한 번 보고 미룬 사람이라 아는 정보다.
  //
  // 상금 문구를 되살리려면 아래 줄로 교체 (prize는 위 두 분기가 계속 쓰므로 그대로 있다):
  //   return `이제 테스트 봐요~ ${prize.lowScore}점만 넘어도 ${won(prize.lowAmount)}을 받아요.`;
  return '이제 테스트 봐요~';
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
const TITLE_FONT_SIZE = 38;
const BODY_FONT_SIZE = 26;
const BUTTON_FONT_SIZE = 26;

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

export default function TestGateOverlay({ gate, onResolved, onEnterTest }: Props) {
  const insets = useSafeAreaInsets();

  /** 0 → 1. 게이지 폭이자 진입 타이머 그 자체다(별도 setTimeout을 두지 않는 이유는 아래). */
  const hold = useSharedValue(0);

  /** 진동 유지용 반복 타이머. 화면을 떠날 때까지 살아 있으면 테스트 화면에서 계속 떨린다. */
  const buzzTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * 본문에 끼울 상금 금액. null이면 아직 조회 중이라 **덮개 자체를 그리지 않는다** —
   * 카드가 먼저 뜨고 본문이 한 박자 뒤에 끼어들면 카드 높이가 튄다. 홈이 잠깐 보였다가
   * 덮이는 편이 낫다는 판단은 `app/index.tsx`의 게이트 조회와 같다(로컬 SQLite 읽기라
   * 실제로는 몇 ms다).
   */
  const [prize, setPrize] = useState<PrizeRange | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPrizeRange()
      .then((p) => {
        if (!cancelled) setPrize(p);
      })
      .catch(() => {
        // 조회 실패로 덮개를 영영 안 띄우면 게이트가 조용히 사라진다 — 상금 문구는
        // 곁다리고 **덮개 자체가 기능**이므로 0원으로라도 띄운다.
        if (!cancelled) setPrize({ topAmount: 0, lowScore: 0, lowAmount: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

    /**
     * 넘기기 **직전에** 부모에게 알려 게이트 상태를 "모름"으로 되돌린다.
     *
     * 홈은 테스트 화면이 위에 쌓이는 동안 언마운트되지 않고, 이 덮개도 그 밑에 그대로
     * 깔려 있다. 알리지 않으면 홈의 `testGate`가 계속 `'due'`라서, **점수를 확인하고
     * 뒤로 나오는 순간 덮개가 다시 드러났다가** 재조회(`'done'`)가 끝나는 몇 ms 뒤에야
     * 사라진다 — 아이가 막 끝내고 나오는 길에 "또 잡네"로 읽히는 자리다.
     *
     * 낙관적으로 `'done'`을 미리 찍지 않고 "모름"으로 두는 이유: 끝까지 볼지는 아직
     * 모르기 때문이다. `null`의 뜻이 이미 "아직 모름 → 덮개 안 그림"이라, 상태를
     * 조작하는 게 아니라 사실대로 되돌리는 것이다.
     */
    onEnterTest();
    router.push({ pathname: '/test', params: { locked: '1' } });
  }, [onEnterTest, stopBuzz]);

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

  // 반환값(성공 여부)을 일부러 보지 않는다. 실패 경로는 하나뿐이고(늦은 밤이라 자정을
  // 넘기는 미루기) 그 답은 성공했을 때와 똑같이 **재조회**다 — 게이트가 다시 판정하면
  // canSnooze가 false로 내려와 마지막 기회 덮개로 바뀐다. 여기서 실패를 따로 처리하면
  // 같은 판정을 화면에서 한 번 더 하게 된다.
  const handleSnooze = async () => {
    await snoozeTest();
    onResolved();
  };

  // scaleX + 왼쪽 기준점으로 채운다. width를 %로 애니메이션하면 매 프레임 레이아웃이
  // 다시 계산되지만, transform은 레이아웃을 건드리지 않아 UI 스레드에서만 돈다.
  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: hold.value }] }));

  // 훅은 전부 위에서 선언했다 — 이 이른 반환은 반드시 마지막 훅 뒤에 와야 한다.
  if (prize === null) return null;

  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
      ]}
    >
      <View style={styles.card}>
        <Text maxFontSizeMultiplier={1.2} style={styles.title}>
          테스트
        </Text>

        <Text maxFontSizeMultiplier={1.2} style={styles.body}>
          {bodyText(gate, prize)}
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

        {/*
          탈출구는 입구에 따라 다르다.
          - `manual`: 본인이 연 것이라 그냥 닫는다. 미루기 횟수를 쓰지 않는다 —
            떠밀린 적이 없으므로 유예할 것도 없다.
          - `due` + 미루기 가능: 30분 유예.
          - `due` + 미루기 불가(소진했거나 자정을 넘기는 늦은 밤): **버튼이 없다.**
            나가는 길은 테스트를 보는 것뿐.

          ── [오늘은 넘어갈래] 제거 (2026-08-29, 딸 본인 요청) ──────────────
          원래는 미루기가 소진되면 이 자리에 [오늘은 넘어갈래]가 떴고, 설계.md §8에
          "없애면 회피가 앱 강제 종료로 옮겨가 자기구속이 오히려 약해진다"고 적어
          **일부러 남겨둔 탈출구**였다. 그 판단을 뒤집은 건 딸 본인이다 — 결심을
          실행시키는 장치로 쓰고 싶으니 빠져나갈 길을 테스트뿐으로 만들어 달라고 했다.
          이 기능은 **딸이 스스로에게 거는 계약**이므로(§8 배경), 계약을 조이는 방향의
          요청은 당사자의 말이 우리 추론을 이긴다.
          되돌리려면 여기 `null` 자리에 [오늘은 넘어갈래] Pressable을 되살리고
          `skipTestToday()`를 다시 부르면 된다(그 함수는 지우지 않고 남겨뒀다).
        */}
        {gate.kind === 'manual' ? (
          <Pressable style={[styles.button, styles.secondaryButton]} onPress={onResolved}>
            <Text maxFontSizeMultiplier={1.2} style={styles.secondaryButtonText}>
              쫌 있다
            </Text>
          </Pressable>
        ) : gate.canSnooze ? (
          <Pressable style={[styles.button, styles.secondaryButton]} onPress={handleSnooze}>
            <Text maxFontSizeMultiplier={1.2} style={styles.secondaryButtonText}>
              30분 뒤에 할래
            </Text>
          </Pressable>
        ) : null}
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
  /**
   * 본문. 제목(주황)보다 약하고 보조 버튼 글자(#888)보다는 진해야 읽힌다 —
   * 이 문단이 덮개에서 유일하게 "읽는" 요소다.
   * 줄바꿈은 손으로 넣지 않는다: 문장 길이가 상금 자릿수·시각에 따라 달라져서
   * 고정 줄바꿈이 금방 어긋난다(제목과 달리 한 낱말이 잘려도 티가 덜 난다).
   */
  body: {
    marginTop: 14,
    fontSize: BODY_FONT_SIZE,
    lineHeight: BODY_FONT_SIZE * HANDWRITING_METRICS.lineHeightEm,
    fontFamily: HANDWRITING_FONT,
    color: '#6b6259',
    textAlign: 'center',
  },
});
