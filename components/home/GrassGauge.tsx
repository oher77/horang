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
 * "🔥 N일 연속" — 불꽃과 글자를 **한 줄(row)로 묶어 덩어리째 가운데 정렬**한다 (2026-08-15).
 *
 * **가로는 시안 절대좌표를 쓰지 않는다 — 이 요소만의 예외다.** 글자가 가변 길이라
 * ("1일 연속" ~ "127일 연속") 둘을 각자 절대배치하면 자릿수가 늘 때 글자만 양옆으로
 * 자라서 ⓐ 덩어리 중심이 오른쪽으로 밀리고 ⓑ 불꽃과의 간격이 좁아진다. 절대좌표 원칙
 * (`mockupLayout.ts`)은 크기가 고정된 에셋에 성립하는 것이고, 가변 길이 텍스트에는
 * 성립하지 않는다. 6개월 완주가 목표라 세 자리 스트릭은 실제로 나오는 값이다.
 *
 * **세로는 각자 실측값을 유지한다** — 불꽃이 글자보다 32px 높이 앉는 게 시안이다.
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
const STREAK_TEXT = { centerY: 512, fontSize: 87 };
/**
 * 불꽃 — 시안 실측 y 448~557. 이모지는 폰트 지표를 믿을 수 없어 박스 높이 안에서 중앙 정렬만 하고,
 * 어긋난 만큼 실기기 측정으로 뺀다.
 * 2026-08-14 측정: 크기는 정확히 맞았고(폭 90) **세로만 22px 낮아** centerY를 502 → 480.
 * 가로 위치(옛 centerX 329)는 2026-08-15 row 정렬로 바뀌면서 `STREAK_GROUP`이 대신한다.
 */
const FIRE = { centerY: 480, fontSize: 95 };

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
    </View>
  );
}

const styles = StyleSheet.create({
  activeDot: {
    position: 'absolute',
    backgroundColor: '#e02020',
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
