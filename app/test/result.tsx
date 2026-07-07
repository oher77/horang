/**
 * 테스트 결과 요약 화면 (설계.md §4.4 테스트 화면 — "채점 후 점수·오답 저장")
 *
 * 점수(100점 환산)와 오답 단어 목록, 이번 테스트로 적립된 Income 금액을 보여준다.
 * income_amount는 lib/reviewQueries.ts의 saveTestSession이 income_rule을 매칭해
 * 이미 test_session에 스냅샷 저장한 값을 그대로 전달받아 표시만 한다.
 */

import { Stack, router, useLocalSearchParams } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

export default function TestResultScreen() {
  const { score100, correctCount, totalCount, incomeAmount, wrongWords } = useLocalSearchParams<{
    sessionId: string;
    score100: string;
    correctCount: string;
    totalCount: string;
    incomeAmount: string;
    wrongWords: string;
  }>();

  const score = Number(score100) || 0;
  const correct = Number(correctCount) || 0;
  const total = Number(totalCount) || 0;
  const income = Number(incomeAmount) || 0;
  let wrongList: string[] = [];
  try {
    wrongList = wrongWords ? (JSON.parse(wrongWords) as string[]) : [];
  } catch {
    wrongList = [];
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: '테스트 결과', headerBackVisible: false }} />

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.scoreCard}>
          <Text style={styles.scoreLabel}>이번 테스트 점수</Text>
          <Text style={styles.scoreValue}>{score}점</Text>
          <Text style={styles.scoreDetail}>
            {total}문제 중 {correct}개 정답
          </Text>
          <View style={styles.incomeBadge}>
            <Text style={styles.incomeBadgeText}>+{income.toLocaleString()}원 적립</Text>
          </View>
        </View>

        <View style={styles.wrongSection}>
          <Text style={styles.wrongTitle}>오답 단어 ({wrongList.length})</Text>
          {wrongList.length === 0 && <Text style={styles.perfectText}>오답 없이 전부 맞았어요!</Text>}
          {wrongList.map((word, idx) => (
            <View key={`${word}-${idx}`} style={styles.wrongRow}>
              <Text style={styles.wrongWord}>{word}</Text>
            </View>
          ))}
        </View>
      </ScrollView>

      <Pressable style={styles.homeButton} onPress={() => router.replace('/')}>
        <Text style={styles.homeButtonText}>홈으로</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  scrollContent: {
    padding: 24,
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
  wrongSection: {
    marginTop: 32,
  },
  wrongTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#222',
    marginBottom: 12,
  },
  perfectText: {
    fontSize: 14,
    color: '#2e7d32',
  },
  wrongRow: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  wrongWord: {
    fontSize: 16,
    fontWeight: '600',
    color: '#c0392b',
  },
  homeButton: {
    margin: 24,
    backgroundColor: '#222',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  homeButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});
