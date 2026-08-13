import { useMemo, useRef } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

import * as Haptics from 'expo-haptics';

/**
 * 호랑이 머리 제스처 5종 (design/홈화면-에셋-가이드.md §2-8).
 *
 * 이 훅은 **제스처 판정만** 담당한다 — 애니메이션 값(withTiming 등)은 만들지 않고,
 * 판정 결과를 콜백으로만 뱉는다. 실제 transform/사운드 재생은 호출부(TigerHero.tsx)의 몫이다.
 *
 * `pet`·`headPop`은 "누르고 있는 동안 ~ 손 뗄 때"처럼 시작/끝이 있는 제스처라, 단발성
 * 이벤트만으로는 애니메이션을 시작/복귀시킬 수 없다. 그래서 TigerEvent 5종 외에
 * `onPetEnd` · `onPressStateChange` 두 개의 생명주기 콜백을 추가로 둔다 — 이것도
 * "제스처가 지금 어떤 상태인가"를 알려주는 판정 결과일 뿐, 애니메이션 자체는 아니다.
 */
export type TigerEvent = 'tap' | 'tripleTap' | 'pet' | 'petLong' | 'headPop';

// ── 실기기 튜닝 상수 (전부 여기서만 고친다) ──────────────────────────────
/** 탭으로 인정하는 최대 이동 거리(px). §2-8 "탭: 이동 10px 미만" */
const TAP_MAX_DISTANCE_PX = 10;
/** 3연타 판정 창(ms). §2-4 "탭 3연타 (1.2s 내)" */
const TRIPLE_TAP_WINDOW_MS = 1200;
/** 쓰다듬기로 확정하는 가로 이동(px). §2-8 ④ activeOffsetX */
const PAN_ACTIVE_OFFSET_X_PX = 14;
/** 쓰다듬기를 포기하고 스크롤에 양보하는 세로 이동(px). §2-8 ④ failOffsetY */
const PAN_FAIL_OFFSET_Y_PX = 10;
/** 쓰다듬기가 petLong(하품)으로 전환되는 지속 시간(ms). §2-8 ② "1.5초 이상" */
const PET_LONG_THRESHOLD_MS = 1500;
/** 길게 누르기 인식 최소 시간(ms). §2-8 ① Gesture.LongPress().minDuration(400) */
const LONG_PRESS_MIN_DURATION_MS = 400;
/**
 * 길게 누르기 인식(onStart, minDuration 경과 시점) 이후 햅틱까지 대기(ms).
 * 가이드는 "터치 시작부터 1.0초"를 기준으로 말하므로, onStart가 minDuration(400ms)
 * 시점에 발생하는 것을 고려해 여기서는 그 나머지(1000 - 400 = 600ms)를 잰다.
 */
const LONG_PRESS_HAPTIC_DELAY_AFTER_START_MS = 1000 - LONG_PRESS_MIN_DURATION_MS;

/**
 * "1초를 채웠다"는 신호 (§2-8 ①).
 * 손가락이 머리를 가리고 있어 시각 신호가 안 보이므로 촉각으로 알린다.
 * 실패해도 무시한다 — 햅틱이 없는 기기/설정에서도 이벤트 자체는 정상 동작해야 한다.
 */
function triggerHaptic() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

export interface UseTigerGesturesOptions {
  /** 판정된 이벤트 발화. tap/tripleTap/pet/petLong/headPop 다섯 종류뿐이다. */
  onEvent: (event: TigerEvent) => void;
  /** 쓰다듬기 제스처가 끝남(손을 뗌) — pet/petLong 어느 단계였든 한 번만 호출된다. */
  onPetEnd: () => void;
  /** 길게 누르기의 "누르고 있는 중" 여부 변화. true: 눌림 시작(인식됨), false: 뗌/취소. */
  onPressStateChange: (pressing: boolean) => void;
  /**
   * 지금 새 제스처를 받아도 되는지. 다른 이벤트 애니메이션이 재생 중이면 false를
   * 반환해 "이벤트 재생 중 새 제스처 무시"(§2-4 공통 규칙)를 지키게 한다.
   * ref.current를 읽는 동기 함수로 넘길 것 — 렌더마다 새 함수를 만들어도 무방하다.
   */
  isBusy: () => boolean;
}

export function useTigerGestures({
  onEvent,
  onPetEnd,
  onPressStateChange,
  isBusy,
}: UseTigerGesturesOptions) {
  // 최신 콜백을 항상 참조하기 위한 ref (Gesture 객체는 useMemo로 한 번만 만들되,
  // 콜백 내용은 매 렌더 최신값을 써야 하므로 콜백 자체가 아니라 ref를 캡처한다).
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onPetEndRef = useRef(onPetEnd);
  onPetEndRef.current = onPetEnd;
  const onPressStateChangeRef = useRef(onPressStateChange);
  onPressStateChangeRef.current = onPressStateChange;
  const isBusyRef = useRef(isBusy);
  isBusyRef.current = isBusy;

  // 3연타 판정용 탭 타임스탬프 (지연 없이 즉시 발화하면서, 최근 1.2s 내 탭 수만 센다).
  const tapTimestampsRef = useRef<number[]>([]);

  // 쓰다듬기 상태
  const isPettingRef = useRef(false);
  const petLongTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 길게 누르기 상태
  const hapticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleTapEnd() {
    if (isBusyRef.current()) return;
    const now = Date.now();
    const kept = tapTimestampsRef.current.filter((t) => now - t <= TRIPLE_TAP_WINDOW_MS);
    kept.push(now);
    tapTimestampsRef.current = kept;

    onEventRef.current('tap');

    if (kept.length >= 3) {
      tapTimestampsRef.current = [];
      onEventRef.current('tripleTap');
    }
  }

  function handlePanStart() {
    if (isBusyRef.current()) return;
    isPettingRef.current = true;
    onEventRef.current('pet');

    if (petLongTimerRef.current) clearTimeout(petLongTimerRef.current);
    petLongTimerRef.current = setTimeout(() => {
      petLongTimerRef.current = null;
      if (!isPettingRef.current) return; // 이미 손을 뗀 뒤라면 무시
      onEventRef.current('petLong');
    }, PET_LONG_THRESHOLD_MS);
  }

  function handlePanEnd() {
    // onEnd·onFinalize 양쪽에서 호출될 수 있어 idempotent해야 한다.
    if (!isPettingRef.current) return;
    isPettingRef.current = false;
    if (petLongTimerRef.current) {
      clearTimeout(petLongTimerRef.current);
      petLongTimerRef.current = null;
    }
    onPetEndRef.current();
  }

  function handleLongPressStart() {
    // onStart는 minDuration(400ms) 경과 시점에 온다 — 즉, 이 시점부터 이미 "길게 누르기"로
    // 확정된 것이다 (탭이었다면 Race에서 Tap이 먼저 이겼을 것). §2-8 ①의 "누르고 있는 동안
    // 내려감" 애니메이션은 여기서부터 시작한다 — 인식 전(0~400ms)에는 시각 피드백을 주지
    // 않는데, 그렇게 하지 않으면 짧은 탭에도 머리가 살짝 내려갔다 튕기는 것처럼 보여
    // tap의 scale 애니메이션과 충돌한다 (아래 "스펙과 다르게 판단한 것" 참고).
    onPressStateChangeRef.current(true);

    if (hapticTimerRef.current) clearTimeout(hapticTimerRef.current);
    hapticTimerRef.current = setTimeout(() => {
      hapticTimerRef.current = null;
      triggerHaptic();
    }, LONG_PRESS_HAPTIC_DELAY_AFTER_START_MS);
  }

  function handleLongPressEnd(success: boolean) {
    if (hapticTimerRef.current) {
      clearTimeout(hapticTimerRef.current);
      hapticTimerRef.current = null;
    }
    onPressStateChangeRef.current(false);
    if (success) {
      onEventRef.current('headPop');
    }
  }

  // Gesture 객체는 한 번만 생성한다 (콜백은 위 ref를 통해 항상 최신 상태를 본다).
  const gesture = useMemo(() => {
    const tap = Gesture.Tap()
      .maxDistance(TAP_MAX_DISTANCE_PX)
      .onEnd((_e, success) => {
        if (success) runOnJS(handleTapEnd)();
      });

    // 쓰다듬기: 가로 전용. activeOffsetX/failOffsetY 두 값만 설정한다 — 여기 어떤 각도도
    // 쓰지 않는다 (§2-8 ④). 세로로 크게 움직이면 즉시 실패해 ScrollView에 양보한다.
    const pan = Gesture.Pan()
      .activeOffsetX([-PAN_ACTIVE_OFFSET_X_PX, PAN_ACTIVE_OFFSET_X_PX])
      .failOffsetY([-PAN_FAIL_OFFSET_Y_PX, PAN_FAIL_OFFSET_Y_PX])
      .onStart(() => {
        runOnJS(handlePanStart)();
      })
      .onEnd(() => {
        runOnJS(handlePanEnd)();
      })
      .onFinalize(() => {
        runOnJS(handlePanEnd)();
      });

    const longPress = Gesture.LongPress()
      .minDuration(LONG_PRESS_MIN_DURATION_MS)
      .onStart(() => {
        runOnJS(handleLongPressStart)();
      })
      .onEnd((_e, success) => {
        runOnJS(handleLongPressEnd)(success);
      });

    // Race: 셋 중 먼저 조건을 만족하는 쪽이 나머지를 취소한다.
    // - 손가락이 14px 이상 가로로 움직이면 pan이 이기고, longPress는 기본 maxDistance(약
    //   10px)를 넘겨 스스로 실패한다.
    // - 400ms 동안 가만히 있으면 longPress가 이긴다.
    // - 그 전에 손을 떼면(움직임도 없이) tap이 이긴다.
    return Gesture.Race(pan, longPress, tap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { gesture };
}
