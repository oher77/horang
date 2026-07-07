/**
 * 예문 바텀시트 (사용자 확정 UX) — 단어장 행 탭(가려지지 않은 상태) 시 headword,
 * 품사별 뜻 전부, 설정된 난이도의 예문(품사별 1개, en+ko)을 보여준다.
 *
 * 신규 패키지 설치 금지 가드레일 준수: @gorhom/bottom-sheet 등 미사용, 기존
 * 패키지(react-native Modal + reanimated + gesture-handler)만으로 자체 구현.
 * - RN Modal(transparent, animationType="none")로 오버레이 + 배경 탭 닫기.
 * - reanimated로 진입 시 아래→위 슬라이드업, 닫을 때 위→아래 슬라이드다운.
 * - gesture-handler Pan으로 시트를 아래로 드래그하면 임계값 이상 시 닫힘.
 *
 * TTS 버튼은 DayWordRow와 동일한 Gesture.Tap 기반 스피커 버튼을 재사용하지 않고
 * (요구사항 3 취소로 DayWordRow의 TtsButton 구조는 손대지 않기로 함) 이 시트
 * 전용의 작은 스피커 버튼을 자체 렌더링한다.
 */

import * as Speech from 'expo-speech';
import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import type { WordDetail } from '../lib/wordDetail';

const SLIDE_DURATION = 220;
const DRAG_CLOSE_THRESHOLD = 120;

interface WordDetailSheetProps {
  visible: boolean;
  loading: boolean;
  error: string | null;
  detail: WordDetail | null;
  onClose: () => void;
}

export default function WordDetailSheet({ visible, loading, error, detail, onClose }: WordDetailSheetProps) {
  const translateY = useSharedValue(400);
  const [mounted, setMounted] = useState(visible);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      translateY.value = withTiming(0, { duration: SLIDE_DURATION });
    } else if (mounted) {
      translateY.value = withTiming(400, { duration: SLIDE_DURATION }, (finished) => {
        if (finished) runOnJS(setMounted)(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const handleClose = useCallback(() => {
    Speech.stop();
    setSpeaking(false);
    onClose();
  }, [onClose]);

  const dragGesture = Gesture.Pan()
    .onUpdate((e) => {
      if (e.translationY > 0) translateY.value = e.translationY;
    })
    .onEnd((e) => {
      if (e.translationY > DRAG_CLOSE_THRESHOLD) {
        runOnJS(handleClose)();
      } else {
        translateY.value = withTiming(0, { duration: 160 });
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const handleSpeak = useCallback(() => {
    if (!detail) return;
    Speech.stop();
    setSpeaking(true);
    Speech.speak(detail.headword, {
      language: 'en-US',
      onDone: () => setSpeaking(false),
      onStopped: () => setSpeaking(false),
      onError: () => setSpeaking(false),
    });
  }, [detail]);

  if (!mounted) return null;

  return (
    <Modal transparent visible animationType="none" onRequestClose={handleClose}>
      <Pressable style={styles.backdrop} onPress={handleClose} />

      <GestureDetector gesture={dragGesture}>
        <Animated.View style={[styles.sheet, sheetStyle]}>
          <View style={styles.dragHandle} />

          {loading && <Text style={styles.statusText}>불러오는 중...</Text>}
          {error && <Text style={styles.errorText}>{error}</Text>}

          {!loading && !error && detail && (
            <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
              <View style={styles.headerRow}>
                <Text style={styles.headword}>{detail.headword}</Text>
                <Pressable
                  style={[styles.speakerButton, speaking && styles.speakerButtonActive]}
                  onPress={handleSpeak}
                  hitSlop={8}
                >
                  <Text style={styles.speakerIcon}>{speaking ? '🔊' : '🔈'}</Text>
                </Pressable>
              </View>

              <Text style={styles.sectionLabel}>뜻</Text>
              {detail.meanings.length === 0 && <Text style={styles.emptyText}>등록된 뜻이 없습니다.</Text>}
              {detail.meanings.map((m) => (
                <View key={m.id} style={styles.meaningRow}>
                  <Text style={styles.posTag}>{m.pos}</Text>
                  <Text style={styles.meaningText}>{m.meaning_ko}</Text>
                </View>
              ))}

              <Text style={styles.sectionLabel}>예문</Text>
              {detail.examples.length === 0 && (
                <Text style={styles.emptyText}>이 난이도의 예문이 없습니다.</Text>
              )}
              {detail.examples.map((ex) => (
                <View key={ex.id} style={styles.exampleCard}>
                  <Text style={styles.posTag}>{ex.pos}</Text>
                  <Text style={styles.exampleEn}>{ex.en}</Text>
                  {ex.ko && <Text style={styles.exampleKo}>{ex.ko}</Text>}
                </View>
              ))}

              <View style={styles.bottomSpacer} />
            </ScrollView>
          )}
        </Animated.View>
      </GestureDetector>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '75%',
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 24,
  },
  dragHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#ddd',
    marginBottom: 12,
  },
  scroll: {
    maxHeight: '100%',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headword: {
    fontSize: 22,
    fontWeight: '700',
    color: '#222',
  },
  speakerButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speakerButtonActive: {
    backgroundColor: '#eef6ff',
  },
  speakerIcon: {
    fontSize: 18,
  },
  sectionLabel: {
    marginTop: 18,
    marginBottom: 6,
    fontSize: 13,
    fontWeight: '700',
    color: '#999',
  },
  meaningRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 6,
    gap: 8,
  },
  posTag: {
    fontSize: 12,
    fontWeight: '700',
    color: '#ff8a34',
    backgroundColor: '#fff0e0',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  meaningText: {
    fontSize: 15,
    color: '#333',
    flex: 1,
  },
  exampleCard: {
    marginBottom: 12,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#fafafa',
  },
  exampleEn: {
    marginTop: 6,
    fontSize: 14,
    color: '#222',
    lineHeight: 20,
  },
  exampleKo: {
    marginTop: 4,
    fontSize: 13,
    color: '#888',
  },
  emptyText: {
    fontSize: 13,
    color: '#aaa',
  },
  statusText: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    paddingVertical: 24,
  },
  errorText: {
    fontSize: 14,
    color: '#c0392b',
    textAlign: 'center',
    paddingVertical: 24,
  },
  bottomSpacer: {
    height: 12,
  },
});
