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

import * as Haptics from 'expo-haptics';

import {
  HANDWRITING_FONT,
  HANDWRITING_TUNED_SCALE,
  handwritingLineHeight,
  handwritingTop,
} from '../../lib/fonts';
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
 *
 * ── 머리 제스처 4종 (2026-08-14 재설계) ────────────────────────────────
 * 탭 1회는 더 이상 고정된 "움찔"이 아니라, 아래 4개 효과(TigerEffect) 중 랜덤으로
 * 하나를 고른다(직전 것 제외) — 제스처를 모르는 아이도 탭만으로 모든 연출을 발견하게
 * 하기 위해서다. 탭 3연타는 폐기했다(랜덤 탭과 판정이 충돌). 길게 누르기도 폐기하고
 * **아래로 당겼다 놓기**로 교체했다 — 머리 영역에서는 세로 스크롤을 포기해도 된다는
 * 결정 덕분에, 예전에 당기기를 막았던 ScrollView 충돌 문제가 사라졌다. 자세한 판정
 * 로직은 `useTigerGestures.ts`, 표는 `design/홈화면-에셋-가이드.md` §2-4·§2-8.
 */
export interface TigerHeroProps {
  /** 말풍선 안에 얹을 값 — 이미지에 넣지 않고 폰트로 렌더한다 (§2). */
  dayIndex: number;
  wordsCount: number;
  dateLabel: string;
  /** 말풍선 탭 → 오늘의 단어장 진입. */
  onEnterWordbook: () => void;
  /**
   * 홈 화면 ScrollView의 ref — 머리를 아래로 당기는 제스처가 세로 스크롤을 이기게
   * 하려면 필요하다 (useTigerGestures의 blocksExternalGesture, §2-8 ①).
   */
  scrollRef: React.RefObject<unknown>;
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
/*
 * 글자 크기 비율(2026-08-14 사용자 지정): 날짜 : DAY N : 단어 수 = 52 : 140 : 52.
 * 버튼 라벨 "복습"(150, 비율 90)을 기준으로 환산한 값이다 — 히어로 좌표계(1060)와
 * 버튼 좌표계(866)는 다르지만 화면에 그려질 때 둘 다 같은 배율 `s`가 곱해지므로
 * 비율이 그대로 반영된다. `GrassGauge.STREAK_TEXT.fontSize`도 같은 기준.
 */
/*
 * centerY = **시안에서 잰 글자 잉크의 세로 중심** (말풍선 로컬 y — 말풍선은 히어로 y 384에서 시작).
 * 시안 실측 히어로 좌표 495 / 665 / 812 에서 384를 뺀 값이다.
 *
 * 폰트 지표 보정은 `lib/fonts.ts`의 `handwritingTop()`이 처리한다 —
 * 여기에는 보정값을 섞지 말 것. 폰트를 바꿔도 이 값은 그대로 둔다.
 */
/*
 * fontSize는 2026-08-23에 옛 값(87 / 233 / 87)에 1.235를 곱해 반올림한 값으로 교체했다 —
 * 경위는 lib/fonts.ts의 `HANDWRITING_TUNED_SCALE` 주석 참조. 지금 값이 곧 최종 크기다.
 * centerY는 크기를 키울 때 함께 건드리지 않았다 — 글자는 그 중심을 기준으로 커진다.
 *
 * 단 **날짜 줄의 centerY만 125 → 135**로 내렸다(2026-08-23 실기기 튜닝). 글자가 커지면서
 * 시안 실측 위치 그대로는 위 세 줄 간격이 답답해 보였다. DAY N(280)·단어 수(435)는 그대로.
 */
const BUBBLE_LINES = {
  date: { centerY: 135, fontSize: 107 * HANDWRITING_TUNED_SCALE },
  day: { centerY: 280, fontSize: 288 * HANDWRITING_TUNED_SCALE },
  words: { centerY: 435, fontSize: 107 * HANDWRITING_TUNED_SCALE },
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

// ── 탭 1회(tap) 랜덤 효과 4종 (2026-08-14) ──────────────────────────────
// 탭이 오면 아래 네 시퀀스 중 하나를 랜덤으로 고른다(직전 것 제외, handleTigerEvent
// 'tap' 케이스). 연출 자체는 기존 tripleTap/pet/petLong 코드를 그대로 재사용한다.

// 효과: 움찔(nudge) — scale 1.03, 사운드는 4개 중 랜덤(직전 소리 제외)
const TAP_SCALE = 1.03; // 튜닝 대상
const TAP_TOTAL_MS = 200;

// 효과: 갸우뚱(tilt) — rotate ±10°, huh.m4a 고정. 250 → 500 유지 → 250
const TILT_ROTATE_DEG = 10; // 튜닝 대상
const TILT_IN_MS = 250;
const TILT_HOLD_MS = 500;
const TILT_OUT_MS = 250;

// 효과: 머리 내려감(headDown) — purr.m4a 고정, translateY +18px. 좌우 쓰다듬기(pet)와
// 달리 손을 떼지 않아도 스스로 내려갔다 돌아오는 고정 시퀀스라 별도 타이밍을 둔다.
const TAP_HEADDOWN_DOWN_MS = 300;
const TAP_HEADDOWN_HOLD_MS = 300;
const TAP_HEADDOWN_RETURN_MS = 300;

// 이벤트 2(쓰다듬기, pet — 손 떼기 전까지 유지): translateY +18px, 400ms 하강 후 유지
const PET_DOWN_DESIGN_PX = 18; // 튜닝 대상
const PET_DOWN_MS = 400;
const PET_RETURN_MS = 400; // 손 뗀 뒤 복귀

// 이벤트 1(petLong — 하품, 얼굴/발톱 없이 모션만) / 효과: 하품(yawn, 탭 랜덤 풀 항목).
// §2-7 타임라인의 머리 모션 구간만. "0ms 머리 뒤로 젖히기(rotate −6°, translateY −8px,
// 300ms)" → "600ms 유지" → "880ms 머리 복귀(300ms)". 총 1200ms(+ 스펙상 1.4s는 얼굴
// 교체 여운 포함, 여기선 얼굴 교체가 없으므로 1200ms로 busy를 잡는다). 손으로 계속
// 쓰다듬어 도달한 경우(petLong)와 탭 랜덤으로 뽑힌 경우(yawn) 모두 playYawnSequence()
// 하나를 공유한다 — 어느 쪽이든 완주까지 손을 뗄 필요가 없는 고정 시퀀스이기 때문.
const PET_LONG_ROTATE_DEG = -6; // 튜닝 대상
const PET_LONG_TRANSLATE_DESIGN_PX = -8; // 튜닝 대상 (음수 = 위로)
const PET_LONG_ROTATE_MS = 300;
const PET_LONG_HOLD_MS = 600;
const PET_LONG_RETURN_MS = 300;
// PET_LONG_TODO: tiger-face-yawn1.png / yawn2.png / tiger-claws.png 도착 시,
// 아래 playYawnSequence()에 §2-7 타임라인 그대로 얼굴 교체를 끼워 넣을 것: 0ms normal
// → 120ms yawn1(입 조금) → 280ms yawn2(입 최대, 발톱 팝인 250ms) → 880ms yawn1(입
// 줄어듦) → 1000ms normal(발톱 소멸) → 1180ms 깜박임 1회(여운) → 1400ms 끝. 얼굴
// 레이어를 하나 더 두고(TigerArtwork 내부) opacity 스왑 또는 source 스왑으로 구현.

// 이벤트 5(아래로 당겼다 놓기, headPop): §2-8 ① — 2026-08-14, 길게 누르기에서 교체.
/**
 * 당기는 동안 고무줄 저항이 걸리는 최대치(디자인 px). 목 연장분(§2-2)과 맞물리므로
 * 임의로 늘리지 말 것. `eased = MAX * (1 - Math.exp(-dy / MAX))` 감쇠식의 MAX.
 */
const PULL_MAX_DESIGN_PX = 60; // 튜닝 대상 — 목 연장분과 맞물림
/** 이만큼 당기면 "장전"(놓으면 튕김 발동). 시간 조건은 없다 — §2-8 ① */
const PULL_ARM_DESIGN_PX = 40; // 튜닝 대상
const HEADPOP_RISE_MS = 180;
const HEADPOP_HOLD_MS = 150;
/** 낙하 시간. 튕김 복귀는 스프링이 아니라 중력 낙하다(출렁임 없음) — 느리면 이 값을 줄인다. */
const HEADPOP_RETURN_MS = 220; // 튜닝 대상
/**
 * 머리가 튀어오르는 최고 지점 — 중립보다 이만큼 위(디자인 px).
 * 2026-08-14: 60 → 90 (사용자 지정, 더 확실한 분리). 머리 밑선이 281이므로 90px 상승 시
 * 머리 바닥이 191, 목 상단이 224 → 갭 33px.
 */
const HEADPOP_GAP_DESIGN_PX = 90;

const ALL_SOUNDS: TigerSound[] = ['roar', 'purr', 'huh', 'yelp'];

/** 탭 1회의 랜덤 효과 4종 (design/홈화면-에셋-가이드.md §2-4 "머리 이벤트" 표). */
type TigerEffect = 'nudge' | 'tilt' | 'headDown' | 'yawn';
const ALL_TAP_EFFECTS: TigerEffect[] = ['nudge', 'tilt', 'headDown', 'yawn'];

/**
 * "장전(40 디자인 px)"에 도달했다는 신호 (§2-8 ①). 손가락이 머리를 가리고 있어
 * 시각 신호가 안 보이므로 촉각으로 알린다. 실패해도 무시한다 — 햅틱이 없는
 * 기기/설정에서도 제스처 자체는 정상 동작해야 한다.
 */
function triggerHaptic() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

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
/**
 * 제자리에서 **위로** 올라가는 최대치(디자인 px). 들숨에 올라가고 날숨에 제자리로 온다.
 * 2026-08-14: 4 → 8. 예전 구현은 `+amp ↔ −amp`를 왕복해 실제 이동량이 상수의 2배였으므로,
 * 8로 두면 눈에 보이는 이동량이 그대로 유지된다.
 */
const BREATH_AMPLITUDE_DESIGN_PX = 8; // 튜닝 대상
const BREATH_PERIOD_MS = 3000; // 튜닝 대상 — 3초 주기(올라가기 1.5s + 내려오기 1.5s)

export default function TigerHero({
  dayIndex,
  wordsCount,
  dateLabel,
  onEnterWordbook,
  scrollRef,
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
  const lastEffectRef = useRef<TigerEffect | null>(null);
  const pullHapticFiredRef = useRef(false); // 이번 당기기에서 이미 햅틱을 울렸는지(재발화 방지)
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

  /** 탭 1회의 랜덤 효과 — 직전에 나온 효과는 후보에서 제외(2026-08-14). */
  function pickRandomTapEffect(): TigerEffect {
    const candidates = lastEffectRef.current
      ? ALL_TAP_EFFECTS.filter((e) => e !== lastEffectRef.current)
      : ALL_TAP_EFFECTS;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // ── 탭 랜덤 효과 4종 — 기존 tripleTap/pet/petLong 시퀀스를 함수로 뽑아 공유한다 ──

  /** 효과: 움찔(nudge) — scale 1.03 + 사운드 랜덤(직전 제외). 예전 'tap' 케이스 그대로. */
  function playNudgeSequence() {
    setBusyFor(TAP_TOTAL_MS);
    eyeShutOpacity.value = 0; // 덮개 끔
    playAndTrack(pickRandomTapSound());
    headScale.value = withSequence(
      withTiming(TAP_SCALE, { duration: TAP_TOTAL_MS / 2 }),
      withTiming(1, { duration: TAP_TOTAL_MS / 2 }),
    );
  }

  /** 효과: 갸우뚱(tilt) — rotate ±10° + huh.m4a 고정. 예전 'tripleTap' 케이스 그대로. */
  function playTiltSequence() {
    setBusyFor(TILT_IN_MS + TILT_HOLD_MS + TILT_OUT_MS);
    eyeShutOpacity.value = 0; // 덮개 끔
    playAndTrack('huh');
    const dir = Math.random() < 0.5 ? -1 : 1;
    headRotateDeg.value = withSequence(
      withTiming(dir * TILT_ROTATE_DEG, { duration: TILT_IN_MS }),
      withDelay(TILT_HOLD_MS, withTiming(0, { duration: TILT_OUT_MS })),
    );
  }

  /**
   * 효과: 머리 내려감(headDown) — purr.m4a 고정. 좌우 쓰다듬기(pet)와 달리 손을
   * 떼지 않아도 스스로 내려갔다 돌아오는 고정 시퀀스라 busy로 잠근다.
   */
  function playHeadDownSequence() {
    setBusyFor(TAP_HEADDOWN_DOWN_MS + TAP_HEADDOWN_HOLD_MS + TAP_HEADDOWN_RETURN_MS);
    playAndTrack('purr');
    eyeShutOpacity.value = withSequence(
      withTiming(1, { duration: 0 }), // 켬 — 눈 감고 골골 (즉시)
      withDelay(
        TAP_HEADDOWN_DOWN_MS + TAP_HEADDOWN_HOLD_MS,
        withTiming(0, { duration: TAP_HEADDOWN_RETURN_MS }),
      ),
    );
    headExtraTranslateY.value = withSequence(
      withTiming(designPxToReal(PET_DOWN_DESIGN_PX), { duration: TAP_HEADDOWN_DOWN_MS }),
      withDelay(TAP_HEADDOWN_HOLD_MS, withTiming(0, { duration: TAP_HEADDOWN_RETURN_MS })),
    );
  }

  /**
   * 효과: 하품(yawn) — roar.m4a 고정. 손으로 계속 쓰다듬어 1.5초를 넘긴 경우(petLong)와
   * 탭 랜덤으로 뽑힌 경우 모두 이 시퀀스 하나를 공유한다(예전 'petLong' 케이스 그대로).
   */
  function playYawnSequence() {
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
  }

  // ── 이벤트 판정 → 애니메이션/사운드 ───────────────────────────────
  function handleTigerEvent(event: TigerEvent) {
    switch (event) {
      case 'tap': {
        const effect = pickRandomTapEffect();
        lastEffectRef.current = effect;
        switch (effect) {
          case 'nudge':
            playNudgeSequence();
            break;
          case 'tilt':
            playTiltSequence();
            break;
          case 'headDown':
            playHeadDownSequence();
            break;
          case 'yawn':
            playYawnSequence();
            break;
        }
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
        playYawnSequence();
        break;
      }
      case 'headPop': {
        setBusyFor(HEADPOP_RISE_MS + HEADPOP_HOLD_MS + HEADPOP_RETURN_MS);
        eyeShutOpacity.value = 0; // 덮개 끔
        playAndTrack('yelp');
        headExtraTranslateY.value = withSequence(
          withTiming(designPxToReal(-HEADPOP_GAP_DESIGN_PX), {
            duration: HEADPOP_RISE_MS,
            easing: Easing.out(Easing.cubic),
          }),
          // 복귀는 스프링이 아니라 **떨어지는 모션**이다 — 2026-08-14 실기기 확인 후 변경.
          // 예전엔 withSpring(overshootClamping:false)이라 착지 후 출렁거렸다.
          // Easing.in(cubic) = 천천히 시작해 가속 = 중력 낙하. 오버슈트가 없어 턱 붙는다.
          withDelay(
            HEADPOP_HOLD_MS,
            withTiming(0, { duration: HEADPOP_RETURN_MS, easing: Easing.in(Easing.cubic) }),
          ),
        );
        break;
      }
    }
  }

  function handlePetEnd() {
    isPettingRef.current = false;
    if (eventBusyRef.current) {
      // petLong(yawn) 시퀀스가 이미 자체적으로 중립 복귀까지 재생 중 — 여기서 또 덮어쓰지 않는다.
      return;
    }
    eyeShutOpacity.value = 0;
    headExtraTranslateY.value = withTiming(0, { duration: PET_RETURN_MS });
  }

  /**
   * 아래로 당기는 중. dy는 손가락 세로 이동량(화면 px, 0 이상)이다. 고무줄 저항을 걸어
   * 최대 PULL_MAX_DESIGN_PX(디자인 px)에서 서서히 둔화시키고, PULL_ARM_DESIGN_PX를
   * 넘으면 "장전"으로 보고 햅틱을 1회 울린다(§2-8 ①).
   *
   * 반환값(armed)은 useTigerGestures가 그대로 캐싱했다가 onPullEnd에 실어 보낸다 —
   * 래칫 방식: 한 번 넘으면(pullHapticFiredRef가 true) 손가락이 살짝 되돌아와도
   * 장전 상태를 유지한다(순간값 비교보다 아이 손끝의 미세한 떨림에 관대하다).
   */
  function handlePullMove(dy: number): boolean {
    const maxReal = designPxToReal(PULL_MAX_DESIGN_PX);
    if (maxReal > 0) {
      const eased = maxReal * (1 - Math.exp(-dy / maxReal));
      headExtraTranslateY.value = eased;
    }
    const armThresholdReal = designPxToReal(PULL_ARM_DESIGN_PX);
    if (dy >= armThresholdReal && !pullHapticFiredRef.current) {
      pullHapticFiredRef.current = true;
      triggerHaptic();
    }
    return pullHapticFiredRef.current;
  }

  /** 당기기 끝. armed면 headPop(튕김) 시퀀스, 아니면 이벤트 없이 스프링으로 원위치. */
  function handlePullEnd(armed: boolean) {
    pullHapticFiredRef.current = false; // 다음 당기기를 위해 초기화
    if (armed) {
      handleTigerEvent('headPop');
    } else {
      headExtraTranslateY.value = withSpring(0, { damping: 14, stiffness: 180 });
    }
  }

  const { gesture } = useTigerGestures({
    onEvent: handleTigerEvent,
    onPetEnd: handlePetEnd,
    onPullMove: handlePullMove,
    onPullEnd: handlePullEnd,
    isBusy: () => eventBusyRef.current,
    scrollRef,
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
        // 타이머만 지우고 플래그를 되돌리지 않으면, 연출 재생 중(eventBusyRef=true) 화면을
        // 벗어났을 때 복귀 후에도 플래그가 true로 굳어 제스처 4종·깜박임이 영구히 멈춘다.
        // 깜박이는 도중(BLINK_DURATION_MS 110ms)에 벗어나면 눈이 감긴 채로도 굳으므로
        // eyeShutOpacity도 함께 되돌린다.
        eventBusyRef.current = false;
        isPettingRef.current = false;
        eyeShutOpacity.value = 0;
      };
    }, [scheduleNextBlink]),
  );

  // 숨쉬기는 이벤트 중에도 멈추지 않는다 — 화면 이탈(포커스 아웃) 시에만 정지.
  // renderedWidth가 바뀌면(레이아웃 재측정) 진폭을 다시 환산해 재시작한다.
  useFocusEffect(
    useCallback(() => {
      if (renderedWidth > 0) {
        const amplitude = designPxToReal(BREATH_AMPLITUDE_DESIGN_PX);
        // ★ 한 방향(위로)만 정의하고 되돌아오기는 reverse:true에 맡긴다.
        //   `withSequence(+amp, −amp)` + `reverse:false`로 짜면 시퀀스가 시작점(0)으로
        //   돌아오지 않은 채 끝나고, 반복이 다음 회차를 시작할 때 값이 0으로 즉시 리셋되어
        //   "올라갔다가 제자리로 툭" 떨어지는 이음새가 보인다 (2026-08-14 실기기에서 발생).
        //   reverse:true는 같은 애니메이션을 역재생하므로 시작점으로 정확히 돌아온다 —
        //   리셋할 지점 자체가 없어 이음새가 구조적으로 생기지 않는다.
        breathTranslateY.value = withRepeat(
          withTiming(-amplitude, {
            duration: BREATH_PERIOD_MS / 2,
            easing: Easing.inOut(Easing.sin),
          }),
          -1,
          true,
        );
      }
      return () => {
        cancelAnimation(breathTranslateY);
        // ★ 중립(0)으로 되돌려야 한다. withTiming은 **현재값에서** 목표값까지 가는데,
        //   하필 값이 -amplitude(맨 위) 근처에서 멈춘 채 화면을 벗어나면 다음 복귀 때
        //   `-amplitude → -amplitude`가 되어 진폭 0 = 숨쉬기가 아예 멈춘다.
        //   멈춘 지점이 어디였냐에 따라 복귀 후 진폭이 들쭉날쭉해지는 것도 같은 이유다
        //   (2026-08-22 실기기: 단어장 다녀오면 숨쉬기가 멈춤).
        //   화면을 벗어난 뒤에 되돌리므로 제자리로 돌아가는 모습은 보이지 않는다.
        breathTranslateY.value = 0;
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

      {/* 순수 터치 영역 — 자식 없음. 위치는 애니메이션과 무관하게 고정(§2 "터치 영역은
          머리를 따라 움직이지 않게" 원칙과 동일하게 말풍선도 정적으로 유지). */}
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
      />

      {/* 말풍선 글자 — Pressable과 같은 위치/크기지만 breathStyle(숨쉬기)을 태워 그림과
          함께 움직인다. pointerEvents="none"이라 탭은 위 Pressable이 그대로 받고,
          Pressable보다 뒤에 렌더해야 글자가 그 위에 보인다. */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.touchArea,
          styles.bubbleTouchArea,
          {
            left: `${BUBBLE_AREA.left * 100}%`,
            top: `${BUBBLE_AREA.top * 100}%`,
            width: `${BUBBLE_AREA.width * 100}%`,
            height: `${BUBBLE_AREA.height * 100}%`,
          },
          breathStyle,
        ]}
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
              // 절대좌표 배치라 OS 텍스트 크기 배율이 들어오면 top과 fontSize의 관계가 깨진다.
              allowFontScaling={false}
              style={[
                styles.bubbleLine,
                {
                  fontSize: designPxToReal(line.fontSize),
                  lineHeight: designPxToReal(handwritingLineHeight(line.fontSize)),
                  top: designPxToReal(handwritingTop(line.centerY, line.fontSize)),
                },
              ]}
            >
              {text}
            </Text>
          );
        })}
      </Animated.View>
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
