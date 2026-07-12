import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { AppStateStatus, ViewToken } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import DayWordRow, { ROW_HEIGHT } from '../../components/DayWordRow';
import WordDetailSheet from '../../components/WordDetailSheet';
import {
  currentSlotIndex,
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

// 하루 4회 분산 인출 습관 시스템 — 세션 트래킹 상수 (설계.md §7.1, §7.3, 2026-07-09 기준 교체)
const DWELL_MS_PER_WORD = 5000; // 오늘 첫 세션 임계: 단어수 × 5초 (2026-07-10 사용자 조정, 1초→5초)
const LATER_SESSION_BASE_MS = 3000; // 이후 세션 임계 기본값: 3초 + 배지수×1초
// 이탈 허용 유예(2026-07-12): 앱이 비활성화됐다가 이 시간 안에 돌아오면 실수/시스템 UI
// (알림센터 등)로 보고 이어서 세고, 넘기면 임계값 전체로 리셋. AppState 상태명(inactive/
// background)으로 구분하지 않는 이유: iOS가 알림센터를 background로 보고하는 버전이 있어
// (RN 알려진 퀴크) 상태명 기반 구분은 기기에 따라 깨진다 — 시간 기반이 유일하게 안정적.
const DWELL_LEAVE_GRACE_MS = 3000;
const BANNER_DURATION_MS = 2000; // 완료 피드백 배너 표시 시간

// 인출모드 카운트다운 라인바 상수 (설계.md §7.3)
const COUNTDOWN_MS_PER_WORD = 5000; // 단어수 × 5초
// 인출모드 시간 임박 사이렌 (2026-07-11 사용자 요청) — 남은 시간이 이 값 이하로 떨어지는
// 순간 트리거, SIREN_DURATION_MS 동안 표시 후 자동으로 사라진다.
const SIREN_AT_REMAINING_MS = 10_000;
const SIREN_DURATION_MS = 1400;

// 미션 완료 동전 애니메이션 (2026-07-12 사용자 요청) — 배너 메시지가 먼저 자리 잡은 뒤
// COIN_DELAY_MS 후에 등장, 위로 살짝 떠오르며 페이드아웃. 총 소요시간을 상수로 분리해
// 애니메이션 타이밍과 state 정리 타이머가 같은 값을 공유하게 한다(어긋나면 잔상/조기소멸
// 버그로 이어짐).
const COIN_DELAY_MS = 900; // 배너 등장(FadeIn 200ms) 후 이 시점에 동전 시작
const COIN_DURATION_MS = 1000; // 동전 등장→상승→소멸 전체 시간

type ColumnKey = 'word' | 'meaning';
type StudyMode = 'study' | 'retrieval';

export default function DayScreen() {
  const { dayId, dayIndex: dayIndexParam, initialMode } = useLocalSearchParams<{
    dayId: string;
    dayIndex?: string;
    initialMode?: string;
  }>();
  // 복습 메뉴에서 진입하면 인출모드로 시작 (2026-07-11 사용자 요청). 그 외(홈 등)는 학습모드.
  const startInRetrieval = initialMode === 'retrieval';
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
  // 인출모드로 시작하면 handleModeChange와 동일하게 뜻 컬럼을 초기부터 가린다.
  const [columnHidden, setColumnHidden] = useState<Record<ColumnKey, boolean>>({
    word: false,
    meaning: startInRetrieval,
  });

  // 학습/인출모드 토글 — 기본 학습모드, 단 복습 메뉴에서 진입(initialMode=retrieval)하면
  // 인출모드로 시작한다. 인출모드 진입 시 뜻 컬럼을 일괄 가림(설계.md §4.5, §7.3).
  // 이후 눈 아이콘 수동 조작은 모드와 독립(단방향 세팅).
  const [mode, setMode] = useState<StudyMode>(startInRetrieval ? 'retrieval' : 'study');
  // 인출모드 카운트다운 라인바 진행도 (1=가득 참 → 0=소진). mode==='retrieval'일 때만 렌더.
  const lineBarProgress = useSharedValue(0);
  // 인출모드 시간 임박 사이렌 표시 여부 — 리스트 밖 형제 노드로 렌더해 renderItem deps에
  // 넣지 않는다(넣으면 사이렌 토글 때 전 행이 리렌더됨).
  const [sirenVisible, setSirenVisible] = useState(false);

  // 개별 셀 "잠깐 보이기" — dayWordId별로 컬럼 peek 타이머 관리
  const [peekMap, setPeekMap] = useState<Record<number, Partial<Record<ColumnKey, boolean>>>>({});
  const peekTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // 현재 화면에 보이는 행의 인덱스 집합 → stagger 지연 계산 기준(설계.md §4.5)
  const [visibleIndexes, setVisibleIndexes] = useState<number[]>([]);
  const minVisibleIndexRef = useRef(0);

  // --- 하루 4회 분산 인출 습관 시스템 — 세션 트래킹 (설계.md §7.1, §7.3) ---
  // 트래킹 적용 여부: 오늘 Day가 아니거나 진입 시점이 데드존(슬롯 없음)이면 비활성.
  const [trackingEnabled, setTrackingEnabled] = useState(false);
  const [sessionRecorded, setSessionRecorded] = useState(false);
  const [completionBanner, setCompletionBanner] = useState<string | null>(null);
  // 미션 완료 동전 애니메이션 — 총 지급액만 표시(개별 보너스 내역은 배너 문구로 충분).
  // 세션당 1회 구조(sessionRecorded 잠금)라 큐잉 없이 단순 교체로 충분하다.
  const [coinAmount, setCoinAmount] = useState<number | null>(null);
  const coinShowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 배너 후 지연 등장용
  const coinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 소멸(state 정리)용

  // ★★★ 임시 애니메이션 미리보기 (2026-07-12) — 확인 끝나면 이 useEffect 통째로 삭제할 것 ★★★
  // 오늘 슬롯이 이미 기록돼 실제 경로로는 재생 불가라, DB를 건드리지 않고 화면 진입 1.5초 뒤
  // 배너+동전 시퀀스를 가짜로 재생한다. 화면을 나갔다 다시 들어오면 반복 재생.
  useEffect(() => {
    const t = setTimeout(() => {
      setCompletionBanner('이번 슬롯 미션 완료!');
      setTimeout(() => setCompletionBanner(null), BANNER_DURATION_MS);
      coinShowTimerRef.current = setTimeout(() => setCoinAmount(10), COIN_DELAY_MS);
      coinTimerRef.current = setTimeout(() => setCoinAmount(null), COIN_DELAY_MS + COIN_DURATION_MS);
    }, 1500);
    return () => clearTimeout(t);
  }, []);
  // ★★★ 임시 미리보기 끝 ★★★

  // 트래킹 초기화 1회 가드 — 초기화 성공 후에는 words 변경(스와이프에 의한 setWords)이
  // 발생해도 임계값 재계산이 다시 일어나지 않는다("세션 중 임계 고정" 스펙의 필수 전제이자,
  // 기존에 스와이프마다 쿼리 4개가 재실행되던 잠복 문제의 수정).
  const trackingInitializedRef = useRef(false);

  // 체류 타이머 상태 — "남은 시간만큼 setTimeout" 방식. 이탈(비활성화) 후 복귀가
  // DWELL_LEAVE_GRACE_MS 이내면 이어서 세고, 넘기거나 화면을 이동하면 임계값 전체로
  // 리셋한다(설계.md §7.1 "연속" 판정, 2026-07-12 사용자 확정 — 끊지 않고 한 번에
  // 채워야 인정, 집중 습관 형성 목적).
  // 초기값 0: 트래킹 초기화 effect가 실제 임계값을 계산해 넣기 전까지는 resumeDwellTimer의
  // `<= 0` 가드가 타이머 오시작을 막는 안전망.
  const dwellThresholdMsRef = useRef(0); // 이 세션의 임계값(리셋 복원용, 초기화 시 1회 계산)
  const dwellRemainingMsRef = useRef(0);
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dwellRunningSinceRef = useRef<number | null>(null); // 현재 구간 시작 epoch ms (null = 정지 중)
  const dwellSatisfiedRef = useRef(false);
  const screenFocusedRef = useRef(true);
  const appActiveRef = useRef(AppState.currentState === 'active');
  // 앱이 비활성화된 시각 — 복귀 시 이탈 시간(now - leftAt)으로 유예 초과 여부를 판정한다.
  const leftAtMsRef = useRef<number | null>(null);

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
  // words가 로드돼야 체류 임계값(단어수 기반)을 계산할 수 있으므로 words 로드와 별도 effect.
  // trackingInitializedRef 가드로 초기화는 세션당 정확히 1회만 수행된다(위 ref 선언부 주석 참고).
  useEffect(() => {
    const id = Number(dayId);
    if (!Number.isFinite(id) || !words) return;
    if (trackingInitializedRef.current) return;

    let cancelled = false;
    Promise.all([isTodayDay(id), isFirstSessionOfToday(), currentSlotIndex(), getTodaySlots()]).then(
      ([todayDay, firstSession, slotIndex, todaySlots]) => {
        if (cancelled) return;
        if (!todayDay || slotIndex === null) {
          // 오늘 Day가 아니거나 데드존 — 트래킹을 시작하지 않는다(다음 words 변경 시 재시도 가능).
          return;
        }
        trackingInitializedRef.current = true;

        // 미션 임계값(체류 단독, 2026-07-09 확정 — 설계.md §7.1): 오늘 첫 세션은 단어수×5초
        // (DWELL_MS_PER_WORD, 2026-07-10 1초→5초 조정), 이후 세션은 3초 + (스와이프 배지
        // 단어수)×1초. 배지 수는 이 시점(화면 로드) 1회 계산해 세션 중 스와이프해도 임계는 고정된다.
        const badgeWordCount = words.filter((w) => w.recall_stage > 0).length;
        const thresholdMs = Math.max(
          1000,
          firstSession
            ? words.length * DWELL_MS_PER_WORD
            : LATER_SESSION_BASE_MS + badgeWordCount * 1000,
        );
        dwellThresholdMsRef.current = thresholdMs;
        dwellRemainingMsRef.current = thresholdMs;

        if (todaySlots[slotIndex]) {
          // 현재 슬롯이 이미 확정됨 — 판정 시도 없이 조용히 잠근다(recordRetrievalSession의
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
    if (!Number.isFinite(dayIdNum)) return;

    // 조건 충족 순간 즉시 잠가 중복 호출 방지 (DB round-trip 중 재진입 방지)
    setSessionRecorded(true);

    recordRetrievalSession(dayIdNum)
      .then((result) => {
        if (!result.recorded) {
          // 이미 이 슬롯이 찬 상태 등 — 조용히 무시(스펙: recorded=false면 피드백 없음)
          return;
        }

        // 배너 문구 — 실지급 내역(result.paidBonuses) 기반으로 조립. 이전에는
        // DEFAULT_HABIT_BONUS 상수 금액을 그대로 찍어 설정에서 금액을 바꾸면 배너가
        // 틀린 숫자를 보여주는 잠복 버그가 있었다(2026-07-12 수정). 개별 금액은
        // 배너에 쓰지 않는다 — 동전이 총액을 보여주므로 단문 유지.
        const kinds = new Set(result.paidBonuses.map((b) => b.kind));
        const parts = ['이번 슬롯 미션 완료!'];
        if (kinds.has('full_day')) parts.push('오늘 4회 완주!');
        if (kinds.has('streak7')) parts.push(`${result.streakDays}일 연속!`);
        const milestoneKind = result.paidBonuses.find((b) =>
          ['streak14', 'streak30', 'streak60', 'streak100'].includes(b.kind),
        );
        if (milestoneKind) parts.push(`${result.streakDays}일 마일스톤 달성!`);
        setCompletionBanner(parts.join(' '));
        setTimeout(() => setCompletionBanner(null), BANNER_DURATION_MS);

        // 동전 애니메이션 — 이번 호출에서 실제로 지급된 보너스 총액만 표시.
        // 배너가 먼저 자리 잡도록 COIN_DELAY_MS 후에 등장시킨다(2026-07-12 사용자 조정).
        const total = result.paidBonuses.reduce((sum, b) => sum + b.amount, 0);
        if (total > 0) {
          if (coinShowTimerRef.current) clearTimeout(coinShowTimerRef.current);
          if (coinTimerRef.current) clearTimeout(coinTimerRef.current);
          coinShowTimerRef.current = setTimeout(() => {
            setCoinAmount(total);
            coinShowTimerRef.current = null;
          }, COIN_DELAY_MS);
          coinTimerRef.current = setTimeout(() => {
            setCoinAmount(null);
            coinTimerRef.current = null;
          }, COIN_DELAY_MS + COIN_DURATION_MS);
        }
      })
      .catch(() => {
        // 습관 트래킹은 부가 기능 — 실패해도 학습 흐름을 막지 않는다.
      });
  }, [trackingEnabled, sessionRecorded, dayIdNum]);

  const tryFinalizeRef = useRef(tryFinalizeSession);
  tryFinalizeRef.current = tryFinalizeSession;

  // 체류 타이머 일시정지 — 남은 시간을 dwellRemainingMsRef에 보존. 모든 비활성화 시
  // 일단 이걸로 멈추고, 리셋 여부는 복귀 시점에 이탈 시간으로 판정한다(유예 초과 시
  // resetDwellTimer). 화면 이동(blur)은 유예 없이 즉시 resetDwellTimer.
  const pauseDwellTimer = useCallback(() => {
    if (dwellTimerRef.current) {
      clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
    if (dwellRunningSinceRef.current !== null) {
      const elapsed = Date.now() - dwellRunningSinceRef.current;
      dwellRemainingMsRef.current = Math.max(0, dwellRemainingMsRef.current - elapsed);
      dwellRunningSinceRef.current = null;
    }
  }, []);

  // 체류 타이머 리셋 — 백그라운드 이탈/화면 이동 시 잔여시간을 버리고 임계값 전체로
  // 되돌린다(설계.md §7.1 "연속" 판정, 2026-07-12). 이미 판정이 끝난 세션이면 무의미하므로
  // 건드리지 않는다.
  const resetDwellTimer = useCallback(() => {
    if (dwellTimerRef.current) {
      clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
    dwellRunningSinceRef.current = null;
    if (!dwellSatisfiedRef.current) {
      dwellRemainingMsRef.current = dwellThresholdMsRef.current;
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
      tryFinalizeRef.current();
    }, dwellRemainingMsRef.current);
  }, [trackingEnabled, sessionRecorded]);

  // trackingEnabled가 켜지는 순간 타이머 시작 (화면 focus + 앱 active 전제)
  useEffect(() => {
    if (!trackingEnabled) return;
    if (screenFocusedRef.current && appActiveRef.current) {
      resumeDwellTimer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackingEnabled]);

  // AppState: 비활성화(inactive/background 불문)되면 일시정지 + 이탈 시각 기록, active
  // 복귀 시 이탈 시간이 DWELL_LEAVE_GRACE_MS를 넘겼으면 리셋(임계값 전체부터), 이내면
  // 보존된 잔여시간부터 재개. 판정을 복귀 시점으로 미루므로 백그라운드에서 JS가 멈춰
  // 있어도 타이머 없이 동작하고, iOS의 inactive/background 보고 편차와도 무관하다.
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      const wasActive = appActiveRef.current;
      const isActive = nextState === 'active';
      appActiveRef.current = isActive;
      if (wasActive && !isActive) {
        leftAtMsRef.current = Date.now();
        pauseDwellTimer();
      } else if (!wasActive && isActive) {
        const awayMs = leftAtMsRef.current !== null ? Date.now() - leftAtMsRef.current : 0;
        leftAtMsRef.current = null;
        if (awayMs > DWELL_LEAVE_GRACE_MS) {
          resetDwellTimer();
        }
        if (screenFocusedRef.current) {
          resumeDwellTimer();
        }
      }
    };
    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => sub.remove();
  }, [pauseDwellTimer, resetDwellTimer, resumeDwellTimer]);

  // 화면 blur/focus (expo-router) — 다른 화면으로 이동 = 이탈이므로 리셋, 복귀 시 임계값
  // 전체부터 다시 시작.
  useFocusEffect(
    useCallback(() => {
      screenFocusedRef.current = true;
      if (appActiveRef.current) {
        resumeDwellTimer();
      }
      return () => {
        screenFocusedRef.current = false;
        resetDwellTimer();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resetDwellTimer, resumeDwellTimer]),
  );

  // 화면 완전 이탈 시 타이머 정리 (cleanup 누락 방지)
  useEffect(() => {
    return () => {
      if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current);
      if (coinShowTimerRef.current) clearTimeout(coinShowTimerRef.current);
      if (coinTimerRef.current) clearTimeout(coinTimerRef.current);
    };
  }, []);

  const wordCount = words?.length ?? 0;

  // 인출모드 카운트다운 라인바 — 인출모드로 (재)진입할 때마다 리셋 후 단어수×5초 선형 감소.
  // trackingEnabled와 무관한 순수 시각 장치라 복습 Day·데드존에서도 동작(설계.md §7.3).
  // words 배열 참조 대신 wordCount(길이)에 의존해 스와이프로 인한 setWords 재발행에는 반응하지 않는다.
  useEffect(() => {
    if (mode !== 'retrieval' || wordCount === 0) return;
    cancelAnimation(lineBarProgress);
    lineBarProgress.value = 1;
    const duration = wordCount * COUNTDOWN_MS_PER_WORD;
    lineBarProgress.value = withTiming(0, {
      duration,
      easing: Easing.linear,
    });

    // 시간 임박 사이렌 — 남은 시간이 SIREN_AT_REMAINING_MS 이하가 되는 시점에 표시,
    // SIREN_DURATION_MS 후 자동으로 사라진다. 총 길이가 임계 이하면 예약하지 않는다.
    let showTimer: ReturnType<typeof setTimeout> | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    if (duration > SIREN_AT_REMAINING_MS) {
      showTimer = setTimeout(() => {
        setSirenVisible(true);
        hideTimer = setTimeout(() => {
          setSirenVisible(false);
        }, SIREN_DURATION_MS);
      }, duration - SIREN_AT_REMAINING_MS);
    }

    return () => {
      if (showTimer) clearTimeout(showTimer);
      if (hideTimer) clearTimeout(hideTimer);
      setSirenVisible(false);
    };
  }, [mode, wordCount, lineBarProgress]);

  // 모드 전환 — 인출모드 진입 시 뜻 컬럼만 가림(단어 컬럼은 그대로). 이후 눈 아이콘 수동
  // 조작은 이 세팅과 독립적으로 동작한다(단방향, 설계.md §4.5).
  const handleModeChange = useCallback((next: StudyMode) => {
    setMode(next);
    setColumnHidden({ word: false, meaning: next === 'retrieval' });
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

  const handleTapCell = useCallback((dayWordId: number, column: ColumnKey) => {
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
  }, []);

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
      <Stack.Screen
        options={{
          title: dayIndex !== null ? `Day${dayIndex}` : '단어장',
          headerRight: () => <ModeToggle mode={mode} onChange={handleModeChange} />,
        }}
      />

      {error && <Text style={styles.error}>{error}</Text>}

      {!error && !words && <ActivityIndicator style={styles.loading} />}

      {!error && words && mode === 'retrieval' && (
        <RetrievalCountdownBar progress={lineBarProgress} />
      )}

      {coinAmount !== null && <CoinPopup amount={coinAmount} top={insets.top + 8} />}

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

      {mode === 'retrieval' && sirenVisible && <RetrievalSiren />}

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

// 학습/인출모드 2세그먼트 필 토글 (헤더 우측, 설계.md §4.5). 기본 학습모드.
function ModeToggle({
  mode,
  onChange,
}: {
  mode: StudyMode;
  onChange: (next: StudyMode) => void;
}) {
  return (
    <View style={styles.modeToggle}>
      <Pressable
        style={[styles.modeToggleSegment, mode === 'study' && styles.modeToggleSegmentActive]}
        onPress={() => onChange('study')}
        hitSlop={6}
      >
        <Text style={[styles.modeToggleText, mode === 'study' && styles.modeToggleTextActive]}>
          학습
        </Text>
      </Pressable>
      <Pressable
        style={[styles.modeToggleSegment, mode === 'retrieval' && styles.modeToggleSegmentActive]}
        onPress={() => onChange('retrieval')}
        hitSlop={6}
      >
        <Text style={[styles.modeToggleText, mode === 'retrieval' && styles.modeToggleTextActive]}>
          인출
        </Text>
      </Pressable>
    </View>
  );
}

// 인출모드 카운트다운 라인바 — 버튼 아님, 순수 시각 장치(설계.md §7.3). 시간 텍스트 없이
// scaleX만으로 단어수×5초 동안 선형 감소, 소진 시 아무 일도 일어나지 않는다.
function RetrievalCountdownBar({ progress }: { progress: SharedValue<number> }) {
  const fillStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: progress.value }],
  }));
  return (
    <View style={styles.countdownTrack}>
      <Animated.View style={[styles.countdownFill, fillStyle]} />
    </View>
  );
}

// 인출모드 시간 임박 사이렌 (2026-07-11 사용자 요청) — 리스트 위 화면 중앙에 절대배치,
// pointerEvents="none"으로 행 탭/스와이프를 방해하지 않는다. 등장·퇴장은 페이드 없이 즉시.
function RetrievalSiren() {
  const rotate = useSharedValue(0);

  useEffect(() => {
    rotate.value = withRepeat(
      withSequence(
        withTiming(-8, { duration: 80 }),
        withTiming(8, { duration: 80 }),
      ),
      -1,
      true,
    );
    return () => {
      cancelAnimation(rotate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotate.value}deg` }],
  }));

  return (
    <View style={styles.sirenOverlay} pointerEvents="none">
      <Animated.Text style={[styles.sirenIcon, iconStyle]}>🚨</Animated.Text>
      <Text style={styles.sirenText}>비상비상!</Text>
    </View>
  );
}

// 미션 완료 동전 애니메이션 (2026-07-12 사용자 요청) — 리스트 밖 형제 노드로 렌더
// (§4.5 FlatList 성능 계약 유지, renderItem deps에는 넣지 않는다). 등장 시
// opacity 0→1 + 위로 살짝 떠오르며 후반부 페이드아웃.
function CoinPopup({ amount, top }: { amount: number; top: number }) {
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(0);

  useEffect(() => {
    // 1. 투명도(Opacity) 애니메이션
    opacity.value = withSequence(
      // withTiming(1, { duration: 150, easing: Easing.out(Easing.quad) }),
      withTiming(1, { duration: COIN_DURATION_MS - 400}),
      withTiming(0, { duration: 400, easing: Easing.in(Easing.quad) }),
    );
    // 2. Y축 위치(TranslateY) 애니메이션
    translateY.value = withSequence(
      withTiming(0, { duration: COIN_DURATION_MS -400 }),
      withTiming(-48, { duration: 400, easing: Easing.out(Easing.quad) }), 
    );
    return () => {
      cancelAnimation(opacity);
      cancelAnimation(translateY);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const coinStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  // 금액 단계별 동전 지름 — 큰 보상일수록 큰 동전 (2026-07-12 사용자 확정)
  const coinDiameter = amount >= 100_000 ? 88 : amount >= 10_000 ? 72 : amount >= 1_000 ? 56 : 42;

  return (
    // 배너(top 위치, 높이 ~40) 아래 56px 지점에서 시작해 translateY −48로 떠오르면
    // 배너 높이 부근에서 페이드아웃된다. zIndex가 배너(10)보다 높아(11) 마지막에 배너
    <View style={[styles.coinWrap, { top: top + 56 }]} pointerEvents="none">
      {/* 글자 크기는 고정(12pt), 동전 지름만 금액 단계에 따라 커진다 (2026-07-12 사용자 확정).
          지름은 각 단계 최장 문구("+100,000" 등)가 원 안에 들어가는 크기로 산정. */}
      <Animated.View
        style={[
          styles.coin,
          { width: coinDiameter, height: coinDiameter, borderRadius: coinDiameter / 2 },
          coinStyle,
        ]}
      >
        <Text style={styles.coinText}>+{amount.toLocaleString()}</Text>
      </Animated.View>
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
    width: 132,
  },
  meaningCell: {
    flex: 1,
    marginLeft: 4,
  },
  modeToggle: {
    flexDirection: 'row',
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd',
    overflow: 'hidden',
    marginRight: 8,
  },
  modeToggleSegment: {
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  modeToggleSegmentActive: {
    backgroundColor: '#ddd',
  },
  modeToggleText: {
    fontSize: 13,
    color: '#999',
    fontWeight: '600',
  },
  modeToggleTextActive: {
    color: '#444',
  },
  countdownTrack: {
    height: 3,
    backgroundColor: '#eee',
  },
  countdownFill: {
    height: 3,
    width: '100%',
    backgroundColor: '#ff9f43',
    transformOrigin: 'left',
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
  coinWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 11, // 배너(10)보다 위 — 동전이 메시지 앞으로 지나가며 사라진다 (2026-07-12 사용자 조정)
    alignItems: 'center',
  },
  coin: {
    // 항상 완전한 원 (2026-07-12 사용자 확정 — 알약형 반려). width/height/borderRadius는
    // CoinPopup이 금액 단계별 지름(coinDiameter)으로 주입한다.
    backgroundColor: '#ffc94a',
    borderWidth: 1,
    borderColor: '#c98a12',
    alignItems: 'center',
    justifyContent: 'center',
  },
  coinText: {
    color: '#7a4e00',
    fontSize: 10,
    fontWeight: '600',
    textAlign: 'center',
  },
  sirenOverlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sirenIcon: {
    fontSize: 56,
  },
  sirenText: {
    marginTop: 4,
    fontSize: 18,
    fontWeight: 'bold',
    color: '#c0392b',
  },
});
