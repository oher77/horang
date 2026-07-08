/**
 * "내 자랑스런 업적" 화면 (설계.md §4.2 achievements.tsx, §4.4 "나의 업적" 행;
 * 단어장 앱 만들기.md "나의 업적 화면 구성")
 *
 * 최근 5일 점수 차트 + 낯가림 단어 Top10 + 용돈 장부(이달 합계·내역·지급 토글)를
 * 한 스크롤 화면으로 통합한다. 기존에 app/index.tsx에 인라인으로 붙어있던
 * <HomeStats />(components/stats/HomeStats.tsx)와, 별도 라우트였던
 * app/income/index.tsx의 기능을 이 화면 안의 섹션들로 이전했다.
 *
 * 기획서 "나의 업적 화면 구성" 순서: 현재 수준 → 이달의 Income → 최근 5일 점수
 * (장부: 날짜·단어장·점수·Income·입금여부) → 낯가림 Top10 → 추이 그래프들.
 * 이번 임무 범위는 사용자가 명시한 3섹션(최근5일 점수 차트, 낯가림 Top10, 용돈장부)
 * 뿐이라 "현재 수준"과 각종 추이 그래프(월별 Income/점수/오답 추이, 정답 누적 추이)는
 * 이번 구현에서 제외했다 — 설계.md §4.4 표에 나열된 Q-INCOME-TREND/Q-SCORE-TREND/
 * Q-WRONG-TREND/Q-CORRECT-CUMULATIVE는 범위 밖(완료 보고에 명시).
 *
 * 섹션 순서는 사용자 지시 순서(① 최근5일 점수 차트 → ② 낯가림 Top10 → ③ 용돈장부)를
 * 그대로 따른다 — 기획서 순서(Income이 점수 차트보다 먼저)와 다르지만, 이번 임무의
 * 명시적 지시가 우선한다.
 */

import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { epochDayToDateString, toEpochDay } from '../../lib/dates';
import {
  getMonthHabitBonusTotal,
  listHabitBonusesForMonth,
  setHabitBonusPaid,
  type HabitBonusRow,
} from '../../lib/habitQueries';
import {
  getIncomeSessionsThisMonth,
  getMonthIncomeTotal,
  setSessionPaid,
  type IncomeSessionRow,
} from '../../lib/incomeQueries';
import { getRecentScores, getScaryWordsTop10, type RecentScore, type ScaryWord } from '../../lib/statsQueries';

/** 'YYYY-MM' 형식의 이번 달 키 (habitQueries 조회용, 로컬타임 기준). */
function currentYearMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function habitBonusLabel(kind: HabitBonusRow['kind']): string {
  return kind === 'full_day' ? '하루 4회 완주' : '7일 연속 보너스';
}

const BAR_MAX_HEIGHT = 80;

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

  const [incomeSessions, setIncomeSessions] = useState<IncomeSessionRow[] | null>(null);
  const [monthTotal, setMonthTotal] = useState(0);
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

  const loadIncome = useCallback(() => {
    setIncomeError(null);
    Promise.all([getIncomeSessionsThisMonth(), getMonthIncomeTotal()])
      .then(([rows, total]) => {
        setIncomeSessions(rows);
        setMonthTotal(total);
      })
      .catch((err: unknown) => setIncomeError(err instanceof Error ? err.message : String(err)));
  }, []);

  const loadHabit = useCallback(() => {
    setHabitError(null);
    const yearMonth = currentYearMonth();
    Promise.all([listHabitBonusesForMonth(yearMonth), getMonthHabitBonusTotal(yearMonth)])
      .then(([rows, total]) => {
        setHabitBonuses(rows);
        setHabitBonusTotal(total);
      })
      .catch((err: unknown) => setHabitError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    loadStats();
    loadIncome();
    loadHabit();
  }, [loadStats, loadIncome, loadHabit]);

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

      <RecentScoresSection scores={recentScores} error={statsError} />

      <ScaryWordsSection words={scaryWords} error={statsError} />

      <IncomeSection
        sessions={incomeSessions}
        monthTotal={monthTotal + habitBonusTotal}
        error={incomeError}
        onTogglePaid={handleTogglePaid}
        habitBonuses={habitBonuses}
        habitError={habitError}
        onToggleHabitPaid={handleToggleHabitPaid}
      />
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

function IncomeSection({
  sessions,
  monthTotal,
  error,
  onTogglePaid,
  habitBonuses,
  habitError,
  onToggleHabitPaid,
}: {
  sessions: IncomeSessionRow[] | null;
  monthTotal: number;
  error: string | null;
  onTogglePaid: (row: IncomeSessionRow) => void;
  habitBonuses: HabitBonusRow[] | null;
  habitError: string | null;
  onToggleHabitPaid: (row: HabitBonusRow) => void;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>용돈 장부</Text>

      <View style={styles.summaryCard}>
        <Text style={styles.summaryLabel}>이달의 Income</Text>
        <Text style={styles.summaryValue}>{monthTotal.toLocaleString()}원</Text>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      {!error && !sessions && <ActivityIndicator style={styles.loading} />}

      {!error && sessions && sessions.length === 0 && (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>이번 달 테스트 기록이 없어요.</Text>
          <Text style={styles.emptySubText}>테스트를 완료하면 여기에 Income이 쌓여요.</Text>
        </View>
      )}

      {!error && sessions && sessions.length > 0 && (
        <FlatList
          data={sessions}
          keyExtractor={(item) => String(item.sessionId)}
          scrollEnabled={false}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Text style={styles.dayLabel}>Day{item.dayIndex}</Text>
                <Text style={styles.dateText}>{formatDateTime(item.takenMs)}</Text>
              </View>
              <View style={styles.rowMid}>
                <Text style={styles.scoreText}>{item.score100 ?? '-'}점</Text>
                <Text style={styles.incomeText}>{(item.incomeAmount ?? 0).toLocaleString()}원</Text>
              </View>
              <Pressable
                style={[styles.paidToggle, item.paid && styles.paidToggleOn]}
                onPress={() => onTogglePaid(item)}
                hitSlop={8}
              >
                <Text style={[styles.paidToggleText, item.paid && styles.paidToggleTextOn]}>
                  {item.paid ? '지급완료' : '미지급'}
                </Text>
              </Pressable>
            </View>
          )}
        />
      )}

      {habitError && <Text style={styles.error}>{habitError}</Text>}

      {!habitError && habitBonuses && habitBonuses.length > 0 && (
        <FlatList
          data={habitBonuses}
          keyExtractor={(item) => String(item.id)}
          scrollEnabled={false}
          contentContainerStyle={styles.habitListContent}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Text style={styles.dayLabel}>{habitBonusLabel(item.kind)}</Text>
                <Text style={styles.dateText}>{epochDayToDateString(item.local_day)}</Text>
              </View>
              <View style={styles.rowMid}>
                <Text style={styles.incomeText}>{item.amount.toLocaleString()}원</Text>
              </View>
              <Pressable
                style={[styles.paidToggle, item.paid && styles.paidToggleOn]}
                onPress={() => onToggleHabitPaid(item)}
                hitSlop={8}
              >
                <Text style={[styles.paidToggleText, item.paid && styles.paidToggleTextOn]}>
                  {item.paid ? '지급완료' : '미지급'}
                </Text>
              </Pressable>
            </View>
          )}
        />
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
  habitListContent: {
    gap: 12,
    marginTop: 12,
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
