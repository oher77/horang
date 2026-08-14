import { Image, StyleSheet, Text, View } from 'react-native';

import { HANDWRITING_FONT } from '../../lib/fonts';

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

/** "🔥 N일 연속" — 시안 실측(전구 아래, grass-box 좌표 y 472~552). 실기기 미세조정 대상. */
const STREAK_TOP = 455;
/*
 * 글자 크기 비율(2026-08-14 사용자 지정): "N일 연속" = 52.
 * 버튼 라벨 "복습"(150, 비율 90) 기준 환산. 잔디 좌표계(928)와 버튼 좌표계(866)는
 * 다르지만 화면에 그려질 때 둘 다 같은 배율 `scale`이 곱해지므로 비율이 그대로 반영된다.
 */
const STREAK_FONT_SIZE = 87;

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
    <View style={{ width: boxWidth, height: boxHeight, overflow: 'hidden' }}>
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

      <Text style={[styles.streakText, { top: STREAK_TOP * scale, fontSize: STREAK_FONT_SIZE * scale }]}>
        🔥 {streak}일 연속
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
});
