/**
 * 복습 화면 (설계.md §4.2 `review.tsx`, §4.4, §5 Q-REVIEW-DAYS, §7.6 미결 4)
 *
 * 학습일 기준 -1/-3/-7/-14/-30/-60/-120일 전에 생성된 단어장(Day) 목록을 최근순으로
 * 보여준다. 각 항목을 탭하면 기존 Day 상세 라우트(`/day/[dayId]`)를 재사용해 단어장을
 * 그대로 열람한다(복습 전용 가림 UI는 이번 범위 밖 — day 상세 화면 담당 워커 영역).
 *
 * 슬롯 편입(§7.6 미결 4): 슬롯 하나를 채우려면 오늘 단어장 + 오늘의 복습 대상 Day
 * 전부가 필요하고, 슬롯마다 다시 전부 해야 한다. 이 화면은 "이번 슬롯에서 뭘 이미
 * 통과했는지"를 currentSlotIndex() + getSlotPassedDayIds()로 조회해 카드에 표시한다.
 * 화면 focus마다(단어장에서 돌아올 때 즉시 반영되도록) 재조회한다.
 */

import { Stack, router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { epochDayToDateString } from '../../lib/dates';
import { currentSlotIndex, getSlotPassedDayIds } from '../../lib/habitQueries';
import { getReviewDays, type ReviewDay } from '../../lib/reviewQueries';

export default function ReviewScreen() {
  const [days, setDays] = useState<ReviewDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passedDayIds, setPassedDayIds] = useState<number[]>([]);
  const [isDeadZone, setIsDeadZone] = useState(false);

  const load = useCallback(() => {
    setError(null);
    getReviewDays()
      .then(setDays)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));

    // 슬롯 진행 조회는 부가 정보 — 실패해도 복습 열람 자체(메인 흐름)는 막지 않는다
    // (app/index.tsx의 loadHabit과 동일한 관행). 실패 시 통과 집합을 빈 배열로 둔다.
    currentSlotIndex()
      .then((slot) => {
        setIsDeadZone(slot === null);
        return getSlotPassedDayIds(slot);
      })
      .then(setPassedDayIds)
      .catch(() => {
        setIsDeadZone(false);
        setPassedDayIds([]);
      });
  }, []);

  // 단어장에서 복습을 마치고 돌아오면 즉시 완료 표시가 반영돼야 한다.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const passedSet = new Set(passedDayIds);
  const passedCount = days ? days.filter((d) => passedSet.has(d.id)).length : 0;
  const totalCount = days ? days.length : 0;

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
          ListHeaderComponent={
            <Text style={styles.progressSummary}>
              {isDeadZone ? '지금은 기록되지 않는 시간대예요' : `이번 시간대 복습 ${passedCount}/${totalCount}`}
            </Text>
          }
          renderItem={({ item }) => {
            const passed = !isDeadZone && passedSet.has(item.id);
            return (
              <Pressable
                style={[styles.card, passed && styles.cardPassed]}
                onPress={() =>
                  router.push({
                    pathname: '/day/[dayId]',
                    params: {
                      dayId: String(item.id),
                      dayIndex: String(item.day_index),
                      initialMode: 'retrieval',
                    },
                  })
                }
              >
                <View style={styles.cardHeader}>
                  <View style={styles.cardHeaderLeft}>
                    {passed && <Text style={styles.passedCheck}>✓</Text>}
                    <Text style={styles.dayLabel}>Day{item.day_index}</Text>
                  </View>
                  <Text style={styles.offsetBadge}>-{item.offset}일 전</Text>
                </View>
                <Text style={styles.dateText}>{epochDayToDateString(item.created_day)}</Text>
                <Text style={styles.wordsCount}>단어 {item.words_count}개</Text>
              </Pressable>
            );
          }}
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
  progressSummary: {
    fontSize: 13,
    fontWeight: '600',
    color: '#888',
    marginBottom: 12,
  },
  card: {
    backgroundColor: '#f7f7f7',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  cardPassed: {
    opacity: 0.55,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  passedCheck: {
    fontSize: 16,
    fontWeight: '700',
    color: '#2e7d32',
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
