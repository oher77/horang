/**
 * 복습 화면 (설계.md §4.2 `review.tsx`, §4.4, §5 Q-REVIEW-DAYS)
 *
 * 학습일 기준 -1/-3/-7/-14/-30/-60/-120일 전에 생성된 단어장(Day) 목록을 최근순으로
 * 보여준다. 각 항목을 탭하면 기존 Day 상세 라우트(`/day/[dayId]`)를 재사용해 단어장을
 * 그대로 열람한다(복습 전용 가림 UI는 이번 범위 밖 — day 상세 화면 담당 워커 영역).
 */

import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { epochDayToDateString } from '../../lib/dates';
import { getReviewDays, type ReviewDay } from '../../lib/reviewQueries';

export default function ReviewScreen() {
  const [days, setDays] = useState<ReviewDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    getReviewDays()
      .then(setDays)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: '복습' }} />

      {error && <Text style={styles.error}>{error}</Text>}

      {!error && !days && <ActivityIndicator style={styles.loading} />}

      {!error && days && days.length === 0 && (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>아직 복습할 단어장이 없어요.</Text>
          <Text style={styles.emptySubText}>
            -1/-3/-7/-14/-30/-60/-120일 전에 학습한 단어장이 생기면 여기 표시돼요.
          </Text>
        </View>
      )}

      {!error && days && days.length > 0 && (
        <FlatList
          data={days}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <Pressable
              style={styles.card}
              onPress={() =>
                router.push({
                  pathname: '/day/[dayId]',
                  params: { dayId: String(item.id), dayIndex: String(item.day_index) },
                })
              }
            >
              <View style={styles.cardHeader}>
                <Text style={styles.dayLabel}>Day{item.day_index}</Text>
                <Text style={styles.offsetBadge}>-{item.offset}일 전</Text>
              </View>
              <Text style={styles.dateText}>{epochDayToDateString(item.created_day)}</Text>
              <Text style={styles.wordsCount}>단어 {item.words_count}개</Text>
            </Pressable>
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
    padding: 16,
    gap: 12,
  },
  card: {
    backgroundColor: '#f7f7f7',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dayLabel: {
    fontSize: 18,
    fontWeight: '700',
    color: '#222',
  },
  offsetBadge: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ff8a34',
    backgroundColor: '#fff1e6',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    overflow: 'hidden',
  },
  dateText: {
    marginTop: 6,
    fontSize: 13,
    color: '#888',
  },
  wordsCount: {
    marginTop: 2,
    fontSize: 13,
    color: '#666',
  },
});
