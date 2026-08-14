import { Image, StyleSheet, Text, View } from 'react-native';

import { HANDWRITING_FONT, handwritingLineHeight, handwritingTop } from '../../lib/fonts';

/**
 * 잔디 게이지 (design/홈화면-에셋-가이드.md §1).
 *
 * ── 3층 스택, 좌우 이동 한 번 말고는 좌표 계산이 없다 ──────────────────────
 *
 *   grass-box.png (928 × 619)   배경 + 꺼진 전구 4개(반투명 검정 워시)
 *     ├ bulb-glow.png × 완료 슬롯   272 × 619 — **세로는 전체 높이라 x만 옮긴다**
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
 * "🔥 N일 연속" — **이모지와 글자를 한 `<Text>`에 넣지 않는다** (2026-08-14).
 *
 * 이모지는 이 폰트에 없어서 Apple Color Emoji로 대체되는데, 그 폰트의 ascent가 훨씬 커서
 * 줄 전체를 밀어내린다. 실측으로 이 줄만 다른 텍스트보다 0.27em 더 밀렸다
 * (글자 0.62em vs 이 줄 0.885em). 둘을 갈라 각자 배치하면 글자가 폰트 지표대로 앉는다.
 *
 * 아래 값은 전부 **시안에서 잰 잉크 중심**(grass-box 좌표). 폰트 보정은 `handwritingTop()`이 한다.
 */
// fontSize 87 = 사용자 지정 비율("N일 연속" 52, 복습 150/비율 90 기준 환산).
const STREAK_TEXT = { centerX: 496, centerY: 512, fontSize: 87 };
/**
 * 불꽃 — 시안 실측 x 287~372 / y 448~557 (86 × 110).
 * 이모지는 폰트 지표를 믿을 수 없어 박스 중앙 정렬만 하고, 어긋난 만큼 실기기 측정으로 뺀다.
 * 2026-08-14 측정: x·크기는 정확히 맞았고(중심 325/폭 90) **세로만 22px 낮아** centerY를 502 → 480.
 */
const FIRE = { centerX: 329, centerY: 480, fontSize: 95 };

export default function GrassGauge({
  slots,
  streak,
  activeSlot,
  scale,
}: {
  slots: boolean[] | null;
  streak: number;
  activeSlot: number | null;
  /** 시안 px → 화면 px 배율. grass-box도 시안에서 1:1로 잘렸으므로 같은 배율이 그대로 통한다. */
  scale: number;
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
    // pointerEvents="none" — 잔디는 호랑이 **위**에 그려지므로(app/index.tsx 렌더 순서),
    // 이게 없으면 겹치는 구간(말풍선 탭 영역 아래 16px)의 터치를 잔디가 가로챈다.
    // 잔디는 보여주기만 하는 레이어라 터치를 받을 이유가 없다.
    <View
      style={{ width: boxWidth, height: boxHeight, overflow: 'hidden' }}
      pointerEvents="none"
    >
      <Image
        source={require('../../assets/images/grass-box.png')}
        style={layerStyle}
        resizeMode="contain"
      />

      {/* 켜진 전구 — 세로는 전체 높이 그대로, 좌우로만 옮긴다. */}
      {slots?.map((filled, i) =>
        filled && i < TOTAL_SLOTS ? (
          <Image
            key={i}
            source={require('../../assets/images/bulb-glow.png')}
            style={{
              position: 'absolute',
              left: (BULB_CENTERS_X[i] - GLOW_CORE_CX) * scale,
              top: 0,
              width: GLOW_WIDTH * scale,
              height: GLOW_HEIGHT * scale,
            }}
            resizeMode="contain"
          />
        ) : null,
      )}

      {/* 윤곽선은 빛 위에 얹어야 켜진 전구도 테두리가 살아난다. */}
      <Image
        source={require('../../assets/images/bulbs.png')}
        style={layerStyle}
        resizeMode="contain"
      />

      {activeSlot !== null && activeSlot < TOTAL_SLOTS && (
        <View
          style={[
            styles.activeDot,
            {
              left: (BULB_CENTERS_X[activeSlot] - DOT_SIZE / 2) * scale,
              top: DOT_Y * scale,
              width: DOT_SIZE * scale,
              height: DOT_SIZE * scale,
              borderRadius: (DOT_SIZE * scale) / 2,
            },
          ]}
        />
      )}

      {/* 불꽃 — 이모지 전용 박스. 폰트 지표를 못 믿으므로 박스 안에서 중앙 정렬만 한다. */}
      <Text
        style={[
          styles.fire,
          {
            left: (FIRE.centerX - FIRE.fontSize) * scale,
            top: (FIRE.centerY - FIRE.fontSize) * scale,
            width: FIRE.fontSize * 2 * scale,
            height: FIRE.fontSize * 2 * scale,
            lineHeight: FIRE.fontSize * 2 * scale,
            fontSize: FIRE.fontSize * scale,
          },
        ]}
      >
        🔥
      </Text>

      <Text
        style={[
          styles.streakText,
          {
            top: handwritingTop(STREAK_TEXT.centerY, STREAK_TEXT.fontSize) * scale,
            fontSize: STREAK_TEXT.fontSize * scale,
            lineHeight: handwritingLineHeight(STREAK_TEXT.fontSize) * scale,
            // 좌우 0 + textAlign center 기준으로, 글자 중심을 잔디 박스 중심에서 옮긴다.
            marginLeft: (STREAK_TEXT.centerX - BOX_WIDTH / 2) * scale,
          },
        ]}
      >
        {streak}일 연속
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  activeDot: {
    position: 'absolute',
    backgroundColor: '#e02020',
  },
  streakText: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    fontFamily: HANDWRITING_FONT,
    color: '#1b1b1b',
  },
  fire: {
    position: 'absolute',
    textAlign: 'center',
  },
});
