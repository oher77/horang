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

import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { epochDayToDateString, toEpochDay } from '../../lib/dates';
import {
  getMonthHabitBonusTotal,
  listHabitBonusesForMonth,
  listUnpaidHabitBonuses,
  setHabitBonusPaid,
  type HabitBonusRow,
} from '../../lib/habitQueries';
import {
  getIncomeSessionsThisMonth,
  getMonthIncomeTotal,
  getUnpaidIncomeSessions,
  setSessionPaid,
  type IncomeSessionRow,
} from '../../lib/incomeQueries';
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

/** 'YYYY-MM' 형식의 이번 달 키 (habitQueries 조회용, 로컬타임 기준). */
function currentYearMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 로컬 기준 이번 달 [시작 ms, 다음달 시작 ms) 범위 — incomeQueries.currentMonthRangeMs와 동일 로직
 * (그쪽은 비공개 함수라 화면에서 "지급완료는 이번 달만" 필터링을 위해 동일 계산을 이 파일에서도 둔다). */
function currentMonthRangeMs(): { startMs: number; nextStartMs: number } {
  const now = new Date();
  return {
    startMs: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
    nextStartMs: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(),
  };
}

function habitBonusLabel(kind: HabitBonusRow['kind']): string {
  return kind === 'full_day' ? '하루 4회 완주' : '7일 연속 보너스';
}

/**
 * 용돈 장부 병합 리스트 1행 — 테스트 수입(test_session)과 습관 보너스(habit_bonus)를
 * 단일 리스트로 보여주기 위한 판별 유니온. 정렬 키는 ms로 통일하되(테스트=takenMs,
 * 보너스=created_ms), 각 행의 표기 방식은 기존 그대로(테스트=날짜·점수, 보너스=
 * local_day 날짜·라벨) 유지한다.
 */
type LedgerItem =
  | { kind: 'test'; ms: number; session: IncomeSessionRow }
  | { kind: 'habit'; ms: number; bonus: HabitBonusRow };

/** 테스트 세션 + 습관 보너스를 ms 내림차순으로 병합한다. */
function mergeLedgerItems(
  sessions: IncomeSessionRow[],
  habitBonuses: HabitBonusRow[],
): LedgerItem[] {
  const items: LedgerItem[] = [
    ...sessions.map((session): LedgerItem => ({ kind: 'test', ms: session.takenMs, session })),
    ...habitBonuses.map((bonus): LedgerItem => ({ kind: 'habit', ms: bonus.created_ms, bonus })),
  ];
  return items.sort((a, b) => b.ms - a.ms);
}

function ledgerItemKey(item: LedgerItem): string {
  return item.kind === 'test' ? `test-${item.session.sessionId}` : `habit-${item.bonus.id}`;
}

const BAR_MAX_HEIGHT = 80;
const TREND_MAX_HEIGHT = 60;

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}.${m}.${day}`;
}

export default function AchievementsScreen() {
  const [recentScores, setRecentScores] = useState<RecentScore[] | null>(null);
  const [scaryWords, setScaryWords] = useState<ScaryWord[] | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [wordStateTrend, setWordStateTrend] = useState<WordStatePoint[] | null>(null);
  const [wordTrendError, setWordTrendError] = useState<string | null>(null);

  // 미지급(전체 기간) ∪ 이번 달(전체 상태) 세션을 sessionId로 병합한 단일 소스.
  // 지급 토글은 이 배열 안에서 in-place로 반영하고, 화면에 보여줄 "미지급"/
  // "이번 달 지급완료" 두 그룹은 아래 useMemo로 파생한다(다른 달의 지급완료
  // 건은 애초에 로드하지 않으므로 파생 결과에도 나타나지 않는다 — 스펙 의도대로).
  const [incomeSessions, setIncomeSessions] = useState<IncomeSessionRow[] | null>(null);
  const [monthTotal, setMonthTotal] = useState(0);
  const [monthlyIncome, setMonthlyIncome] = useState<MonthlyIncomePoint[] | null>(null);
  const [incomeError, setIncomeError] = useState<string | null>(null);

  const [habitBonuses, setHabitBonuses] = useState<HabitBonusRow[] | null>(null);
  const [habitBonusTotal, setHabitBonusTotal] = useState(0);
  const [habitError, setHabitError] = useState<string | null>(null);

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
    Promise.all([
      getUnpaidIncomeSessions(),
      getIncomeSessionsThisMonth(),
      getMonthIncomeTotal(),
      getMonthlyIncomeTotals(6),
    ])
      .then(([unpaid, month, total, trend]) => {
        const merged = new Map<number, IncomeSessionRow>();
        for (const s of unpaid) merged.set(s.sessionId, s);
        for (const s of month) merged.set(s.sessionId, s);
        setIncomeSessions(Array.from(merged.values()));
        setMonthTotal(total);
        setMonthlyIncome(trend);
      })
      .catch((err: unknown) => setIncomeError(err instanceof Error ? err.message : String(err)));
  }, []);

  const loadHabit = useCallback(() => {
    setHabitError(null);
    const yearMonth = currentYearMonth();
    Promise.all([listUnpaidHabitBonuses(), listHabitBonusesForMonth(yearMonth), getMonthHabitBonusTotal(yearMonth)])
      .then(([unpaid, month, total]) => {
        const merged = new Map<number, HabitBonusRow>();
        for (const b of unpaid) merged.set(b.id, b);
        for (const b of month) merged.set(b.id, b);
        setHabitBonuses(Array.from(merged.values()));
        setHabitBonusTotal(total);
      })
      .catch((err: unknown) => setHabitError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    loadStats();
    loadWordTrend();
    loadIncome();
    loadHabit();
  }, [loadStats, loadWordTrend, loadIncome, loadHabit]);

  const unpaidItems = useMemo<LedgerItem[]>(() => {
    if (!incomeSessions || !habitBonuses) return [];
    return mergeLedgerItems(
      incomeSessions.filter((s) => !s.paid),
      habitBonuses.filter((b) => !b.paid),
    );
  }, [incomeSessions, habitBonuses]);

  const paidItemsThisMonth = useMemo<LedgerItem[]>(() => {
    if (!incomeSessions || !habitBonuses) return [];
    const { startMs, nextStartMs } = currentMonthRangeMs();
    return mergeLedgerItems(
      incomeSessions.filter((s) => s.paid && s.takenMs >= startMs && s.takenMs < nextStartMs),
      habitBonuses.filter((b) => b.paid && b.created_ms >= startMs && b.created_ms < nextStartMs),
    );
  }, [incomeSessions, habitBonuses]);

  const handleTogglePaid = useCallback(async (row: IncomeSessionRow) => {
    const next = !row.paid;
    // 낙관적 갱신 — 체크는 즉시 화면에 반영하고 user.db도 즉시 갱신한다.
    setIncomeSessions((prev) =>
      prev ? prev.map((r) => (r.sessionId === row.sessionId ? { ...r, paid: next } : r)) : prev,
    );
    try {
      await setSessionPaid(row.sessionId, next);
    } catch (err) {
      // 저장 실패 시 롤백
      setIncomeSessions((prev) =>
        prev ? prev.map((r) => (r.sessionId === row.sessionId ? { ...r, paid: row.paid } : r)) : prev,
      );
      setIncomeError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleToggleHabitPaid = useCallback(async (row: HabitBonusRow) => {
    const next = !row.paid;
    setHabitBonuses((prev) => (prev ? prev.map((r) => (r.id === row.id ? { ...r, paid: next } : r)) : prev));
    try {
      await setHabitBonusPaid(row.id, next);
    } catch (err) {
      setHabitBonuses((prev) => (prev ? prev.map((r) => (r.id === row.id ? { ...r, paid: row.paid } : r)) : prev));
      setHabitError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: '내 자랑스런 업적' }} />

      <IncomeSection
        monthlyIncome={monthlyIncome}
        monthTotal={monthTotal + habitBonusTotal}
        loading={incomeSessions === null || habitBonuses === null}
        error={incomeError}
        habitError={habitError}
        unpaidItems={unpaidItems}
        paidItemsThisMonth={paidItemsThisMonth}
        onTogglePaid={handleTogglePaid}
        onToggleHabitPaid={handleToggleHabitPaid}
      />

      <ScaryWordsSection words={scaryWords} error={statsError} />

      <RecentScoresSection scores={recentScores} error={statsError} />

      <WordsInSection trend={wordStateTrend} error={wordTrendError} />

      <WordsOutSection trend={wordStateTrend} error={wordTrendError} />
    </ScrollView>
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
        <View style={styles.barRow}>
          {/* Q-RECENT5는 최신순(DESC)으로 오므로, 그래프는 시간 흐름대로 보이도록 뒤집는다. */}
          {[...scores].reverse().map((item) => {
            const score = item.score100 ?? 0;
            const barHeight = Math.max((score / 100) * BAR_MAX_HEIGHT, 2);
            return (
              <View key={item.session_id} style={styles.barItem}>
                <Text style={styles.barScoreLabel}>{item.score100 ?? '-'}</Text>
                <View style={styles.barTrack}>
                  <View style={[styles.barFill, { height: barHeight }]} />
                </View>
                <Text style={styles.barDateLabel}>
                  {epochDayToDateString(toEpochDay(new Date(item.taken_ms))).slice(5)}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

function ScaryWordsSection({ words, error }: { words: ScaryWord[] | null; error: string | null }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>낯가림 단어 Top10</Text>

      {error && <Text style={styles.error}>{error}</Text>}

      {!error && !words && <ActivityIndicator style={styles.loading} />}

      {!error && words && words.length === 0 && <Text style={styles.emptyText}>아직 오답이 없어요.</Text>}

      {!error && words && words.length > 0 && (
        <View style={styles.scaryList}>
          {words.map((word, index) => (
            <View key={word.content_word_id} style={styles.scaryRow}>
              <Text style={styles.scaryRank}>{index + 1}</Text>
              <Text style={styles.scaryWord} numberOfLines={1}>
                {word.headword}
              </Text>
              <Text style={styles.scaryCount}>{word.wrong_count}회</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * WordsIn/WordsOut 공용 일별 30일 추이 막대 그래프 (View 기반, 라이브러리 없음).
 * y스케일은 시리즈 최댓값 기준 정규화하고, 최댓값이 0이면 플레이스홀더 텍스트로
 * 대체한다. 값 라벨은 마지막(오늘) 막대 위에만, 날짜 라벨은 첫날/중간/오늘만 표시해
 * 30개 막대가 화면 폭에 가로 스크롤 없이 들어가게 한다.
 */
function DailyTrendBarChart({
  points,
  valueOf,
  color,
}: {
  points: WordStatePoint[];
  valueOf: (p: WordStatePoint) => number;
  color: string;
}) {
  const values = points.map(valueOf);
  const max = Math.max(0, ...values);

  if (max === 0) {
    return <Text style={styles.emptyText}>아직 테스트 기록이 없어요.</Text>;
  }

  const midIndex = Math.floor((points.length - 1) / 2);

  return (
    <View style={styles.trendRow}>
      {points.map((p, index) => {
        const value = valueOf(p);
        const barHeight = value > 0 ? Math.max((value / max) * TREND_MAX_HEIGHT, 2) : 0;
        const isLast = index === points.length - 1;
        const showDateLabel = index === 0 || index === midIndex || isLast;
        return (
          <View key={p.day} style={styles.trendBarItem}>
            <Text style={styles.trendValueLabel}>{isLast ? value : ''}</Text>
            <View style={styles.trendBarTrack}>
              <View style={[styles.trendBarFill, { height: barHeight, backgroundColor: color }]} />
            </View>
            <Text style={styles.trendDateLabel} numberOfLines={1}>
              {showDateLabel ? epochDayToDateString(p.day).slice(5) : ''}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function WordsInSection({ trend, error }: { trend: WordStatePoint[] | null; error: string | null }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>머리에 들어온 단어</Text>

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
      <Text style={styles.sectionSubtitle}>줄어드는 구간이 보이면 칭찬 타이밍!</Text>

      {error && <Text style={styles.error}>{error}</Text>}

      {!error && !trend && <ActivityIndicator style={styles.loading} />}

      {!error && trend && <DailyTrendBarChart points={trend} valueOf={(p) => p.wrongCount} color="#c0392b" />}
    </View>
  );
}

/** 용돈 장부 상단의 월별 Income 추이 미니 막대 그래프 — RecentScoresSection의 View-바 패턴 재사용. */
function IncomeTrendMiniChart({ points }: { points: MonthlyIncomePoint[] }) {
  const max = Math.max(0, ...points.map((p) => p.total));

  if (max === 0) {
    return <Text style={styles.emptyText}>최근 {points.length}개월간 Income 기록이 없어요.</Text>;
  }

  return (
    <View style={styles.barRow}>
      {points.map((p) => {
        const barHeight = p.total > 0 ? Math.max((p.total / max) * BAR_MAX_HEIGHT, 2) : 0;
        const month = Number(p.yearMonth.split('-')[1]);
        return (
          <View key={p.yearMonth} style={styles.barItem}>
            <Text style={styles.barScoreLabel}>{p.total > 0 ? p.total.toLocaleString() : ''}</Text>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { height: barHeight }]} />
            </View>
            <Text style={styles.barDateLabel}>{month}월</Text>
          </View>
        );
      })}
    </View>
  );
}

/** 용돈 장부 병합 리스트 1행 렌더 — 미지급/지급완료 두 그룹에서 공유한다. */
function LedgerRow({
  item,
  onTogglePaid,
  onToggleHabitPaid,
}: {
  item: LedgerItem;
  onTogglePaid: (row: IncomeSessionRow) => void;
  onToggleHabitPaid: (row: HabitBonusRow) => void;
}) {
  if (item.kind === 'test') {
    const session = item.session;
    return (
      <View style={styles.row}>
        <View style={styles.rowLeft}>
          <Text style={styles.dayLabel}>Day{session.dayIndex}</Text>
          <Text style={styles.dateText}>{formatDateTime(session.takenMs)}</Text>
        </View>
        <View style={styles.rowMid}>
          <Text style={styles.scoreText}>{session.score100 ?? '-'}점</Text>
          <Text style={styles.incomeText}>{(session.incomeAmount ?? 0).toLocaleString()}원</Text>
        </View>
        <Pressable
          style={[styles.paidToggle, session.paid && styles.paidToggleOn]}
          onPress={() => onTogglePaid(session)}
          hitSlop={8}
        >
          <Text style={[styles.paidToggleText, session.paid && styles.paidToggleTextOn]}>
            {session.paid ? '지급완료' : '미지급'}
          </Text>
        </Pressable>
      </View>
    );
  }

  const bonus = item.bonus;
  return (
    <View style={styles.row}>
      <View style={styles.rowLeft}>
        <Text style={styles.dayLabel}>{habitBonusLabel(bonus.kind)}</Text>
        <Text style={styles.dateText}>{epochDayToDateString(bonus.local_day)}</Text>
      </View>
      <View style={styles.rowMid}>
        <Text style={styles.incomeText}>{bonus.amount.toLocaleString()}원</Text>
      </View>
      <Pressable
        style={[styles.paidToggle, bonus.paid && styles.paidToggleOn]}
        onPress={() => onToggleHabitPaid(bonus)}
        hitSlop={8}
      >
        <Text style={[styles.paidToggleText, bonus.paid && styles.paidToggleTextOn]}>
          {bonus.paid ? '지급완료' : '미지급'}
        </Text>
      </Pressable>
    </View>
  );
}

function IncomeSection({
  monthlyIncome,
  monthTotal,
  loading,
  error,
  habitError,
  unpaidItems,
  paidItemsThisMonth,
  onTogglePaid,
  onToggleHabitPaid,
}: {
  monthlyIncome: MonthlyIncomePoint[] | null;
  monthTotal: number;
  loading: boolean;
  error: string | null;
  habitError: string | null;
  unpaidItems: LedgerItem[];
  paidItemsThisMonth: LedgerItem[];
  onTogglePaid: (row: IncomeSessionRow) => void;
  onToggleHabitPaid: (row: HabitBonusRow) => void;
}) {
  const [showPaid, setShowPaid] = useState(false);
  const hasAnyError = Boolean(error) || Boolean(habitError);
  const isEmpty = !loading && !hasAnyError && unpaidItems.length === 0 && paidItemsThisMonth.length === 0;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>용돈 장부</Text>

      {!monthlyIncome && <ActivityIndicator style={styles.loading} />}
      {monthlyIncome && <IncomeTrendMiniChart points={monthlyIncome} />}

      <View style={styles.summaryCard}>
        <Text style={styles.summaryLabel}>이달의 Income</Text>
        <Text style={styles.summaryValue}>{monthTotal.toLocaleString()}원</Text>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}
      {habitError && <Text style={styles.error}>{habitError}</Text>}

      {loading && !hasAnyError && <ActivityIndicator style={styles.loading} />}

      {isEmpty && (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>테스트 기록이 없어요.</Text>
          <Text style={styles.emptySubText}>테스트를 완료하면 여기에 Income이 쌓여요.</Text>
        </View>
      )}

      {!loading && !hasAnyError && !isEmpty && (
        <>
          {unpaidItems.length > 0 ? (
            <View style={styles.listContent}>
              {unpaidItems.map((item) => (
                <LedgerRow
                  key={ledgerItemKey(item)}
                  item={item}
                  onTogglePaid={onTogglePaid}
                  onToggleHabitPaid={onToggleHabitPaid}
                />
              ))}
            </View>
          ) : (
            <Text style={styles.emptyText}>미지급 내역이 없어요.</Text>
          )}

          <Pressable style={styles.paidToggleSection} onPress={() => setShowPaid((v) => !v)} hitSlop={8}>
            <Text style={styles.paidToggleSectionText}>
              {showPaid ? '지급 완료 접기 ▲' : `지급 완료 ${paidItemsThisMonth.length}건 보기 ▼`}
            </Text>
          </Pressable>

          {showPaid && (
            <View style={styles.listContent}>
              {paidItemsThisMonth.length === 0 ? (
                <Text style={styles.emptyText}>이번 달 지급 완료 내역이 없어요.</Text>
              ) : (
                paidItemsThisMonth.map((item) => (
                  <LedgerRow
                    key={ledgerItemKey(item)}
                    item={item}
                    onTogglePaid={onTogglePaid}
                    onToggleHabitPaid={onToggleHabitPaid}
                  />
                ))
              )}
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
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
  barRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'flex-end',
    marginBottom: 16,
  },
  barItem: {
    alignItems: 'center',
    width: 48,
  },
  barScoreLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#444',
    marginBottom: 4,
  },
  barTrack: {
    width: 20,
    height: BAR_MAX_HEIGHT,
    justifyContent: 'flex-end',
  },
  barFill: {
    width: 20,
    borderRadius: 4,
    backgroundColor: '#ff8a34',
  },
  barDateLabel: {
    marginTop: 6,
    fontSize: 11,
    color: '#999',
  },
  trendRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  trendBarItem: {
    flex: 1,
    alignItems: 'center',
  },
  trendBarTrack: {
    width: 4,
    height: TREND_MAX_HEIGHT,
    justifyContent: 'flex-end',
  },
  trendBarFill: {
    width: 4,
    borderRadius: 2,
  },
  trendValueLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#444',
    marginBottom: 2,
    height: 14,
  },
  trendDateLabel: {
    marginTop: 4,
    fontSize: 9,
    color: '#999',
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
  listContent: {
    gap: 12,
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
  rowMid: {
    alignItems: 'flex-end',
    marginRight: 12,
  },
  scoreText: {
    fontSize: 14,
    color: '#666',
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
