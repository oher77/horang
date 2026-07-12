/**
 * 테스트 화면 (단어장 앱 만들기.md "단어장 > 테스트 화면 구성" 그대로 재구현).
 *
 * 흐름(기획서 원문 그대로):
 * 1. grading: 2컬럼(문제/답) 테이블. 답은 학생이 TextInput에 직접 입력.
 *    출제 풀은 당일 학습 단어 + 복습 대상 Day 단어를 랜덤 순으로 섞은 것.
 * 2. "점수 메기기" 버튼 클릭 → graded로 전환. 정답 컬럼·발음확인(TTS) 컬럼·
 *    오답 체크 컬럼·발음 헷갈림 체크 컬럼이 생긴다. 버튼은 "점수 확인"으로 바뀐다.
 *    (오답/발음헷갈림 체크는 학생이 스스로 자기 답과 정답을 비교해서 누르는
 *    자기채점 — 자동 정답판정 로직 없음)
 * 3. "점수 확인" 클릭 → revealing으로 전환. 코끼리가 북 치는 애니메이션 3초.
 *    애니메이션 화면의 "취소" 버튼을 누르면 다시 graded(점수 메기기 화면)로 복귀.
 * 4. 애니메이션 종료 → 이 시점에 test_session/test_item을 user.db에 저장(income 연동
 *    포함) → result로 전환. 점수와 "나의 업적보기"/"다시 채점하기" 버튼을 보여준다.
 *    "다시 채점하기"는 graded로 되돌아가고, 그 상태에서 다시 "점수 확인"을 누르면
 *    같은 세션을 덮어써 갱신한다(세션 중복 생성 방지 — lib/reviewQueries.ts
 *    saveTestSession의 existingSessionId 인자, 완료 보고 참고).
 *
 * 자기채점 원칙과 income 연동(getIncomeForScore→income_amount 스냅샷)은
 * 기존 구현을 그대로 유지한다.
 */

import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import ScoreRevealAnimation from '../../components/test/ScoreRevealAnimation';
import TestRow, { ROW_MIN_HEIGHT } from '../../components/test/TestRow';
import { ensureTodayDay } from '../../lib/queries';
import {
  getTestPool,
  getTodayTestSession,
  saveTestSession,
  type TestQuestion,
  type TodayTestSession,
} from '../../lib/reviewQueries';

type LoadState = 'loading' | 'ready' | 'empty' | 'error' | 'done';
type Phase = 'grading' | 'graded' | 'revealing' | 'result';

interface GradeState {
  isWrong: boolean;
  pronConfused: boolean;
}

export default function TestScreen() {
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<TestQuestion[]>([]);
  const [phase, setPhase] = useState<Phase>('grading');
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [grades, setGrades] = useState<Record<number, GradeState>>({});
  const [result, setResult] = useState<{
    score100: number;
    correctCount: number;
    totalCount: number;
    incomeAmount: number;
  } | null>(null);
  // 오늘 이미 테스트를 봤을 때(진입 게이트) 완료 상태 UI에 표시할 세션 요약.
  const [todaySession, setTodaySession] = useState<TodayTestSession | null>(null);

  const dayIdRef = useRef<number | null>(null);
  const sessionIdRef = useRef<number | undefined>(undefined);

  // grading phase 답 입력칸 return 키 → 다음 칸 포커스 이동용 refs.
  // index 기준으로 캐싱해 매 렌더 새 함수를 만들지 않고(= TestRow의 memo 유지) 참조를 안정적으로 유지한다.
  const flatListRef = useRef<FlatList<TestQuestion>>(null);
  const inputRefsRef = useRef<Map<number, TextInput>>(new Map());
  const inputRefCallbacksRef = useRef<Map<number, (el: TextInput | null) => void>>(new Map());
  const submitHandlersRef = useRef<Map<number, () => void>>(new Map());
  const lastIndexRef = useRef(-1);
  const pendingFocusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    setState('loading');
    setError(null);
    setPhase('grading');
    setAnswers({});
    setGrades({});
    setResult(null);
    setTodaySession(null);
    sessionIdRef.current = undefined;

    (async () => {
      try {
        // 진입 게이트: 오늘(taken_day 기준) 이미 테스트를 봤으면 출제 풀 조회 자체를
        // 하지 않고 완료 상태로 전환한다 (2026-07-12 사용자 확정, 재채점은 별개 허용).
        const session = await getTodayTestSession();
        if (session) {
          setTodaySession(session);
          setState('done');
          return;
        }

        const day = await ensureTodayDay();
        dayIdRef.current = day.id;
        const pool = await getTestPool(day.id);
        setQuestions(pool);
        setState(pool.length === 0 ? 'empty' : 'ready');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setState('error');
      }
    })();
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    lastIndexRef.current = questions.length - 1;
  }, [questions.length]);

  useEffect(() => {
    return () => {
      if (pendingFocusTimeoutRef.current) {
        clearTimeout(pendingFocusTimeoutRef.current);
      }
    };
  }, []);

  // 지정한 index의 답 입력칸에 포커스. windowSize=5 덕에 인접 행은 거의 항상
  // 마운트돼 있어 ref가 바로 잡히지만, 드물게 미마운트인 경우 scrollToIndex로
  // 화면에 올린 뒤 짧은 지연 후 다시 시도하는 폴백을 둔다.
  const focusInputAt = useCallback((index: number) => {
    const existing = inputRefsRef.current.get(index);
    if (existing) {
      existing.focus();
      return;
    }

    flatListRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.5 });

    if (pendingFocusTimeoutRef.current) {
      clearTimeout(pendingFocusTimeoutRef.current);
    }
    pendingFocusTimeoutRef.current = setTimeout(() => {
      pendingFocusTimeoutRef.current = null;
      inputRefsRef.current.get(index)?.focus();
    }, 120);
  }, []);

  // return 키 제출 시: 마지막 문제가 아니면 다음 칸으로 포커스 이동, 마지막이면
  // 아무것도 하지 않고 TextInput 기본 동작(blurAndSubmit)에 맡겨 키보드가 내려가게 둔다.
  const handleSubmitEditingAt = useCallback(
    (index: number) => {
      if (index >= lastIndexRef.current) {
        return;
      }
      focusInputAt(index + 1);
    },
    [focusInputAt],
  );

  // index별로 onSubmitEditing 핸들러를 캐싱해 renderItem이 다시 호출돼도
  // 같은 index에는 항상 동일한 함수 참조를 반환한다(TestRow memo 무력화 방지).
  const getSubmitHandler = useCallback(
    (index: number) => {
      let handler = submitHandlersRef.current.get(index);
      if (!handler) {
        handler = () => handleSubmitEditingAt(index);
        submitHandlersRef.current.set(index, handler);
      }
      return handler;
    },
    [handleSubmitEditingAt],
  );

  // index별 TextInput ref 콜백도 동일하게 캐싱한다.
  const registerInputRef = useCallback((index: number) => {
    let cb = inputRefCallbacksRef.current.get(index);
    if (!cb) {
      cb = (el: TextInput | null) => {
        if (el) {
          inputRefsRef.current.set(index, el);
        } else {
          inputRefsRef.current.delete(index);
        }
      };
      inputRefCallbacksRef.current.set(index, cb);
    }
    return cb;
  }, []);

  const handleChangeAnswer = useCallback((wordId: number, text: string) => {
    setAnswers((prev) => ({ ...prev, [wordId]: text }));
  }, []);

  const handleToggleWrong = useCallback((wordId: number) => {
    setGrades((prev) => ({
      ...prev,
      [wordId]: {
        isWrong: !prev[wordId]?.isWrong,
        pronConfused: prev[wordId]?.pronConfused ?? false,
      },
    }));
  }, []);

  const handleTogglePronConfused = useCallback((wordId: number) => {
    setGrades((prev) => ({
      ...prev,
      [wordId]: {
        isWrong: prev[wordId]?.isWrong ?? false,
        pronConfused: !prev[wordId]?.pronConfused,
      },
    }));
  }, []);

  // "점수 메기기" → 정답/발음확인/오답/발음헷갈림 컬럼 노출
  const handleStartGrading = useCallback(() => {
    setPhase('graded');
  }, []);

  // "점수 확인" → 코끼리 애니메이션
  const handleRevealScore = useCallback(() => {
    setPhase('revealing');
  }, []);

  // 애니메이션 중 "취소" → 점수 메기기 화면(graded)으로 복귀
  const handleCancelReveal = useCallback(() => {
    setPhase('graded');
  }, []);

  // 애니메이션 3초 종료 → 세션 저장 후 점수 확인 화면(result)
  const handleAnimationComplete = useCallback(async () => {
    const dayId = dayIdRef.current;
    if (dayId == null) return;

    // 이중 방어: 새 세션(재채점이 아닌 최초 제출)일 때만, INSERT 직전에 한 번 더
    // 오늘 세션 존재 여부를 확인한다. 자정 경계(테스트 시작 후 자정을 넘겨 제출)나
    // 이중 탭으로 같은 화면 인스턴스에서 두 번 제출되는 경우를 막기 위함.
    // sessionIdRef == null 조건이 핵심: 이게 없으면 재채점 재제출 때 방금 만든 자기
    // 세션을 "이미 있음"으로 오인해 정상 재채점을 막는다 (재채점 경로는 게이트 대상 아님).
    if (sessionIdRef.current == null) {
      const session = await getTodayTestSession();
      if (session) {
        setTodaySession(session);
        setState('done');
        setPhase('grading');
        return;
      }
    }

    const results = questions.map((q) => ({
      content_word_id: q.content_word_id,
      is_wrong: grades[q.content_word_id]?.isWrong ?? false,
      pron_confused: grades[q.content_word_id]?.pronConfused ?? false,
    }));

    const saved = await saveTestSession(dayId, results, sessionIdRef.current);
    sessionIdRef.current = saved.sessionId;

    setResult({
      score100: saved.score100,
      correctCount: saved.correctCount,
      totalCount: saved.totalCount,
      incomeAmount: saved.incomeAmount,
    });
    setPhase('result');
  }, [questions, grades]);

  // "다시 메기기" → 점수 메기기 화면(graded)으로 복귀. 체크 상태는 유지해 이어서 조정 가능.
  const handleRegrade = useCallback(() => {
    setPhase('graded');
  }, []);

  const handleGoAchievements = useCallback(() => {
    router.push('/achievements');
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: TestQuestion; index: number }) => {
      const wordId = item.content_word_id;
      const isLast = index === questions.length - 1;
      return (
        <TestRow
          ref={registerInputRef(index)}
          index={index}
          question={item}
          graded={phase !== 'grading'}
          userAnswer={answers[wordId] ?? ''}
          isWrong={grades[wordId]?.isWrong ?? false}
          pronConfused={grades[wordId]?.pronConfused ?? false}
          onChangeAnswer={(text) => handleChangeAnswer(wordId, text)}
          onToggleWrong={() => handleToggleWrong(wordId)}
          onTogglePronConfused={() => handleTogglePronConfused(wordId)}
          returnKeyType={isLast ? 'done' : 'next'}
          submitBehavior={isLast ? undefined : 'submit'}
          onSubmitEditing={getSubmitHandler(index)}
        />
      );
    },
    [
      phase,
      answers,
      grades,
      questions.length,
      handleChangeAnswer,
      handleToggleWrong,
      handleTogglePronConfused,
      registerInputRef,
      getSubmitHandler,
    ],
  );

  const keyExtractor = useCallback((item: TestQuestion) => String(item.content_word_id), []);

  const getItemLayout = useCallback(
    (_: unknown, index: number) => ({
      length: ROW_MIN_HEIGHT,
      offset: ROW_MIN_HEIGHT * index,
      index,
    }),
    [],
  );

  const headerLabel = useMemo(() => (phase === 'grading' ? '문제 / 답' : '문제 / 채점'), [phase]);

  if (phase === 'revealing') {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: '테스트', headerBackVisible: false }} />
        <ScoreRevealAnimation onComplete={handleAnimationComplete} onCancel={handleCancelReveal} />
      </View>
    );
  }

  if (phase === 'result' && result) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: '테스트 결과', headerBackVisible: false }} />
        <View style={styles.resultContainer}>
          <View style={styles.scoreCard}>
            <Text style={styles.scoreLabel}>이번 테스트 점수</Text>
            <Text style={styles.scoreValue}>{result.score100}점</Text>
            <Text style={styles.scoreDetail}>
              {result.totalCount}문제 중 {result.correctCount}개 정답
            </Text>
            <View style={styles.incomeBadge}>
              <Text style={styles.incomeBadgeText}>+{result.incomeAmount.toLocaleString()}원 적립</Text>
            </View>
          </View>

          <View style={styles.resultButtonRow}>
            <Pressable style={[styles.resultButton, styles.regradeButton]} onPress={handleRegrade}>
              <Text style={styles.regradeButtonText}>다시 채점하기</Text>
            </Pressable>
            <Pressable style={[styles.resultButton, styles.achievementsButton]} onPress={handleGoAchievements}>
              <Text style={styles.achievementsButtonText}>나의 업적보기</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

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

      {state === 'done' && (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {todaySession?.score100 != null
              ? `오늘 테스트는 완료했어요! ${todaySession.score100}점`
              : '오늘 테스트는 완료했어요!'}
          </Text>
          <Text style={styles.emptySubText}>내일 다시 도전해 보세요!</Text>
        </View>
      )}

      {state === 'ready' && questions.length > 0 && (
        <>
          <View style={styles.tableHeaderRow}>
            <View style={styles.headerNumberCell} />
            <Text style={[styles.headerText, styles.headerPromptCell]}>문제</Text>
            {phase === 'grading' && <Text style={[styles.headerText, styles.headerFlexCell]}>답</Text>}
            {phase !== 'grading' && (
              <>
                <Text style={[styles.headerText, styles.headerFlexCell]}>내 답</Text>
                <Text style={[styles.headerText, styles.headerFlexCell]}>정답</Text>
                <Text style={[styles.headerText, styles.headerSmallCell]}>발음</Text>
                <Text style={[styles.headerText, styles.headerSmallCell]}>오답</Text>
                <Text style={[styles.headerText, styles.headerSmallCell]}>헷갈림</Text>
              </>
            )}
          </View>
          <Text style={styles.tableSubHeader}>{headerLabel} · 총 {questions.length}문제</Text>

          {/*
            §4.5 100+행 가상화 전략 준용: RN 내장 FlatList + getItemLayout으로
            보이는 15~20행만 렌더. 채점 컬럼이 늘어도 행높이는 ROW_MIN_HEIGHT로 고정.
          */}
          <FlatList
            ref={flatListRef}
            data={questions}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            getItemLayout={getItemLayout}
            initialNumToRender={18}
            windowSize={5}
            maxToRenderPerBatch={8}
            removeClippedSubviews
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
          />

          <View style={styles.footer}>
            {phase === 'grading' && (
              <Pressable style={styles.footerButton} onPress={handleStartGrading}>
                <Text style={styles.footerButtonText}>점수 메기기</Text>
              </Pressable>
            )}
            {phase === 'graded' && (
              <Pressable style={styles.footerButton} onPress={handleRevealScore}>
                <Text style={styles.footerButtonText}>점수 확인</Text>
              </Pressable>
            )}
          </View>
        </>
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
  tableHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    backgroundColor: '#f5f5f5',
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
  },
  headerNumberCell: {
    width: 24,
  },
  headerText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#666',
  },
  headerPromptCell: {
    width: 110,
  },
  headerFlexCell: {
    flex: 1,
  },
  headerSmallCell: {
    width: 36,
    textAlign: 'center',
  },
  tableSubHeader: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 11,
    color: '#aaa',
  },
  footer: {
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#eee',
  },
  footerButton: {
    backgroundColor: '#222',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  footerButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  resultContainer: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
  },
  scoreCard: {
    alignItems: 'center',
    backgroundColor: '#fff1e6',
    borderRadius: 16,
    padding: 24,
  },
  scoreLabel: {
    fontSize: 14,
    color: '#888',
  },
  scoreValue: {
    marginTop: 8,
    fontSize: 40,
    fontWeight: '800',
    color: '#ff8a34',
  },
  scoreDetail: {
    marginTop: 6,
    fontSize: 14,
    color: '#666',
  },
  incomeBadge: {
    marginTop: 14,
    backgroundColor: '#ffe0b2',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  incomeBadgeText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#b45309',
  },
  resultButtonRow: {
    marginTop: 32,
    flexDirection: 'row',
    gap: 12,
  },
  resultButton: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  regradeButton: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
  },
  regradeButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#444',
  },
  achievementsButton: {
    backgroundColor: '#222',
  },
  achievementsButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },
});
