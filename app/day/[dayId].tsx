import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
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
  getSlotPassedDayIds,
  getSlotRequirement,
  getTodayPassCount,
  recordSlotPart,
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

// 하루 4회 분산 인출 습관 시스템 — 세션 트래킹 상수 (설계.md §7.1, §7.3, §7.6 미결 4)
// 세션 완료(= 조각 하나 채우기 = 보상) 체류 임계 — 오늘 Day인지 복습 Day인지, 그리고
// 오늘 Day라면 몇 번째 패스인지로 규칙이 갈린다.
// 2026-08-24 복습이 슬롯 조건에 편입되며 재편. 이전에는 "차수"가 오늘 확정된
// retrieval_session 행 수(= 오늘 완료한 슬롯 수)였으나, 이제 그 테이블은 슬롯 완성만
// 기록해 단어장을 훑은 횟수와 안 맞는다. 지금의 "패스 횟수"는 getTodayPassCount(dayId)
// = 오늘 이 특정 Day를 슬롯에서 통과한 횟수(slot_part 기준)로, "오늘 완료한 슬롯 수"가
// 아니라 "오늘 이 Day를 훑은 횟수"다 — 원래 의도(체크가 덜 된 초반엔 전량, 어느 정도
// 훑은 뒤엔 배지만)에 맞는 축은 원래도 이쪽이었다.
//
// 갈리는 축은 차수가 아니라 "배지가 이미 의미를 갖느냐"다:
// - 오늘 Day 1·2번째 패스: 그날 막 나온 단어라 아직 체크가 덜 돼 있어 배지가 정보가
//   못 된다 → 전체 단어수 기준.
// - 그 외 전부(오늘 Day 3·4번째 패스 + 복습 Day의 모든 패스): 복습 Day는 며칠에 걸쳐
//   분류가 끝나 있어 첫 패스부터 배지가 의미 있고, 오늘 Day도 3·4번째쯤엔 마찬가지다
//   → 체크(배지) 단어수 기준. 다 외운 복습 Day(배지 0)는 하한만 채우고 통과한다
//   (§7.6 "볼 게 없는 Day를 보상 때문에 붙잡지 않는다"가 이 분기로 지켜진다).
const DWELL_FIRST_MS_PER_WORD = 2500; // 오늘 Day 1번째 패스: 전체 단어수 × 2.5초
const DWELL_SECOND_MS_PER_WORD = 1500; // 오늘 Day 2번째 패스: 전체 단어수 × 1.5초
const DWELL_LATER_MS_PER_BADGE = 2000; // 그 외 전부: 체크(배지) 단어수 × 2초
// "그 외 전부" 분기의 하한(2026-08-24 사용자 확정). 배지가 0이면 곱셈 결과가 0이라 아래
// Math.max(1000,...) 안전망에 걸려 1초 만에 통과해 버린다. 오늘 Day 3·4번째는 보상이
// 걸린 화면이라(슬롯 통과 + 4/4 보너스) 스와이프를 안 하는 아이가 1초씩 넘기게 되고,
// 복습 Day는 다 외운 Day를 즉시 통과시키되 "0초 통과"라는 티는 안 나게 하려는 취지다.
// 1·2번째(오늘 Day)는 전체 단어수 기준이라 0이 될 일이 없다.
const DWELL_LATER_MIN_MS = 3000;
// 이탈 허용 유예(2026-07-12): 앱이 비활성화됐다가 이 시간 안에 돌아오면 실수/시스템 UI
// (알림센터 등)로 보고 이어서 세고, 넘기면 임계값 전체로 리셋. AppState 상태명(inactive/
// background)으로 구분하지 않는 이유: iOS가 알림센터를 background로 보고하는 버전이 있어
// (RN 알려진 퀴크) 상태명 기반 구분은 기기에 따라 깨진다 — 시간 기반이 유일하게 안정적.
const DWELL_LEAVE_GRACE_MS = 3000;
const BANNER_DURATION_MS = 2000; // 완료 피드백 배너 표시 시간

// 인출모드 카운트다운(타임어택) 라인바 상수 — 오늘 단어장·복습 Day **공통**
// (2026-08-24 사용자 확정: 화면마다 규칙이 다르면 아이가 헷갈리므로 일치시킨다).
//
// 길이 = 전체 단어수 × 3초 고정. 배지 수는 쓰지 않는다 — 2026-07-20에는 배지수 × 5초
// (배지 0이면 전체 × 5초 폴백)였으나 다음 두 이유로 폐기했다:
//  ⓐ 배지 0의 뜻이 화면마다 정반대다. 오늘 Day는 "아직 분류 안 함"(전량 훑어야 함),
//     복습 Day는 "다 외웠음". 같은 식을 쓰면 가장 쉬운 Day가 가장 긴 시간을 받는다.
//  ⓑ 배지로 길이를 정하면 길이가 아이의 자기표시에 휘둘린다(배지 1개짜리 Day가 5초로
//     최단이 되는 등). 카운트다운은 보상과 무관한 순수 집중 장치라 예측 가능한 고정
//     길이가 낫다.
// 보상 조건(세션 완료 판정)은 이것과 별개로 체류시간이 본다(DWELL_* 상수 참고).
const COUNTDOWN_MS_PER_WORD = 3000;
// 인출모드 시간 임박 사이렌 (2026-07-11 사용자 요청) — 남은 시간이 이 값 이하로 떨어지는
// 순간 트리거, SIREN_DURATION_MS 동안 표시 후 자동으로 사라진다. 총 시간이
// SIREN_MIN_TOTAL_MS 이하면 아예 예약하지 않는다(짧은 카운트다운에서 진입 직후
// 사이렌이 뜨는 것 방지, 2026-07-20 확정).
const SIREN_AT_REMAINING_MS = 10_000;
const SIREN_DURATION_MS = 1400;
const SIREN_MIN_TOTAL_MS = 15_000;

// 미션 완료 동전 애니메이션 (2026-07-12 사용자 요청) — 배너 메시지가 먼저 자리 잡은 뒤
// COIN_DELAY_MS 후에 등장, 위로 살짝 떠오르며 페이드아웃. 총 소요시간을 상수로 분리해
// 애니메이션 타이밍과 state 정리 타이머가 같은 값을 공유하게 한다(어긋나면 잔상/조기소멸
// 버그로 이어짐).
const COIN_DELAY_MS = 0; // 배너 등장(FadeIn 200ms) 후 이 시점에 동전 시작
const COIN_DURATION_MS = 1000; // 동전 등장→상승→소멸 전체 시간

type ColumnKey = 'word' | 'meaning';
type StudyMode = 'study' | 'retrieval';

function DayScreenBody() {
  const router = useRouter();
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
  // 인출모드 타임 오버 표시 (2026-07-20 사용자 요청) — 카운트다운 소진 시 표시, 배지를
  // 탭하면 countdownRun을 올려 카운트다운 effect를 재실행(라인바 리셋·사이렌 재예약)한다.
  const [timeOverVisible, setTimeOverVisible] = useState(false);
  const [countdownRun, setCountdownRun] = useState(0);

  // 개별 셀 "잠깐 보이기" — dayWordId별로 컬럼 peek 타이머 관리
  const [peekMap, setPeekMap] = useState<Record<number, Partial<Record<ColumnKey, boolean>>>>({});
  const peekTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // 현재 화면에 보이는 행의 인덱스 집합 → stagger 지연 계산 기준(설계.md §4.5)
  const [visibleIndexes, setVisibleIndexes] = useState<number[]>([]);
  const minVisibleIndexRef = useRef(0);

  // --- 하루 4회 분산 인출 습관 시스템 — 세션 트래킹 (설계.md §7.1, §7.3, §7.6 미결 4) ---
  // 트래킹 적용 여부: 이 Day가 오늘의 요구 집합(오늘 Day + 복습 대상)에 없거나 진입
  // 시점이 데드존(슬롯 없음)이면 비활성.
  const [trackingEnabled, setTrackingEnabled] = useState(false);
  const [sessionRecorded, setSessionRecorded] = useState(false);
  const [completionBanner, setCompletionBanner] = useState<string | null>(null);
  // 연쇄 복습 버튼용 — 이 슬롯에서 아직 남은 Day id(최근순, todayDayId 포함 가능) 및
  // 오늘 Day의 id(라벨 분기용). 초기화 effect와 recordSlotPart 결과 양쪽에서 채운다.
  const [remaining, setRemaining] = useState<number[]>([]);
  // 이 슬롯의 요구 Day 전체(순서 = [오늘 Day, 복습 -1, -3, ...]). remaining과 달리 통과해도
  // 줄지 않는다 — 슬롯 완성 후 순환 이동의 순서표이자 진행 점의 눈금이다. 요구 집합은
  // 화면이 열려 있는 동안 불변이므로(위 trackingInitializedRef 주석) 마운트 시 1회만 채운다.
  const [requiredDayIds, setRequiredDayIds] = useState<number[]>([]);
  const todayDayIdRef = useRef<number | null>(null);
  // 미션 완료 동전 애니메이션 — 총 지급액만 표시(개별 보너스 내역은 배너 문구로 충분).
  // 세션당 1회 구조(sessionRecorded 잠금)라 큐잉 없이 단순 교체로 충분하다.
  const [coinAmount, setCoinAmount] = useState<number | null>(null);
  const coinShowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 배너 후 지연 등장용
  const coinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 소멸(state 정리)용

  // ★★★ 임시 애니메이션 미리보기 (2026-07-12) — 확인 끝나면 이 useEffect 통째로 삭제할 것 ★★★
  // 오늘 슬롯이 이미 기록돼 실제 경로로는 재생 불가라, DB를 건드리지 않고 화면 진입 1.5초 뒤
  // 배너+동전 시퀀스를 가짜로 재생한다. 화면을 나갔다 다시 들어오면 반복 재생.
  // useEffect(() => {
  //   const t = setTimeout(() => {
  //     setCompletionBanner('이번 슬롯 미션 완료!');
  //     setTimeout(() => setCompletionBanner(null), BANNER_DURATION_MS);
  //     coinShowTimerRef.current = setTimeout(() => setCoinAmount(100), COIN_DELAY_MS);
  //     coinTimerRef.current = setTimeout(() => setCoinAmount(null), COIN_DELAY_MS + COIN_DURATION_MS);
  //   }, 1500);
  //   return () => clearTimeout(t);
  // }, []);
  // ★★★ 임시 미리보기 끝 ★★★

  // 트래킹 초기화 1회 가드 — 초기화 성공 후에는 words 변경(스와이프에 의한 setWords)이
  // 발생해도 임계값 재계산이 다시 일어나지 않는다("세션 중 임계 고정" 스펙의 필수 전제이자,
  // 기존에 스와이프마다 쿼리 4개가 재실행되던 잠복 문제의 수정).
  // ★ 이 가드는 "초기화 성공" 때만 서던 것이라 복습 Day에서는 영원히 서지 않아 같은
  //   재실행이 남아 있었다(2026-08-24 수정). 아래 초기화 effect의 실패 분기 참고 —
  //   영구 실패(요구 집합 밖의 Day)는 가드를 세우고, 일시 실패(데드존)는 세우지 않는다.
  //   2026-08-24 재정정: 요구 집합은 getSlotRequirement()가 오늘 날짜와 day.created_day로
  //   정하므로 화면이 열려 있는 동안 절대 바뀌지 않는다(오늘 Day든 복습 Day든 동일) —
  //   "복습 Day라서"가 아니라 "요구 집합이 화면 생존 기간 내 불변이라서" 가드를 세운다.
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

  // 세션 트래킹 초기화 — 이 Day가 오늘 요구 집합에 있고 + 데드존 아님(currentSlotIndex
  // != null) 확인 후에만 활성화. words가 로드돼야 체류 임계값(단어수 기반)을 계산할 수
  // 있으므로 words 로드와 별도 effect. trackingInitializedRef 가드로 초기화는 세션당
  // 정확히 1회만 수행된다(위 ref 선언부 주석 참고).
  useEffect(() => {
    const id = Number(dayId);
    if (!Number.isFinite(id) || !words) return;
    if (trackingInitializedRef.current) return;

    let cancelled = false;
    Promise.all([getSlotRequirement(), getTodayPassCount(id), currentSlotIndex()]).then(
      ([req, passCount, slotIndex]) => {
        if (cancelled) return;
        // 실패 두 종류를 구분한다(2026-08-24). 전에는 둘을 한 조건으로 묶어 똑같이
        // "가드 없이 return"했는데, 그러면 복습 Day에서 가드가 영원히 안 서서
        // 스와이프(setWords)마다 위 쿼리들이 통째로 재실행됐다.
        if (!req.requiredDayIds.includes(id)) {
          // 오늘 요구 집합 밖의 Day(오늘 Day도 복습 대상도 아님) — 이 집합은
          // 오늘 날짜와 day.created_day로만 정해지므로 화면이 열려 있는 동안 절대
          // 바뀌지 않는다. 재시도해도 답이 같으므로 가드를 세워 재실행을 끊는다.
          trackingInitializedRef.current = true;
          return;
        }
        if (slotIndex === null) {
          // 데드존(00:00–05:59) — 지금은 실패지만 슬롯이 열리면 성공한다. 가드를 세우지
          // 않고 나가 다음 words 변경 시 재시도되게 둔다(기존 동작 유지).
          return;
        }
        trackingInitializedRef.current = true;
        todayDayIdRef.current = req.todayDayId;
        setRequiredDayIds(req.requiredDayIds);

        // 미션 임계값(체류 단독, 설계.md §7.1) — 오늘 Day/복습 Day로 규칙이 갈린다
        // (상수부 주석 참조). 배지 수는 이 시점(화면 로드) 1회 계산해 세션 중 스와이프해도
        // 임계는 고정된다.
        const isTodaysDay = req.todayDayId === id;
        const badgeWordCount = words.filter((w) => w.recall_stage > 0).length;
        const thresholdMs = Math.max(
          1000,
          isTodaysDay && passCount === 0
            ? words.length * DWELL_FIRST_MS_PER_WORD
            : isTodaysDay && passCount === 1
              ? words.length * DWELL_SECOND_MS_PER_WORD
              : Math.max(DWELL_LATER_MIN_MS, badgeWordCount * DWELL_LATER_MS_PER_BADGE),
        );
        dwellThresholdMsRef.current = thresholdMs;
        dwellRemainingMsRef.current = thresholdMs;

        getSlotPassedDayIds(slotIndex).then((passedDayIds) => {
          if (cancelled) return;
          const passedSet = new Set(passedDayIds);
          if (passedSet.has(id)) {
            // 이 슬롯에서 이 Day를 이미 통과함 — 판정 시도 없이 조용히 잠근다
            // (recordSlotPart의 INSERT OR IGNORE도 결국 무시하지만, 헛되이 타이머를
            // 돌릴 필요가 없어 미리 잠근다).
            setSessionRecorded(true);
          }
          setRemaining(req.requiredDayIds.filter((d) => !passedSet.has(d)));
        });
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

  // dayId를 숫자로 안전 변환 (recordSlotPart 호출용). 트래킹 로직 전반에서 재사용.
  const dayIdNum = Number(dayId);

  // 조건 충족 시 recordSlotPart() 호출 — 순서: 요구 집합 판단/currentSlotIndex 등
  // 슬롯 귀속 판단은 lib/habitQueries.ts 내부가 전담하므로 여기서는 호출만 한다.
  const tryFinalizeSession = useCallback(() => {
    if (!trackingEnabled || sessionRecorded) return;
    if (!dwellSatisfiedRef.current) return;
    if (!Number.isFinite(dayIdNum)) return;

    // 조건 충족 순간 즉시 잠가 중복 호출 방지 (DB round-trip 중 재진입 방지)
    setSessionRecorded(true);

    recordSlotPart(dayIdNum)
      .then((result) => {
        setRemaining(result.remainingDayIds);

        if (!result.partRecorded) {
          // 이미 이 슬롯에서 이 Day를 통과한 상태 — 조용히 무시(피드백 없음)
          return;
        }

        if (!result.slotCompleted) {
          // 조각만 기록됨(슬롯 미완성) — 남은 개수를 알려주는 짧은 배너.
          const isTodaysDay = dayIdNum === todayDayIdRef.current;
          const remainingCount = result.remainingDayIds.length;
          const banner = isTodaysDay
            ? `단어장 끝! 복습 ${remainingCount}개 남았어요`
            : `복습 하나 끝! ${remainingCount}개 남았어요`;
          setCompletionBanner(banner);
          setTimeout(() => setCompletionBanner(null), BANNER_DURATION_MS);

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
          return;
        }

        // 슬롯 완성 — 배너 문구를 실지급 내역(result.paidBonuses) 기반으로 조립.
        // 이전에는 DEFAULT_HABIT_BONUS 상수 금액을 그대로 찍어 설정에서 금액을 바꾸면
        // 배너가 틀린 숫자를 보여주는 잠복 버그가 있었다(2026-07-12 수정). 개별 금액은
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

  // 인출모드 카운트다운 라인바 — 인출모드로 (재)진입/재시작할 때마다 리셋 후 전체 단어수
  // 기준 시간(상수부 주석 참조) 동안 선형 감소. trackingEnabled와 무관한 순수 시각 장치라
  // 복습 Day·데드존에서도 동작(설계.md §7.3).
  // 스와이프(setWords 재발행)에 라인바가 반응하지 않는 것은 deps가 words가 아니라
  // wordCount(= words.length)이기 때문이다 — 스와이프는 길이를 바꾸지 않는다.
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
    // SIREN_DURATION_MS 후 자동으로 사라진다. 총 길이가 SIREN_MIN_TOTAL_MS 이하면
    // 예약하지 않는다.
    let showTimer: ReturnType<typeof setTimeout> | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    if (duration > SIREN_MIN_TOTAL_MS) {
      showTimer = setTimeout(() => {
        setSirenVisible(true);
        hideTimer = setTimeout(() => {
          setSirenVisible(false);
        }, SIREN_DURATION_MS);
      }, duration - SIREN_AT_REMAINING_MS);
    }

    // 소진 시 타임 오버 표시 — 탭(재시작) 또는 모드 전환/이탈 전까지 유지된다.
    const overTimer = setTimeout(() => {
      setTimeOverVisible(true);
    }, duration);

    return () => {
      if (showTimer) clearTimeout(showTimer);
      if (hideTimer) clearTimeout(hideTimer);
      clearTimeout(overTimer);
      setSirenVisible(false);
      setTimeOverVisible(false);
    };
  }, [mode, wordCount, lineBarProgress, countdownRun]);

  // 모드 전환 — 인출모드 진입 시 뜻 컬럼만 가림(단어 컬럼은 그대로). 이후 눈 아이콘 수동
  // 조작은 이 세팅과 독립적으로 동작한다(단방향, 설계.md §4.5).
  const handleModeChange = useCallback((next: StudyMode) => {
    setMode(next);
    setColumnHidden({ word: false, meaning: next === 'retrieval' });
  }, []);

  // 타임 오버 배지 탭 → 카운트다운을 처음부터 재시작 (countdownRun 변화로 effect 재실행)
  const handleCountdownRestart = useCallback(() => {
    setTimeOverVisible(false);
    setCountdownRun((n) => n + 1);
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

  // 연쇄 복습 버튼 — 목적지 결정은 두 단계다.
  //   ① 슬롯 미완성: remaining(아직 안 지난 요구 Day)의 첫 항목. remaining은 [오늘 Day,
  //      복습 -1, -3, -7, ...] 순서를 그대로 물려받아 자연히 우선순위가 된다. 오늘 단어장이
  //      아직이면 그게 먼저 나온다 — 의도된 동작(복습만 걸러내지 않는다). 이미 통과한 Day는
  //      목록에서 빠지므로 제안되지 않는다: 의무가 남은 동안 버튼은 "다음에 할 것"을 가리키는
  //      안내자라, 편한 Day를 반복하고 남은 걸 미루는 길을 열어주면 안 된다.
  //   ② 슬롯 완성(remaining이 빔): requiredDayIds를 **순환**한다(2026-08-30 추가). 전에는
  //      여기서 버튼이 사라졌는데, 갈 곳이 없어진 게 아니라 셈이 끝났을 뿐이다 — Day들은
  //      그대로 있다. 완성 순간 도달 범위가 넓어지는 비대칭은 의도한 것이다: 의무가 없어지면
  //      버튼의 역할이 안내자에서 통로로 바뀐다.
  //      순환은 끝이 없으므로 종료 조건이 필요 없는 대신, 요구 Day가 1개뿐인 날(복습 대상
  //      없음)에는 다음이 자기 자신이 되므로 그때만 null로 숨긴다.
  const cyclicNextDayId = (() => {
    if (requiredDayIds.length < 2) return null;
    const i = requiredDayIds.indexOf(dayIdNum);
    if (i < 0) return null;
    return requiredDayIds[(i + 1) % requiredDayIds.length];
  })();
  const nextDayId = remaining.find((id) => id !== dayIdNum) ?? cyclicNextDayId;
  const [nextDayIndex, setNextDayIndex] = useState<number | null>(null);

  useEffect(() => {
    if (nextDayId === null) {
      setNextDayIndex(null);
      return;
    }
    let cancelled = false;
    getDayIndex(nextDayId)
      .then((idx) => {
        if (!cancelled) setNextDayIndex(idx);
      })
      .catch(() => {
        // 라벨 표시용이라 실패해도 화면 동작에는 지장 없음
      });
    return () => {
      cancelled = true;
    };
  }, [nextDayId]);

  const handleGoNext = useCallback(() => {
    if (nextDayId === null) return;
    // ★ 목적지가 오늘 단어장이면 initialMode를 넘기지 않는다(= 학습모드).
    //   remaining 순서상 오늘 Day가 맨 앞이라, 복습 화면에서 시작해 복습을 먼저 끝내면
    //   이 버튼이 오늘 단어장을 가리키게 된다. 그때 인출모드로 열면 **아직 한 번도 안 본
    //   오늘의 새 단어 20개가 뜻이 가려진 채 카운트다운과 함께** 나온다 — 인출할 것이
    //   머릿속에 없는데 인출을 시키는 셈이라 학습이 아니라 좌절이 된다.
    //   복습 Day는 반대다(며칠 전에 배운 것을 꺼내는 화면) → 인출모드가 맞다.
    //   이 분기 덕에 "인출모드로 여는 곳은 복습뿐"이라는 기존 규약도 그대로 유지된다.
    const isNextTodaysDay = nextDayId === todayDayIdRef.current;
    // push가 아니라 replace — 슬롯 요구 개수만큼 연쇄 이동하므로 push를 쓰면 뒤로가기가
    // 미로가 된다(최대 7단까지 쌓일 수 있음, §7.6 미결 4).
    router.replace({
      pathname: '/day/[dayId]',
      params: {
        dayId: String(nextDayId),
        ...(nextDayIndex !== null ? { dayIndex: String(nextDayIndex) } : {}),
        ...(isNextTodaysDay ? {} : { initialMode: 'retrieval' }),
      },
    });
  }, [nextDayId, nextDayIndex, router]);

  const nextDayLabel =
    nextDayId === null
      ? ''
      : nextDayId === todayDayIdRef.current
        ? '오늘 단어장 →'
        : nextDayIndex !== null
          ? `Day${nextDayIndex} 복습 →`
          : '복습 →';

  const showChainButton = sessionRecorded && nextDayId !== null;

  // 진행 점 — requiredDayIds 눈금 위에 통과(●) / 아직(○) / 지금 여기(◉)를 겹쳐 그린다.
  // 잔량을 세던 문구("이번 시간대에 N개 남았어요")를 대체한 것이다. 순환에는 끝이 없어
  // **잔량이 정의되지 않는다** — 어떤 정의로 세도 마지막 칸에서 0이 나오고 다음 바퀴에
  // 부활해, "0개 남았어요" 밑에 "가자" 버튼이 붙는 모순이 생긴다. 위치는 끝이 없어도 항상
  // 참이라 완성 전후를 한 규칙으로 그릴 수 있고, 그래서 여기엔 완성 여부 분기가 없다.
  // 채움은 "이번 슬롯 통과"라 **바퀴가 바뀌어도 비우지 않는다**(2026-08-30 사용자 확정) —
  // 비우려면 데이터에 없는 "바퀴" 개념을 만들어 replace 리마운트 너머까지 영속시켜야 한다.
  // 통과 여부·현재 위치 모두 기존 state에서 파생되므로 새 쿼리가 없다.
  const chainFooter = showChainButton ? (
    <View style={styles.chainFooter}>
      <View style={styles.chainDots}>
        {requiredDayIds.map((id) => {
          const passed = !remaining.includes(id);
          const isCurrent = id === dayIdNum;
          return (
            <View
              key={id}
              style={[
                styles.chainDot,
                passed && styles.chainDotPassed,
                isCurrent && styles.chainDotCurrent,
                isCurrent && passed && styles.chainDotCurrentPassed,
              ]}
            />
          );
        })}
      </View>
      <Pressable style={styles.chainButton} onPress={handleGoNext} hitSlop={8}>
        <Text style={styles.chainButtonText}>{nextDayLabel}</Text>
      </Pressable>
    </View>
  ) : null;

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
            ListFooterComponent={chainFooter}
          />
        </>
      )}

      {mode === 'retrieval' && sirenVisible && <RetrievalSiren />}

      {mode === 'retrieval' && timeOverVisible && (
        <RetrievalTimeOver onRestart={handleCountdownRestart} />
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

export default function DayScreen() {
  const { dayId } = useLocalSearchParams<{ dayId: string }>();
  // ★ 연쇄 복습 버튼이 router.replace로 같은 라우트를 갈아끼운다. expo-router는 파라미터만
  //   바뀌면 리마운트하지 않으므로 이전 Day의 상태(스크롤·가림·카운트다운·체류 타이머·
  //   트래킹 초기화 가드)를 그대로 물고 간다. key로 강제 리마운트해 매번 새 화면이 되게 한다.
  return <DayScreenBody key={dayId} />;
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
// scaleX만으로 배지 단어수 기준 시간(상수부 주석 참조) 동안 선형 감소, 소진 시 타임 오버
// 표시(RetrievalTimeOver)가 뜬다.
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
      <Text style={styles.sirenSubText}>{SIREN_AT_REMAINING_MS / 1000}초 전</Text>
    </View>
  );
}

// 인출모드 타임 오버 표시 (2026-07-20 사용자 요청) — 카운트다운 소진 시 화면 중앙에 표시,
// 배지를 탭하면 카운트다운을 처음부터 다시 시작한다. 컨테이너는 box-none으로 두어 배지
// 바깥의 행 탭/스와이프를 막지 않는다. 자동 소멸 없음(탭 또는 모드 전환/이탈 시에만 사라짐).
function RetrievalTimeOver({ onRestart }: { onRestart: () => void }) {
  return (
    <View style={styles.sirenOverlay} pointerEvents="box-none">
      <Pressable style={styles.timeOverBadge} onPress={onRestart} hitSlop={8}>
        <Text style={styles.timeOverIcon}>⏰</Text>
        <Text style={styles.timeOverText}>타임 오버</Text>
        <Text style={styles.timeOverHint}>탭하면 다시 시작</Text>
      </Pressable>
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
  chainFooter: {
    alignItems: 'center',
    paddingVertical: 20,
    paddingHorizontal: 24,
  },
  // 홈 잔디 게이지의 전구도 "동그란 것 여러 개 = 진행"이라 시각 문법이 겹친다. 뜻은 완전히
  // 다르므로(전구 = 오늘 4바퀴 중 몇 바퀴 / 점 = 이 바퀴 안에서 몇 번째) 인상을 갈라놓는다:
  // 점은 작고 무채색으로 두고 색은 현재 위치에만 준다. 개수도 다르다 — 전구는 4개 고정이고
  // 점은 1 + 오늘의 복습 Day 수(최대 8, REVIEW_OFFSETS가 7개)라 날마다 바뀐다.
  chainDots: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  chainDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    marginHorizontal: 3,
    borderWidth: 1,
    borderColor: '#c7c7c7',
  },
  chainDotPassed: {
    backgroundColor: '#c7c7c7',
  },
  // 지금 여기 — 7px 점에서는 색만으로 잘 안 읽혀 크기도 함께 키운다. 채움(배경색)은 아래
  // chainDotCurrentPassed로 분리했다.
  // ★ 그래서 "현재인데 아직 ○"인 상태가 문법상 존재하지만 **실기기에서는 도달하지 않는다**
  //   (2026-08-30 QA 확인). 푸터가 sessionRecorded 이후에야 마운트되므로 점이 채워진 뒤에
  //   화면에 나타난다 — 차오르는 연출은 없다(설계 당시 있을 거라 본 것은 틀린 예측이었다).
  //   분리는 안전망으로 남겨둔다: 푸터 노출 조건이 바뀌면 그때 제대로 동작한다.
  chainDotCurrent: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    borderColor: '#ff9f43',
  },
  chainDotCurrentPassed: {
    backgroundColor: '#ff9f43',
  },
  chainButton: {
    backgroundColor: '#ff9f43',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  chainButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
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
  sirenSubText: {
    marginTop: 2,
    fontSize: 14,
    fontWeight: '600',
    color: '#c0392b',
  },
  timeOverBadge: {
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 28,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderWidth: 1,
    borderColor: '#c0392b',
  },
  timeOverIcon: {
    fontSize: 56,
  },
  timeOverText: {
    marginTop: 4,
    fontSize: 18,
    fontWeight: 'bold',
    color: '#c0392b',
  },
  timeOverHint: {
    marginTop: 2,
    fontSize: 12,
    color: '#888',
  },
});
