import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { HANDWRITING_FONT, handwritingLineHeight, handwritingTop } from '../lib/fonts';
import NotebookBackground, { LINE_HEIGHT } from './home/NotebookBackground';

/**
 * 초기화 중 보여주는 애니메이션 스플래시 — 글씨 쓰는 호랑이.
 *
 * ── 이게 "네이티브 스플래시"가 아니다 ──────────────────────────────────────
 * 앱 실행 순서는 세 단계다.
 *   ① 네이티브 스플래시 : iOS가 JS 시작 **전에** storyboard로 그린다. **애니메이션 불가.**
 *   ② 이 컴포넌트       : JS가 뜬 뒤 DB 초기화가 끝날 때까지. 애니메이션 가능.
 *   ③ 홈
 * ①은 `app.json`의 `expo-splash-screen` 플러그인 설정이고, 이 파일은 ②다.
 * ①→② 전환이 안 보이려면 **호랑이가 같은 크기·같은 자리**여야 한다 — 아래 참조.
 *
 * ── ①과 맞춰야 하는 값 (틀어지면 전환 때 호랑이가 튄다) ────────────────────
 * 플러그인은 `imageWidth × imageWidth` 정사각형 안에 이미지를 contain으로 담아 굽고,
 * 그 정사각형을 **화면 정중앙**(centerX/centerY 제약)에 놓는다. 우리 프레임은 가로가
 * 더 길어서 contain이 가로를 꽉 채우므로, 결국 **호랑이 폭 = `imageWidth` pt, 세로
 * 중심 = 화면 중심**이 된다. 그래서 이 컴포넌트도 똑같이 그린다.
 *
 * **`IMAGE_WIDTH`와 app.json의 `imageWidth`는 반드시 같은 숫자여야 한다.**
 * app.json은 TS를 import할 수 없어 자동 동기화가 불가능하다 — 한쪽만 고치지 말 것.
 *
 * 화면 폭에 비례(%)시키지 않고 **고정 pt**인 이유가 여기 있다. ①은 고정 dp만 지정할
 * 수 있어서, ②가 화면 폭에 비례하면 넓은 기기에서 최대 9% 차이가 나 전환 때 확대되어
 * 보인다. 1179px 원본은 393pt 기기에서 정확히 3배라 그 폭을 기준으로 잡았다.
 *
 * ── 호랑이를 위/아래로 옮기고 싶으면 ───────────────────────────────────────
 * 코드로는 못 옮긴다(①이 무조건 화면 정중앙에 놓으므로 ②만 옮기면 전환이 깨진다).
 * **프레임 PNG 캔버스에 투명 여백을 넣어서** 옮길 것 — 아래쪽에 여백을 더하면
 * 호랑이가 위로 올라간다. 그래야 ①·② 양쪽이 같이 움직인다.
 */

/** 프레임 PNG 캔버스 (4장 모두 동일 — 팔만 다르다). */
const FRAME_W = 1179;
const FRAME_H = 717;

/** ★ app.json의 `expo-splash-screen` → `imageWidth`와 **같은 값이어야 한다.** */
const IMAGE_WIDTH = 393;
const IMAGE_HEIGHT = (IMAGE_WIDTH * FRAME_H) / FRAME_W;

const FRAMES = [
  require('../assets/images/splash-1.png'),
  require('../assets/images/splash-2.png'),
  require('../assets/images/splash-3.png'),
  require('../assets/images/splash-4.png'),
];

/**
 * 재생 순서 — **왕복이다.** 종이의 글씨는 4장 모두 완성된 상태라 "글자가 늘어나는"
 * 연출이 아니라 팔을 좌우로 끄적이는 동작이고, 연필은 1→4로 갈수록 왼쪽으로 간다.
 * 1→2→3→4→1로 단순 반복하면 맨 왼쪽에서 맨 오른쪽으로 순간이동해 팔이 튄다.
 * 양끝(0, 3)은 한 번씩만 나와야 그 자리에서 머뭇거리지 않는다.
 */
const SEQUENCE = [0, 1, 2, 3, 2, 1];
const FRAME_MS = 130;

/**
 * "호랑잉글리시" — 이미지가 아니라 **텍스트로 그린다.** 앱 전역 손글씨 폰트를 쓰므로
 * 어느 해상도에서도 선명하고, 위치를 숫자 하나로 조정할 수 있다.
 * (그래서 ①에는 글자가 없다. storyboard는 커스텀 폰트를 못 그리고, 이미지로 구워
 *  넣으면 코드가 그린 글자와 위치가 어긋나 전환 중 두 겹으로 보인다.)
 */
const TITLE = '호랑잉글리시';
const TITLE_FONT_SIZE = 26;
/**
 * ★ 세로 위치 조정 손잡이 — 호랑이 아래끝에서 글자가 앉을 줄까지의 거리(pt).
 * **아무 숫자나 넣어도 된다.** 줄 격자가 이 값을 따라오므로(아래 `lineOffset`)
 * 글자는 언제나 줄 위에 정확히 앉는다. 전 기기에서 이 간격이 그대로 유지된다.
 */
const TITLE_GAP = 28;
/**
 * 글자 잉크 중심이 줄보다 위로 뜨는 정도(em). 공책에 쓴 글씨처럼 **줄 위에 앉게** 한다.
 * 0이면 줄이 글자 한가운데를 가로지른다. 폰트를 바꾸면 이 값만 다시 보면 된다.
 */
const TITLE_SIT_EM = 0.36;

export default function AnimatedSplash() {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const [step, setStep] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setStep((s) => (s + 1) % SEQUENCE.length), FRAME_MS);
    return () => clearInterval(id);
  }, []);

  // ①과 동일하게 화면 정중앙 배치.
  const imageLeft = (screenWidth - IMAGE_WIDTH) / 2;
  const imageTop = (screenHeight - IMAGE_HEIGHT) / 2;

  // 글자가 앉을 줄의 y. 여기에 줄이 **정확히** 지나가도록 격자를 통째로 민다.
  // (글자를 32의 배수로 스냅하는 반대 방식은 기기마다 호랑이와의 간격이 최대 32pt
  //  널뛴다 — 실측으로 11~31pt까지 벌어졌다. 줄의 위상은 안 보이고 간격은 보인다.)
  const titleLineY = imageTop + IMAGE_HEIGHT + TITLE_GAP;
  const lineOffset = ((titleLineY % LINE_HEIGHT) + LINE_HEIGHT) % LINE_HEIGHT;
  const titleInkCenterY = titleLineY - TITLE_SIT_EM * TITLE_FONT_SIZE;

  const activeFrame = SEQUENCE[step];

  return (
    <NotebookBackground lineOffset={lineOffset}>
      <View style={{ height: screenHeight }}>
        {/*
          4장을 전부 겹쳐두고 opacity로 고른다. `source`를 갈아끼우면 첫 한 바퀴 동안
          디코딩 지연으로 깜빡인다 — 스플래시는 그 첫 바퀴가 곧 사용자가 보는 전부다.
        */}
        {FRAMES.map((src, i) => (
          <Image
            key={i}
            source={src}
            style={{
              position: 'absolute',
              left: imageLeft,
              top: imageTop,
              width: IMAGE_WIDTH,
              height: IMAGE_HEIGHT,
              opacity: i === activeFrame ? 1 : 0,
            }}
            resizeMode="contain"
          />
        ))}

        <Text
          style={[
            styles.title,
            {
              top: handwritingTop(titleInkCenterY, TITLE_FONT_SIZE),
              fontSize: TITLE_FONT_SIZE,
              lineHeight: handwritingLineHeight(TITLE_FONT_SIZE),
            },
          ]}
        >
          {TITLE}
        </Text>
      </View>
    </NotebookBackground>
  );
}

const styles = StyleSheet.create({
  title: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    fontFamily: HANDWRITING_FONT,
    color: '#1b1b1b',
  },
});
