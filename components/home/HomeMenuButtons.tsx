import { router, type Href } from 'expo-router';
import { Fragment } from 'react';
import { Image, Pressable, StyleSheet, Text } from 'react-native';

import { HANDWRITING_FONT, handwritingLineHeight, handwritingTop } from '../../lib/fonts';
import { place, PLACE, type Placement } from './mockupLayout';

/**
 * 복습 / 발음체크 / 테스트 + 하단 꽃(업적) · 리본(획득물)
 * (design/홈화면-에셋-가이드.md §6 진입점 배치).
 *
 * 전부 시안 절대좌표로 배치한다 — 좌표의 근거는 `mockupLayout.ts` 주석 참조.
 * 버튼 3개는 폭도 좌우 위치도 미묘하게 다르고(866/867/875, x 157/133/129),
 * 꽃과 리본은 크기가 확연히 다르며(135 vs 176) 좌우로 크게 벌어져 있다.
 * **하나로 통일하거나 나란히 배치하지 말 것.**
 *
 * ── 라벨은 이미지가 아니라 폰트로 얹는다 (2026-08-11 변경) ──────────────────
 * 버튼 이미지를 **글자 없는 버전으로 교체할 예정**이라, 라벨을 코드에서 렌더한다.
 * 위치·크기는 현재 이미지에 그려진 딸 손글씨를 실측해 맞췄다(아래 LABELS).
 * 글자 없는 이미지로 바꿔도 이 좌표는 그대로 쓰면 된다.
 */

interface MenuItem {
  key: string;
  source: number;
  at: Placement;
  route: Href;
  /**
   * 라벨이 없는 항목(꽃·리본)은 undefined.
   *
   * 좌표는 전부 **버튼 로컬 px(= 시안 px)의 정수**다. 비율(0~1)로 두면 소수점이 생기고
   * 버튼마다 폭·높이가 달라 값을 눈으로 비교할 수 없다.
   */
  label?: {
    text: string;
    fontSize: number;
    /** 시안에서 잰 글자 잉크의 중심 x. */
    centerX: number;
    /**
     * 시안에서 잰 글자 잉크의 중심 y.
     * 폰트 지표 보정은 `lib/fonts.ts`의 `handwritingTop()`이 처리하므로
     * **여기에 보정값을 섞지 말 것.** 폰트를 바꿔도 이 값은 그대로 둔다.
     */
    centerY: number;
  };
}

const ITEMS: MenuItem[] = [
  {
    key: 'review',
    source: require('../../assets/images/btn-review.png'),
    at: PLACE.review,
    route: '/review',
    label: { text: '복습', fontSize: 150, centerX: 425, centerY: 119 },
    // 글자 크기 비율(2026-08-14 사용자 지정): 복습 : 발음체크 : 테스트 = 90 : 80 : 100.
    // 복습 150을 기준(=90)으로 환산 → 발음체크 133, 테스트 167.
  },
  {
    key: 'pronunciation',
    source: require('../../assets/images/btn-pronunciation.png'),
    at: PLACE.pronunciation,
    route: '/pronunciation',
    // 오른쪽에 개구리가 있어 글자가 왼쪽으로 치우쳐 있다.
    label: { text: '발음체크', fontSize: 133, centerX: 334, centerY: 137 },
  },
  {
    key: 'test',
    source: require('../../assets/images/btn-test.png'),
    at: PLACE.test,
    route: '/test',
    // 오른쪽에 호랑이가 있어 글자가 왼쪽으로 치우쳐 있다.
    label: { text: '테스트', fontSize: 167, centerX: 346, centerY: 133 },
  },
  {
    key: 'achievements',
    source: require('../../assets/images/btn-achievements.png'),
    at: PLACE.flower,
    route: '/achievements',
  },
  {
    key: 'collection',
    source: require('../../assets/images/btn-collection.png'),
    at: PLACE.ribbon,
    route: '/collection',
  },
];

export default function HomeMenuButtons({ scale }: { scale: number }) {
  return (
    <Fragment>
      {ITEMS.map((item) => (
        <Pressable
          key={item.key}
          style={place(item.at, scale)}
          onPress={() => router.push(item.route)}
        >
          <Image source={item.source} style={styles.fill} resizeMode="contain" />

          {item.label && (
            <Text
              style={[
                styles.label,
                {
                  fontSize: item.label.fontSize * scale,
                  lineHeight: handwritingLineHeight(item.label.fontSize) * scale,
                  top: handwritingTop(item.label.centerY, item.label.fontSize) * scale,
                  // 글자 중심을 버튼 중심에서 얼마나 옮길지 (좌우 0 + textAlign center 기준).
                  marginLeft: (item.label.centerX - item.at.w / 2) * scale,
                },
              ]}
            >
              {item.label.text}
            </Text>
          )}
        </Pressable>
      ))}
    </Fragment>
  );
}

const styles = StyleSheet.create({
  fill: {
    width: '100%',
    height: '100%',
  },
  label: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    fontFamily: HANDWRITING_FONT,
    color: '#1b1b1b',
  },
});
