/**
 * Income(용돈) 장부 화면 (설계.md §4.4 "나의 업적" 화면 중 Income 관련 부분,
 * §5 Q-INCOME-MONTH, §1.3 test_session.income_amount/paid;
 * 단어장 앱 만들기.md "나의 업적 화면 구성" — 이달의 Income, 날짜·단어장·점수·Income·
 * 입금여부 체크 목록)
 *
 * 설계.md §4.2 네비게이션 트리에는 이 목록이 achievements.tsx 한 화면(현재
 * level/추이 그래프 등과 함께) 안의 섹션으로 그려져 있으나, 실제 이 저장소는 drawer
 * 없이 app/day, app/review, app/settings, app/test처럼 기능별 최상위 라우트로
 * 단순화되어 구현되고 있다. 이 컨벤션을 따라 Income 장부만 app/income/index.tsx로
 * 분리했다 — 추이 그래프·현재 level 등 achievements의 나머지 섹션은 이번 작업
 * 범위 밖(다른 워커 영역 아님, 단순히 이번 지시 범위가 "Income 장부"로 한정됨).
 *
 * 실제 결제 연동 없음 — 점수→income_rule 매칭 금액을 보여주고, 부모가 지급했는지
 * 사용자가 직접 체크하는 장부 개념. 체크는 즉시 user.db에 반영된다.
 */

import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  getIncomeSessionsThisMonth,
  getMonthIncomeTotal,
  setSessionPaid,
  type IncomeSessionRow,
} from '../../lib/incomeQueries';

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}.${m}.${day}`;
}

export default function IncomeScreen() {
  const [sessions, setSessions] = useState<IncomeSessionRow[] | null>(null);
  const [monthTotal, setMonthTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([getIncomeSessionsThisMonth(), getMonthIncomeTotal()])
      .then(([rows, total]) => {
        setSessions(rows);
        setMonthTotal(total);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleTogglePaid = useCallback(async (row: IncomeSessionRow) => {
    const next = !row.paid;
    // 낙관적 갱신 — 체크는 즉시 화면에 반영하고 user.db도 즉시 갱신한다.
    setSessions((prev) =>
      prev
        ? prev.map((r) => (r.sessionId === row.sessionId ? { ...r, paid: next } : r))
        : prev,
    );
    try {
      await setSessionPaid(row.sessionId, next);
    } catch (err) {
      // 저장 실패 시 롤백
      setSessions((prev) =>
        prev
          ? prev.map((r) => (r.sessionId === row.sessionId ? { ...r, paid: row.paid } : r))
          : prev,
      );
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Income 장부' }} />

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
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Text style={styles.dayLabel}>Day{item.dayIndex}</Text>
                <Text style={styles.dateText}>{formatDateTime(item.takenMs)}</Text>
              </View>
              <View style={styles.rowMid}>
                <Text style={styles.scoreText}>{item.score100 ?? '-'}점</Text>
                <Text style={styles.incomeText}>
                  {(item.incomeAmount ?? 0).toLocaleString()}원
                </Text>
              </View>
              <Pressable
                style={[styles.paidToggle, item.paid && styles.paidToggleOn]}
                onPress={() => handleTogglePaid(item)}
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
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  summaryCard: {
    margin: 16,
    alignItems: 'center',
    backgroundColor: '#fff1e6',
    borderRadius: 16,
    padding: 20,
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
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f7f7f7',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
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
