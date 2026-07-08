/**
 * 발음 체크 장부 화면 (임무 지시 경로: `app/pronunciation/index.tsx`)
 *
 * 기획서(§단어장 앱 만들기.md L50) + 설계.md §6-10: 발음은 녹음이 아니라, 테스트
 * 채점 시 TTS를 들어보고 "발음 헷갈림"만 체크하는 장부 개념. test_item.pron_confused
 * 체크가 남은 단어를 headword/체크 횟수/최근 체크일로 모아 보여주고, 행마다 TTS로
 * 다시 들어볼 수 있게 한다.
 *
 * 해소(체크 해제) 처리: 설계.md·기획서 어디에도 이 장부에서의 리셋 액션이 규정돼
 * 있지 않다 — 기획서는 "채점 시 체크가 생성된다"는 것만 명시. 따라서 이번 구현은
 * 목록을 유지하는 누적 기록 뷰로만 구현했다 (해소 액션 없음). 자세한 판단 근거는
 * lib/statsQueries.ts의 getPronunciationConfusedWords 주석 참고, 완료 보고에도 명시.
 */

import * as Speech from 'expo-speech';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

import { epochDayToDateString, toEpochDay } from '../../lib/dates';
import { getPronunciationConfusedWords, type PronunciationConfusedWord } from '../../lib/statsQueries';

export default function PronunciationScreen() {
  const [words, setWords] = useState<PronunciationConfusedWord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    getPronunciationConfusedWords()
      .then(setWords)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    // 화면 이탈 시 재생 중인 TTS 정리 (CLAUDE.md 가드레일: 중복 재생 방지 패턴의 연장)
    return () => {
      Speech.stop();
    };
  }, []);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: '발음 체크 장부' }} />

      {error && <Text style={styles.error}>{error}</Text>}

      {!error && !words && <ActivityIndicator style={styles.loading} />}

      {!error && words && words.length === 0 && (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>발음이 헷갈렸던 단어가 없어요.</Text>
          <Text style={styles.emptySubText}>
            테스트 채점 중 &apos;발음 헷갈림&apos;을 체크하면 여기 쌓여요.
          </Text>
        </View>
      )}

      {!error && words && words.length > 0 && (
        <FlatList
          data={words}
          keyExtractor={(item) => String(item.content_word_id)}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => <PronunciationRow item={item} />}
        />
      )}
    </View>
  );
}

function PronunciationRowImpl({ item }: { item: PronunciationConfusedWord }) {
  const [speaking, setSpeaking] = useState(false);

  const handleSpeak = useCallback(() => {
    // CLAUDE.md 가드레일: 연속 탭 중복 재생 방지 — 항상 stop() 후 speak().
    Speech.stop();
    setSpeaking(true);
    Speech.speak(item.headword, {
      language: 'en-US',
      onDone: () => setSpeaking(false),
      onStopped: () => setSpeaking(false),
      onError: () => setSpeaking(false),
    });
  }, [item.headword]);

  const tapGesture = Gesture.Tap().onEnd(() => {
    // 제스처 콜백은 UI 스레드(worklet)에서 실행됨 — JS 함수는 runOnJS 경유 필수 (직접 호출 시 크래시)
    runOnJS(handleSpeak)();
  });

  return (
    <View style={styles.card}>
      <View style={styles.cardMain}>
        <Text style={styles.wordText}>{item.headword}</Text>
        <Text style={styles.metaText}>
          체크 {item.confused_count}회 · 최근 {formatCheckedDate(item.last_checked_ms)}
        </Text>
      </View>

      <GestureDetector gesture={tapGesture}>
        <View style={[styles.speakerButton, speaking && styles.speakerButtonActive]}>
          <Text style={styles.speakerIcon}>{speaking ? '🔊' : '🔈'}</Text>
        </View>
      </GestureDetector>
    </View>
  );
}
const PronunciationRow = PronunciationRowImpl;

/** taken_ms(epoch ms) → "YYYY-MM-DD" 표시 문자열. dates.ts 유틸을 경유(직접 Date 연산 금지). */
function formatCheckedDate(takenMs: number): string {
  return epochDayToDateString(toEpochDay(new Date(takenMs)));
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  loading: {
    marginTop: 40,
  },
  error: {
    margin: 24,
    color: '#c0392b',
    textAlign: 'center',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#444',
  },
  emptySubText: {
    marginTop: 8,
    fontSize: 13,
    color: '#999',
    textAlign: 'center',
  },
  listContent: {
    padding: 16,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f7f7f7',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  cardMain: {
    flex: 1,
  },
  wordText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#222',
  },
  metaText: {
    marginTop: 4,
    fontSize: 13,
    color: '#888',
  },
  speakerButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: '#fff',
    marginLeft: 12,
  },
  speakerButtonActive: {
    backgroundColor: '#eef6ff',
  },
  speakerIcon: {
    fontSize: 18,
  },
});
