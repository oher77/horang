import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
// ★ ScrollView는 반드시 gesture-handler 것을 쓴다 (react-native 것 아님).
// `blocksExternalGesture()`는 gesture-handler가 아는 핸들러만 차단할 수 있는데,
// RN 기본 ScrollView는 등록돼 있지 않아 차단 관계가 조용히 무시된다. 그러면 머리
// "아래로 당기기" Pan과 UIScrollView의 내장 pan이 네이티브에서 그냥 경쟁해서,
// 같은 동작인데도 어떨 땐 스크롤이 되고 어떨 땐 당기기가 되는 현상이 생긴다
// (2026-08-14 실기기에서 발생).
import { ScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * 홈 화면 — `design/호랑이잉글리시.png` 시안 좌표로 절대배치한다.
 *
 * 단, **세로 기준점은 시안이 아니라 안전영역**이다(`PLACE`의 y = 시안 y − 222).
 * 시안이 원본인 것은 요소 간 **상대** 위치이고, 화면에서의 절대 세로 위치는 아니다.
 * 좌표계·배율 규칙과 그 근거는 `components/home/mockupLayout.ts` 헤더 참조.
 */

import GrassGauge from '../components/home/GrassGauge';
import HomeMenuButtons from '../components/home/HomeMenuButtons';
import {
  canvasHeight,
  MOCKUP_WIDTH,
  place,
  PLACE,
  TOP_GAP_DESIGN_PX,
} from '../components/home/mockupLayout';
import NotebookBackground, { PAPER_COLOR } from '../components/home/NotebookBackground';
import TigerHero from '../components/home/TigerHero';
import { epochDayToDateString, todayEpochDay } from '../lib/dates';
import { currentSlotIndex, getCurrentStreak, getTodaySlots } from '../lib/habitQueries';
import { ensureTodayDay, type DayWithWords } from '../lib/queries';

export default function Index() {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  /** 시안 px → 화면 px 배율. 이 값 하나로 전체 레이아웃이 결정된다. */
  const s = screenWidth / MOCKUP_WIDTH;
  /** 호랑이 머리 "아래로 당기기" 제스처가 세로 스크롤을 이기게 하는 데 필요한 ref. */
  const scrollRef = useRef<ScrollView>(null);

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
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        <NotebookBackground>
          {/*
            상단 앵커 — 캔버스는 안전영역 아래끝에서 시작한다 (2026-08-15).
            `PLACE`의 y가 이미 안전영역 기준(시안 y − 222)이라 여기서 인셋만 얹으면 된다.
            근거와 기기별 수치는 `mockupLayout.ts` 헤더 참조.

            **인셋을 `paddingTop`으로 주지 말 것.** 캔버스 자식이 전부 `position:'absolute'`라
            padding이 자식을 밀지 못하고 높이만 늘려서, 그 인셋이 통째로 캔버스 **아래**
            여백으로 남는다(2026-08-15 실기기에서 발생). 형제 View의 높이로 줘야 한다.
          */}
          <View style={{ height: insets.top + TOP_GAP_DESIGN_PX * s }} />

          {/*
            **하단에는 인셋을 주지 않는다.** 캔버스 맨 아래 `deco-mountains`가 장식 띠라
            홈 인디케이터가 그 위에 얹혀도 가려질 정보가 없고 탭할 것도 없다. 오히려
            여백이 생기면 시안이 거기서 끊긴 것처럼 보인다.
            **여백이 없다고 버그로 오해해 인셋을 더하지 말 것.**
            (단어장 화면은 반대다 — 마지막 행의 좌우 스와이프가 시스템 제스처와 겹치므로
             하단 인셋이 필요하다. app/day/[dayId].tsx 참조.)
          */}
          <View style={{ height: canvasHeight(s) }}>
            <Pressable style={place(PLACE.sun, s)} onPress={() => router.push('/settings')}>
              <Image
                source={require('../assets/images/btn-settings.png')}
                style={styles.fill}
                resizeMode="contain"
              />
            </Pressable>

            {!loading && !error && day && (
              <View style={place(PLACE.tiger, s)}>
                <TigerHero
                  dayIndex={day.day_index}
                  wordsCount={day.words_count}
                  dateLabel={today}
                  scrollRef={scrollRef}
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

            {/*
              잔디를 호랑이보다 **나중에** 그린다 — 시안에서 잔디가 호랑이 발을 덮는다.
              (2026-08-14 정정. 그 전엔 반대로 알고 순서가 뒤바뀌어 있었다.)
              잔디 위쪽은 풀잎 끝이라 거의 투명해서, 순서만 바꿔도 발이 풀 사이로 비치는
              시안 모습이 그대로 재현된다 — 별도 마스킹 불필요.
              말풍선 탭 영역 아래 16px과 겹치지만 GrassGauge가 pointerEvents="none"이라
              터치는 그대로 통과한다.
            */}
            <View style={place(PLACE.grass, s)}>
              <GrassGauge slots={todaySlots} streak={streak} activeSlot={activeSlot} scale={s} />
            </View>

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
