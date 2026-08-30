/**
 * "내 자랑스런 업적" 화면 (설계.md §4.2 achievements.tsx, §4.4 "나의 업적" 행;
 * 단어장 앱 만들기.md "나의 업적 화면 구성")
 *
 * 용돈 장부(월별 Income 추이 + 미지급 우선/지급완료 펼치기) + 낯가림 단어 Top10 +
 * 최근 5일 점수 + 단어 정답/오답 추이(최근 30일 일별) 5개 섹션을 한 스크롤 화면으로
 * 통합한다.
 *
 * 섹션 순서(2026-07-09 사용자 확정): ① 용돈 장부 → ② 낯가림 Top10 → ③ 최근5일 점수
 * → ④ 머리에 들어온 단어(정답 추이) → ⑤ 아직 안 외워진 단어(오답 추이).
 * 기획서 원문 순서(현재 수준 → Income → 점수차트 → 낯가림 → 추이)와는 다르지만
 * 이번 임무의 명시적 지시가 우선한다. "현재 수준(레벨)" 섹션은 여전히 범위 밖.
 *
 * 이번 개편(2026-07-09) 전에는 Q-CORRECT-CUMULATIVE(세션 단위 누적)를 썼으나,
 * "재채점으로 정답↔오답이 뒤집힐 수 있다"는 실제 도메인 규칙과 맞지 않아
 * getWordStateTrend(단어별 최신 상태 시계열)로 대체하며 제거했다.
 */

import { router, Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  DailyTrendBarChart,
  ScoreBarChart,
  shortDateLabel,
  type ScoreBar,
} from '../../components/StatCharts';
import LedgerDetailSheet, { type LedgerSheetRootMode } from '../../components/LedgerDetailSheet';
import WordDetailSheet from '../../components/WordDetailSheet';
import { epochDayToDateString, hourMinute, toEpochDay, todayEpochDay, weekdayLabel } from '../../lib/dates';
import {
  getMonthHabitBonusTotal,
  type HabitBonusRow,
} from '../../lib/habitQueries';
import { getMonthIncomeTotal } from '../../lib/incomeQueries';
import {
  getDailyLedgerSummaries,
  getLedgerEntriesForDay,
  getLedgerTotalForRange,
  getWeeklyLedgerSummaries,
  setRangePaid,
  weekIndexOf,
  weekRangeOf,
  type DayLedgerSummary,
  type LedgerEntry,
  type WeekLedgerSummary,
} from '../../lib/ledgerQueries';
import { useSettingsStore } from '../../lib/settings';
import {
  getMonthlyIncomeTotals,
  getRecentScores,
  getScaryWordsTop10,
  getWordStateTrend,
  type MonthlyIncomePoint,
  type RecentScore,
  type ScaryWord,
  type WordStatePoint,
} from '../../lib/statsQueries';
import { getWordDetail, type WordDetail } from '../../lib/wordDetail';

/** 'YYYY-MM' 형식의 이번 달 키 (habitQueries 조회용, 로컬타임 기준). */
function currentYearMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** kind → 장부 라벨 매핑 (2026-07-11: 슬롯 통과·장기 스트릭 마일스톤 5종 추가). */
const HABIT_BONUS_LABELS: Record<string, string> = {
  full_day: '하루 4회 완주',
  streak7: '7일 연속 보너스',
  streak14: '14일 연속 보너스',
  streak30: '30일 연속 보너스',
  streak60: '60일 연속 보너스',
  streak100: '100일 연속 보너스',
};

/** review_day_{dayId}_s{slotIndex} 형식에서 dayId만 추출한다. 정보 부가 없는 슬롯
 * 번호는 라벨에 넣지 않는다 — 장부는 이미 시각(created_ms)을 보여준다. */
const REVIEW_DAY_KIND_RE = /^review_day_(\d+)_s\d+$/;

function habitBonusLabel(kind: HabitBonusRow['kind']): string {
  // slot_pass_*는 2026-08-25부터 "오늘 단어장 조각 통과" 시점에 즉시 지급된다(그 전에는
  // 슬롯 완성 시점). kind 문자열은 그대로 둬서 과거 행도 같은 라벨로 읽힌다 — 복습 편입
  // 전에는 "슬롯 통과 == 오늘 단어장 통과"였으므로 지난 기록에도 이 라벨이 맞다.
  if (kind.startsWith('slot_pass_')) return '오늘 단어장 통과';
  const reviewMatch = kind.match(REVIEW_DAY_KIND_RE);
  if (reviewMatch) return `Day${reviewMatch[1]} 복습`;
  if (kind.startsWith('review_day_')) return '복습 보너스';
  return HABIT_BONUS_LABELS[kind] ?? kind;
}

/** epoch day → "M/D" 표시 문자열 (세부내역 시트의 날짜별 목록·헤더용). */
function shortMonthDay(epochDay: number): string {
  const iso = epochDayToDateString(epochDay); // "YYYY-MM-DD"
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** epoch day → "2026.8.31 월" (오늘 미리보기 목록의 머리글). 0을 채우지 않는다 —
 * 손으로 쓴 날짜처럼 보이는 쪽이 목록 위 한 줄로 자연스럽다. */
function fullDateLabel(epochDay: number): string {
  const [y, m, d] = epochDayToDateString(epochDay).split('-');
  return `${y}.${Number(m)}.${Number(d)} ${weekdayLabel(epochDay)}`;
}

/** 주 라벨 (스펙 §3.3) — 이번주/지난주는 고정 문구, 그 이전은 "M/D~M/D". */
function weekLabel(week: WeekLedgerSummary, todayDay: number): string {
  const thisWeekIndex = weekIndexOf(todayDay);
  if (week.weekIndex === thisWeekIndex) return '이번주 받은 용돈';
  if (week.weekIndex === thisWeekIndex - 1) return '지난주 받은 용돈';
  return `${shortMonthDay(week.startDay)}~${shortMonthDay(week.endDay)}`;
}

/** "이번주 받은 용돈" 합계 행을 세부내역 시트에 넘기기 위한 임시 WeekLedgerSummary —
 * entryCount/paidCount는 시트가 참조하지 않으므로(범위 조회만 씀) 0으로 채운다. */
function thisWeekPseudoSummary(todayDay: number, total: number): WeekLedgerSummary {
  const weekIndex = weekIndexOf(todayDay);
  const { startDay, endDay } = weekRangeOf(weekIndex);
  return { weekIndex, startDay, endDay, total, entryCount: 0, paidCount: 0 };
}

/** 섹션 맨 위 미리보기에 보여줄 건수. 대상은 **오늘 일어난 일뿐**이다(2026-08-30 사용자
 * 확정) — 전 기간 최신순이면 며칠 쉬었을 때 지난주 항목이 "최근"이라며 올라와, 오늘 뭘
 * 했는지 보러 온 화면에서 오늘과 무관한 것만 보이게 된다. */
const RECENT_PREVIEW_LIMIT = 5;

export default function AchievementsScreen() {
  const [recentScores, setRecentScores] = useState<RecentScore[] | null>(null);
  const [scaryWords, setScaryWords] = useState<ScaryWord[] | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [wordStateTrend, setWordStateTrend] = useState<WordStatePoint[] | null>(null);
  const [wordTrendError, setWordTrendError] = useState<string | null>(null);

  // 용돈 장부 — 집계만 화면 진입 시 로드한다(스펙 §3.6). 개별 항목은 시트를 열 때 조회.
  const [monthTotal, setMonthTotal] = useState(0);
  const [monthlyIncome, setMonthlyIncome] = useState<MonthlyIncomePoint[] | null>(null);
  const [habitBonusTotal, setHabitBonusTotal] = useState(0);
  const [incomeError, setIncomeError] = useState<string | null>(null);

  const [todayLedgerEntries, setTodayLedgerEntries] = useState<LedgerEntry[] | null>(null);
  const [todayTotal, setTodayTotal] = useState<number | null>(null);
  const [thisWeekTotal, setThisWeekTotal] = useState<number | null>(null);
  const [weekSummaries, setWeekSummaries] = useState<WeekLedgerSummary[] | null>(null);
  /** 전 기간에 기록이 하나라도 있는가 — 빈 화면 문구 판정 전용. 미리보기(오늘)나 주
   * 목록(이번주 제외)으로 판정하면 "이번주에만 기록이 있는" 사용자가 빈 화면을 본다. */
  const [hasAnyRecord, setHasAnyRecord] = useState(false);
  const [ledgerListError, setLedgerListError] = useState<string | null>(null);

  const [showPaidWeeks, setShowPaidWeeks] = useState(false);

  // 낯가림 단어 탭 → 단어 상세 바텀시트 (day/[dayId].tsx의 패턴을 그대로 이식).
  const { level } = useSettingsStore();
  const [sheetVisible, setSheetVisible] = useState(false);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sheetDetail, setSheetDetail] = useState<WordDetail | null>(null);

  const loadStats = useCallback(() => {
    setStatsError(null);
    Promise.all([getRecentScores(), getScaryWordsTop10()])
      .then(([scores, scary]) => {
        setRecentScores(scores);
        setScaryWords(scary);
      })
      .catch((err: unknown) => setStatsError(err instanceof Error ? err.message : String(err)));
  }, []);

  const loadWordTrend = useCallback(() => {
    setWordTrendError(null);
    getWordStateTrend(30)
      .then(setWordStateTrend)
      .catch((err: unknown) => setWordTrendError(err instanceof Error ? err.message : String(err)));
  }, []);

  const loadIncome = useCallback(() => {
    setIncomeError(null);
    const yearMonth = currentYearMonth();
    Promise.all([getMonthIncomeTotal(), getMonthHabitBonusTotal(yearMonth), getMonthlyIncomeTotals(6)])
      .then(([testTotal, bonusTotal, trend]) => {
        setMonthTotal(testTotal);
        setHabitBonusTotal(bonusTotal);
        setMonthlyIncome(trend);
      })
      .catch((err: unknown) => setIncomeError(err instanceof Error ? err.message : String(err)));
  }, []);

  // 세부내역 시트가 열려 있는 동안 "그 주(또는 오늘)를 다시 조회하지 않기 위한 캐시" —
  // 화면을 벗어나면 자연 소멸(영속화하지 않는다, 스펙 §3.6). loadLedgerLists가 오늘치를
  // 미리 채워 넣으므로 선언이 그보다 위에 있어야 한다.
  const dayEntriesCache = useRef(new Map<string, LedgerEntry[]>());
  const daySummariesCache = useRef(new Map<string, DayLedgerSummary[]>());

  const loadLedgerLists = useCallback(() => {
    setLedgerListError(null);
    const today = todayEpochDay();
    const thisWeekIndex = weekIndexOf(today);
    const { startDay, endDay } = weekRangeOf(thisWeekIndex);
    Promise.all([
      getLedgerEntriesForDay(today),
      getLedgerTotalForRange(today, today),
      getLedgerTotalForRange(startDay, endDay),
      getWeeklyLedgerSummaries(),
    ])
      .then(([todayEntries, todaySum, weekSum, weeks]) => {
        // 미리보기에는 5건만 쓰지만(아래 slice) 조회는 오늘 하루치를 통째로 해서 캐시에
        // 넣는다 — "오늘 받은 용돈" 시트가 열릴 때 다시 조회할 필요가 없다. 하루치는
        // 기록량이 아니라 하루 활동량에 묶인 상한이라 지연 로드 원칙과 어긋나지 않는다.
        dayEntriesCache.current.set(`day-${today}`, todayEntries);
        setTodayLedgerEntries(todayEntries);
        setTodayTotal(todaySum);
        setThisWeekTotal(weekSum);
        // 모든 기록은 어느 주엔가 속하므로 "weeks가 비었다 == 기록이 하나도 없다"이다.
        setHasAnyRecord(weeks.length > 0);
        // 이번주는 "미지급 주 목록"에 넣지 않는다(스펙 §3.4 — 아직 정산 대상이 아님).
        setWeekSummaries(weeks.filter((w) => w.weekIndex !== thisWeekIndex));
      })
      .catch((err: unknown) => setLedgerListError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    loadStats();
    loadWordTrend();
    loadIncome();
    loadLedgerLists();
  }, [loadStats, loadWordTrend, loadIncome, loadLedgerLists]);

  // weekSummaries에는 이번주가 이미 빠져 있다(위 loadLedgerLists) — 여기서 또 거르지 않는다.
  const unpaidWeeks = useMemo(
    () => (weekSummaries ?? []).filter((w) => w.paidCount < w.entryCount),
    [weekSummaries],
  );
  const paidWeeks = useMemo(
    () => (weekSummaries ?? []).filter((w) => w.paidCount >= w.entryCount && w.entryCount > 0),
    [weekSummaries],
  );

  const invalidateWeekCache = useCallback((startDay: number, endDay: number) => {
    daySummariesCache.current.delete(`week-${startDay}-${endDay}`);
    for (let d = startDay; d <= endDay; d++) {
      dayEntriesCache.current.delete(`day-${d}`);
    }
  }, []);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetRootMode, setSheetRootMode] = useState<LedgerSheetRootMode>('days');
  const [sheetTitle, setSheetTitle] = useState('');
  const [sheetLoadingLedger, setSheetLoadingLedger] = useState(false);
  const [sheetLedgerError, setSheetLedgerError] = useState<string | null>(null);
  const [sheetDaySummaries, setSheetDaySummaries] = useState<DayLedgerSummary[] | null>(null);
  const [sheetRootEntries, setSheetRootEntries] = useState<LedgerEntry[] | null>(null);

  const openTodaySheet = useCallback(() => {
    setSheetOpen(true);
    setSheetRootMode('entries');
    setSheetTitle('오늘 받은 용돈');
    setSheetLedgerError(null);
    setSheetDaySummaries(null);
    const today = todayEpochDay();
    const cacheKey = `day-${today}`;
    const cached = dayEntriesCache.current.get(cacheKey);
    if (cached) {
      setSheetRootEntries(cached);
      setSheetLoadingLedger(false);
      return;
    }
    setSheetLoadingLedger(true);
    setSheetRootEntries(null);
    getLedgerEntriesForDay(today)
      .then((entries) => {
        dayEntriesCache.current.set(cacheKey, entries);
        setSheetRootEntries(entries);
      })
      .catch((err: unknown) => setSheetLedgerError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSheetLoadingLedger(false));
  }, []);

  const openWeekSheet = useCallback((week: WeekLedgerSummary, title: string) => {
    setSheetOpen(true);
    setSheetRootMode('days');
    setSheetTitle(title);
    setSheetLedgerError(null);
    setSheetRootEntries(null);
    const cacheKey = `week-${week.startDay}-${week.endDay}`;
    const cached = daySummariesCache.current.get(cacheKey);
    if (cached) {
      setSheetDaySummaries(cached);
      setSheetLoadingLedger(false);
      return;
    }
    setSheetLoadingLedger(true);
    setSheetDaySummaries(null);
    getDailyLedgerSummaries(week.startDay, week.endDay)
      .then((days) => {
        daySummariesCache.current.set(cacheKey, days);
        setSheetDaySummaries(days);
      })
      .catch((err: unknown) => setSheetLedgerError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSheetLoadingLedger(false));
  }, []);

  const handleRequestDayEntries = useCallback(async (epochDay: number): Promise<LedgerEntry[]> => {
    const cacheKey = `day-${epochDay}`;
    const cached = dayEntriesCache.current.get(cacheKey);
    if (cached) return cached;
    const entries = await getLedgerEntriesForDay(epochDay);
    dayEntriesCache.current.set(cacheKey, entries);
    return entries;
  }, []);

  const handleCloseLedgerSheet = useCallback(() => {
    setSheetOpen(false);
  }, []);

  const handleToggleWeekPaid = useCallback(
    async (week: WeekLedgerSummary) => {
      const nextPaid = week.paidCount < week.entryCount; // 지금 미지급이면 지급으로, 아니면 취소
      // 낙관적 갱신
      setWeekSummaries((prev) =>
        prev
          ? prev.map((w) =>
              w.weekIndex === week.weekIndex ? { ...w, paidCount: nextPaid ? w.entryCount : 0 } : w,
            )
          : prev,
      );
      try {
        await setRangePaid(week.startDay, week.endDay, nextPaid);
        invalidateWeekCache(week.startDay, week.endDay);
      } catch (err) {
        // 롤백
        setWeekSummaries((prev) =>
          prev
            ? prev.map((w) => (w.weekIndex === week.weekIndex ? { ...w, paidCount: week.paidCount } : w))
            : prev,
        );
        setLedgerListError(err instanceof Error ? err.message : String(err));
      }
    },
    [invalidateWeekCache],
  );

  const ledgerLabelFor = useCallback((entry: LedgerEntry): string => {
    if (entry.source === 'test') return `Day${entry.dayIndex} 테스트`;
    return habitBonusLabel(entry.kind ?? '');
  }, []);

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

  return (
    <View style={styles.flexFill}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
        <Stack.Screen options={{ title: '내 자랑스런 업적' }} />

        <Pressable style={styles.bragButton} onPress={() => router.push('/brag')}>
          <Text style={styles.bragButtonText}>🎉 자랑하기</Text>
        </Pressable>

        <IncomeSection
          monthlyIncome={monthlyIncome}
          monthTotal={monthTotal + habitBonusTotal}
          loading={monthlyIncome === null}
          error={incomeError}
          listError={ledgerListError}
          todayEntries={todayLedgerEntries}
          hasAnyRecord={hasAnyRecord}
          todayTotal={todayTotal}
          thisWeekTotal={thisWeekTotal}
          unpaidWeeks={unpaidWeeks}
          paidWeeks={paidWeeks}
          showPaidWeeks={showPaidWeeks}
          onToggleShowPaidWeeks={() => setShowPaidWeeks((v) => !v)}
          labelFor={ledgerLabelFor}
          onOpenToday={openTodaySheet}
          onOpenWeek={openWeekSheet}
          onToggleWeekPaid={handleToggleWeekPaid}
        />

        <ScaryWordsSection words={scaryWords} error={statsError} onWordPress={handleOpenDetail} />

        <RecentScoresSection scores={recentScores} error={statsError} />

        <WordsInSection trend={wordStateTrend} error={wordTrendError} />

        <WordsOutSection trend={wordStateTrend} error={wordTrendError} />
      </ScrollView>

      {/* ScrollView 바깥(화면 루트 레벨)에 렌더해야 시트가 전체 화면 위로 올라온다
          (day/[dayId].tsx와 동일 배치). */}
      <WordDetailSheet
        visible={sheetVisible}
        loading={sheetLoading}
        error={sheetError}
        detail={sheetDetail}
        onClose={handleCloseSheet}
      />

      <LedgerDetailSheet
        visible={sheetOpen}
        rootMode={sheetRootMode}
        title={sheetTitle}
        loading={sheetLoadingLedger}
        error={sheetLedgerError}
        daySummaries={sheetDaySummaries}
        rootEntries={sheetRootEntries}
        onRequestDayEntries={handleRequestDayEntries}
        labelFor={ledgerLabelFor}
        formatDay={shortMonthDay}
        onClose={handleCloseLedgerSheet}
      />
    </View>
  );
}

function RecentScoresSection({ scores, error }: { scores: RecentScore[] | null; error: string | null }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>최근 5일 점수</Text>

      {error && <Text style={styles.error}>{error}</Text>}

      {!error && !scores && <ActivityIndicator style={styles.loading} />}

      {!error && scores && scores.length === 0 && (
        <Text style={styles.emptyText}>최근 5일간 치른 테스트가 없어요.</Text>
      )}

      {!error && scores && scores.length > 0 && (
        // Q-RECENT5는 최신순(DESC)으로 오므로, 그래프는 시간 흐름대로 보이도록 뒤집는다.
        <ScoreBarChart
          bars={[...scores].reverse().map<ScoreBar>((item) => ({
            key: String(item.session_id),
            value: item.score100 ?? 0,
            topLabel: String(item.score100 ?? '-'),
            bottomLabel: shortDateLabel(toEpochDay(new Date(item.taken_ms))),
          }))}
          emptyText="최근 5일간 치른 테스트가 없어요."
        />
      )}
    </View>
  );
}

function ScaryWordsSection({
  words,
  error,
  onWordPress,
}: {
  words: ScaryWord[] | null;
  error: string | null;
  onWordPress: (contentWordId: number) => void;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>낯가림 단어 Top10</Text>

      {error && <Text style={styles.error}>{error}</Text>}

      {!error && !words && <ActivityIndicator style={styles.loading} />}

      {!error && words && words.length === 0 && <Text style={styles.emptyText}>아직 오답이 없어요.</Text>}

      {!error && words && words.length > 0 && (
        <View style={styles.scaryList}>
          {words.map((word, index) => (
            <Pressable
              key={word.content_word_id}
              style={styles.scaryRow}
              onPress={() => onWordPress(word.content_word_id)}
              hitSlop={4}
            >
              <Text style={styles.scaryRank}>{index + 1}</Text>
              <Text style={styles.scaryWord} numberOfLines={1}>
                {word.headword}
              </Text>
              <Text style={styles.scaryCount}>{word.wrong_count}회</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function WordsInSection({ trend, error }: { trend: WordStatePoint[] | null; error: string | null }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>머리에 쏘옥~ 들어온 단어</Text>
      <Text style={styles.sectionSubtitle}>늘어나는 어휘력 늘어나는 영어 실력</Text> 
      {error && <Text style={styles.error}>{error}</Text>}

      {!error && !trend && <ActivityIndicator style={styles.loading} />}

      {!error && trend && <DailyTrendBarChart points={trend} valueOf={(p) => p.correctCount} color="#2e7d32" />}
    </View>
  );
}

function WordsOutSection({ trend, error }: { trend: WordStatePoint[] | null; error: string | null }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>아직 안 외워진 단어</Text>
      {/* <Text style={styles.sectionSubtitle}>늘어나기 마련인데 줄어들고 있다고? 굉장한 아이로군!</Text> */}

      {error && <Text style={styles.error}>{error}</Text>}

      {!error && !trend && <ActivityIndicator style={styles.loading} />}

      {!error && trend && <DailyTrendBarChart points={trend} valueOf={(p) => p.wrongCount} color="#c0392b" />}
    </View>
  );
}

/** 용돈 장부 상단의 월별 Income 추이 미니 막대 그래프 — 공용 ScoreBarChart 재사용. */
function IncomeTrendMiniChart({ points }: { points: MonthlyIncomePoint[] }) {
  return (
    <ScoreBarChart
      bars={points.map<ScoreBar>((p) => ({
        key: p.yearMonth,
        value: p.total,
        topLabel: p.total > 0 ? p.total.toLocaleString() : '',
        bottomLabel: `${Number(p.yearMonth.split('-')[1])}월`,
      }))}
      emptyText={`최근 ${points.length}개월간 Income 기록이 없어요.`}
    />
  );
}

/** 최근 5건 미리보기 1행 — 읽기 전용(지급 버튼 없음). */
function RecentEntryRow({ entry, labelFor }: { entry: LedgerEntry; labelFor: (entry: LedgerEntry) => string }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowLeft}>
        <Text style={styles.dayLabel}>
          {labelFor(entry)}
          <Text style={styles.rowMeta}>{`  ${hourMinute(entry.ms)}`}</Text>
        </Text>
        {entry.source === 'test' && entry.score100 !== null && (
          <Text style={styles.dateText}>{entry.score100}점</Text>
        )}
      </View>
      <Text style={styles.incomeText}>{entry.amount.toLocaleString()}원</Text>
    </View>
  );
}

/** "오늘"/"이번주" 합계 행 — 탭하면 세부내역 시트가 열린다. 지급 버튼 없음(스펙 §3.1). */
function TotalRow({ label, total, onPress }: { label: string; total: number; onPress: () => void }) {
  return (
    <Pressable style={styles.totalRow} onPress={onPress} hitSlop={4}>
      <Text style={styles.totalRowLabel}>{label}</Text>
      <Text style={styles.totalRowAmount}>{total.toLocaleString()}원</Text>
    </Pressable>
  );
}

/** 미지급/지급완료 주 목록 1행 — 라벨·금액·주 일괄 지급 토글, 행 탭 시 세부내역 시트. */
function WeekRow({
  week,
  label,
  onPress,
  onTogglePaid,
}: {
  week: WeekLedgerSummary;
  label: string;
  onPress: () => void;
  onTogglePaid: () => void;
}) {
  const isPaid = week.paidCount >= week.entryCount && week.entryCount > 0;
  return (
    <Pressable style={styles.row} onPress={onPress} hitSlop={4}>
      <View style={styles.rowLeft}>
        <Text style={styles.dayLabel}>{label}</Text>
      </View>
      <View style={styles.rowMid}>
        <Text style={styles.incomeText}>{week.total.toLocaleString()}원</Text>
      </View>
      <Pressable
        style={[styles.paidToggle, isPaid && styles.paidToggleOn]}
        onPress={onTogglePaid}
        hitSlop={8}
      >
        <Text style={[styles.paidToggleText, isPaid && styles.paidToggleTextOn]}>
          {isPaid ? '지급완료' : '미지급'}
        </Text>
      </Pressable>
    </Pressable>
  );
}

function IncomeSection({
  monthlyIncome,
  monthTotal,
  loading,
  error,
  listError,
  todayEntries,
  hasAnyRecord,
  todayTotal,
  thisWeekTotal,
  unpaidWeeks,
  paidWeeks,
  showPaidWeeks,
  onToggleShowPaidWeeks,
  labelFor,
  onOpenToday,
  onOpenWeek,
  onToggleWeekPaid,
}: {
  monthlyIncome: MonthlyIncomePoint[] | null;
  monthTotal: number;
  loading: boolean;
  error: string | null;
  listError: string | null;
  todayEntries: LedgerEntry[] | null;
  hasAnyRecord: boolean;
  todayTotal: number | null;
  thisWeekTotal: number | null;
  unpaidWeeks: WeekLedgerSummary[];
  paidWeeks: WeekLedgerSummary[];
  showPaidWeeks: boolean;
  onToggleShowPaidWeeks: () => void;
  labelFor: (entry: LedgerEntry) => string;
  onOpenToday: () => void;
  onOpenWeek: (week: WeekLedgerSummary, title: string) => void;
  onToggleWeekPaid: (week: WeekLedgerSummary) => void;
}) {
  const hasAnyError = Boolean(error) || Boolean(listError);
  const listLoading = todayEntries === null;
  // 빈 화면 판정은 hasAnyRecord 하나로 한다 — 미리보기가 "오늘"로 좁혀진 뒤로는 목록
  // 길이로 판정할 수 없다(어제까지 열심히 한 아이가 오늘 아침에 열면 셋 다 0이 된다).
  const isEmpty = !loading && !listLoading && !hasAnyError && !hasAnyRecord;

  const today = todayEpochDay();
  const previewEntries = (todayEntries ?? []).slice(0, RECENT_PREVIEW_LIMIT);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>용돈 장부</Text>

      <View style={styles.summaryCard}>
        <Text style={styles.summaryLabel}>이달의 Income</Text>
        <Text style={styles.summaryValue}>{monthTotal.toLocaleString()}원</Text>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}
      {listError && <Text style={styles.error}>{listError}</Text>}

      {(loading || listLoading) && !hasAnyError && <ActivityIndicator style={styles.loading} />}

      {isEmpty && (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>단어장을 공부하면 용돈이 쌓여요.</Text>
          <View style={styles.emptyList}>
            <Text style={styles.emptyListItem}>1. 일정시간 이상 오늘의 단어장 암기</Text>
            <Text style={styles.emptyListItem}>2. 복습할 단어장을 보며 외운 단어 다시 떠올리기</Text>
            <Text style={styles.emptyListItem}>3. 테스트 보기</Text>
            <Text style={styles.emptyListItem}>4. 전구 4개를 다 켜보기</Text>
            <Text style={styles.emptyListItem}>5. 매일매일 지속하면 더 큰 상금이!</Text>
          </View>
        </View>
      )}

      {!loading && !listLoading && !hasAnyError && !isEmpty && (
        <>
          {previewEntries.length > 0 && (
            <>
              <Text style={styles.previewDate}>{fullDateLabel(today)}</Text>
              <View style={styles.listContent}>
                {previewEntries.map((entry) => (
                  <RecentEntryRow key={entry.key} entry={entry} labelFor={labelFor} />
                ))}
              </View>
            </>
          )}

          <View style={styles.totalRowGroup}>
            <TotalRow label="오늘 받은 용돈" total={todayTotal ?? 0} onPress={onOpenToday} />
            <TotalRow
              label="이번주 받은 용돈"
              total={thisWeekTotal ?? 0}
              onPress={() => onOpenWeek(thisWeekPseudoSummary(today, thisWeekTotal ?? 0), '이번주 받은 용돈')}
            />
          </View>

          <View style={[styles.listContent, styles.weekList]}>
            {unpaidWeeks.length === 0 ? (
              <Text style={styles.emptyText}>미지급 내역이 없어요.</Text>
            ) : (
              unpaidWeeks.map((week) => (
                <WeekRow
                  key={week.weekIndex}
                  week={week}
                  label={weekLabel(week, today)}
                  onPress={() => onOpenWeek(week, weekLabel(week, today))}
                  onTogglePaid={() => onToggleWeekPaid(week)}
                />
              ))
            )}
          </View>

          <Pressable style={styles.paidToggleSection} onPress={onToggleShowPaidWeeks} hitSlop={8}>
            <Text style={styles.paidToggleSectionText}>
              {showPaidWeeks ? '지급 완료 접기 ▲' : `지급 완료 ${paidWeeks.length}건 보기 ▼`}
            </Text>
          </Pressable>

          {showPaidWeeks && (
            <View style={styles.listContent}>
              {paidWeeks.length === 0 ? (
                <Text style={styles.emptyText}>지급 완료 내역이 없어요.</Text>
              ) : (
                paidWeeks.map((week) => (
                  <WeekRow
                    key={week.weekIndex}
                    week={week}
                    label={weekLabel(week, today)}
                    onPress={() => onOpenWeek(week, weekLabel(week, today))}
                    onTogglePaid={() => onToggleWeekPaid(week)}
                  />
                ))
              )}
            </View>
          )}
        </>
      )}

      {/* 실기기 QA 피드백(A): 월별 Income 미니 차트는 지급/미지급 리스트 아래(섹션 하단)로 이동.
          요약 합계(summaryCard)는 기존 위치(섹션 상단) 유지. */}
      {!monthlyIncome && <ActivityIndicator style={styles.loading} />}
      {monthlyIncome && (
        <View style={styles.chartBlock}>
          <Text style={styles.chartTitle}>매달 단어를 외워 이만큼 받았어요</Text>
          <IncomeTrendMiniChart points={monthlyIncome} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flexFill: {
    flex: 1,
  },
  scroll: {
    flex: 1,
    backgroundColor: '#fff',
  },
  container: {
    padding: 16,
    gap: 20,
  },
  section: {
    backgroundColor: '#f7f7f7',
    borderRadius: 12,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#222',
    marginBottom: 12,
  },
  sectionSubtitle: {
    fontSize: 12,
    color: '#999',
    marginTop: -8,
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 13,
    color: '#999',
  },
  error: {
    color: '#c0392b',
    textAlign: 'center',
  },
  loading: {
    marginVertical: 12,
  },
  bragButton: {
    backgroundColor: '#ff8a34',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  bragButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  scaryList: {
    gap: 8,
  },
  scaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  scaryRank: {
    width: 20,
    fontSize: 13,
    fontWeight: '700',
    color: '#ff8a34',
  },
  scaryWord: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#222',
  },
  scaryCount: {
    fontSize: 13,
    color: '#888',
  },
  summaryCard: {
    alignItems: 'center',
    backgroundColor: '#fff1e6',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  summaryLabel: {
    fontSize: 14,
    color: '#888',
  },
  summaryValue: {
    marginTop: 8,
    fontSize: 32,
    fontWeight: '800',
    color: '#ff8a34',
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  emptySubText: {
    marginTop: 8,
    fontSize: 13,
    color: '#999',
    textAlign: 'center',
  },
  emptyList: {
    marginTop: 8,
    alignSelf: 'stretch',
    gap: 4,
  },
  emptyListItem: {
    fontSize: 13,
    color: '#999',
    textAlign: 'left',
  },
  previewDate: {
    fontSize: 13,
    fontWeight: '700',
    color: '#888',
    marginBottom: 10,
  },
  listContent: {
    gap: 12,
  },
  // 블록 사이 여백 — 최근 미리보기 / 오늘·이번주 / 주별 목록은 성격이 다른 세 덩어리라
  // 붙어 있으면 한 목록으로 읽힌다(2026-08-30 실기기 피드백).
  totalRowGroup: {
    marginTop: 22,
    gap: 8,
  },
  weekList: {
    marginTop: 22,
  },
  chartBlock: {
    marginTop: 24,
  },
  chartTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#555',
    marginBottom: 10,
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff1e6',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  totalRowLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#b45309',
  },
  totalRowAmount: {
    fontSize: 16,
    fontWeight: '800',
    color: '#b45309',
  },
  paidToggleSection: {
    marginTop: 16,
    alignItems: 'center',
    paddingVertical: 8,
  },
  paidToggleSectionText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#888',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
  },
  rowLeft: {
    flex: 1,
  },
  dayLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: '#222',
  },
  dateText: {
    marginTop: 4,
    fontSize: 12,
    color: '#999',
  },
  // 미션명 옆 부가정보(시각). 미리보기는 오늘분만 보여주므로 날짜는 빼고 시각만 남겼다 —
  // 모든 행이 같은 날짜라 "8/30"이 다섯 번 반복될 뿐이었다(2026-08-30).
  rowMeta: {
    fontSize: 12,
    fontWeight: '400',
    color: '#aaa',
  },
  rowMid: {
    alignItems: 'flex-end',
    marginRight: 12,
  },
  incomeText: {
    marginTop: 4,
    fontSize: 16,
    fontWeight: '700',
    color: '#b45309',
  },
  paidToggle: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#eee',
  },
  paidToggleOn: {
    backgroundColor: '#2e7d32',
  },
  paidToggleText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#888',
  },
  paidToggleTextOn: {
    color: '#fff',
  },
});
