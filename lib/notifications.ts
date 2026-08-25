/**
 * 시간대 미션(하루 4슬롯 분산 인출) 로컬 알림 (설계.md §7.6, 2026-07-09 구현).
 *
 * expo-notifications 로컬 알림만 사용한다 — 원격 푸시(getExpoPushTokenAsync 등)는
 * 다루지 않는다(가드레일). Expo Go(SDK 54)는 로컬 알림을 지원하므로 별도
 * config plugin/dev build 없이 동작한다.
 *
 * 재예약 전략: "48시간 지평선, 앱 포그라운드 전환마다 갱신"(누적 스케줄 대신
 * 매번 전체 취소 후 다시 계산해 넣는 방식 — 슬롯 시간/완료 여부가 바뀌어도
 * 항상 최신 상태로 수렴한다). 트리거는 DATE(one-off)만 사용한다 — DAILY 반복
 * 트리거는 "이미 완료한 슬롯도 계속 울림" 문제가 있어 배제한다(작업 지시 가드레일).
 *
 * app_meta 키 'notifications_enabled' ('1'|'0', 없으면 OFF 기본)에 켬/끔 상태를
 * 영속한다. lib/db.ts의 app_meta 테이블을 그대로 재사용하고 스키마는 바꾸지 않는다.
 */

import * as Notifications from 'expo-notifications';

import { getUserDb } from './db';
import { getSlotConfig, getTodaySlots, hasCompletedAnySession } from './habitQueries';

const NOTIFICATIONS_ENABLED_KEY = 'notifications_enabled';
/** 홈 알림 opt-in 덮개를 이미 물어봤는지('1'|없음). 사용자가 어느 버튼을 골랐든 저장된다. */
const NOTIFY_OPTIN_ASKED_KEY = 'notify_optin_asked';

/** 포그라운드 수신 시에도 배너/목록에 표시 + 소리(설계 요구사항). 모듈 로드 시 1회 설정. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** app_meta.notifications_enabled 읽기. 키가 없으면 OFF 기본. */
export async function isNotificationsEnabled(): Promise<boolean> {
  const db = getUserDb();
  const row = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM app_meta WHERE key = ?",
    [NOTIFICATIONS_ENABLED_KEY],
  );
  return row?.value === '1';
}

async function persistEnabled(enabled: boolean): Promise<void> {
  const db = getUserDb();
  await db.runAsync(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [NOTIFICATIONS_ENABLED_KEY, enabled ? '1' : '0'],
  );
}

/**
 * 알림 켬/끔 토글(설정 화면 스위치 연동).
 * 켤 때: 권한 요청 → 거부되면 저장 없이 false 반환. 승인되면 app_meta 저장 +
 *        rescheduleSlotNotifications()로 즉시 예약.
 * 끌 때: app_meta 저장 + 전체 예약 취소. 실패해도 항상 false 반환(끄기는 실패하지 않는다).
 */
export async function setNotificationsEnabled(enabled: boolean): Promise<boolean> {
  if (enabled) {
    let granted = false;
    try {
      const result = await Notifications.requestPermissionsAsync();
      granted = result.granted;
    } catch (err) {
      console.warn('[notifications] 권한 요청 실패', err);
      granted = false;
    }
    if (!granted) return false;

    await persistEnabled(true);
    await rescheduleSlotNotifications();
    return true;
  }

  await persistEnabled(false);
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch (err) {
    console.warn('[notifications] 예약 취소 실패', err);
  }
  return false;
}

/** 로컬 캘린더 날짜(baseDate)의 hour:00:00.000 시각을 가리키는 Date. */
function dateAtHour(baseDate: Date, hour: number): Date {
  const d = new Date(baseDate);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** slotIndex(0-based) → 알림 본문에 쓸 순번(1-based) 문구. */
function slotOrdinal(slotIndex: number): number {
  return slotIndex + 1;
}

async function scheduleSlotAt(target: Date, slotIndex: number): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: '호랑잉글리시 🐯',
      body: `인출 타임! 오늘 ${slotOrdinal(slotIndex)}번째 미션 시간이 열렸어요`,
      sound: true,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: target,
    },
  });
}

/**
 * 예약 테스트 알림 문구. 슬롯 알림(scheduleSlotAt)과 같은 형식(title 고정 +
 * body에 상황 설명)을 쓴다.
 */
async function scheduleTestAlarmAt(target: Date): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: '호랑잉글리시 🐯',
      body: '테스트 타임! 오늘 테스트 시간이 됐어요',
      sound: true,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: target,
    },
  });
}

/**
 * 예약 테스트 알림을 48시간 지평선(오늘+내일)으로 재계산해 예약한다
 * (2026-08-25 정정 — 이전 버전은 'due' 상태에서 즉시(1초 뒤) 알림을 추가로
 * 깔았는데, rescheduleSlotNotifications()가 앱 시작·포그라운드 복귀마다
 * 불리므로 due 상태로 앱을 열 때마다 이미 떠 있는 덮개와 똑같은 내용의
 * 알림이 반복 발송되는 결함이었다. 알람 시각에 이미 'before' 예약분이
 * 한 번 울렸으므로 'due'는 그 이후 상태 — 추가 알림이 필요 없다).
 *
 * - 오늘분: before → 오늘 hour시 0분 1건 / snoozed → untilMs 1건 /
 *   due·done·skipped·off·unavailable → 오늘분 없음.
 * - 내일분: config.enabled === true면 오늘 상태와 무관하게 내일 hour시 0분
 *   1건(내일은 새 날이므로 오늘 done/skipped여도 내일은 알려야 한다).
 *   enabled === false면 없음.
 *
 * notifications_enabled(시간대 알림) 스위치에 종속된다 — 시간대 알림이 꺼져
 * 있으면 테스트 예약이 켜져 있어도 알림은 가지 않는다(2026-08-25, 알림 스위치를
 * 한 곳으로 모으기 위함). 테스트 타임 자체(홈 화면 덮개)는 이 스위치와 무관하게
 * 계속 동작한다 — 영향받는 건 알림 발송 여부뿐이다.
 *
 * notifications.ts ↔ testSchedule.ts 순환 import 방지를 위해 동적 import를
 * 쓴다(testSchedule.ts도 이 파일을 동적 import로만 참조한다).
 */
async function scheduleTestAlarmIfDue(): Promise<void> {
  if (!(await isNotificationsEnabled())) return;

  const { getTestAlarmConfig, getTestGateState } = await import('./testSchedule');
  const config = await getTestAlarmConfig();
  const gate = await getTestGateState();

  const now = new Date();

  switch (gate.kind) {
    case 'before': {
      const todayTarget = dateAtHour(now, gate.hour);
      if (todayTarget.getTime() > now.getTime()) {
        await scheduleTestAlarmAt(todayTarget);
      }
      break;
    }
    case 'snoozed': {
      await scheduleTestAlarmAt(new Date(gate.untilMs));
      break;
    }
    case 'due':
    case 'done':
    case 'skipped':
    case 'off':
    case 'unavailable':
      break;
  }

  if (config.enabled) {
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const tomorrowTarget = dateAtHour(tomorrow, config.hour);
    await scheduleTestAlarmAt(tomorrowTarget);
  }
}

/**
 * 시간대 미션 알림을 재계산해 다시 예약한다(핵심 로직, 설계.md §7.6).
 *
 * 1. 비활성이면 전체 취소 후 종료.
 * 2. cancelAllScheduledNotificationsAsync()로 기존 예약을 비우고(멱등하게 재계산
 *    하기 위함), slot_config + 오늘 완료 슬롯을 읽는다.
 * 3. 오늘: 시작 시각이 아직 미래이고 미완료인 슬롯만 예약.
 * 4. 내일: 완료 여부를 아직 알 수 없으므로(오늘 밤 자정 이후 리셋) 4슬롯 전부 예약.
 *    → 오늘+내일로 48시간 지평선을 커버하고, 앱을 다시 열 때마다 이 함수가 또
 *      불려 최신 상태로 갱신된다.
 *
 * cancelAllScheduledNotificationsAsync()로 시작하므로 예약 테스트 알림도 반드시
 * 이 함수 안에서 함께 예약한다 — 별도 함수에서 예약하면 이 함수가 호출될 때마다
 * (앱 시작·포그라운드 복귀·슬롯 시간 변경) 조용히 지워진다.
 *
 * 알림 예약 실패가 앱 동작을 막으면 안 되므로 전체를 try/catch로 감싸고
 * console.warn만 남긴다(작업 지시 가드레일).
 */
export async function rescheduleSlotNotifications(): Promise<void> {
  try {
    const enabled = await isNotificationsEnabled();
    if (!enabled) {
      await Notifications.cancelAllScheduledNotificationsAsync();
    } else {
      await Notifications.cancelAllScheduledNotificationsAsync();

      const slots = await getSlotConfig();
      const todaySlots = await getTodaySlots();

      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const tomorrow = new Date(today.getTime() + 86400000);

      for (const slot of slots) {
        const alreadyDone = todaySlots[slot.slotIndex] ?? false;
        if (alreadyDone) continue;

        const todayTarget = dateAtHour(today, slot.startHour);
        if (todayTarget.getTime() > now.getTime()) {
          await scheduleSlotAt(todayTarget, slot.slotIndex);
        }
      }

      for (const slot of slots) {
        const tomorrowTarget = dateAtHour(tomorrow, slot.startHour);
        await scheduleSlotAt(tomorrowTarget, slot.slotIndex);
      }
    }
  } catch (err) {
    console.warn('[notifications] 재예약 실패', err);
  }

  // 예약 테스트 알림은 별도 함수에서 판정하되 notifications_enabled 가드는 그
  // 함수 내부(scheduleTestAlarmIfDue)에 있다. 위 블록에서
  // cancelAllScheduledNotificationsAsync()가 이미 실행됐으므로(비활성 경로 포함)
  // 여기서 새로 추가하는 것만으로 최신 상태가 된다.
  try {
    await scheduleTestAlarmIfDue();
  } catch (err) {
    console.warn('[notifications] 예약 테스트 알림 재예약 실패', err);
  }
}

/**
 * 설정 화면의 "알림 테스트" 버튼용 — 권한 확인/요청 후 5초 뒤 알림 1건을
 * DATE 트리거(one-off)로 예약한다. 권한이 없으면(거부됨) false.
 */
export async function scheduleTestNotification(): Promise<boolean> {
  try {
    let granted = (await Notifications.getPermissionsAsync()).granted;
    if (!granted) {
      granted = (await Notifications.requestPermissionsAsync()).granted;
    }
    if (!granted) return false;

    await Notifications.scheduleNotificationAsync({
      content: {
        title: '호랑잉글리시 🐯',
        body: '테스트 알림이에요! 잘 도착했다면 준비 완료입니다.',
        sound: true,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(Date.now() + 5000),
      },
    });
    return true;
  } catch (err) {
    console.warn('[notifications] 테스트 알림 예약 실패', err);
    return false;
  }
}

/**
 * 홈 알림 opt-in 덮개 (첫 세션 직후 "알림 켤까?") — 관련 함수 3개.
 *
 * iOS 권한 팝업은 앱 생애 딱 한 번만 뜬다. 거부되면 그 뒤로는 요청해도 아무것도
 * 안 뜨고 즉시 거부로 처리되며 복구는 iOS 설정 앱뿐이다. 그래서 우리 화면으로
 * 먼저 묻고 "응"일 때만 진짜 권한 팝업(setNotificationsEnabled 내부)을 부른다.
 */

/** 홈에서 "알림 켤까?"를 지금 물어야 하는가 — 세 조건을 전부 만족해야 true. */
export async function shouldAskNotificationOptIn(): Promise<boolean> {
  const db = getUserDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM app_meta WHERE key = ?',
    [NOTIFY_OPTIN_ASKED_KEY],
  );
  if (row?.value === '1') return false; // 이미 물어봤음

  if (await isNotificationsEnabled()) return false; // 이미 켜져 있으면 물을 이유 없음

  return hasCompletedAnySession(); // 첫 세션을 끝냈을 때만
}

/** 물어봤음을 영속한다(사용자가 어느 버튼을 골랐든 호출). */
export async function markNotificationOptInAsked(): Promise<void> {
  const db = getUserDb();
  await db.runAsync(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [NOTIFY_OPTIN_ASKED_KEY, '1'],
  );
}

/** __DEV__ QA 전용 — 물어본 기록을 지워 opt-in 덮개가 다시 뜨게 한다. */
export async function resetNotifyOptInAsk(): Promise<void> {
  const db = getUserDb();
  await db.runAsync('DELETE FROM app_meta WHERE key = ?', [NOTIFY_OPTIN_ASKED_KEY]);
}
