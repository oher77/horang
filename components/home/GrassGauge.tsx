import { useEffect } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import {
  HANDWRITING_FONT,
  HANDWRITING_TUNED_SCALE,
  handwritingLineHeight,
  handwritingTop,
} from '../../lib/fonts';
import type { SlotState } from '../../lib/habitQueries';

/**
 * 잔디 게이지 (design/홈화면-에셋-가이드.md §1).
 *
 * ── 3층 스택, 좌우 이동 한 번 말고는 좌표 계산이 없다 ──────────────────────
 *
 *   grass-box.png (928 × 619)   배경 + 꺼진 전구 4개(반투명 검정 워시)
 *     ├ bulb-glow.png × 불 켜진 슬롯 272 × 619 — **세로는 전체 높이라 x만 옮긴다**
 *     │   슬롯은 3상태다(§7.6 미결 4): full=완전 점등 / partial=지지직 깜박임 /
 *     │   empty=글로우 없음. 렌더는 아래 `BulbGlow`가 담당한다.
 *     ├ bulbs.png (928 × 619)       전구 윤곽선 4개. **(0,0)에 겹치기만**
 *     ├ 빨간 점 (코드)               현재 열린 슬롯 위
 *     └ 🔥 N일 연속 (코드)           전구 아래
 *
 * 2026-08-11 에셋 재작업으로 `bulbs.png`가 grass-box와 같은 928 × 619 캔버스가 되고
 * 윤곽선이 워시 전구와 맞춰졌으며(중심 205.5/377/544/717 vs 워시 205.5/377/542/715),
 * `bulb-glow.png`는 높이가 619로 늘어나 **y 보정이 필요 없어졌다.**
 * 호랑이(body/face/eye-shut)와 같은 "같은 캔버스에 겹치기" 방식이다.
 *
 * 슬롯 판정 로직은 만들지 않는다 — 부모(app/index.tsx)가 준 값을 그리기만 한다.
 */

const TOTAL_SLOTS = 4;

/** grass-box.png / bulbs.png 캔버스. 모든 내부 좌표의 기준이다. */
const BOX_WIDTH = 928;
const BOX_HEIGHT = 619;

// ── grass-box.png(928 × 619) 내부 실측 좌표 ──────────────────────────────
/** bulbs.png 윤곽선 4개의 중심 x. 손그림이라 간격이 균등하지 않다. */
const BULB_CENTERS_X = [205.5, 377, 544, 717];

/** bulb-glow.png 규격: 272 × 619, 빛의 코어 중심이 x = 135. */
const GLOW_WIDTH = 272;
const GLOW_HEIGHT = 619;
const GLOW_CORE_CX = 135;

/** 빨간 점 — 윤곽선 상단(y 246)보다 위. */
const DOT_Y = 205;
const DOT_SIZE = 26;
/**
 * 평상시 / 눌렸을 때 색. **투명도가 아니라 색을 바꾼다**(2026-08-15 실기기 확인) —
 * 점이 실기기에서 약 8.7pt라 살짝 흐려지는 정도는 눈에 안 들어온다.
 */
const DOT_COLOR = '#e02020';
const DOT_COLOR_PRESSED = '#ff8c1a';

/**
 * 열린 슬롯 탭 영역 — 빨간 점 + 그 아래 전구를 통째로 덮는다 (2026-08-15).
 *
 * **점만 탭 영역으로 쓸 수 없다.** 26px = 실기기 약 8.7pt라 손가락이 못 맞춘다.
 * `bulbs.png` 실측 윤곽선(y 245~455, 폭 140~145)까지 내려 잡아 약 50 × 88pt를 만든다.
 * 사용자가 누르려는 대상도 점이 아니라 "점이 찍힌 전구"다.
 *
 * **위 끝 195는 말풍선과의 충돌을 막는 값이다.** 캔버스 기준 1147 + 195 = 1342이고
 * 말풍선 탭 영역 아래끝은 1163(호랑이 209 + 954) — 179px 여유가 있다. 이 값을 내리면
 * 오늘 단어장 진입이 말풍선과 두 곳에서 겹친다. **줄이려거든 그 계산을 먼저 다시 할 것.**
 *
 * 좌우 ±75는 전구 간격 171의 절반(85.5)보다 좁아 옆 전구를 침범하지 않는다.
 */
const HIT = { top: 195, bottom: 460, halfWidth: 75 };

/**
 * "🔥 N일 연속" — 불꽃과 글자를 **한 줄(row)로 묶어 덩어리째 가운데 정렬**한다 (2026-08-15).
 *
 * **가로는 시안 절대좌표를 쓰지 않는다 — 이 요소만의 예외다.** 글자가 가변 길이라
 * ("1일 연속" ~ "127일 연속") 둘을 각자 절대배치하면 자릿수가 늘 때 글자만 양옆으로
 * 자라서 ⓐ 덩어리 중심이 오른쪽으로 밀리고 ⓑ 불꽃과의 간격이 좁아진다. 절대좌표 원칙
 * (`mockupLayout.ts`)은 크기가 고정된 에셋에 성립하는 것이고, 가변 길이 텍스트에는
 * 성립하지 않는다. 6개월 완주가 목표라 세 자리 스트릭은 실제로 나오는 값이다.
 *
 * **세로는 각자 실측값을 유지한다** — 불꽃이 글자보다 조금 높이 앉는 게 시안이다
 * (차이는 2026-08-23 폰트 크기 조정 후 32px → 12px = STREAK_TEXT 512 − FIRE 500).
 *
 * **이모지와 글자를 한 `<Text>`에 넣지 않는다** (2026-08-14): 이모지는 이 폰트에 없어서
 * Apple Color Emoji로 대체되는데, 그 폰트의 ascent가 훨씬 커서 줄 전체를 밀어내린다.
 * 실측으로 이 줄만 다른 텍스트보다 0.27em 더 밀렸다(글자 0.62em vs 이 줄 0.885em).
 * 둘을 갈라 각자 세로 배치해야 글자가 폰트 지표대로 앉는다. row로 묶어도 이 분리는 유지된다.
 */
const STREAK_GROUP = {
  /**
   * 불꽃과 글자 사이 간격 — **여기가 유일한 간격 조정 지점.**
   * 덩어리가 가운데 정렬이라 값을 키우면 양쪽으로 대칭으로 벌어진다.
   *
   * **0이 정상이다(2026-08-15 실기기 확인). 버그로 오해해 양수로 되돌리지 말 것.**
   * Apple Color Emoji는 글리프 advance가 잉크보다 넓어(fontSize 95 기준 잉크 폭은 90)
   * 좌우에 보이지 않는 side bearing이 이미 깔린다. 그 여백만으로 시안과 맞았다.
   * 즉 눈에 보이는 간격 ≈ 이모지 side bearing + 손글씨 첫 글자의 left side bearing.
   * 폰트(손글씨·이모지 어느 쪽이든)가 바뀌면 이 전제가 깨지므로 재확인할 것.
   */
  gap: 0,
  /**
   * 덩어리 중심 X. 기본은 grass-box 중심(464)이나, 실기기에서 24px 왼쪽이 시안과 맞았다
   * (2026-08-15). 시안의 "🔥 N일 연속"이 잔디 정중앙이 아니라 살짝 왼쪽에 앉아 있다.
   */
  centerX: BOX_WIDTH / 2 - 24,
};
/** centerY는 시안에서 잰 **글자 잉크의 세로 중심**. 폰트 보정은 `handwritingTop()`이 한다.
 *  fontSize 87 = 사용자 지정 비율("N일 연속" 52, 복습 150/비율 90 기준 환산). */
const STREAK_TEXT = { centerY: 512, fontSize: 107 * HANDWRITING_TUNED_SCALE };
/**
 * 불꽃 — 시안 실측 y 448~557. 이모지는 폰트 지표를 믿을 수 없어 박스 높이 안에서 중앙 정렬만 하고,
 * 어긋난 만큼 실기기 측정으로 뺀다.
 * 2026-08-14 측정: 크기는 정확히 맞았고(폭 90) **세로만 22px 낮아** centerY를 502 → 480.
 * 가로 위치(옛 centerX 329)는 2026-08-15 row 정렬로 바뀌면서 `STREAK_GROUP`이 대신한다.
 */
// 두 fontSize는 2026-08-23에 옛 값(87 / 95)에 1.235를 곱해 반올림한 값으로 교체했다 —
// 경위는 lib/fonts.ts의 `HANDWRITING_TUNED_SCALE` 주석. 불꽃은 top·height·lineHeight가
// 전부 이 fontSize에서 파생돼 박스 중앙이 항상 centerY이므로, 크기만 커지고 중심은 유지된다.
//
// **불꽃 centerY 480 → 500** (2026-08-23, 실기기에서 눈으로 맞춘 값).
// 같은 날 `glyphCenterEm`을 0.65로 내려 "N일 연속" 글자가 아래로 이동했고, 불꽃은
// `glyphCenterEm`을 쓰지 않아(자체 박스 중앙 정렬) 혼자 제자리에 남아 짝이 틀어졌다.
// ☞ **계산으로는 483이 나왔는데 실제로 맞은 값은 500이다.** 17px 차이 — 위 주석대로
//    이모지는 폰트 지표를 믿을 수 없다는 게 다시 확인된 셈이다.
//    **이 값을 계산값으로 "고치지 말 것."** 눈으로 맞추는 종류의 숫자다.
// ☞ 글자와 불꽃은 위치 계산 방식이 달라 **자동으로 같이 움직이지 않는다.**
//    `glyphCenterEm`이나 fontSize를 또 건드리면 이 값도 실기기에서 다시 맞춰야 한다.
//    미세조정 단위: 1 디자인 px = 아이폰 15에서 정확히 1 네이티브 px(0.33pt).
const FIRE = { centerY: 500, fontSize: 117 * HANDWRITING_TUNED_SCALE };

/**
 * 'partial' 상태 — "형광등이 나가기 직전" 지지직 깜박임 (설계.md §7.6 미결 4).
 *
 * 기준 밝기 0.5에서 위아래로 불규칙하게 오르내린다. 균등한 사인파 호흡처럼 보이면
 * 실패 — **짧고 불규칙한 지지직 구간 몇 개 + 긴 정체 구간 하나**로 만든다.
 *
 * `withRepeat(withSequence(...), -1, false)`를 쓰되 **시퀀스의 마지막 opacity가
 * 첫 opacity와 같아야 한다** — 안 그러면 매 주기 경계에서 값이 "툭" 튄다
 * (2026-08-14 숨쉬기 애니메이션에서 실제로 겪은 함정, CLAUDE.md §8 참조).
 * 아래 시퀀스는 BASE(0.5)에서 시작해 지지직거리다 BASE로 돌아온다.
 */
const PARTIAL_BASE_OPACITY = 0.5;
const PARTIAL_LOW_OPACITY = 0.15;
const PARTIAL_HIGH_OPACITY = 0.62;
/**
 * 지지직 한 번 치고 나서 조용히 머무는 시간 — **깜박임 간격을 조절하는 손잡이는 여기 하나뿐.**
 *
 * 눈에 보이는 멈춤 = 이 값 + 마지막 복귀 램프 200ms. 지금은 약 2.2초다.
 * (2026-08-25 사용자 조정: 520 → 2800 → **2000**. 520은 0.7초라 쉴 새 없이 깜박이는
 *  느낌이었고, 2800은 3초로 너무 뜸했다.)
 * 값을 키우면 "가끔 한 번씩 지지직"에 가까워지고, 줄이면 "고장 나기 직전"에 가까워진다.
 *
 * 깜박임 자체(LOW로 세 번 떨어지는 부분)는 총 440ms이고 이 값과 무관하다 — 개수·리듬을
 * 바꾸려면 아래 시퀀스의 duration을 직접 건드려야 한다.
 */
const PARTIAL_HOLD_MS = 2000;
/**
 * 슬롯마다 시작 위상을 어긋나게 해 4개가 동시에 깜박이지 않게 한다.
 * **한 주기가 길어지면(PARTIAL_HOLD_MS ↑) 이 값도 같이 키워야 4개가 고르게 흩어진다.**
 * 220 → **550** (2026-08-25 사용자 조정, HOLD를 늘리면서 함께 벌렸다). 주기가 2.64초이므로
 * 550 × 4 = 2.2초에 걸쳐 네 전구가 차례로 지지직거린다 — 한꺼번에 깜박이지 않는다.
 */
const PARTIAL_INDEX_STAGGER_MS = 550;

/** 켜진 전구 글로우 한 칸. 상태별 opacity를 계산만 하고 훅은 무조건 호출한다
 *  (`.map()` 안에서 조건부로 훅을 호출하면 React 규칙 위반 — 슬롯 상태가 바뀔 때
 *  훅 순서가 깨진다). */
function BulbGlow({ state, index, scale }: { state: SlotState; index: number; scale: number }) {
  const opacity = useSharedValue(state === 'full' ? 1 : PARTIAL_BASE_OPACITY);

  useEffect(() => {
    if (state === 'partial') {
      opacity.value = withDelay(
        index * PARTIAL_INDEX_STAGGER_MS,
        withRepeat(
          withSequence(
            // 긴 정체 구간 — 기준 밝기에서 머문다. 이미 BASE에 있으므로 실질적으로 "대기"다.
            withTiming(PARTIAL_BASE_OPACITY, { duration: PARTIAL_HOLD_MS, easing: Easing.linear }),
            // 지지직 1 — 순간적으로 확 꺼졌다 올라온다.
            withTiming(PARTIAL_LOW_OPACITY, { duration: 60, easing: Easing.linear }),
            withTiming(PARTIAL_HIGH_OPACITY, { duration: 90, easing: Easing.linear }),
            withTiming(PARTIAL_LOW_OPACITY, { duration: 50, easing: Easing.linear }),
            // 지지직 2 — 짧게 한 번 더, 다른 리듬으로.
            withTiming(PARTIAL_HIGH_OPACITY, { duration: 120, easing: Easing.linear }),
            withTiming(PARTIAL_BASE_OPACITY, { duration: 80, easing: Easing.linear }),
            withTiming(PARTIAL_LOW_OPACITY, { duration: 40, easing: Easing.linear }),
            // 기준으로 복귀 — 다음 주기 시작값(BASE)과 반드시 같아야 이음새가 안 튄다.
            withTiming(PARTIAL_BASE_OPACITY, { duration: 200, easing: Easing.linear }),
          ),
          -1,
          false,
        ),
      );
    } else {
      cancelAnimation(opacity);
      opacity.value = state === 'full' ? 1 : PARTIAL_BASE_OPACITY;
    }
    return () => cancelAnimation(opacity);
  }, [state, index, opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: state === 'full' ? 1 : opacity.value,
  }));

  if (state === 'empty') return null;

  return (
    <Animated.Image
      source={require('../../assets/images/bulb-glow.png')}
      style={[
        {
          position: 'absolute',
          left: (BULB_CENTERS_X[index] - GLOW_CORE_CX) * scale,
          top: 0,
          width: GLOW_WIDTH * scale,
          height: GLOW_HEIGHT * scale,
        },
        animatedStyle,
      ]}
      resizeMode="contain"
    />
  );
}

export default function GrassGauge({
  slots,
  streak,
  activeSlot,
  scale,
  onPressActiveSlot,
}: {
  slots: SlotState[] | null;
  streak: number;
  activeSlot: number | null;
  /** 시안 px → 화면 px 배율. grass-box도 시안에서 1:1로 잘렸으므로 같은 배율이 그대로 통한다. */
  scale: number;
  /**
   * 빨간 점이 찍힌 전구를 눌렀을 때 (오늘 단어장 진입). 빠지면 탭 영역 자체가 생기지 않는다.
   * **판정을 여기서 새로 하지 않는다** — 점을 찍는 조건(`activeSlot`)과 좌표를 그대로 쓴다.
   * 부모가 아직 오늘 Day를 못 읽었으면 `undefined`를 넘겨 누를 수 없게 한다.
   */
  onPressActiveSlot?: () => void;
}) {
  // ★ 부모 크기에 의존하지 않는다. `%`·`StyleSheet.absoluteFill`로 부모 높이에 기대면
  //   부모 높이가 안 잡히는 순간 이미지가 원본 크기로 흘러넘친다(2026-08-13 실기기에서 발생 —
  //   잔디와 전구가 3배로 커져 화면을 덮었다). 전부 scale로 직접 px를 계산한다.
  const boxWidth = BOX_WIDTH * scale;
  const boxHeight = BOX_HEIGHT * scale;
  const layerStyle = {
    position: 'absolute' as const,
    left: 0,
    top: 0,
    width: boxWidth,
    height: boxHeight,
  };

  return (
    // ★ 터치 — 열린 전구 Pressable 하나만 받고 나머지는 아무 핸들러가 없다.
    //   `pointerEvents`는 쓰지 않는다. 잔디가 호랑이 **위**에 그려져서(app/index.tsx 렌더
    //   순서) 말풍선 탭 영역과 아래 16px이 겹치지만, 사람은 말풍선 가운데를 누르므로
    //   그 띠를 못 받아도 무방하다고 정했다(2026-08-15 사용자 판단). 그거 하나 살리려고
    //   레이어를 `pointerEvents` 묶음으로 감싸는 건 배보다 배꼽이 크다.
    <View style={{ width: boxWidth, height: boxHeight, overflow: 'hidden' }}>
      <Image
        source={require('../../assets/images/grass-box.png')}
        style={layerStyle}
        resizeMode="contain"
      />

      {/* 켜진 전구 — 세로는 전체 높이 그대로, 좌우로만 옮긴다.
          3상태(empty/partial/full) 렌더는 BulbGlow가 담당 — 훅을 무조건 호출한다. */}
      {slots?.map((s, i) => (i < TOTAL_SLOTS ? <BulbGlow key={i} state={s} index={i} scale={scale} /> : null))}

      {/* 윤곽선은 빛 위에 얹어야 켜진 전구도 테두리가 살아난다. */}
      <Image
        source={require('../../assets/images/bulbs.png')}
        style={layerStyle}
        resizeMode="contain"
      />

      {/*
        "🔥 N일 연속" — 두 요소를 한 row에 담아 **덩어리째** 가운데 정렬한다.
        자릿수가 늘면 양옆으로 대칭으로 자라므로 중심도 간격도 유지된다.
        세로는 각자 `top`(relative 오프셋)으로 실측 위치를 잡는다 — row는 가로만 담당.
      */}
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: boxWidth,
          height: boxHeight,
          flexDirection: 'row',
          justifyContent: 'center',
          alignItems: 'flex-start',
          gap: STREAK_GROUP.gap * scale,
          transform: [{ translateX: (STREAK_GROUP.centerX - BOX_WIDTH / 2) * scale }],
        }}
      >
        {/* 불꽃 — 폭을 지정하지 않아 글리프 폭 그대로 잡힌다(간격 계산이 예측 가능해진다).
            높이/lineHeight를 fontSize의 2배로 잡아 그 안에서 세로 중앙 정렬만 시킨다. */}
        <Text
          // 절대좌표 배치라 OS 텍스트 크기 배율이 들어오면 top과 fontSize의 관계가 깨진다.
          allowFontScaling={false}
          style={[
            styles.fire,
            {
              top: (FIRE.centerY - FIRE.fontSize) * scale,
              height: FIRE.fontSize * 2 * scale,
              lineHeight: FIRE.fontSize * 2 * scale,
              fontSize: FIRE.fontSize * scale,
            },
          ]}
        >
          🔥
        </Text>

        <Text
          // 절대좌표 배치라 OS 텍스트 크기 배율이 들어오면 top과 fontSize의 관계가 깨진다.
          allowFontScaling={false}
          style={[
            styles.streakText,
            {
              top: handwritingTop(STREAK_TEXT.centerY, STREAK_TEXT.fontSize) * scale,
              fontSize: STREAK_TEXT.fontSize * scale,
              lineHeight: handwritingLineHeight(STREAK_TEXT.fontSize) * scale,
            },
          ]}
        >
          {streak}일 연속
        </Text>
      </View>

      {/*
        빨간 점 = "지금 열린 슬롯" 표시이자 **오늘 단어장으로 가는 입구**다.
        점을 찍는 조건·좌표를 그대로 탭 영역으로 쓴다 — 슬롯 판정을 두 번 하지 않는다.
        (`HIT`이 점보다 훨씬 큰 이유는 위 상수 주석 참조.)

        **반드시 맨 마지막 자식이어야 한다.** 위의 "N일 연속" row가 박스 전체를 덮는
        오버레이라, 이게 그 앞에 오면 (나중에 그린 형제가 터치를 먼저 받으므로)
        row가 탭을 가로채 전구가 눌리지 않는다. 순서만 지키면 `pointerEvents`가 필요 없다.
        빨간 점(y 205)과 스트릭 글자(y 448~)는 안 겹쳐서 보이는 모습은 순서와 무관하다.
      */}
      {activeSlot !== null && activeSlot < TOTAL_SLOTS && (
        <Pressable
          onPress={onPressActiveSlot}
          // 부모가 오늘 Day를 아직 못 읽었으면 눌러도 갈 곳이 없다 — 아예 타깃에서 뺀다.
          pointerEvents={onPressActiveSlot ? 'auto' : 'none'}
          accessibilityRole="button"
          accessibilityLabel="지금 열린 시간대 — 오늘의 단어장 열기"
          style={{
            position: 'absolute',
            left: (BULB_CENTERS_X[activeSlot] - HIT.halfWidth) * scale,
            top: HIT.top * scale,
            width: HIT.halfWidth * 2 * scale,
            height: (HIT.bottom - HIT.top) * scale,
          }}
        >
          {({ pressed }) => (
            // 눌린 반응은 점에만 준다 — 전구는 공용 이미지라 한 칸만 밝히지 못한다.
            <View
              style={[
                styles.activeDot,
                {
                  left: (HIT.halfWidth - DOT_SIZE / 2) * scale,
                  top: (DOT_Y - HIT.top) * scale,
                  width: DOT_SIZE * scale,
                  height: DOT_SIZE * scale,
                  borderRadius: (DOT_SIZE * scale) / 2,
                  backgroundColor: pressed ? DOT_COLOR_PRESSED : DOT_COLOR,
                },
              ]}
            />
          )}
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // 색은 여기서 정하지 않는다 — 눌림 상태에 따라 바뀌므로 렌더에서 준다(DOT_COLOR*).
  activeDot: {
    position: 'absolute',
  },
  // 둘 다 row 안의 in-flow 자식이다 — `position:'absolute'`나 `left/right`를 다시 넣지 말 것.
  // (2026-08-15 이전엔 absolute + left:0/right:0 + textAlign:center + marginLeft 조합이었는데,
  //  left/right가 잡힌 박스에 marginLeft를 주면 박스가 이동하는 대신 좁아져서
  //  이동량이 절반만 먹혔다. 덩어리 정렬로 바꾸면서 그 조합 자체를 걷어냈다.)
  streakText: {
    fontFamily: HANDWRITING_FONT,
    color: '#1b1b1b',
  },
  fire: {
    textAlign: 'center',
  },
});
