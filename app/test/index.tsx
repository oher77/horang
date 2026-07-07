/**
 * 테스트 화면 (설계.md §4.2 `test.tsx`, §4.4, §5 Q-TEST-POOL)
 *
 * 출제 풀: 당일 Day + 복습 대상 Day(-1/-3/-7/-14/-30/-60/-120일)의 단어를 합쳐 랜덤 셔플.
 * 혼합 출제: writing_item이 있는 단어 중 30%는 쓰기 문제, 나머지는 단어→뜻/뜻→단어를
 * 50:50으로 섞는다 (lib/reviewQueries.ts의 WRITING_RATIO — 설계.md §6-9 "비율은 구현 시
 * 기본값을 정해 사용자 확인"에 대한 기본값).
 *
 * 자기채점: 문제를 보고 학생이 스스로 답을 떠올린 뒤 "정답 보기" → "맞음/틀림" +
 * "발음 헷갈림" 체크. 녹음 없음. 채점 결과는 세션 종료 시 한 번에 user.db에 저장한다.
 */

import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { SelfGradeAnswer, TestQuestionCard } from '../../components/test/TestQuestionCard';
import { ensureTodayDay } from '../../lib/queries';
import { getTestPool, saveTestSession, type TestItemResult, type TestQuestion } from '../../lib/reviewQueries';

type LoadState = 'loading' | 'ready' | 'empty' | 'error';

export default function TestScreen() {
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<TestQuestion[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const dayIdRef = useRef<number | null>(null);
  const resultsRef = useRef<TestItemResult[]>([]);

  const load = useCallback(() => {
    setState('loading');
    setError(null);
    setCurrentIndex(0);
    resultsRef.current = [];

    ensureTodayDay()
      .then(async (day) => {
        dayIdRef.current = day.id;
        const pool = await getTestPool(day.id);
        setQuestions(pool);
        setState(pool.length === 0 ? 'empty' : 'ready');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setState('error');
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSubmit = useCallback(
    async (answer: SelfGradeAnswer) => {
      const question = questions[currentIndex];
      resultsRef.current.push({
        content_word_id: question.content_word_id,
        is_wrong: answer.is_wrong,
        pron_confused: answer.pron_confused,
      });

      if (currentIndex + 1 < questions.length) {
        setCurrentIndex((i) => i + 1);
        return;
      }

      // 마지막 문항 → 세션 저장 후 결과 화면으로 이동
      const dayId = dayIdRef.current;
      if (dayId == null) return;

      const saved = await saveTestSession(dayId, resultsRef.current);
      const wrongWords = questions.filter((_, idx) => resultsRef.current[idx]?.is_wrong);

      router.replace({
        pathname: '/test/result',
        params: {
          sessionId: String(saved.sessionId),
          score100: String(saved.score100),
          correctCount: String(saved.correctCount),
          totalCount: String(saved.totalCount),
          incomeAmount: String(saved.incomeAmount),
          wrongWords: JSON.stringify(wrongWords.map((w) => w.headword)),
        },
      });
    },
    [currentIndex, questions],
  );

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: '테스트' }} />

      {state === 'loading' && <ActivityIndicator style={styles.loading} />}

      {state === 'error' && <Text style={styles.error}>{error}</Text>}

      {state === 'empty' && (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>출제할 단어가 없어요.</Text>
          <Text style={styles.emptySubText}>오늘의 단어장을 먼저 학습해 보세요.</Text>
        </View>
      )}

      {state === 'ready' && questions.length > 0 && (
        <TestQuestionCard
          key={currentIndex}
          question={questions[currentIndex]}
          index={currentIndex}
          total={questions.length}
          onSubmit={handleSubmit}
        />
      )}
    </View>
  );
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
});
