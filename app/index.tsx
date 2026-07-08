import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { epochDayToDateString, todayEpochDay } from '../lib/dates';
import { currentSlotIndex, getCurrentStreak, getTodaySlots } from '../lib/habitQueries';
import { ensureTodayDay, type DayWithWords } from '../lib/queries';

const TOTAL_SLOTS = 4;

export default function Index() {
  const [today] = useState(() => epochDayToDateString(todayEpochDay()));
  const [day, setDay] = useState<DayWithWords | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [todaySlots, setTodaySlots] = useState<boolean[] | null>(null);
  const [streak, setStreak] = useState(0);
  const [activeSlot, setActiveSlot] = useState<number | null>(null);

  const loadTodayDay = useCallback(() => {
    setLoading(true);
    setError(null);
    ensureTodayDay()
      .then(setDay)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  const loadHabit = useCallback(() => {
    Promise.all([getTodaySlots(), getCurrentStreak(), currentSlotIndex()])
      .then(([slots, streakDays, active]) => {
        setTodaySlots(slots);
        setStreak(streakDays);
        setActiveSlot(active);
      })
      .catch(() => {
        // 습관 배너는 부가 정보 — 조회 실패해도 메인 흐름(오늘 단어장)은 막지 않는다.
      });
  }, []);

  useEffect(() => {
    loadTodayDay();
  }, [loadTodayDay]);

  // 단어장 화면에서 돌아올 때 게이지 갱신 필요(§7.3) — focus 시마다 재조회.
  useFocusEffect(
    useCallback(() => {
      loadHabit();
    }, [loadHabit]),
  );

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'horang english' }} />
      <Text style={styles.title}>호랑이 잉글리시</Text>
      <Text style={styles.date}>{today}</Text>

      <HabitBanner slots={todaySlots} streak={streak} activeSlot={activeSlot} />

      {loading && <ActivityIndicator style={styles.spacing} />}

      {error && <Text style={styles.error}>{error}</Text>}

      {!loading && !error && day && (
        <View style={styles.spacing}>
          <Text style={styles.dayLabel}>Day{day.day_index}</Text>
          <Text style={styles.wordsCount}>단어 {day.words_count}개 준비됨</Text>

          <Pressable
            style={styles.button}
            onPress={() =>
              router.push({
                pathname: '/day/[dayId]',
                params: { dayId: String(day.id), dayIndex: String(day.day_index) },
              })
            }
          >
            <Text style={styles.buttonText}>오늘의 단어장 시작하기</Text>
          </Pressable>

          <Pressable style={styles.secondaryButton} onPress={() => router.push('/review')}>
            <Text style={styles.secondaryButtonText}>복습</Text>
          </Pressable>

          <Pressable style={styles.secondaryButton} onPress={() => router.push('/test')}>
            <Text style={styles.secondaryButtonText}>테스트</Text>
          </Pressable>

          <Pressable style={styles.secondaryButton} onPress={() => router.push('/pronunciation')}>
            <Text style={styles.secondaryButtonText}>발음 체크</Text>
          </Pressable>

          <Pressable style={styles.secondaryButton} onPress={() => router.push('/settings')}>
            <Text style={styles.secondaryButtonText}>설정</Text>
          </Pressable>

          <Pressable style={styles.secondaryButton} onPress={() => router.push('/achievements')}>
            <Text style={styles.secondaryButtonText}>내 자랑스런 업적</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

/**
 * 하루 4회 분산 인출 습관 배너 (설계.md §7.3).
 * - 4칸 게이지: 확정 ● / 미확정 ○, 현재 시각이 속한 슬롯은 강조 테두리.
 * - 스트릭 "🔥 N일 연속".
 * - 데드존(activeSlot null)이면 게이지 회색 처리 + 안내 문구.
 */
function HabitBanner({
  slots,
  streak,
  activeSlot,
}: {
  slots: boolean[] | null;
  streak: number;
  activeSlot: number | null;
}) {
  if (!slots) return null;

  const isDeadZone = activeSlot === null;

  return (
    <View style={styles.habitBanner}>
      <View style={styles.habitGauge}>
        {Array.from({ length: TOTAL_SLOTS }, (_, i) => {
          const filled = slots[i];
          const isActive = activeSlot === i;
          return (
            <View
              key={i}
              style={[
                styles.habitDot,
                filled ? styles.habitDotFilled : styles.habitDotEmpty,
                isDeadZone && styles.habitDotDeadZone,
                isActive && styles.habitDotActive,
              ]}
            >
              <Text style={[styles.habitDotText, isDeadZone && styles.habitDotTextDeadZone]}>
                {filled ? '●' : '○'}
              </Text>
            </View>
          );
        })}
      </View>

      <Text style={styles.habitStreak}>🔥 {streak}일 연속</Text>

      {isDeadZone && <Text style={styles.habitDeadZoneHint}>곧 첫 슬롯이 열려요</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: '#fff',
  },
  container: {
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
  },
  date: {
    fontSize: 14,
    color: '#888',
    marginTop: 4,
  },
  spacing: {
    marginTop: 32,
    alignItems: 'center',
  },
  dayLabel: {
    fontSize: 20,
    fontWeight: '600',
  },
  wordsCount: {
    fontSize: 14,
    color: '#666',
    marginTop: 4,
  },
  button: {
    marginTop: 20,
    backgroundColor: '#ff8a34',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 12,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#ff8a34',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
    minWidth: 200,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#ff8a34',
    fontSize: 15,
    fontWeight: '600',
  },
  error: {
    marginTop: 24,
    color: '#c0392b',
    textAlign: 'center',
  },
  habitBanner: {
    marginTop: 16,
    alignItems: 'center',
  },
  habitGauge: {
    flexDirection: 'row',
    gap: 8,
  },
  habitDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  habitDotFilled: {
    backgroundColor: '#fff1e6',
  },
  habitDotEmpty: {
    backgroundColor: '#f2f2f2',
  },
  habitDotDeadZone: {
    backgroundColor: '#eee',
  },
  habitDotActive: {
    borderColor: '#ff8a34',
  },
  habitDotText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#ff8a34',
  },
  habitDotTextDeadZone: {
    color: '#bbb',
  },
  habitStreak: {
    marginTop: 6,
    fontSize: 13,
    fontWeight: '600',
    color: '#666',
  },
  habitDeadZoneHint: {
    marginTop: 4,
    fontSize: 12,
    color: '#999',
  },
});
