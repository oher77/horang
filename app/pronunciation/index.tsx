/**
 * 발음 체크 장부 화면 (임무 지시 경로: `app/pronunciation/index.tsx`)
 *
 * 기획서(§단어장 앱 만들기.md L50) + 설계.md §6-10: 발음은 녹음이 아니라, 테스트
 * 채점 시 TTS를 들어보고 "발음 헷갈림"만 체크하는 장부 개념. test_item.pron_confused
 * 체크가 남은 단어를 headword/체크 횟수/최근 체크일로 모아 보여주고, 행마다 TTS로
 * 다시 들어볼 수 있게 한다.
 *
 * 해소 처리 (2026-07-09 확정, A안 + 재발 자동 복귀): 활성 행을 왼쪽으로 스와이프해
 * 나오는 "외워짐" 버튼으로 셀프 해소 → 하단 "외워짐" 섹션으로 이동. 외워짐 행을 같은
 * 방식으로 스와이프하면 "까먹음" 버튼으로 되돌린다. 이후 테스트에서 같은 단어에 다시
 * 헷갈림 체크가 생기면 자동으로 활성 목록에 복귀한다 (시각 비교 파생 —
 * lib/statsQueries.ts getPronunciationLedger 주석 참고).
 */

import * as Speech from 'expo-speech';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { runOnJS } from 'react-native-reanimated';

import { epochDayToDateString, toEpochDay } from '../../lib/dates';
import {
  getPronunciationLedger,
  resolvePronunciation,
  unresolvePronunciation,
  type PronunciationConfusedWord,
  type PronunciationLedger,
} from '../../lib/statsQueries';

type RowKind = 'active' | 'resolved';

interface LedgerSection {
  title: string;
  kind: RowKind;
  data: PronunciationConfusedWord[];
}

export default function PronunciationScreen() {
  const [ledger, setLedger] = useState<PronunciationLedger | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    getPronunciationLedger()
      .then(setLedger)
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

  const handleResolve = useCallback(
    (contentWordId: number) => {
      resolvePronunciation(contentWordId)
        .then(load)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [load],
  );

  const handleUndo = useCallback(
    (contentWordId: number) => {
      unresolvePronunciation(contentWordId)
        .then(load)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [load],
  );

  const sections = useMemo<LedgerSection[]>(() => {
    if (!ledger) return [];
    const result: LedgerSection[] = [];
    if (ledger.active.length > 0) {
      result.push({ title: `헷갈리는 단어 ${ledger.active.length}`, kind: 'active', data: ledger.active });
    }
    if (ledger.resolved.length > 0) {
      result.push({ title: `외워짐 ${ledger.resolved.length}`, kind: 'resolved', data: ledger.resolved });
    }
    return result;
  }, [ledger]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: '발음 체크 장부' }} />

      {error && <Text style={styles.error}>{error}</Text>}

      {!error && !ledger && <ActivityIndicator style={styles.loading} />}

      {!error && ledger && sections.length === 0 && (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>발음이 헷갈렸던 단어가 없어요.</Text>
          <Text style={styles.emptySubText}>
            테스트 채점 중 &apos;발음 헷갈림&apos;을 체크하면 여기 쌓여요.
          </Text>
        </View>
      )}

      {!error && ledger && sections.length > 0 && (
        <SectionList
          sections={sections}
          keyExtractor={(item) => String(item.content_word_id)}
          contentContainerStyle={styles.listContent}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionHeader}>{section.title}</Text>
          )}
          renderItem={({ item, section }) => (
            <PronunciationRow
              item={item}
              kind={(section as LedgerSection).kind}
              onResolve={handleResolve}
              onUndo={handleUndo}
            />
          )}
        />
      )}
    </View>
  );
}

function PronunciationRowImpl({
  item,
  kind,
  onResolve,
  onUndo,
}: {
  item: PronunciationConfusedWord;
  kind: RowKind;
  onResolve: (contentWordId: number) => void;
  onUndo: (contentWordId: number) => void;
}) {
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

  const isResolved = kind === 'resolved';
  const swipeRef = useRef<SwipeableMethods>(null);

  const handleSwipeAction = useCallback(() => {
    swipeRef.current?.close();
    if (isResolved) {
      onUndo(item.content_word_id);
    } else {
      onResolve(item.content_word_id);
    }
  }, [isResolved, item.content_word_id, onResolve, onUndo]);

  // 왼쪽 스와이프로 노출되는 액션 버튼: 활성 행 = "외워짐"(해소), 외워짐 행 = "까먹음"(되돌리기)
  const renderRightActions = useCallback(
    () => (
      <Pressable
        style={[styles.swipeAction, isResolved ? styles.swipeActionForgot : styles.swipeActionMemorized]}
        onPress={handleSwipeAction}
      >
        <Text style={styles.swipeActionText}>{isResolved ? '까먹음' : '외워짐'}</Text>
      </Pressable>
    ),
    [handleSwipeAction, isResolved],
  );

  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      renderRightActions={renderRightActions}
      friction={2}
      rightThreshold={36}
      overshootRight={false}
      containerStyle={styles.rowContainer}
    >
      <View style={[styles.card, isResolved && styles.cardResolved]}>
        <View style={styles.cardMain}>
          <Text style={[styles.wordText, isResolved && styles.wordTextResolved]}>{item.headword}</Text>
          <Text style={styles.metaText}>
            {isResolved && item.resolved_ms !== null
              ? `외워짐 ${formatCheckedDate(item.resolved_ms)} · 체크 ${item.confused_count}회`
              : `체크 ${item.confused_count}회 · 최근 ${formatCheckedDate(item.last_checked_ms)}`}
          </Text>
        </View>

        <GestureDetector gesture={tapGesture}>
          <View style={[styles.speakerButton, speaking && styles.speakerButtonActive]}>
            <Text style={styles.speakerIcon}>{speaking ? '🔊' : '🔈'}</Text>
          </View>
        </GestureDetector>
      </View>
    </ReanimatedSwipeable>
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
    paddingBottom: 32,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '700',
    color: '#888',
    marginTop: 8,
    marginBottom: 10,
  },
  rowContainer: {
    marginBottom: 12,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f7f7f7',
    borderRadius: 12,
    padding: 16,
  },
  cardResolved: {
    backgroundColor: '#fbfbfb',
  },
  swipeAction: {
    width: 88,
    marginLeft: 8,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swipeActionMemorized: {
    backgroundColor: '#2e7d32',
  },
  swipeActionForgot: {
    backgroundColor: '#ff9f43',
  },
  swipeActionText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
  },
  cardMain: {
    flex: 1,
  },
  wordText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#222',
  },
  wordTextResolved: {
    color: '#999',
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
