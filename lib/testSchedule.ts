/**
 * 예약 테스트 — 데이터 레이어 (작업 지시서 기반, 2026-08-25).
 *
 * 배경: 딸(중2) 피드백 — "시험 보는 게 무서워서 테스트 버튼을 회피하게 된다".
 * 무서운 건 시험이 아니라 "버튼을 누르는 결정"이므로, 설정한 시각이 되면 홈 화면에
 * 덮개를 띄워 그 결정을 없앤다. 단 완전히 가두지는 않는다 — 미루기(snooze)와
 * 오늘 넘어가기(skip) 탈출구를 반드시 둔다(탈출구가 "앱 강제 종료"뿐이면 회피가
 * 버튼에서 앱 전체로 옮겨간다).
 *
 * 영속은 app_meta 키-값만 사용한다 — 새 테이블·ALTER TABLE 금지(§ 가드레일 참고,
 * lib/db.ts의 USER_DB_DDL은 앱 시작마다 재실행되는데 ALTER TABLE ADD COLUMN에는
 * IF NOT EXISTS가 없어 2회차부터 throw해 DB 초기화가 통째로 실패한다). 따라서
 * user_schema_version도 올리지 않는다(스키마 변경 없음).
 *
 * 화면(UI)은 이 모듈을 소유하지 않는다 — app/test, app/settings, app/index는
 * 이 파일이 export하는 함수만 호출한다.
 */

import * as Notifications from 'expo-notifications';

import { getUserDb } from './db';
import { todayEpochDay } from './dates';
import { getTodayTestSession, hasTestPool } from './reviewQueries';

export const SNOOZE_LIMIT = 3;
export const SNOOZE_MINUTES = 30;
export const DEFAULT_ALARM_HOUR = 20;

export type TestAlarmConfig = {
  enabled: boolean;
  hour: number; // 0~23
  /** 내일부터 적용될 예약 변경. 없으면 null. */
  pending: { enabled: boolean; hour: number; fromDay: number } | null;
};

export type TestGateState =
  | { kind: 'off' } // 예약 꺼짐
  | { kind: 'before'; hour: number } // 아직 알람 시각 전
  | { kind: 'done' } // 오늘 테스트 이미 완료
  | { kind: 'skipped' } // 오늘은 넘어가기 사용함
  | { kind: 'unavailable' } // 출제할 단어가 없음
  | { kind: 'snoozed'; untilMs: number } // 미루는 중
  | { kind: 'due'; snoozeCount: number; canSnooze: boolean }; // 덮개를 띄워야 함

// ── app_meta 키 ──────────────────────────────────────────────────────────
const KEY_ENABLED = 'test_alarm_enabled';
const KEY_HOUR = 'test_alarm_hour';
const KEY_PENDING_ENABLED = 'test_alarm_pending_enabled';
const KEY_PENDING_HOUR = 'test_alarm_pending_hour';
const KEY_PENDING_FROM = 'test_alarm_pending_from';
const KEY_SNOOZE_DAY = 'test_snooze_day';
const KEY_SNOOZE_COUNT = 'test_snooze_count';
const KEY_SNOOZE_UNTIL_MS = 'test_snooze_until_ms';
const KEY_SKIP_DAY = 'test_skip_day';

const CONFIG_KEYS = [KEY_ENABLED, KEY_HOUR, KEY_PENDING_ENABLED, KEY_PENDING_HOUR, KEY_PENDING_FROM] as const;

async function readMetaMap(keys: readonly string[]): Promise<Map<string, string>> {
  const db = getUserDb();
  const rows = await db.getAllAsync<{ key: string; value: string }>(
    `SELECT key, value FROM app_meta WHERE key IN (${keys.map(() => '?').join(', ')})`,
    [...keys],
  );
  return new Map(rows.map((r) => [r.key, r.value]));
}

async function writeMeta(entries: [string, string][]): Promise<void> {
  if (entries.length === 0) return;
  const db = getUserDb();
  await db.withTransactionAsync(async () => {
    for (const [key, value] of entries) {
      await db.runAsync(
        `INSERT INTO app_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value],
      );
    }
  });
}

async function deleteMeta(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const db = getUserDb();
  await db.runAsync(`DELETE FROM app_meta WHERE key IN (${keys.map(() => '?').join(', ')})`, keys);
}

/**
 * 현재 확정된 알람 설정을 반환한다. pending이 있고 fromDay <= 오늘이면 읽기
 * 시점에 pending을 본값으로 승격 저장한 뒤(pending 키 3개 삭제) 승격된 값을
 * 반환한다 — 앱을 며칠 안 켜도 안전하도록 지연 승격 방식을 쓴다.
 */
export async function getTestAlarmConfig(): Promise<TestAlarmConfig> {
  const map = await readMetaMap(CONFIG_KEYS);

  const enabled = map.get(KEY_ENABLED) === '1';
  const hourRaw = map.get(KEY_HOUR);
  const hour = hourRaw !== undefined ? Number(hourRaw) : DEFAULT_ALARM_HOUR;

  const pendingEnabledRaw = map.get(KEY_PENDING_ENABLED);
  const pendingHourRaw = map.get(KEY_PENDING_HOUR);
  const pendingFromRaw = map.get(KEY_PENDING_FROM);

  if (pendingEnabledRaw !== undefined && pendingHourRaw !== undefined && pendingFromRaw !== undefined) {
    const fromDay = Number(pendingFromRaw);
    const today = todayEpochDay();

    if (fromDay <= today) {
      const promotedEnabled = pendingEnabledRaw === '1';
      const promotedHour = Number(pendingHourRaw);

      await writeMeta([
        [KEY_ENABLED, promotedEnabled ? '1' : '0'],
        [KEY_HOUR, String(promotedHour)],
      ]);
      await deleteMeta([KEY_PENDING_ENABLED, KEY_PENDING_HOUR, KEY_PENDING_FROM]);

      return { enabled: promotedEnabled, hour: promotedHour, pending: null };
    }

    return {
      enabled,
      hour,
      pending: { enabled: pendingEnabledRaw === '1', hour: Number(pendingHourRaw), fromDay },
    };
  }

  return { enabled, hour, pending: null };
}

/**
 * 알람 설정을 변경한다. 방향에 따라 적용 시점이 다르다:
 * - 끄기(true→false)와 시각 변경은 pending에 쓰고 fromDay = 오늘+1로 미룬다
 *   (불안한 순간에 설정으로 도망가는 길을 막는 장치).
 * - 켜기(false→true)는 즉시 적용(pending 키 삭제) — 계약을 강화하는 방향은
 *   미룰 이유가 없고, 켠 당일 아무 일도 안 일어나면 변화가 눈에 안 보인다.
 * - 켜면서 동시에 시각도 지정한 경우 → 둘 다 즉시.
 * - 이미 pending이 있는 상태에서 다시 호출하면 최신 호출로 덮어쓴다(단 켜기면
 *   즉시 규칙이 우선).
 *
 * 호출 끝에 반드시 rescheduleSlotNotifications()를 기다린다(순환 import 방지를
 * 위해 함수 내부에서 동적 import — 아래 "순환 import" 설명 참고).
 *
 * 켜는 방향(isTurningOn)이면 알림 권한을 요청한다(lib/notifications.ts의
 * setNotificationsEnabled와 동일한 흐름 참고). 단 권한이 거부돼도 예약 자체는
 * 켜진다 — 덮개는 앱을 열면 뜨므로 기능이 죽지 않는다, 알림만 안 갈 뿐이다.
 * 권한 획득 여부가 필요한 호출자는 이 함수 호출 전/후로 별도 export
 * requestTestAlarmPermission()을 쓸 수 있다(아래).
 */
export async function setTestAlarm(next: { enabled: boolean; hour: number }): Promise<TestAlarmConfig> {
  const current = await getTestAlarmConfig();
  const today = todayEpochDay();

  const isTurningOn = !current.enabled && next.enabled;

  if (isTurningOn) {
    // 켜기: 즉시 적용, pending 제거. 권한 요청은 결과와 무관하게 예약을 막지 않는다.
    try {
      await Notifications.requestPermissionsAsync();
    } catch (err) {
      console.warn('[testSchedule] 알림 권한 요청 실패', err);
    }

    await writeMeta([
      [KEY_ENABLED, '1'],
      [KEY_HOUR, String(next.hour)],
    ]);
    await deleteMeta([KEY_PENDING_ENABLED, KEY_PENDING_HOUR, KEY_PENDING_FROM]);
  } else {
    // 끄기 또는 (이미 켜진 상태에서) 시각 변경: 내일부터 적용되도록 pending에 기록.
    await writeMeta([
      [KEY_PENDING_ENABLED, next.enabled ? '1' : '0'],
      [KEY_PENDING_HOUR, String(next.hour)],
      [KEY_PENDING_FROM, String(today + 1)],
    ]);
  }

  const { rescheduleSlotNotifications } = await import('./notifications');
  await rescheduleSlotNotifications();

  return getTestAlarmConfig();
}

/** 오늘 미룬 횟수. 날짜가 바뀌면(test_snooze_day !== 오늘) 0으로 취급한다. */
async function getTodaySnoozeState(): Promise<{ count: number; untilMs: number | null }> {
  const map = await readMetaMap([KEY_SNOOZE_DAY, KEY_SNOOZE_COUNT, KEY_SNOOZE_UNTIL_MS]);
  const day = map.get(KEY_SNOOZE_DAY);
  if (day === undefined || Number(day) !== todayEpochDay()) {
    return { count: 0, untilMs: null };
  }
  const count = Number(map.get(KEY_SNOOZE_COUNT) ?? '0');
  const untilMsRaw = map.get(KEY_SNOOZE_UNTIL_MS);
  return { count: Number.isFinite(count) ? count : 0, untilMs: untilMsRaw !== undefined ? Number(untilMsRaw) : null };
}

/** 오늘 "넘어가기"를 사용했는지. 날짜가 바뀌면 자동 무효. */
async function getTodaySkipped(): Promise<boolean> {
  const map = await readMetaMap([KEY_SKIP_DAY]);
  const day = map.get(KEY_SKIP_DAY);
  return day !== undefined && Number(day) === todayEpochDay();
}

/**
 * 지금 시점의 게이트 상태를 판정한다(순서대로 먼저 걸리는 것이 이긴다):
 * 1. off  2. done  3. skipped  4. before  5. unavailable  6. snoozed  7. due
 */
export async function getTestGateState(nowMs: number = Date.now()): Promise<TestGateState> {
  const config = await getTestAlarmConfig();
  if (!config.enabled) {
    return { kind: 'off' };
  }

  const todaySession = await getTodayTestSession();
  if (todaySession !== null) {
    return { kind: 'done' };
  }

  const skipped = await getTodaySkipped();
  if (skipped) {
    return { kind: 'skipped' };
  }

  const now = new Date(nowMs);
  const alarmToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), config.hour, 0, 0, 0);
  if (nowMs < alarmToday.getTime()) {
    return { kind: 'before', hour: config.hour };
  }

  const available = await hasTestPool();
  if (!available) {
    return { kind: 'unavailable' };
  }

  const snoozeState = await getTodaySnoozeState();
  if (snoozeState.untilMs !== null && nowMs < snoozeState.untilMs) {
    return { kind: 'snoozed', untilMs: snoozeState.untilMs };
  }

  return { kind: 'due', snoozeCount: snoozeState.count, canSnooze: snoozeState.count < SNOOZE_LIMIT };
}

/**
 * 오늘 테스트를 30분 미룬다. 한도(SNOOZE_LIMIT) 초과면 아무것도 쓰지 않고 false.
 * 성공하면 count+1 저장 후 rescheduleSlotNotifications()를 기다리고 true.
 */
export async function snoozeTest(nowMs: number = Date.now()): Promise<boolean> {
  const state = await getTodaySnoozeState();
  if (state.count >= SNOOZE_LIMIT) {
    return false;
  }

  const untilMs = nowMs + SNOOZE_MINUTES * 60 * 1000;
  await writeMeta([
    [KEY_SNOOZE_DAY, String(todayEpochDay())],
    [KEY_SNOOZE_COUNT, String(state.count + 1)],
    [KEY_SNOOZE_UNTIL_MS, String(untilMs)],
  ]);

  const { rescheduleSlotNotifications } = await import('./notifications');
  await rescheduleSlotNotifications();

  return true;
}

/** 오늘은 테스트를 건너뛴다. rescheduleSlotNotifications()를 기다린다. */
export async function skipTestToday(): Promise<void> {
  await writeMeta([[KEY_SKIP_DAY, String(todayEpochDay())]]);

  const { rescheduleSlotNotifications } = await import('./notifications');
  await rescheduleSlotNotifications();
}

/**
 * 현재 알림 권한 승인 여부만 확인한다(요청하지 않음). setTestAlarm()이 이미
 * 켜는 방향에서 자체적으로 권한을 요청하므로 필수 호출은 아니지만, 호출자가
 * "권한이 거부돼서 알림이 안 갈 수 있다"는 안내를 UI에 보여주고 싶을 때 쓴다.
 */
export async function isTestAlarmPermissionGranted(): Promise<boolean> {
  try {
    const result = await Notifications.getPermissionsAsync();
    return result.granted;
  } catch (err) {
    console.warn('[testSchedule] 알림 권한 조회 실패', err);
    return false;
  }
}

/**
 * __DEV__ 전용 QA 도구. 오늘의 미루기·넘어가기 기록만 지운다 — 예약 설정
 * (test_alarm_enabled/test_alarm_hour/pending 3키)은 절대 건드리지 않는다
 * (lib/habitQueries.ts의 deleteTodaySlotRecords()와 동일한 관행: __DEV__
 * 전용이라 감수하는 범위를 명확히 좁게 잡는다).
 *
 * 이게 없으면 실기기 QA에서 미루기(snooze)를 SNOOZE_LIMIT(3)회 쓰는 순간
 * canSnooze가 false로 굳어 그날은 덮개를 다시 볼 수 없다.
 */
export async function clearTodayTestGateState(): Promise<void> {
  await deleteMeta([KEY_SNOOZE_DAY, KEY_SNOOZE_COUNT, KEY_SNOOZE_UNTIL_MS, KEY_SKIP_DAY]);

  const { rescheduleSlotNotifications } = await import('./notifications');
  await rescheduleSlotNotifications();
}
