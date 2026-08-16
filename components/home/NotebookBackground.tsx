import { type ReactNode, useState } from 'react';
import { StyleSheet, View } from 'react-native';

/**
 * 홈 화면 배경 — 노란 줄노트 (design/홈화면-에셋-가이드.md §3, §8).
 *
 * 이미지가 아니라 배경색 + 가로선 반복으로 그린다. 이미지로 만들면 기기 높이마다
 * 줄 간격이 어긋나기 때문(가이드 §3). children의 실제 렌더 높이를 onLayout으로
 * 측정해 스크롤 전체 길이만큼 줄을 이어 그린다(§7 "줄노트 배경은 스크롤 전체
 * 길이에 맞춰 이어 그립니다").
 */

/**
 * 줄 간격(pt). 줄은 컨테이너 top에서 `(i+1) * LINE_HEIGHT` 위치에 그린다.
 * **스플래시가 글자를 줄에 앉히려고 이 값을 읽는다**(components/AnimatedSplash.tsx) —
 * 바꾸면 그쪽 스냅 위치도 같이 움직인다(의도된 연동. 글자가 항상 줄 위에 남는다).
 */
export const LINE_HEIGHT = 32;
export const PAPER_COLOR = '#fffbe8';
const LINE_COLOR = '#f0dca3';

export default function NotebookBackground({
  children,
  lineOffset = 0,
}: {
  children: ReactNode;
  /**
   * 줄 격자 전체를 아래로 미는 값(pt). 특정 y에 줄이 **정확히** 지나가야 할 때 쓴다
   * (스플래시가 "호랑잉글리시"를 줄 위에 앉히는 용도 — components/AnimatedSplash.tsx).
   *
   * 글자를 줄에 맞추는 대신 줄을 글자에 맞추는 이유: 글자를 32의 배수로 스냅하면
   * 기기 높이에 따라 호랑이와의 간격이 최대 32pt 널뛴다. 반대로 줄은 반복 패턴이라
   * **위상이 바뀌어도 눈에 보이지 않는다.** 보이는 것(간격)을 고정하고 안 보이는 것을
   * 양보한 것이다. 홈 화면은 기본값 0이라 동작이 그대로다.
   */
  lineOffset?: number;
}) {
  const [height, setHeight] = useState(0);
  // offset이 줄 하나를 아래로 밀어내므로 여유분을 한 줄 더 그린다.
  const lineCount = Math.max(1, Math.ceil(height / LINE_HEIGHT) + 2);

  return (
    <View style={styles.container} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      <View style={[StyleSheet.absoluteFillObject, styles.paper]} pointerEvents="none">
        {Array.from({ length: lineCount }, (_, i) => (
          <View key={i} style={[styles.line, { top: lineOffset + (i + 1) * LINE_HEIGHT }]} />
        ))}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  paper: {
    backgroundColor: PAPER_COLOR,
  },
  line: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth * 2,
    backgroundColor: LINE_COLOR,
  },
});
