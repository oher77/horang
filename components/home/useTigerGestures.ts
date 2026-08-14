import { useMemo, useRef } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

/**
 * 호랑이 머리 제스처 4종 (design/홈화면-에셋-가이드.md §2-8, 2026-08-14 재설계).
 *
 * 이 훅은 **제스처 판정만** 담당한다 — 애니메이션 값(withTiming 등)은 만들지 않고,
 * 판정 결과를 콜백으로만 뱉는다. 실제 transform/사운드 재생은 호출부(TigerHero.tsx)의 몫이다.
 *
 * ── 2026-08-14 재설계 요지 ──────────────────────────────────────────────
 * - 탭 1회 = 랜덤 이벤트(디스패치는 TigerHero가 함). **탭 3연타 폐기** — 탭이 랜덤이 되면서
 *   "빠른 3탭"이 랜덤 3회인지 3연타 1개인지 판정이 충돌하기 때문.
 * - 길게 누르기(LongPress) 폐기 → **아래로 당겼다 놓기**(Pan, 아래 방향 전용)로 교체.
 *   머리 영역에서는 세로 스크롤을 포기해도 된다는 결정(§2-8) 덕분에, 예전에 당기기를
 *   폐기했던 이유(ScrollView가 먼저 가로채는 문제)가 사라졌다 — `blocksExternalGesture`로
 *   ScrollView를 이긴다.
 * - `pet`(좌우 쓰다듬기)은 그대로 유지 — 아이가 동물에게 하는 본능적 동작이고, 당기기
 *   때문에 Pan 기계장치가 어차피 필요해 추가 비용이 거의 없다.
 *
 * `pet`·`headPop`은 "누르고 있는 동안 ~ 손 뗄 때"처럼 시작/끝이 있는 제스처라, 단발성
 * 이벤트만으로는 애니메이션을 시작/복귀시킬 수 없다. 그래서 TigerEvent 4종 외에
 * `onPetEnd` · `onPullMove` · `onPullEnd` 세 개의 생명주기 콜백을 추가로 둔다 — 이것도
 * "제스처가 지금 어떤 상태인가"를 알려주는 판정 결과일 뿐, 애니메이션 자체는 아니다.
 */
export type TigerEvent = 'tap' | 'pet' | 'petLong' | 'headPop';

// ── 실기기 튜닝 상수 (전부 여기서만 고친다) ──────────────────────────────
/** 탭으로 인정하는 최대 이동 거리(px). §2-8 "탭: 이동 10px 미만" */
const TAP_MAX_DISTANCE_PX = 10;
/** 쓰다듬기로 확정하는 가로 이동(px). §2-8 ④ activeOffsetX */
const PAN_ACTIVE_OFFSET_X_PX = 14;
/** 쓰다듬기를 포기하고 스크롤에 양보하는 세로 이동(px). §2-8 ④ failOffsetY */
const PAN_FAIL_OFFSET_Y_PX = 10;
/** 쓰다듬기가 petLong(하품)으로 전환되는 지속 시간(ms). §2-8 ② "1.5초 이상" */
const PET_LONG_THRESHOLD_MS = 1500;
/** 당기기로 확정하는 아래쪽 이동(화면 px). 이 이상 아래로 움직여야 당기기 제스처가 시작된다. */
const PULL_ACTIVATE_PX = 12;
/** 당기기를 포기하고 다른 제스처(쓰다듬기 등)에 양보하는 가로 이동(화면 px). */
const PULL_FAIL_X_PX = 14;

export interface UseTigerGesturesOptions {
  /** 판정된 이벤트 발화. tap/pet/petLong/headPop 네 종류뿐이다. */
  onEvent: (event: TigerEvent) => void;
  /** 쓰다듬기 제스처가 끝남(손을 뗌) — pet/petLong 어느 단계였든 한 번만 호출된다. */
  onPetEnd: () => void;
  /**
   * 아래로 당기는 중. dy = 손가락 세로 이동량(화면 px, 0 이상)이다.
   * "40 디자인 px 이상 당기면 장전"처럼 화면 크기에 따라 달라지는 임계값 판단은
   * renderedWidth를 아는 TigerHero의 몫이라 이 훅은 관여하지 않는다 — 대신 TigerHero가
   * 자신의 판단(이번 이동으로 장전됐는지)을 반환값으로 돌려주면, 이 훅은 그 값을 그대로
   * 캐싱해 두었다가 onPullEnd에 실어 보낸다(제스처 판정 자체가 아니라 단순 중계).
   */
  onPullMove: (dy: number) => boolean | void;
  /** 당기기 끝. armed=true면 임계를 넘겼으므로 튕김을 발동한다. */
  onPullEnd: (armed: boolean) => void;
  /**
   * 지금 새 제스처를 받아도 되는지. 다른 이벤트 애니메이션이 재생 중이면 false를
   * 반환해 "이벤트 재생 중 새 제스처 무시"(§2-4 공통 규칙)를 지키게 한다.
   * ref.current를 읽는 동기 함수로 넘길 것 — 렌더마다 새 함수를 만들어도 무방하다.
   */
  isBusy: () => boolean;
  /** ScrollView ref — 당기기가 세로 스크롤을 이기게 하려면 필요하다 (blocksExternalGesture). */
  scrollRef: React.RefObject<unknown>;
}

export function useTigerGestures({
  onEvent,
  onPetEnd,
  onPullMove,
  onPullEnd,
  isBusy,
  scrollRef,
}: UseTigerGesturesOptions) {
  // 최신 콜백을 항상 참조하기 위한 ref (Gesture 객체는 useMemo로 한 번만 만들되,
  // 콜백 내용은 매 렌더 최신값을 써야 하므로 콜백 자체가 아니라 ref를 캡처한다).
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onPetEndRef = useRef(onPetEnd);
  onPetEndRef.current = onPetEnd;
  const onPullMoveRef = useRef(onPullMove);
  onPullMoveRef.current = onPullMove;
  const onPullEndRef = useRef(onPullEnd);
  onPullEndRef.current = onPullEnd;
  const isBusyRef = useRef(isBusy);
  isBusyRef.current = isBusy;

  // 쓰다듬기 상태
  const isPettingRef = useRef(false);
  const petLongTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 당기기 상태
  const isPullingRef = useRef(false);
  // TigerHero가 onPullMove()의 반환값으로 알려준 "이번 제스처에서 장전됐는지" — 순수 중계용.
  const pullArmedRef = useRef(false);

  function handleTapEnd() {
    if (isBusyRef.current()) return;
    onEventRef.current('tap');
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

  function handlePullStart() {
    if (isBusyRef.current()) return;
    isPullingRef.current = true;
    pullArmedRef.current = false;
  }

  function handlePullUpdate(dy: number) {
    if (!isPullingRef.current) return;
    const result = onPullMoveRef.current(dy);
    if (typeof result === 'boolean') pullArmedRef.current = result;
  }

  function handlePullEnd() {
    // onEnd·onFinalize 양쪽에서 호출될 수 있어 idempotent해야 한다.
    if (!isPullingRef.current) return;
    isPullingRef.current = false;
    const armed = pullArmedRef.current;
    pullArmedRef.current = false;
    onPullEndRef.current(armed);
  }

  // Gesture 객체는 한 번만 생성한다 (콜백은 위 ref를 통해 항상 최신 상태를 본다).
  const gesture = useMemo(() => {
    const tap = Gesture.Tap()
      .maxDistance(TAP_MAX_DISTANCE_PX)
      .onEnd((_e, success) => {
        if (success) runOnJS(handleTapEnd)();
      });

    // 쓰다듬기: 가로 전용. activeOffsetX/failOffsetY 두 값만 설정한다 — 여기 어떤 각도도
    // 쓰지 않는다 (§2-8 ④). 세로로 크게 움직이면 즉시 실패해 pull/스크롤에 양보한다.
    const pet = Gesture.Pan()
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

    // 당기기: 아래 방향 전용. 위로는 activeOffsetY 범위 밖(-100000)이라 활성화되지 않는다.
    // 가로로 크게 움직이면 실패해 쓰다듬기(pet)에 양보한다. blocksExternalGesture로
    // ScrollView(세로 스크롤)를 이겨야 당기기가 실제로 발동한다(§2-8 ①).
    const pull = Gesture.Pan()
      .activeOffsetY([-100000, PULL_ACTIVATE_PX])
      .failOffsetX([-PULL_FAIL_X_PX, PULL_FAIL_X_PX])
      .blocksExternalGesture(scrollRef as never)
      .onStart(() => {
        runOnJS(handlePullStart)();
      })
      .onUpdate((e) => {
        if (e.translationY <= 0) return; // 안전망 — activeOffsetY가 이미 아래쪽만 허용
        runOnJS(handlePullUpdate)(e.translationY);
      })
      .onEnd(() => {
        runOnJS(handlePullEnd)();
      })
      .onFinalize(() => {
        runOnJS(handlePullEnd)();
      });

    // Race: 넷 중 먼저 조건을 만족하는 쪽이 나머지를 취소한다.
    // - 손가락이 14px 이상 가로로 움직이면 pet이 이기고, pull은 failOffsetX를 넘겨 실패한다.
    // - 손가락이 12px 이상 아래로 움직이면 pull이 이기고, pet은 activeOffsetX 밖이라 대기만 한다.
    // - 그 전에 손을 떼면(움직임도 없이) tap이 이긴다.
    return Gesture.Race(pet, pull, tap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRef]);

  return { gesture };
}
