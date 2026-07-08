/**
 * 단어장 학습 화면의 행 컴포넌트.
 *
 * - 좌/우 스와이프: recall_stage 증감(우=+1, 좌=-1), user.db에 즉시 영속.
 * - 셀 탭: word/meaning 컬럼이 가려진 상태일 때 탭하면 잠깐 보여준다(§4.5 개별 가림 재사용).
 *   가려지지 않은 상태에서 탭하면 예문 바텀시트를 연다(onOpenDetail) — peek와 배타적 트리거.
 * - 스피커 버튼: expo-speech TTS로 영단어 발음 (Speech.stop() 후 speak() — 중복 재생 방지).
 *
 * 성능: React.memo + 얕은 비교로 다른 행의 리렌더를 유발하지 않는다. 애니메이션은
 * reanimated shared value로 UI 스레드에서 처리되어 JS 리렌더를 유발하지 않는다.
 */

import * as Speech from 'expo-speech';
import { memo, useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import DustCoverOverlay from './DustCoverOverlay';
import RecallStageBadge from './RecallStageBadge';
import type { DayWordRow as DayWordRowData } from '../lib/queries';

export const ROW_HEIGHT = 56;

const SWIPE_THRESHOLD = 56;
// 스와이프 중 행이 실제로 밀리는 시각적 상한 — 단계 뱃지 셀 폭만큼만 (사용자 피드백:
// 손가락을 그대로 따라가면 이동 폭이 너무 큼). 제스처 판정(SWIPE_THRESHOLD)은 원본
// translationX 기준이라 영향 없음.
const MAX_ROW_SHIFT = 28;

interface DayWordRowProps {
  item: DayWordRowData;
  index: number;
  isAlt: boolean;
  wordHidden: boolean;
  meaningHidden: boolean;
  peekWord: boolean;
  peekMeaning: boolean;
  columnHideDelayMs: number;
  onSwipeStage: (dayWordId: number, delta: number) => void;
  onTapCell: (dayWordId: number, column: 'word' | 'meaning') => void;
  /**
   * 예문 바텀시트 오픈 트리거 (사용자 확정 UX). word/meaning 셀이 "가려지지
   * 않은 상태"에서의 탭은 기존에 아무 동작도 없었으므로(hidden일 때만 peek
   * 동작) 그 빈 인터랙션을 시트 오픈으로 재활용한다 — peek 탭(가려진 셀 탭)과
   * 명확히 배타적이라 충돌이 없고, 스와이프(Pan)는 activeOffsetX로 별도 처리돼
   * 간섭하지 않는다.
   */
  onOpenDetail: (contentWordId: number) => void;
}

function DayWordRowImpl({
  item,
  index,
  isAlt,
  wordHidden,
  meaningHidden,
  peekWord,
  peekMeaning,
  columnHideDelayMs,
  onSwipeStage,
  onTapCell,
  onOpenDetail,
}: DayWordRowProps) {
  const translateX = useSharedValue(0);
  const [speaking, setSpeaking] = useState(false);
  const speakingRef = useRef(false);

  const handleSwipeStage = useCallback(
    (delta: number) => {
      onSwipeStage(item.id, delta);
    },
    [item.id, onSwipeStage],
  );

  const panGesture = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-14, 14])
    .onUpdate((e) => {
      translateX.value = Math.max(-MAX_ROW_SHIFT, Math.min(MAX_ROW_SHIFT, e.translationX));
    })
    .onEnd((e) => {
      if (e.translationX > SWIPE_THRESHOLD) {
        runOnJS(handleSwipeStage)(1); // 우스와이프 = 인출 실패 단계 증가
      } else if (e.translationX < -SWIPE_THRESHOLD) {
        runOnJS(handleSwipeStage)(-1); // 좌스와이프 = 단계 감소
      }
      // 반동(출렁임) 없는 복귀 — 사용자 피드백으로 spring에서 timing으로 교체
      translateX.value = withTiming(0, { duration: 140 });
    });

  const rowAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const swipeHintStyle = useAnimatedStyle(() => ({
    // 시각 이동이 MAX_ROW_SHIFT로 제한되므로 힌트 게이지도 같은 기준으로 채운다
    opacity: withTiming(Math.min(Math.abs(translateX.value) / MAX_ROW_SHIFT, 1), {
      duration: 80,
    }),
  }));

  const handleSpeak = useCallback(() => {
    // CLAUDE.md 가드레일: 연속 탭 중복 재생 방지 — 항상 stop() 후 speak().
    Speech.stop();
    speakingRef.current = true;
    setSpeaking(true);
    Speech.speak(item.headword, {
      language: 'en-US',
      onDone: () => {
        speakingRef.current = false;
        setSpeaking(false);
      },
      onStopped: () => {
        speakingRef.current = false;
        setSpeaking(false);
      },
      onError: () => {
        speakingRef.current = false;
        setSpeaking(false);
      },
    });
  }, [item.headword]);

  const handleTapWord = useCallback(() => {
    if (wordHidden) {
      onTapCell(item.id, 'word'); // 가려진 상태 탭 = 기존 peek 유지
    } else {
      onOpenDetail(item.content_word_id); // 가려지지 않은 상태 탭 = 예문 바텀시트 오픈
    }
  }, [wordHidden, item.id, item.content_word_id, onTapCell, onOpenDetail]);

  const handleTapMeaning = useCallback(() => {
    if (meaningHidden) {
      onTapCell(item.id, 'meaning');
    } else {
      onOpenDetail(item.content_word_id);
    }
  }, [meaningHidden, item.id, item.content_word_id, onTapCell, onOpenDetail]);

  const wordCellGesture = Gesture.Tap().onEnd(() => {
    runOnJS(handleTapWord)();
  });
  const meaningCellGesture = Gesture.Tap().onEnd(() => {
    runOnJS(handleTapMeaning)();
  });

  const showWordSweep = wordHidden && !peekWord;
  const showMeaningSweep = meaningHidden && !peekMeaning;

  return (
    <GestureDetector gesture={panGesture}>
      <Animated.View style={rowAnimatedStyle}>
        <View style={[styles.row, isAlt && styles.rowAlt]}>
          <View style={styles.stageCell}>
            <RecallStageBadge stage={item.recall_stage} />
          </View>

          <Text style={styles.numberCell}>{item.position + 1}</Text>

          <GestureDetector gesture={wordCellGesture}>
            <View style={styles.wordCell}>
              <DustCoverOverlay hidden={showWordSweep} delayMs={columnHideDelayMs}>
                <View style={styles.wordRow}>
                  <Text style={styles.wordText} numberOfLines={1}>
                    {item.headword}
                  </Text>
                </View>
              </DustCoverOverlay>
            </View>
          </GestureDetector>

          <TtsButton speaking={speaking} onPress={handleSpeak} />

          <GestureDetector gesture={meaningCellGesture}>
            <View style={styles.meaningCell}>
              <DustCoverOverlay hidden={showMeaningSweep} delayMs={columnHideDelayMs}>
                <Text style={styles.meaningText} numberOfLines={2}>
                  {item.meaning_ko ?? '-'}
                </Text>
              </DustCoverOverlay>
            </View>
          </GestureDetector>
        </View>

        {/* 스와이프 진행 힌트(살짝 배경 강조) — 임계값 도달 정도를 opacity로만 표시, 리렌더 없음 */}
        <Animated.View pointerEvents="none" style={[styles.swipeHint, swipeHintStyle]} />
      </Animated.View>
    </GestureDetector>
  );
}

function TtsButtonImpl({ speaking, onPress }: { speaking: boolean; onPress: () => void }) {
  const tapGesture = Gesture.Tap().onEnd(() => {
    runOnJS(onPress)();
  });
  return (
    <GestureDetector gesture={tapGesture}>
      <View style={[styles.speakerButton, speaking && styles.speakerButtonActive]}>
        <Text style={styles.speakerIcon}>{speaking ? '🔊' : '🔈'}</Text>
      </View>
    </GestureDetector>
  );
}
const TtsButton = memo(TtsButtonImpl);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ROW_HEIGHT,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
    backgroundColor: '#fff',
  },
  rowAlt: {
    backgroundColor: '#fafafa',
  },
  stageCell: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  numberCell: {
    width: 28,
    fontSize: 13,
    color: '#999',
  },
  wordCell: {
    width: 100,
  },
  wordRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  wordText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#222',
  },
  speakerButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
  },
  speakerButtonActive: {
    backgroundColor: '#eef6ff',
  },
  speakerIcon: {
    fontSize: 16,
  },
  meaningCell: {
    flex: 1,
    marginLeft: 4,
  },
  meaningText: {
    fontSize: 15,
    color: '#222',
  },
  swipeHint: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    backgroundColor: '#ff9f43',
  },
});

function propsAreEqual(prev: DayWordRowProps, next: DayWordRowProps): boolean {
  return (
    prev.item === next.item &&
    prev.isAlt === next.isAlt &&
    prev.wordHidden === next.wordHidden &&
    prev.meaningHidden === next.meaningHidden &&
    prev.peekWord === next.peekWord &&
    prev.peekMeaning === next.peekMeaning &&
    prev.columnHideDelayMs === next.columnHideDelayMs &&
    prev.onSwipeStage === next.onSwipeStage &&
    prev.onTapCell === next.onTapCell &&
    prev.onOpenDetail === next.onOpenDetail
  );
}

export default memo(DayWordRowImpl, propsAreEqual);
