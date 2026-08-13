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

const LINE_HEIGHT = 32;
export const PAPER_COLOR = '#fffbe8';
const LINE_COLOR = '#f0dca3';

export default function NotebookBackground({ children }: { children: ReactNode }) {
  const [height, setHeight] = useState(0);
  const lineCount = Math.max(1, Math.ceil(height / LINE_HEIGHT) + 1);

  return (
    <View style={styles.container} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      <View style={[StyleSheet.absoluteFillObject, styles.paper]} pointerEvents="none">
        {Array.from({ length: lineCount }, (_, i) => (
          <View key={i} style={[styles.line, { top: (i + 1) * LINE_HEIGHT }]} />
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
