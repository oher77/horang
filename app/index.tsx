import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * 홈 화면 — `design/호랑이잉글리시.png` 시안 절대좌표로 배치한다.
 * 좌표와 배율 규칙은 `components/home/mockupLayout.ts` 참조.
 */

import GrassGauge from '../components/home/GrassGauge';
import HomeMenuButtons from '../components/home/HomeMenuButtons';
import { canvasHeight, MOCKUP, place, PLACE } from '../components/home/mockupLayout';
import NotebookBackground, { PAPER_COLOR } from '../components/home/NotebookBackground';
import TigerHero from '../components/home/TigerHero';
import { epochDayToDateString, todayEpochDay } from '../lib/dates';
import { currentSlotIndex, getCurrentStreak, getTodaySlots } from '../lib/habitQueries';
import { ensureTodayDay, type DayWithWords } from '../lib/queries';

export default function Index() {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  /** 시안 px → 화면 px 배율. 이 값 하나로 전체 레이아웃이 결정된다. */
  const s = screenWidth / MOCKUP.width;

  const [today, setToday] = useState(() => epochDayToDateString(todayEpochDay()));
  const [day, setDay] = useState<DayWithWords | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [todaySlots, setTodaySlots] = useState<boolean[] | null>(null);
  const [streak, setStreak] = useState(0);
  const [activeSlot, setActiveSlot] = useState<number | null>(null);

  // silent=true면 스피너 없이 갱신 (focus/포그라운드 복귀 — 이미 화면에 내용이 있음).
  // 앱을 켜둔 채 자정을 넘기면 마운트가 다시 일어나지 않으므로, ensureTodayDay를
  // 마운트 1회가 아니라 복귀 시점마다 재실행해야 새 Day가 생성된다 (멱등이라 안전).
  const loadTodayDay = useCallback((opts?: { silent?: boolean }) => {
    setToday(epochDayToDateString(todayEpochDay()));
    if (!opts?.silent) setLoading(true);
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
        // 습관 게이지는 부가 정보 — 조회 실패해도 메인 흐름(오늘 단어장)은 막지 않는다.
      });
  }, []);

  useEffect(() => {
    loadTodayDay();
  }, [loadTodayDay]);

  // 단어장 화면에서 돌아올 때 게이지 갱신 필요(§7.3) — focus 시마다 재조회.
  // 오늘 Day·날짜 라벨도 함께 갱신 (다른 화면에 머무는 사이 자정을 넘긴 경우 대응).
  useFocusEffect(
    useCallback(() => {
      loadHabit();
      loadTodayDay({ silent: true });
    }, [loadHabit, loadTodayDay]),
  );

  // 앱을 홈 화면에 둔 채 백그라운드로 갔다가 다음 날 복귀하는 경우 — focus 이벤트가
  // 없으므로 AppState active 복귀에서도 갱신해야 새 단어장이 생성된다.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        loadHabit();
        loadTodayDay({ silent: true });
      }
    });
    return () => sub.remove();
  }, [loadHabit, loadTodayDay]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <NotebookBackground>
          <View
            style={{
              height: canvasHeight(s) + insets.top + insets.bottom,
              paddingTop: insets.top,
            }}
          >
            <Pressable style={place(PLACE.sun, s)} onPress={() => router.push('/settings')}>
              <Image
                source={require('../assets/images/btn-settings.png')}
                style={styles.fill}
                resizeMode="contain"
              />
            </Pressable>

            {/* 잔디를 호랑이보다 **먼저** 그린다 — 시안에서 호랑이 발이 잔디를 덮는다. */}
            <View style={place(PLACE.grass, s)}>
              <GrassGauge slots={todaySlots} streak={streak} activeSlot={activeSlot} scale={s} />
            </View>

            {!loading && !error && day && (
              <View style={place(PLACE.tiger, s)}>
                <TigerHero
                  dayIndex={day.day_index}
                  wordsCount={day.words_count}
                  dateLabel={today}
                  onEnterWordbook={() =>
                    router.push({
                      pathname: '/day/[dayId]',
                      params: { dayId: String(day.id), dayIndex: String(day.day_index) },
                    })
                  }
                />
              </View>
            )}

            {loading && <ActivityIndicator style={[place(PLACE.tiger, s), styles.centered]} />}

            {error && (
              <Text style={[place(PLACE.tiger, s), styles.error]} numberOfLines={4}>
                {error}
              </Text>
            )}

            <HomeMenuButtons scale={s} />

            <Image
              source={require('../assets/images/deco-mountains.png')}
              style={place(PLACE.mountains, s)}
              resizeMode="contain"
            />
          </View>
        </NotebookBackground>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: PAPER_COLOR,
  },
  scrollContent: {
    flexGrow: 1,
  },
  // 배치는 전부 place()가 만든 절대좌표다 — 여기에 padding/gap을 두지 않는다.
  fill: {
    width: '100%',
    height: '100%',
  },
  centered: {
    justifyContent: 'center',
  },
  error: {
    color: '#c0392b',
    textAlign: 'center',
    textAlignVertical: 'center',
  },
});
