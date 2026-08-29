import { router, type Href } from 'expo-router';
import { Fragment } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  HANDWRITING_FONT,
  HANDWRITING_TUNED_SCALE,
  handwritingLineHeight,
  handwritingTop,
} from '../../lib/fonts';
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
  /**
   * 없으면 **장식**이다 — 탭이 안 되는 그림으로만 렌더한다(Pressable을 씌우지 않는다).
   * 리본(획득물)이 여기 해당한다: 화면이 아직 없어서 라우팅을 떼어냈다. 아래 항목 주석 참조.
   */
  route?: Href;
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
    label: { text: '복습', fontSize: 185 * HANDWRITING_TUNED_SCALE, centerX: 425, centerY: 119 },
    // 글자 크기 비율(2026-08-14 사용자 지정): 복습 : 발음체크 : 테스트 = 90 : 80 : 100.
    // 옛 값 150 / 133 / 167에 1.235를 곱해 반올림한 것이 지금의 185 / 164 / 206이다
    // (경위는 lib/fonts.ts의 `HANDWRITING_TUNED_SCALE` 주석). 비율은 그대로 보존된다.
    // **centerX/centerY는 시안 실측 위치라 함께 키우지 않았다.**
  },
  {
    key: 'pronunciation',
    source: require('../../assets/images/btn-pronunciation.png'),
    at: PLACE.pronunciation,
    route: '/pronunciation',
    // 오른쪽에 개구리가 있어 글자가 왼쪽으로 치우쳐 있다.
    label: { text: '발음체크', fontSize: 164 * HANDWRITING_TUNED_SCALE, centerX: 334, centerY: 137 },
  },
  {
    // **테스트만 라우팅이 아니라 덮개를 연다** (2026-08-29) — 홈이 `onPressTest`를
    // 넘겨 `TestGateOverlay`를 manual 모드로 띄운다. 예약 시각에 떠밀려 들어가든
    // 스스로 들어가든 진입 경험이 같아야 하기 때문(그 근거는 덮개 파일 헤더).
    // `route`는 홈이 `onPressTest`를 안 넘겼을 때의 폴백으로만 남는다.
    key: 'test',
    source: require('../../assets/images/btn-test.png'),
    at: PLACE.test,
    route: '/test',
    // 오른쪽에 호랑이가 있어 글자가 왼쪽으로 치우쳐 있다.
    label: { text: '테스트', fontSize: 206 * HANDWRITING_TUNED_SCALE, centerX: 346, centerY: 133 },
  },
  {
    key: 'achievements',
    source: require('../../assets/images/btn-achievements.png'),
    at: PLACE.flower,
    route: '/achievements',
  },
  {
    // 리본(획득물) — **장식이다. 일부러 route가 없다.**
    // 획득물 화면은 스펙 자체가 없고(가이드 §6 "화면은 나중에"), 눌러서 "준비 중" 화면이
    // 뜨는 상태로 심사에 내면 App Review 가이드라인 2.1(App Completeness)에 걸린다.
    // 그래서 2026-08-21 외부 TestFlight 준비 중 라우팅을 떼고 그림만 남겼다 —
    // 딸 시안의 하단 구성을 그대로 지키면서 미완성 화면만 없앤다.
    // 나중에 획득물을 만들면 `route: '/collection'` 한 줄을 되살리면 된다.
    key: 'collection',
    source: require('../../assets/images/btn-collection.png'),
    at: PLACE.ribbon,
  },
];

export default function HomeMenuButtons({
  scale,
  onPressTest,
}: {
  scale: number;
  /**
   * [테스트] 버튼을 눌렀을 때 라우팅 대신 실행할 동작 — 홈이 진입 덮개를 띄우는 데 쓴다.
   * 안 넘기면 예전처럼 `/test`로 바로 간다(덮개 없이 = 잠금 없이 들어간다).
   */
  onPressTest?: () => void;
}) {
  return (
    <Fragment>
      {ITEMS.map((item) => {
        const content = (
          <Fragment>
            <Image source={item.source} style={styles.fill} resizeMode="contain" />

            {item.label && (
              <Text
                // 절대좌표 배치라 OS 텍스트 크기 배율이 들어오면 top과 fontSize의 관계가 깨진다.
                allowFontScaling={false}
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
          </Fragment>
        );

        // route가 없는 항목(리본)은 장식이므로 Pressable로 감싸지 않는다 —
        // onPress 없는 Pressable은 눌러도 아무 일이 없으면서 터치만 삼켜 "고장 난 버튼"으로 보인다.
        const { route } = item;
        if (route === undefined) {
          return <View key={item.key} style={place(item.at, scale)} pointerEvents="none">{content}</View>;
        }

        const handlePress =
          item.key === 'test' && onPressTest ? onPressTest : () => router.push(route);

        return (
          <Pressable key={item.key} style={place(item.at, scale)} onPress={handlePress}>
            {content}
          </Pressable>
        );
      })}
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
