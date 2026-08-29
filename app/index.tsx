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
import NotifyOptInOverlay from '../components/home/NotifyOptInOverlay';
import TestGateOverlay from '../components/home/TestGateOverlay';
import TigerHero from '../components/home/TigerHero';
import { epochDayToDateString, todayEpochDay } from '../lib/dates';
import {
  currentSlotIndex,
  getCurrentStreak,
  getTodaySlotStates,
  type SlotState,
} from '../lib/habitQueries';
import { shouldAskNotificationOptIn } from '../lib/notifications';
import { ensureTodayDay, type DayWithWords } from '../lib/queries';
import { getTodayTestSession } from '../lib/reviewQueries';
import { getTestGateState, type TestGateState } from '../lib/testSchedule';

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

  const [slotStates, setSlotStates] = useState<SlotState[] | null>(null);
  const [streak, setStreak] = useState(0);
  const [activeSlot, setActiveSlot] = useState<number | null>(null);

  // 예약 테스트 덮개 — null이면 "아직 조회 중"(덮개를 띄우지 않는다). 홈이 먼저
  // 보였다가 덮이는 편이, 덮개가 잠깐 떴다 사라지는 것보다 낫다는 판단(작업 지시서).
  const [testGate, setTestGate] = useState<TestGateState | null>(null);

  /**
   * [테스트] 버튼으로 직접 연 덮개(manual 모드). 예약 덮개와 같은 컴포넌트를 쓰되
   * 문구와 탈출구만 다르다 — 스스로 들어가는 길이 더 헐거우면 안 된다는 판단
   * (근거는 `components/home/TestGateOverlay.tsx` 헤더).
   * 예약 덮개와 달리 DB에 남는 게 없으므로 순수 화면 상태다.
   */
  const [manualTestGate, setManualTestGate] = useState(false);

  const loadTestGate = useCallback(() => {
    getTestGateState()
      .then(setTestGate)
      .catch(() => {
        // 조회 실패 시 덮개를 띄우지 않는다 — 예약 기능이 메인 흐름(오늘 단어장)을
        // 막으면 안 된다.
      });
  }, []);

  // 홈 알림 opt-in 덮개 — null이면 "아직 조회 중"(덮개를 띄우지 않는다). testGate와
  // 완전히 같은 패턴: 조회 실패 시 덮개를 띄우지 않아 메인 흐름을 막지 않는다.
  const [askNotify, setAskNotify] = useState<boolean | null>(null);

  const loadAskNotify = useCallback(() => {
    shouldAskNotificationOptIn()
      .then(setAskNotify)
      .catch(() => {
        // 조회 실패 시 덮개를 띄우지 않는다.
      });
  }, []);

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
    Promise.all([getTodaySlotStates(), getCurrentStreak(), currentSlotIndex()])
      .then(([slots, streakDays, active]) => {
        setSlotStates(slots);
        setStreak(streakDays);
        setActiveSlot(active);
      })
      .catch(() => {
        // 습관 게이지는 부가 정보 — 조회 실패해도 메인 흐름(오늘 단어장)은 막지 않는다.
      });
  }, []);

  /**
   * 덮개가 테스트 화면으로 넘어가기 직전에 부른다 — 게이트 상태를 "모름"으로 되돌린다.
   * 안 하면 복귀할 때 옛 `'due'`가 그대로 그려져 덮개가 번쩍인다(근거는 `enterTest` 주석).
   * 두 덮개 다 같은 이유라 하나로 처리한다.
   */
  const handleEnterTest = useCallback(() => {
    setTestGate(null);
    setManualTestGate(false);
  }, []);

  /**
   * [테스트] 버튼 — 곧장 라우팅하지 않고 진입 덮개를 띄운다.
   *
   * 단 **오늘 몫을 이미 봤으면 덮개를 건너뛴다.** 덮개는 "테스트를 보게 만드는 문"인데
   * 볼 게 없으면 1.2초 길게 누르기가 결과·재채점 화면으로 가는 통행세가 될 뿐이고,
   * 문구("최고 N원을 획득하세요")도 이미 받은 사람에게는 거짓말이 된다.
   * `testGate`로 판정하지 않는 이유: 예약이 꺼져 있으면 게이트가 'done'까지 가기 전에
   * 'off'로 끝나서 완료 여부를 알 수 없다.
   */
  const handlePressTest = useCallback(() => {
    getTodayTestSession()
      .then((session) => {
        if (session) router.push('/test');
        else setManualTestGate(true);
      })
      // 조회 실패는 덮개 쪽으로 흘린다 — 테스트 화면이 같은 판정을 한 번 더 하므로
      // (진입 게이트) 잘못 열려도 그쪽에서 완료 화면으로 걸린다.
      .catch(() => setManualTestGate(true));
  }, []);

  // 오늘 단어장 진입 — 입구가 둘이다(말풍선, 잔디 게이지의 열린 전구). 같은 곳으로 보낸다.
  const goToWordbook = useCallback(() => {
    if (!day) return;
    router.push({
      pathname: '/day/[dayId]',
      params: { dayId: String(day.id), dayIndex: String(day.day_index) },
    });
  }, [day]);

  useEffect(() => {
    loadTodayDay();
  }, [loadTodayDay]);

  // 홈 마운트 시 최초 판정. focus/포그라운드 복귀는 위 useFocusEffect/AppState에서 처리.
  useEffect(() => {
    loadTestGate();
    loadAskNotify();
  }, [loadTestGate, loadAskNotify]);

  // 단어장 화면에서 돌아올 때 게이지 갱신 필요(§7.3) — focus 시마다 재조회.
  // 오늘 Day·날짜 라벨도 함께 갱신 (다른 화면에 머무는 사이 자정을 넘긴 경우 대응).
  // 예약 테스트 덮개도 같은 시점에 재판정한다 — 테스트를 마치고 홈으로 돌아오면
  // done이 되어 덮개가 사라져야 하고, 미루기 30분이 지난 뒤 홈에 오면 다시 떠야 한다.
  // 알림 opt-in 덮개도 같은 시점에 재판정한다 — 첫 세션을 막 끝내고 단어장에서
  // 돌아오면 그 순간 노출 조건이 충족되므로 focus 복귀에서 갱신해야 뜬다.
  useFocusEffect(
    useCallback(() => {
      loadHabit();
      loadTodayDay({ silent: true });
      loadTestGate();
      loadAskNotify();
      // 직접 연 덮개는 홈으로 돌아오는 순간 닫는다 — 이게 없으면 덮개로 테스트에
      // 들어갔다 나온 뒤 홈이 다시 그 덮개에 덮여 있다(state가 그대로 남으므로).
      setManualTestGate(false);
    }, [loadHabit, loadTodayDay, loadTestGate, loadAskNotify]),
  );

  // 앱을 홈 화면에 둔 채 백그라운드로 갔다가 다음 날 복귀하는 경우 — focus 이벤트가
  // 없으므로 AppState active 복귀에서도 갱신해야 새 단어장이 생성된다.
  // 예약 테스트 덮개도 마찬가지 — 홈을 켜둔 채 대기하다 알람 시각을 넘기고
  // 돌아오는 경우를 포함한다. 알림 opt-in 덮개도 동일한 이유로 함께 갱신한다.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        loadHabit();
        loadTodayDay({ silent: true });
        loadTestGate();
        loadAskNotify();
      }
    });
    return () => sub.remove();
  }, [loadHabit, loadTodayDay, loadTestGate, loadAskNotify]);

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
                  onEnterWordbook={goToWordbook}
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
              말풍선 탭 영역 아래 16px이 잔디에 덮여 그 띠는 탭이 안 먹는다 — 사람은
              말풍선 가운데를 누르므로 무시하기로 했다(2026-08-15). 이거 하나 살리자고
              GrassGauge를 pointerEvents 묶음으로 감싸지 말 것.
            */}
            <View style={place(PLACE.grass, s)}>
              <GrassGauge
                slots={slotStates}
                streak={streak}
                activeSlot={activeSlot}
                scale={s}
                // 빨간 점이 뜬 전구도 오늘 단어장 입구다 — 점은 누르고 싶어지는 표시라서.
                // 오늘 Day를 아직 못 읽었으면 넘기지 않아 눌리지 않는다.
                onPressActiveSlot={day ? goToWordbook : undefined}
              />
            </View>

            <HomeMenuButtons scale={s} onPressTest={handlePressTest} />

            <Image
              source={require('../assets/images/deco-mountains.png')}
              style={place(PLACE.mountains, s)}
              resizeMode="contain"
            />
          </View>
        </NotebookBackground>
      </ScrollView>

      {/*
        예약 테스트 덮개 — 기존 트리 밖, 맨 마지막 형제로 추가한다. 홈의 절대좌표
        체계(PLACE/place/s)에 참여하지 않고 독자적인 절대배치(flex + 안전영역)로
        전체 화면을 덮는다. testGate가 'due'일 때만 렌더 — 조회 중(null)이거나
        다른 상태(off/before/done/skipped/unavailable/snoozed)면 아무것도 그리지 않는다.
      */}
      {testGate?.kind === 'due' && (
        <TestGateOverlay gate={testGate} onResolved={loadTestGate} onEnterTest={handleEnterTest} />
      )}

      {/*
        [테스트] 버튼으로 직접 연 덮개. 예약 덮개가 떠 있으면 그리지 않는다 — 둘 다
        전체 화면이라 겹치면 하나가 다른 하나를 통째로 가리고, 시각에 묶인 쪽이 우선이다.
        (버튼 자체가 예약 덮개에 가려 안 눌리므로 실제로 겹칠 일은 거의 없지만,
         덮개가 뜨기 직전에 눌린 경우가 남는다.)
      */}
      {testGate?.kind !== 'due' && manualTestGate && (
        <TestGateOverlay
          gate={{ kind: 'manual' }}
          onResolved={() => setManualTestGate(false)}
          onEnterTest={handleEnterTest}
        />
      )}

      {/*
        홈 알림 opt-in 덮개 — 오늘 미션을 통째로 놓친 날(앞 시간대를 전부 흘려보내고
        마지막 시간대에 와서야 단어장을 처음 훑은 날) "알림 보내줄까?"를 묻는다.
        테스트 덮개(예약이든 직접 연 것이든)가 떠 있으면 띄우지 않는다 — 둘 다 전체
        화면이라 겹치면 하나가 다른 하나를 완전히 가린다. 테스트 덮개가 우선이고,
        알림 질문은 다음 기회에 떠도 아무것도 잃지 않는다.

        `testGate !== null`(= 판정이 끝났다)까지 요구하는 이유: 두 판정이 병렬 비동기라
        알림 쪽이 먼저 끝날 수 있는데, 그 틈에 이 덮개가 떴다가 testGate가 'due'로
        확정되는 순간 교체된다. 눈에 거슬리는 정도를 넘어, 그 짧은 사이에 [괜찮아]가
        눌리면 **오늘치 질문이 통째로 소모된다**(app_meta에 오늘 물어봤음이 박혀 자정까지
        다시 뜨지 않는다).
        testGate 조회가 실패하면 이 덮개도 안 뜨게 되지만, 둘 다 같은 user.db를 읽으므로
        한쪽이 실패하면 다른 쪽도 실패한다 — 실질적인 손해가 없다.
      */}
      {testGate !== null && testGate.kind !== 'due' && !manualTestGate && askNotify === true && (
        <NotifyOptInOverlay onResolved={loadAskNotify} />
      )}
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
