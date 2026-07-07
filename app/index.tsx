import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { epochDayToDateString, todayEpochDay } from '../lib/dates';
import { ensureTodayDay, type DayWithWords } from '../lib/queries';

export default function Index() {
  const [today] = useState(() => epochDayToDateString(todayEpochDay()));
  const [day, setDay] = useState<DayWithWords | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTodayDay = useCallback(() => {
    setLoading(true);
    setError(null);
    ensureTodayDay()
      .then(setDay)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadTodayDay();
  }, [loadTodayDay]);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <Text style={styles.title}>호랑이 잉글리시</Text>
      <Text style={styles.date}>{today}</Text>

      {loading && <ActivityIndicator style={styles.spacing} />}

      {error && <Text style={styles.error}>{error}</Text>}

      {!loading && !error && day && (
        <View style={styles.spacing}>
          <Text style={styles.dayLabel}>Day{day.day_index}</Text>
          <Text style={styles.wordsCount}>단어 {day.words_count}개 준비됨</Text>

          <Pressable
            style={styles.button}
            onPress={() => router.push({ pathname: '/day/[dayId]', params: { dayId: String(day.id) } })}
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
});
