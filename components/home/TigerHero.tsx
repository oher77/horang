import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { HANDWRITING_FONT } from '../../lib/fonts';
import { playTigerSound, type TigerSound } from '../../lib/tigerSounds';
import { useTigerGestures, type TigerEvent } from './useTigerGestures';

/**
 * 홈 화면 호랑이 + 말풍선 (design/홈화면-에셋-가이드.md §2).
 *
 * ── 렌더 구조 (2026-08-11 갱신 — body/face-normal/eye-shut 에셋 도착) ──────
 * `tiger-body.png` · `tiger-face-normal.png` · `tiger-eye-shut.png` 세 장 모두
 * 히어로 캔버스(1060 × 1111) 그대로라 (0,0)에 겹쳐 놓기만 하면 위치가 맞는다
 * (좌표 계산 불필요). 구조는 §2 최종형 그대로다:
 *
 *   body (고정, 애니메이션 없음)
 *     └ [머리 컨테이너] — 회전축 (532, 285), transform은 전부 여기 하나에만 건다
 *          ├ tiger-face-normal.png
 *          └ tiger-eye-shut.png (opacity로 on/off, 얼굴 위 레이어)
 *
 * 터치 영역(말풍선 탭 / 머리 제스처) 2개는 이 애니메이션 컨테이너 **밖**에
 * 고정으로 둔다 — 머리가 아무리 움직여도 터치 판정 위치는 그대로다(§2).
 *
 * ── 아직 못 채운 것 ──────────────────────────────────────────────────
 * - `tiger-face-yawn1.png` / `tiger-face-yawn2.png` / `tiger-claws.png` 미도착.
 *   petLong(하품) 이벤트는 얼굴 교체·발톱 없이 **머리 모션만** 재생한다.
 *   교체 지점은 아래 `TigerArtwork` 안, `PET_LONG_TODO` 주석 참고.
 * - 사운드 4종 미도착 — `lib/tigerSounds.ts`는 no-op.
 *
 * ── 평상시 숨쉬기 (2026-08-11 추가) ────────────────────────────────────
 * §2-4 "평상시" 표의 숨쉬기(translateY ±4px, 3초 주기 사인)는 **히어로 전체**
 * (몸+머리 통째로)에 건다 — 머리 컨테이너의 회전축 transform과는 별도의 바깥
 * `breathContainer`에서 처리해 서로 겹치지 않는다. 머리만 움직이는 이벤트
 * (headPop 등)는 안쪽 머리 컨테이너 transform이라 숨쉬기 위에 그대로 얹힌다.
 * 터치 영역은 이 숨쉬기 컨테이너 밖(§2)에 그대로 있다.
 */
export interface TigerHeroProps {
  /** 말풍선 안에 얹을 값 — 이미지에 넣지 않고 폰트로 렌더한다 (§2). */
  dayIndex: number;
  wordsCount: number;
  dateLabel: string;
  /** 말풍선 탭 → 오늘의 단어장 진입. */
  onEnterWordbook: () => void;
}

// ── 히어로 캔버스 기준 상수 ──────────────────────────────────────────────
const HERO_WIDTH = 1060;
const HERO_HEIGHT = 1111;
const HERO_ASPECT_RATIO = HERO_WIDTH / HERO_HEIGHT;

// 회전축 실측값 (532, 285) — §2 "회전축 — 실측값". 목 바로 밑, 턱 밑.
const AXIS_X_RATIO = 532 / HERO_WIDTH;
const AXIS_Y_RATIO = 285 / HERO_HEIGHT;

// 터치 영역 실측 좌표 (§2 "실측 좌표") — 비율(%)로 잡아 기기 크기와 무관하게.
const HEAD_AREA = {
  left: 359 / HERO_WIDTH,
  top: 0,
  width: (697 - 359) / HERO_WIDTH,
  height: 350 / HERO_HEIGHT,
};
const BUBBLE_AREA = {
  left: 90 / HERO_WIDTH,
  top: 384 / HERO_HEIGHT,
  width: (970 - 90) / HERO_WIDTH,
  height: (954 - 384) / HERO_HEIGHT,
};

/**
 * 말풍선 안 세 줄 — 시안(`design/호랑이잉글리시.png`) 실측값.
 *
 * 호랑이 캔버스 로컬 y 중심이 각각 498 / 668 / 819 이고, 말풍선이 y 384에서 시작하므로
 * 아래 `centerY`는 **말풍선 로컬** 좌표다. 좌우는 세 줄 모두 말풍선 중앙에서 30px 이내라
 * 그냥 가운데 정렬한다.
 *
 * **순서 주의: 날짜 → DAY → 단어 수** (시안 순서. 코드가 반대로 돼 있던 것을 2026-08-11 정정)
 *
 * `fontSize`는 손글씨 글자높이(98 / 145 / 64)에서 추정한 값이다 — 폰트가 바뀌면
 * 체감 크기가 달라지므로 **실기기 튜닝 대상**.
 */
const BUBBLE_LINES = {
  date: { centerY: 498 - 384, fontSize: 92 },
  day: { centerY: 668 - 384, fontSize: 160 },
  words: { centerY: 819 - 384, fontSize: 72 },
} as const;

const WEEKDAY_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** `2026-07-11` → `2026.07.11.SAT` (시안 표기). 형식이 다르면 원본을 그대로 돌려준다. */
function formatBubbleDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const weekday = WEEKDAY_LABELS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}.${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}.${weekday}`;
}

// ── 이벤트별 연출 상수 (design/홈화면-에셋-가이드.md §2-4, §2-7, §2-8) ──────
// 전부 "히어로 캔버스 1060px 폭 기준" 디자인 px다. 실제 렌더 폭에 맞춰
// designPxToReal()로 환산해서 쓴다. **실기기 튜닝 대상은 각 상수 옆에 표시.**

// 이벤트 3(탭 1회, tap): scale 1.03 움찔, 0.2s
const TAP_SCALE = 1.03; // 튜닝 대상
const TAP_TOTAL_MS = 200;

// 이벤트 4(탭 3연타, tripleTap): rotate ±10°, 250 → 500 유지 → 250
const TRIPLE_TAP_ROTATE_DEG = 10; // 튜닝 대상
const TRIPLE_TAP_IN_MS = 250;
const TRIPLE_TAP_HOLD_MS = 500;
const TRIPLE_TAP_OUT_MS = 250;

// 이벤트 2(쓰다듬기, pet): translateY +18px, 400ms 하강 후 유지
const PET_DOWN_DESIGN_PX = 18; // 튜닝 대상
const PET_DOWN_MS = 400;
const PET_RETURN_MS = 400; // 손 뗀 뒤 복귀

// 이벤트 1(petLong — 하품, 얼굴/발톱 없이 모션만): §2-7 타임라인의 머리 모션 구간만.
// "0ms 머리 뒤로 젖히기(rotate −6°, translateY −8px, 300ms)" → "600ms 유지"
// → "880ms 머리 복귀(300ms)". 총 1200ms(+ 스펙상 1.4s는 얼굴 교체 여운 포함,
// 여기선 얼굴 교체가 없으므로 1200ms로 busy를 잡는다).
const PET_LONG_ROTATE_DEG = -6; // 튜닝 대상
const PET_LONG_TRANSLATE_DESIGN_PX = -8; // 튜닝 대상 (음수 = 위로)
const PET_LONG_ROTATE_MS = 300;
const PET_LONG_HOLD_MS = 600;
const PET_LONG_RETURN_MS = 300;
// PET_LONG_TODO: tiger-face-yawn1.png / yawn2.png / tiger-claws.png 도착 시,
// 아래 handleTigerEvent()의 'petLong' 케이스에 §2-7 타임라인 그대로 얼굴 교체를
// 끼워 넣을 것: 0ms normal → 120ms yawn1(입 조금) → 280ms yawn2(입 최대, 발톱
// 팝인 250ms) → 880ms yawn1(입 줄어듦) → 1000ms normal(발톱 소멸) → 1180ms
// 깜박임 1회(여운) → 1400ms 끝. 얼굴 레이어를 하나 더 두고(TigerArtwork 내부)
// opacity 스왑 또는 source 스왑으로 구현.

// 이벤트 5(길게 눌렀다 떼기, headPop): §2-8 ①
const PRESS_DESCEND_DESIGN_PX = 60; // 튜닝 대상 — 목 연장분(§2-2)과 맞물림, 임의로 늘리지 말 것
const PRESS_DESCEND_MS = 400;
const PRESS_CANCEL_RETURN_MS = 200; // 인식 실패/취소 시 안전망 복귀
/**
 * 머리가 튀어오르는 최고 지점 — 중립보다 이만큼 위(디자인 px).
 * 2026-08-11 실기기 확인 후 30 → 60 으로 2배. 머리 밑선이 281이므로 60px 상승 시
 * 머리 바닥이 221, 목 상단이 224 → 목 끝에서 막 떨어지는 지점이다.
 * 더 확실한 "분리"를 원하면 90(가이드 §2-8 원안, 갭 33px)까지 올리면 된다. 튜닝 대상.
 */
const HEADPOP_GAP_DESIGN_PX = 60;
const HEADPOP_RISE_MS = 180;
const HEADPOP_HOLD_MS = 150;
const HEADPOP_RETURN_MS = 300;

const ALL_SOUNDS: TigerSound[] = ['roar', 'purr', 'huh', 'yelp'];

// ── 깜박임 (§2-4 "평상시") ────────────────────────────────────────────
const BLINK_DURATION_MS = 110; // 하드컷 — 페이드 금지
const BLINK_MIN_INTERVAL_MS = 3500; // 튜닝 대상
const BLINK_MAX_INTERVAL_MS = 6500; // 튜닝 대상
const BLINK_DOUBLE_PROBABILITY = 0.25; // 튜닝 대상
const BLINK_DOUBLE_GAP_MS = 170;

function randomBlinkIntervalMs() {
  return BLINK_MIN_INTERVAL_MS + Math.random() * (BLINK_MAX_INTERVAL_MS - BLINK_MIN_INTERVAL_MS);
}

// ── 평상시 숨쉬기 (§2-4 "평상시") ─────────────────────────────────────
// 머리 컨테이너가 아니라 히어로 전체(바깥 breathContainer)에 건다.
const BREATH_AMPLITUDE_DESIGN_PX = 4; // 튜닝 대상
const BREATH_PERIOD_MS = 3000; // 튜닝 대상 — 3초 주기(위 1.5s + 아래 1.5s)

export default function TigerHero({
  dayIndex,
  wordsCount,
  dateLabel,
  onEnterWordbook,
}: TigerHeroProps) {
  const [renderedWidth, setRenderedWidth] = useState(0);

  // ── 애니메이션 값 (전부 머리 컨테이너 하나에만 적용) ─────────────────
  const headRotateDeg = useSharedValue(0);
  const headExtraTranslateY = useSharedValue(0); // 실제(렌더) px 단위
  const headScale = useSharedValue(1);
  const eyeShutOpacity = useSharedValue(0); // 0 = 뜬 눈, 1 = 감은 눈 (하드컷, 애니메이션 없음)

  // 숨쉬기 — 머리 컨테이너가 아니라 히어로 전체(바깥 breathContainer)에 적용.
  // 다른 이벤트 transform과 겹치지 않는 별도 shared value/컨테이너.
  const breathTranslateY = useSharedValue(0); // 실제(렌더) px 단위

  // ── JS 쪽 상태 (전부 ref — 렌더와 무관하게 타이머/판정에서만 쓴다) ─────
  const eventBusyRef = useRef(false);
  const busyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPettingRef = useRef(false);
  const lastSoundRef = useRef<TigerSound | null>(null);
  const blinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function designPxToReal(designPx: number) {
    if (renderedWidth <= 0) return 0;
    return designPx * (renderedWidth / HERO_WIDTH);
  }

  function setBusyFor(ms: number) {
    eventBusyRef.current = true;
    if (busyTimerRef.current) clearTimeout(busyTimerRef.current);
    busyTimerRef.current = setTimeout(() => {
      eventBusyRef.current = false;
      busyTimerRef.current = null;
    }, ms);
  }

  function playAndTrack(sound: TigerSound) {
    lastSoundRef.current = sound;
    playTigerSound(sound);
  }

  function pickRandomTapSound(): TigerSound {
    // §2-4 "3(움찔): 직전에 난 소리는 후보에서 제외"
    const candidates = lastSoundRef.current
      ? ALL_SOUNDS.filter((s) => s !== lastSoundRef.current)
      : ALL_SOUNDS;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // ── 이벤트 판정 → 애니메이션/사운드 ───────────────────────────────
  function handleTigerEvent(event: TigerEvent) {
    switch (event) {
      case 'tap': {
        setBusyFor(TAP_TOTAL_MS);
        eyeShutOpacity.value = 0; // 덮개 끔
        playAndTrack(pickRandomTapSound());
        headScale.value = withSequence(
          withTiming(TAP_SCALE, { duration: TAP_TOTAL_MS / 2 }),
          withTiming(1, { duration: TAP_TOTAL_MS / 2 }),
        );
        break;
      }
      case 'tripleTap': {
        setBusyFor(TRIPLE_TAP_IN_MS + TRIPLE_TAP_HOLD_MS + TRIPLE_TAP_OUT_MS);
        eyeShutOpacity.value = 0; // 덮개 끔
        playAndTrack('huh');
        const dir = Math.random() < 0.5 ? -1 : 1;
        headRotateDeg.value = withSequence(
          withTiming(dir * TRIPLE_TAP_ROTATE_DEG, { duration: TRIPLE_TAP_IN_MS }),
          withDelay(TRIPLE_TAP_HOLD_MS, withTiming(0, { duration: TRIPLE_TAP_OUT_MS })),
        );
        break;
      }
      case 'pet': {
        // busy로 잡지 않는다 — 손가락이 이미 머리 위에 있어 같은 터치에서
        // 다른 제스처가 새로 시작될 수 없다 (Race가 보장).
        isPettingRef.current = true;
        eyeShutOpacity.value = 1; // 켬 — 눈 감고 골골
        playAndTrack('purr');
        headExtraTranslateY.value = withTiming(designPxToReal(PET_DOWN_DESIGN_PX), {
          duration: PET_DOWN_MS,
        });
        break;
      }
      case 'petLong': {
        setBusyFor(PET_LONG_ROTATE_MS + PET_LONG_HOLD_MS + PET_LONG_RETURN_MS);
        eyeShutOpacity.value = 0; // 표 그대로 "끔" — normal 얼굴이라 뜬 눈이지만 스펙 그대로 따른다
        playAndTrack('roar');
        headRotateDeg.value = withSequence(
          withTiming(PET_LONG_ROTATE_DEG, { duration: PET_LONG_ROTATE_MS }),
          withDelay(PET_LONG_HOLD_MS, withTiming(0, { duration: PET_LONG_RETURN_MS })),
        );
        headExtraTranslateY.value = withSequence(
          withTiming(designPxToReal(PET_LONG_TRANSLATE_DESIGN_PX), {
            duration: PET_LONG_ROTATE_MS,
          }),
          withDelay(PET_LONG_HOLD_MS, withTiming(0, { duration: PET_LONG_RETURN_MS })),
        );
        break;
      }
      case 'headPop': {
        setBusyFor(HEADPOP_RISE_MS + HEADPOP_HOLD_MS + HEADPOP_RETURN_MS);
        eyeShutOpacity.value = 0; // 덮개 끔
        playAndTrack('yelp');
        // onPressStateChange(false)가 안전망으로 0 복귀를 걸어 두지만, 바로 뒤이어
        // (같은 JS 틱에서) 여기서 실제 상승 시퀀스로 덮어써 무효화한다.
        headExtraTranslateY.value = withSequence(
          withTiming(designPxToReal(-HEADPOP_GAP_DESIGN_PX), {
            duration: HEADPOP_RISE_MS,
            easing: Easing.out(Easing.cubic),
          }),
          withDelay(
            HEADPOP_HOLD_MS,
            withSpring(0, { damping: 10, stiffness: 150, overshootClamping: false }),
          ),
        );
        break;
      }
    }
  }

  function handlePetEnd() {
    isPettingRef.current = false;
    if (eventBusyRef.current) {
      // petLong 시퀀스가 이미 자체적으로 중립 복귀까지 재생 중 — 여기서 또 덮어쓰지 않는다.
      return;
    }
    eyeShutOpacity.value = 0;
    headExtraTranslateY.value = withTiming(0, { duration: PET_RETURN_MS });
  }

  function handlePressStateChange(pressing: boolean) {
    if (pressing) {
      headExtraTranslateY.value = withTiming(designPxToReal(PRESS_DESCEND_DESIGN_PX), {
        duration: PRESS_DESCEND_MS,
      });
    } else {
      // 안전망 — headPop이 뒤이어 발화하면 handleTigerEvent가 즉시 덮어쓴다.
      headExtraTranslateY.value = withTiming(0, { duration: PRESS_CANCEL_RETURN_MS });
    }
  }

  const { gesture } = useTigerGestures({
    onEvent: handleTigerEvent,
    onPetEnd: handlePetEnd,
    onPressStateChange: handlePressStateChange,
    isBusy: () => eventBusyRef.current,
  });

  // ── 깜박임 (§2-4 "평상시") ─────────────────────────────────────────
  // 이벤트 재생 중·쓰다듬기 중이면 이번 차례를 건너뛰고 다시 스케줄한다 —
  // "타이머 정지 후 재개"와 결과적으로 같다.
  const scheduleNextBlink = useCallback(() => {
    blinkTimerRef.current = setTimeout(runBlinkCycle, randomBlinkIntervalMs());
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
  }, []);

  const doOneBlink = useCallback(
    (onDone: () => void) => {
      eyeShutOpacity.value = 1;
      blinkTimerRef.current = setTimeout(() => {
        eyeShutOpacity.value = 0;
        onDone();
      }, BLINK_DURATION_MS);
    },
    [eyeShutOpacity],
  );

  const runBlinkCycle = useCallback(() => {
    if (eventBusyRef.current || isPettingRef.current) {
      scheduleNextBlink();
      return;
    }
    doOneBlink(() => {
      if (Math.random() < BLINK_DOUBLE_PROBABILITY) {
        blinkTimerRef.current = setTimeout(() => {
          if (eventBusyRef.current || isPettingRef.current) {
            scheduleNextBlink();
            return;
          }
          doOneBlink(scheduleNextBlink);
        }, BLINK_DOUBLE_GAP_MS);
      } else {
        scheduleNextBlink();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doOneBlink, scheduleNextBlink]);

  useFocusEffect(
    useCallback(() => {
      scheduleNextBlink();
      return () => {
        if (blinkTimerRef.current) clearTimeout(blinkTimerRef.current);
        blinkTimerRef.current = null;
        if (busyTimerRef.current) clearTimeout(busyTimerRef.current);
        busyTimerRef.current = null;
      };
    }, [scheduleNextBlink]),
  );

  // 숨쉬기는 이벤트 중에도 멈추지 않는다 — 화면 이탈(포커스 아웃) 시에만 정지.
  // renderedWidth가 바뀌면(레이아웃 재측정) 진폭을 다시 환산해 재시작한다.
  useFocusEffect(
    useCallback(() => {
      if (renderedWidth > 0) {
        const amplitude = designPxToReal(BREATH_AMPLITUDE_DESIGN_PX);
        breathTranslateY.value = withRepeat(
          withSequence(
            withTiming(amplitude, {
              duration: BREATH_PERIOD_MS / 2,
              easing: Easing.inOut(Easing.sin),
            }),
            withTiming(-amplitude, {
              duration: BREATH_PERIOD_MS / 2,
              easing: Easing.inOut(Easing.sin),
            }),
          ),
          -1,
          false,
        );
      }
      return () => {
        cancelAnimation(breathTranslateY);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [renderedWidth]),
  );

  const animatedHeadStyle = useAnimatedStyle(() => {
    const w = renderedWidth;
    const h = w / HERO_ASPECT_RATIO;
    const axisX = w * AXIS_X_RATIO;
    const axisY = h * AXIS_Y_RATIO;
    const pivotOffsetX = axisX - w / 2;
    const pivotOffsetY = axisY - h / 2;
    return {
      transform: [
        { translateY: headExtraTranslateY.value },
        { translateX: pivotOffsetX },
        { translateY: pivotOffsetY },
        { rotate: `${headRotateDeg.value}deg` },
        { translateX: -pivotOffsetX },
        { translateY: -pivotOffsetY },
        { scale: headScale.value },
      ],
    };
  });

  const eyeShutStyle = useAnimatedStyle(() => ({ opacity: eyeShutOpacity.value }));

  const breathStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: breathTranslateY.value }],
  }));

  return (
    <View
      style={styles.root}
      onLayout={(e) => setRenderedWidth(e.nativeEvent.layout.width)}
    >
      {/* 숨쉬기 컨테이너 — 히어로 전체(몸+머리)를 통째로 위아래로. 터치 영역은
          이 밖에 그대로 둔다(§2 "터치 영역은 애니메이션을 따라 움직이지 않는다"). */}
      <Animated.View style={[StyleSheet.absoluteFill, breathStyle]}>
        <TigerArtwork animatedHeadStyle={animatedHeadStyle} eyeShutStyle={eyeShutStyle} />
      </Animated.View>

      {/* 터치 영역 — 애니메이션 컨테이너 밖에 고정 (§2 "터치 영역은 머리를 따라 움직이지 않게") */}
      <GestureDetector gesture={gesture}>
        <View
          style={[
            styles.touchArea,
            {
              left: `${HEAD_AREA.left * 100}%`,
              top: `${HEAD_AREA.top * 100}%`,
              width: `${HEAD_AREA.width * 100}%`,
              height: `${HEAD_AREA.height * 100}%`,
            },
          ]}
        />
      </GestureDetector>

      <Pressable
        style={[
          styles.touchArea,
          styles.bubbleTouchArea,
          {
            left: `${BUBBLE_AREA.left * 100}%`,
            top: `${BUBBLE_AREA.top * 100}%`,
            width: `${BUBBLE_AREA.width * 100}%`,
            height: `${BUBBLE_AREA.height * 100}%`,
          },
        ]}
        onPress={onEnterWordbook}
      >
        {/* 말풍선 안쪽 텍스트 — 시안 순서(날짜 → DAY → 단어 수)와 실측 위치. BUBBLE_LINES 참조 */}
        {(['date', 'day', 'words'] as const).map((key) => {
          const line = BUBBLE_LINES[key];
          const text =
            key === 'date'
              ? formatBubbleDate(dateLabel)
              : key === 'day'
                ? `DAY ${dayIndex}`
                : `단어 ${wordsCount}개`;
          return (
            <Text
              key={key}
              style={[
                styles.bubbleLine,
                {
                  fontSize: designPxToReal(line.fontSize),
                  // lineHeight를 fontSize와 같게 고정해야 top 계산이 예측 가능해진다.
                  lineHeight: designPxToReal(line.fontSize),
                  top: designPxToReal(line.centerY - line.fontSize / 2),
                },
              ]}
            >
              {text}
            </Text>
          );
        })}
      </Pressable>
    </View>
  );
}

/**
 * 애니메이션 대상 아트워크 — 에셋이 더 도착하면 **이 컴포넌트 내부만** 고치면 된다.
 * (하품 얼굴 교체·발톱 레이어는 PET_LONG_TODO 주석 위치에 이 컴포넌트를 확장해서 추가)
 */
function TigerArtwork({
  animatedHeadStyle,
  eyeShutStyle,
}: {
  animatedHeadStyle: ReturnType<typeof useAnimatedStyle>;
  eyeShutStyle: ReturnType<typeof useAnimatedStyle>;
}) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Image
        source={require('../../assets/images/tiger-body.png')}
        style={styles.layerImage}
        resizeMode="stretch"
      />
      <Animated.View style={[StyleSheet.absoluteFill, animatedHeadStyle]}>
        <Image
          source={require('../../assets/images/tiger-face-normal.png')}
          style={styles.layerImage}
          resizeMode="stretch"
        />
        <Animated.View style={[StyleSheet.absoluteFill, eyeShutStyle]}>
          <Image
            source={require('../../assets/images/tiger-eye-shut.png')}
            style={styles.layerImage}
            resizeMode="stretch"
          />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
    aspectRatio: HERO_ASPECT_RATIO,
  },
  layerImage: {
    width: '100%',
    height: '100%',
  },
  touchArea: {
    position: 'absolute',
  },
  bubbleTouchArea: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  bubbleLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    fontFamily: HANDWRITING_FONT,
    color: '#1b1b1b',
  },
});
