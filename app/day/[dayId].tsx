import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { AppStateStatus, ViewToken } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import DayWordRow, { ROW_HEIGHT } from '../../components/DayWordRow';
import WordDetailSheet from '../../components/WordDetailSheet';
import {
  currentSlotIndex,
  DEFAULT_HABIT_BONUS,
  getTodaySlots,
  isFirstSessionOfToday,
  isTodayDay,
  recordRetrievalSession,
} from '../../lib/habitQueries';
import {
  getDayIndex,
  getDayWords,
  markDayStarted,
  type DayWordRow as DayWordRowData,
} from '../../lib/queries';
import { useSettingsStore } from '../../lib/settings';
import { adjustRecallStage } from '../../lib/study';
import { getWordDetail, type WordDetail } from '../../lib/wordDetail';

// stagger: 컬럼 일괄 가림 시 "현재 화면에 보이는 행"에만 index*STAGGER_MS 지연 적용
// (설계.md §4.5). 화면 밖 행은 FlatList가 언마운트하므로 자연히 대상에서 빠진다.
const STAGGER_MS = 15;
const PEEK_DURATION_MS = 1400;

// 하루 4회 분산 인출 습관 시스템 — 세션 트래킹 상수 (설계.md §7.1, §7.3)
const MIN_DWELL_MS = 150_000; // 최소 체류 150초(모든 세션 공통)
const COVERAGE_RATIO = 0.7; // 첫 세션에만 적용되는 커버리지 임계
const BANNER_DURATION_MS = 2000; // 완료 피드백 배너 표시 시간

type ColumnKey = 'word' | 'meaning';

export default function DayScreen() {
  const { dayId, dayIndex: dayIndexParam } = useLocalSearchParams<{
    dayId: string;
    dayIndex?: string;
  }>();
  const [words, setWords] = useState<DayWordRowData[] | null>(null);
  // 호출측(홈/복습)이 이미 아는 Day 번호를 param으로 넘겨주면 첫 프레임부터 제 타이틀로
  // 시작한다 (DB 조회 대기 중 대체 타이틀이 깜빡이는 것 방지). param 없이 열린 경우만
  // DB에서 조회.
  const [dayIndex, setDayIndex] = useState<number | null>(() => {
    const n = Number(dayIndexParam);
    return Number.isFinite(n) && n > 0 ? n : null;
  });
  const [error, setError] = useState<string | null>(null);
  const { level } = useSettingsStore();
  const insets = useSafeAreaInsets();

  // 예문 바텀시트 상태 (사용자 확정 UX: 가려지지 않은 행 탭 → 상세 시트)
  const [sheetVisible, setSheetVisible] = useState(false);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sheetDetail, setSheetDetail] = useState<WordDetail | null>(null);

  // 컬럼 전체 가림 토글 (헤더 눈아이콘). 화면 로컬 UI 상태 — DB 미저장(설계.md §4.5).
  const [columnHidden, setColumnHidden] = useState<Record<ColumnKey, boolean>>({
    word: false,
    meaning: false,
  });

  // 개별 셀 "잠깐 보이기" — dayWordId별로 컬럼 peek 타이머 관리
  const [peekMap, setPeekMap] = useState<Record<number, Partial<Record<ColumnKey, boolean>>>>({});
  const peekTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // 현재 화면에 보이는 행의 인덱스 집합 → stagger 지연 계산 기준(설계.md §4.5)
  const [visibleIndexes, setVisibleIndexes] = useState<number[]>([]);
  const minVisibleIndexRef = useRef(0);

  // --- 하루 4회 분산 인출 습관 시스템 — 세션 트래킹 (설계.md §7.1, §7.3) ---
  // 트래킹 적용 여부: 오늘 Day가 아니거나 진입 시점이 데드존(슬롯 없음)이면 비활성.
  const [trackingEnabled, setTrackingEnabled] = useState(false);
  const [isFirstSession, setIsFirstSession] = useState(false);
  const [wordsRequiredForCoverage, setWordsRequiredForCoverage] = useState(0);
  const coveredWordIdsRef = useRef<Set<number>>(new Set());
  const [coveredCount, setCoveredCount] = useState(0);
  const [sessionRecorded, setSessionRecorded] = useState(false);
  // 첫 세션 진행 표시("이번 인출 X/N")와 달리 이후 세션은 남은 체류 시간(초)을 보여준다.
  const [dwellRemainingSec, setDwellRemainingSec] = useState<number | null>(null);
  const [completionBanner, setCompletionBanner] = useState<string | null>(null);

  // 체류 타이머 상태 — "남은 시간만큼 setTimeout + 일시정지 시 잔여시간 보존" 방식.
  const dwellRemainingMsRef = useRef(MIN_DWELL_MS);
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dwellIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dwellRunningSinceRef = useRef<number | null>(null); // 현재 구간 시작 epoch ms (null = 정지 중)
  const dwellSatisfiedRef = useRef(false);
  const screenFocusedRef = useRef(true);
  const appActiveRef = useRef(AppState.currentState === 'active');

  useEffect(() => {
    const id = Number(dayId);
    if (!Number.isFinite(id)) {
      setError('잘못된 단어장 id입니다.');
      return;
    }
    getDayWords(id)
      .then(setWords)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    // 단어장을 연 순간 "시작됨" 기록 — 이후 하루 단어 수 설정을 바꿔도 이 Day는 유지됨
    markDayStarted(id).catch(() => {});
    if (dayIndex === null) {
      getDayIndex(id)
        .then(setDayIndex)
        .catch(() => {
          // 타이틀 표시용이라 실패해도 화면 동작에는 지장 없음 — 기본 타이틀 유지
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayId]);

  // 세션 트래킹 초기화 — 오늘 Day + 데드존 아님(currentSlotIndex != null) 확인 후에만 활성화.
  // words가 로드돼야 커버리지 임계(ceil(N*0.7))를 계산할 수 있으므로 words 로드와 별도 effect.
  useEffect(() => {
    const id = Number(dayId);
    if (!Number.isFinite(id) || !words) return;

    let cancelled = false;
    Promise.all([isTodayDay(id), isFirstSessionOfToday(), currentSlotIndex(), getTodaySlots()]).then(
      ([todayDay, firstSession, slotIndex, todaySlots]) => {
        if (cancelled) return;
        if (!todayDay || slotIndex === null) {
          // 오늘 Day가 아니거나 데드존 — 트래킹도 인디케이터도 시작하지 않는다.
          return;
        }
        setIsFirstSession(firstSession);
        setWordsRequiredForCoverage(Math.ceil(words.length * COVERAGE_RATIO));
        if (todaySlots[slotIndex]) {
          // 현재 슬롯이 이미 확정됨 — 판정 시도 없이 인디케이터도 숨긴다(recordRetrievalSession의
          // INSERT OR IGNORE도 결국 무시하지만, 헛되이 타이머를 돌릴 필요가 없어 미리 잠근다).
          setSessionRecorded(true);
        }
        setTrackingEnabled(true);
      },
    );

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayId, words]);

  useEffect(() => {
    return () => {
      // 화면 이탈 시 pending peek 타이머 정리
      peekTimers.current.forEach((t) => clearTimeout(t));
      peekTimers.current.clear();
    };
  }, []);

  // dayId를 숫자로 안전 변환 (recordRetrievalSession 호출용). 트래킹 로직 전반에서 재사용.
  const dayIdNum = Number(dayId);

  // 조건 충족 시 recordRetrievalSession() 호출 — 순서: isTodayDay/currentSlotIndex 등
  // 슬롯 귀속 판단은 lib/habitQueries.ts 내부가 전담하므로 여기서는 호출만 한다.
  const tryFinalizeSession = useCallback(() => {
    if (!trackingEnabled || sessionRecorded) return;
    if (!dwellSatisfiedRef.current) return;
    if (isFirstSession && coveredWordIdsRef.current.size < wordsRequiredForCoverage) return;
    if (!Number.isFinite(dayIdNum)) return;

    // 조건 충족 순간 즉시 잠가 중복 호출 방지 (DB round-trip 중 재진입 방지)
    setSessionRecorded(true);

    recordRetrievalSession(dayIdNum)
      .then((result) => {
        if (!result.recorded) {
          // 이미 이 슬롯이 찬 상태 등 — 조용히 무시(스펙: recorded=false면 피드백 없음)
          return;
        }
        let message = '이번 슬롯 인출 완료 ●';
        if (result.fullDayBonusPaid && result.streakBonusPaid) {
          message = `오늘 4회 완주! +${DEFAULT_HABIT_BONUS.fullDay}원, ${result.streakDays}일 연속 +${DEFAULT_HABIT_BONUS.streak7}원`;
        } else if (result.fullDayBonusPaid) {
          message = `오늘 4회 완주! +${DEFAULT_HABIT_BONUS.fullDay}원`;
        }
        setCompletionBanner(message);
        setTimeout(() => setCompletionBanner(null), BANNER_DURATION_MS);
      })
      .catch(() => {
        // 습관 트래킹은 부가 기능 — 실패해도 학습 흐름을 막지 않는다.
      });
  }, [trackingEnabled, sessionRecorded, isFirstSession, wordsRequiredForCoverage, dayIdNum]);

  const tryFinalizeRef = useRef(tryFinalizeSession);
  tryFinalizeRef.current = tryFinalizeSession;

  // 체류 타이머 일시정지 — 남은 시간을 dwellRemainingMsRef에 보존.
  const pauseDwellTimer = useCallback(() => {
    if (dwellTimerRef.current) {
      clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
    if (dwellIntervalRef.current) {
      clearInterval(dwellIntervalRef.current);
      dwellIntervalRef.current = null;
    }
    if (dwellRunningSinceRef.current !== null) {
      const elapsed = Date.now() - dwellRunningSinceRef.current;
      dwellRemainingMsRef.current = Math.max(0, dwellRemainingMsRef.current - elapsed);
      dwellRunningSinceRef.current = null;
    }
  }, []);

  // 체류 타이머 재개 — 잔여시간만큼 setTimeout을 새로 건다. 화면 focus AND 앱 active일 때만 호출.
  const resumeDwellTimer = useCallback(() => {
    if (!trackingEnabled || sessionRecorded || dwellSatisfiedRef.current) return;
    if (dwellRunningSinceRef.current !== null) return; // 이미 실행 중
    if (dwellRemainingMsRef.current <= 0) return;

    dwellRunningSinceRef.current = Date.now();
    dwellTimerRef.current = setTimeout(() => {
      dwellRemainingMsRef.current = 0;
      dwellRunningSinceRef.current = null;
      dwellSatisfiedRef.current = true;
      setDwellRemainingSec(0);
      tryFinalizeRef.current();
    }, dwellRemainingMsRef.current);

    // 인디케이터 갱신용 1초 간격 tick (이후 세션의 "남은 시간 mm:ss" 표시)
    dwellIntervalRef.current = setInterval(() => {
      if (dwellRunningSinceRef.current === null) return;
      const elapsed = Date.now() - dwellRunningSinceRef.current;
      const remaining = Math.max(0, dwellRemainingMsRef.current - elapsed);
      setDwellRemainingSec(Math.ceil(remaining / 1000));
    }, 1000);
  }, [trackingEnabled, sessionRecorded]);

  // trackingEnabled가 켜지는 순간 타이머 시작 (화면 focus + 앱 active 전제)
  useEffect(() => {
    if (!trackingEnabled) return;
    setDwellRemainingSec(Math.ceil(dwellRemainingMsRef.current / 1000));
    if (screenFocusedRef.current && appActiveRef.current) {
      resumeDwellTimer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackingEnabled]);

  // AppState: background/inactive 시 일시정지, active 복귀 시 재개
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      const wasActive = appActiveRef.current;
      const isActive = nextState === 'active';
      appActiveRef.current = isActive;
      if (wasActive && !isActive) {
        pauseDwellTimer();
      } else if (!wasActive && isActive && screenFocusedRef.current) {
        resumeDwellTimer();
      }
    };
    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => sub.remove();
  }, [pauseDwellTimer, resumeDwellTimer]);

  // 화면 blur/focus (expo-router) — 다른 화면으로 이동 시 일시정지, 복귀 시 재개
  useFocusEffect(
    useCallback(() => {
      screenFocusedRef.current = true;
      if (appActiveRef.current) {
        resumeDwellTimer();
      }
      return () => {
        screenFocusedRef.current = false;
        pauseDwellTimer();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pauseDwellTimer, resumeDwellTimer]),
  );

  // 화면 완전 이탈 시 타이머 정리 (cleanup 누락 방지)
  useEffect(() => {
    return () => {
      if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current);
      if (dwellIntervalRef.current) clearInterval(dwellIntervalRef.current);
    };
  }, []);

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const indexes = viewableItems
      .map((v) => v.index)
      .filter((i): i is number => i !== null && i !== undefined);
    setVisibleIndexes(indexes);
    if (indexes.length > 0) {
      minVisibleIndexRef.current = Math.min(...indexes);
    }
  }).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 30 }).current;

  const toggleColumn = useCallback((column: ColumnKey) => {
    setColumnHidden((prev) => ({ ...prev, [column]: !prev[column] }));
  }, []);

  // day_word.id(dayWordId) → content_word_id 조회용 (커버리지 Set은 content_word_id 기준, §7.1)
  const contentWordIdByDayWordId = useMemo(() => {
    const map = new Map<number, number>();
    words?.forEach((w) => map.set(w.id, w.content_word_id));
    return map;
  }, [words]);

  const handleTapCell = useCallback((dayWordId: number, column: ColumnKey) => {
    // 커버리지 계상: 가려진 셀의 peek 탭만 (헤더 일괄 해제·예문 바텀시트는 별도 경로라 여기 안 들어옴)
    if (trackingEnabled && !sessionRecorded) {
      const contentWordId = contentWordIdByDayWordId.get(dayWordId);
      if (contentWordId !== undefined && !coveredWordIdsRef.current.has(contentWordId)) {
        coveredWordIdsRef.current.add(contentWordId);
        setCoveredCount(coveredWordIdsRef.current.size);
        tryFinalizeRef.current();
      }
    }

    const key = `${dayWordId}:${column}`;
    const existingTimer = peekTimers.current.get(key);
    if (existingTimer) clearTimeout(existingTimer);

    setPeekMap((prev) => ({
      ...prev,
      [dayWordId]: { ...prev[dayWordId], [column]: true },
    }));

    const timer = setTimeout(() => {
      setPeekMap((prev) => {
        const next = { ...prev[dayWordId] };
        delete next[column];
        return { ...prev, [dayWordId]: next };
      });
      peekTimers.current.delete(key);
    }, PEEK_DURATION_MS);
    peekTimers.current.set(key, timer);
  }, [trackingEnabled, sessionRecorded, contentWordIdByDayWordId]);

  const handleSwipeStage = useCallback((dayWordId: number, delta: number) => {
    // 낙관적 갱신 + user.db 영속 (설계.md §5: recall_stage = MAX(0,MIN(5, ...)))
    setWords((prev) =>
      prev
        ? prev.map((w) =>
            w.id === dayWordId
              ? { ...w, recall_stage: Math.max(0, Math.min(5, w.recall_stage + delta)) }
              : w,
          )
        : prev,
    );
    adjustRecallStage(dayWordId, delta).catch(() => {
      // 실패 시에도 화면 크래시는 막는다. 재조회로 정합성 복구를 원하면 추후 재조회 추가 가능.
    });
  }, []);

  const minVisibleIndex = visibleIndexes.length > 0 ? Math.min(...visibleIndexes) : minVisibleIndexRef.current;

  const handleOpenDetail = useCallback(
    (contentWordId: number) => {
      setSheetVisible(true);
      setSheetLoading(true);
      setSheetError(null);
      setSheetDetail(null);
      getWordDetail(contentWordId, level)
        .then((detail) => setSheetDetail(detail))
        .catch((err: unknown) => setSheetError(err instanceof Error ? err.message : String(err)))
        .finally(() => setSheetLoading(false));
    },
    [level],
  );

  const handleCloseSheet = useCallback(() => {
    setSheetVisible(false);
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: DayWordRowData; index: number }) => {
      const peek = peekMap[item.id];
      const staggerDelay = Math.max(0, index - minVisibleIndex) * STAGGER_MS;
      return (
        <DayWordRow
          item={item}
          index={index}
          isAlt={index % 2 === 1}
          wordHidden={columnHidden.word}
          meaningHidden={columnHidden.meaning}
          peekWord={Boolean(peek?.word)}
          peekMeaning={Boolean(peek?.meaning)}
          columnHideDelayMs={staggerDelay}
          onSwipeStage={handleSwipeStage}
          onTapCell={handleTapCell}
          onOpenDetail={handleOpenDetail}
        />
      );
    },
    [peekMap, columnHidden, minVisibleIndex, handleSwipeStage, handleTapCell, handleOpenDetail],
  );

  const keyExtractor = useCallback((item: DayWordRowData) => String(item.id), []);

  const getItemLayout = useCallback(
    (_: unknown, index: number) => ({
      length: ROW_HEIGHT,
      offset: ROW_HEIGHT * index,
      index,
    }),
    [],
  );

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: dayIndex !== null ? `Day${dayIndex}` : '단어장' }} />

      {error && <Text style={styles.error}>{error}</Text>}

      {!error && !words && <ActivityIndicator style={styles.loading} />}

      {trackingEnabled && !sessionRecorded && (
        <RetrievalProgressIndicator
          isFirstSession={isFirstSession}
          coveredCount={coveredCount}
          requiredCount={wordsRequiredForCoverage}
          dwellRemainingSec={dwellRemainingSec}
        />
      )}

      {completionBanner && (
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(300)}
          style={[styles.completionBanner, { top: insets.top + 8 }]}
        >
          <Text style={styles.completionBannerText}>{completionBanner}</Text>
        </Animated.View>
      )}

      {!error && words && (
        <>
          <View style={[styles.row, styles.headerRow]}>
            <View style={styles.stageCell} />
            <Text style={styles.numberCell}>#</Text>
            <HeaderEyeCell
              label="영단어"
              hidden={columnHidden.word}
              onToggle={() => toggleColumn('word')}
              style={styles.wordCell}
            />
            <View style={styles.speakerButton} />
            <HeaderEyeCell
              label="뜻"
              hidden={columnHidden.meaning}
              onToggle={() => toggleColumn('meaning')}
              style={styles.meaningCell}
            />
          </View>

          {/*
            §4.5 100+행 테이블 가상화 전략: RN 내장 FlatList (FlashList는 Expo Go
            미포함이라 금지). initialNumToRender/windowSize로 보이는 15~20행만 렌더.
            onViewableItemsChanged로 가시 행 인덱스를 추적해 stagger 지연 계산에 쓴다.
          */}
          <FlatList
            data={words}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            getItemLayout={getItemLayout}
            // 마지막 행이 홈 인디케이터에 붙으면 스와이프가 시스템 제스처와 겹쳐 어려움 —
            // 하단 여백으로 끝까지 스크롤 시 마지막 행이 한 행 높이만큼 떠 있게 한다.
            // (하단 padding은 getItemLayout offset 계산에 영향 없음)
            contentContainerStyle={{ paddingBottom: insets.bottom + ROW_HEIGHT }}
            initialNumToRender={18}
            windowSize={5}
            maxToRenderPerBatch={8}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
          />
        </>
      )}

      <WordDetailSheet
        visible={sheetVisible}
        loading={sheetLoading}
        error={sheetError}
        detail={sheetDetail}
        onClose={handleCloseSheet}
      />
    </View>
  );
}

// 인출 세션 진행 인디케이터 — 버튼 아님, 조용한 상단 표시(설계.md §7.1, §7.3).
// 첫 세션: 커버리지 진행 "이번 인출 X/N". 이후 세션: 체류 충족까지 남은 시간(mm:ss).
function RetrievalProgressIndicator({
  isFirstSession,
  coveredCount,
  requiredCount,
  dwellRemainingSec,
}: {
  isFirstSession: boolean;
  coveredCount: number;
  requiredCount: number;
  dwellRemainingSec: number | null;
}) {
  if (isFirstSession) {
    return (
      <View style={styles.progressIndicator}>
        <Text style={styles.progressIndicatorText}>
          이번 인출 {Math.min(coveredCount, requiredCount)}/{requiredCount}
        </Text>
      </View>
    );
  }

  if (dwellRemainingSec === null || dwellRemainingSec <= 0) return null;
  const mm = String(Math.floor(dwellRemainingSec / 60)).padStart(2, '0');
  const ss = String(dwellRemainingSec % 60).padStart(2, '0');
  return (
    <View style={styles.progressIndicator}>
      <Text style={styles.progressIndicatorText}>
        {mm}:{ss}
      </Text>
    </View>
  );
}

function HeaderEyeCell({
  label,
  hidden,
  onToggle,
  style,
}: {
  label: string;
  hidden: boolean;
  onToggle: () => void;
  style: object;
}) {
  return (
    <Pressable style={[styles.headerEyeCell, style]} onPress={onToggle} hitSlop={8}>
      <Text style={styles.headerText}>{label}</Text>
      <Text style={styles.eyeIcon}>{hidden ? '🙈' : '👁️'}</Text>
    </Pressable>
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 44,
    paddingHorizontal: 12,
  },
  headerRow: {
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
    backgroundColor: '#f5f5f5',
  },
  headerText: {
    fontWeight: '700',
    color: '#444',
    fontSize: 14,
  },
  headerEyeCell: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  eyeIcon: {
    fontSize: 14,
  },
  stageCell: {
    width: 28,
  },
  numberCell: {
    width: 28,
    fontSize: 13,
    color: '#999',
  },
  wordCell: {
    width: 100,
  },
  speakerButton: {
    width: 32,
  },
  meaningCell: {
    flex: 1,
    marginLeft: 4,
  },
  progressIndicator: {
    alignItems: 'center',
    paddingVertical: 4,
    backgroundColor: '#fafafa',
  },
  progressIndicatorText: {
    fontSize: 12,
    color: '#aaa',
  },
  completionBanner: {
    position: 'absolute',
    left: 24,
    right: 24,
    zIndex: 10,
    alignItems: 'center',
    backgroundColor: 'rgba(40,40,40,0.92)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  completionBannerText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
});
