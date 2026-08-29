/**
 * 예약 테스트 — 데이터 레이어 (작업 지시서 기반, 2026-08-25).
 *
 * 배경: 딸(중2) 피드백 — "시험 보는 게 무서워서 테스트 버튼을 회피하게 된다".
 * 무서운 건 시험이 아니라 "버튼을 누르는 결정"이므로, 설정한 시각이 되면 홈 화면에
 * 덮개를 띄워 그 결정을 없앤다.
 *
 * ⚠ 이 파일 첫 버전에는 "완전히 가두지 않는다 — 미루기와 오늘 넘어가기 탈출구를
 * 반드시 둔다"고 적혀 있었다. **그 전제는 폐기됐다**(2026-08-29, 딸 본인 요청):
 * 탈출구가 없는 편이 자신을 더 잘 가이드해 준다고 했다. 넘어가기는 삭제됐고
 * 미루기는 하루 1회만 남았다. 진짜 탈출구는 화면이 아니라 설정에 있다(테스트 타임을
 * 끄면 된다 — 대신 그 변경은 내일부터 적용된다). 그러니 **이 기능을 무르게 만드는
 * 방향의 변경은 기본 반려**다(설계.md §8 배경 ⓓ).
 *
 * 영속은 app_meta 키-값만 사용한다 — 새 테이블·ALTER TABLE 금지(§ 가드레일 참고,
 * lib/db.ts의 USER_DB_DDL은 앱 시작마다 재실행되는데 ALTER TABLE ADD COLUMN에는
 * IF NOT EXISTS가 없어 2회차부터 throw해 DB 초기화가 통째로 실패한다). 따라서
 * user_schema_version도 올리지 않는다(스키마 변경 없음).
 *
 * 화면(UI)은 이 모듈을 소유하지 않는다 — app/test, app/settings, app/index는
 * 이 파일이 export하는 함수만 호출한다.
 */

import { getUserDb } from './db';
import { todayEpochDay } from './dates';
import { getTodayTestSession, hasTestPool } from './reviewQueries';

export const SNOOZE_LIMIT = 1;
export const SNOOZE_MINUTES = 30;
export const DEFAULT_ALARM_HOUR = 22;

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
  // 덮개를 띄워야 함. `hour`는 덮개 문구가 "N시가 지나면 …"이라고 말하기 위해
  // 함께 싣는다 — 설정에서 바뀌는 값이라 덮개가 상수로 박으면 거짓말이 된다.
  //
  // `canSnooze`는 **횟수와 시각 두 조건의 곱**이다(snoozeWouldCrossMidnight 참고).
  // 화면은 이 불리언 하나만 보고 [30분 뒤에 할래]를 그릴지 정한다 — 왜 못 미루는지는
  // 화면이 알 필요가 없고, 알게 하면 그 이유마다 문구가 갈라진다.
  | { kind: 'due'; hour: number; snoozeCount: number; canSnooze: boolean };

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

  // **키가 없으면 켜짐이다** (2026-08-29 사용자 결정 — 그 전엔 기본 꺼짐이었다).
  // 이 기능은 딸이 스스로에게 거는 계약인데, 설정 화면에 들어가 스위치를 켜야만
  // 시작되면 정작 필요한 사람(미루는 사람)에게는 영영 시작되지 않는다.
  // `=== '1'`로 두면 미설정이 '0'과 구별되지 않으므로 undefined를 따로 본다.
  const enabledRaw = map.get(KEY_ENABLED);
  const enabled = enabledRaw === undefined ? true : enabledRaw === '1';
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
 * 여기서는 알림 권한을 요청하지 않는다(2026-08-25 변경) — 테스트 타임 알림은
 * 이제 notifications_enabled(전구 미션 알림) 스위치에 종속되므로, 그 스위치를 켤 때
 * lib/notifications.ts의 setNotificationsEnabled가 권한을 요청한다. 덮개 자체는
 * 알림 권한과 무관하게 앱을 열면 뜨므로 여기서 권한 팝업을 띄우는 건 목적 없는
 * 방해다. 이 파일은 이제 알림 권한을 아예 다루지 않는다 — 권한을 조회하던
 * isTestAlarmPermissionGranted()도 함께 삭제했다. 그 함수의 유일한 용도가
 * "권한이 꺼져 알림이 안 갈 수 있다"는 설정 화면 안내였는데, 그 안내 자체가
 * 이 변경으로 사라졌기 때문이다(남겨두면 삭제한 안내를 되살리도록 유인한다).
 */
export async function setTestAlarm(next: { enabled: boolean; hour: number }): Promise<TestAlarmConfig> {
  const current = await getTestAlarmConfig();
  const today = todayEpochDay();

  const isTurningOn = !current.enabled && next.enabled;

  if (isTurningOn) {
    // 켜기: 즉시 적용, pending 제거.
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

/**
 * 지금 미루면 자정을 넘기는가. `true`면 미루기를 막는다(2026-08-29 사용자 지적).
 *
 * 23:50에 미루면 재개 시각이 00:20인데, 그때는 이미 날짜가 바뀌어 있다 —
 * `getTodaySnoozeState()`의 기록은 어제 것이라 무효가 되고, 게이트는 새 날의 알람
 * 시각 전이므로 `before`를 돌려준다. 즉 덮개가 다시 뜨지 않는다.
 *
 * **손해를 보는 쪽은 장치가 아니라 아이다.** [30분 뒤에 할래]를 누른 아이는 30분 뒤에
 * 보겠다고 한 것이지 오늘을 포기한 게 아닌데, 앱이 다시 묻지 않아 **그날 상금을
 * 통째로 날린다.** 테스트는 하루 1회(taken_day)라 다음 날 만회도 안 된다. 결국 그
 * 버튼은 조용히 [오늘은 넘어갈래]가 된다 — 딸 요청으로 없앤 바로 그 버튼이다.
 *
 * 그러니 이 차단은 계약을 더 조이는 장치가 아니라 **약속을 지키는 쪽**이다. 버튼이
 * "30분 뒤에"라고 말했으면 30분 뒤가 있어야 한다. 없으면 그 버튼을 내리는 게 맞다.
 *
 * 경계값(22:00 알람 기준 23:30)을 상수로 박지 않고 SNOOZE_MINUTES에서 **파생**한다 —
 * 유예 시간을 60분으로 바꾸면 경계도 23:00으로 저절로 따라가야 한다. 초는 무시하므로
 * 실제 재개 시각이 23:59:xx까지는 갈 수 있는데, 오늘 안이라 문제가 없다.
 */
function snoozeWouldCrossMidnight(now: Date): boolean {
  const minutesLeftToday = 24 * 60 - (now.getHours() * 60 + now.getMinutes());
  return minutesLeftToday <= SNOOZE_MINUTES;
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

  return {
    kind: 'due',
    hour: config.hour,
    snoozeCount: snoozeState.count,
    canSnooze: snoozeState.count < SNOOZE_LIMIT && !snoozeWouldCrossMidnight(now),
  };
}

/**
 * 오늘 테스트를 30분 미룬다. 한도(SNOOZE_LIMIT) 초과이거나 자정을 넘기는 시각이면
 * 아무것도 쓰지 않고 false. 성공하면 count+1 저장 후
 * rescheduleSlotNotifications()를 기다리고 true.
 *
 * 시각 검사를 `canSnooze`에만 두지 않고 여기서 다시 하는 이유: 덮개는 **뜰 때 한 번**
 * 판정한 `gate`를 들고 있다. 23:25에 뜬 덮개를 23:35에 누르면 화면에는 버튼이 살아
 * 있으므로, 여기서 막지 않으면 그 한 번은 자정을 넘겨 미뤄진다. 막힌 경우 화면은
 * 재조회(`onResolved`)로 마지막 기회 덮개로 바뀐다.
 */
export async function snoozeTest(nowMs: number = Date.now()): Promise<boolean> {
  if (snoozeWouldCrossMidnight(new Date(nowMs))) {
    return false;
  }

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

/**
 * 오늘은 테스트를 건너뛴다. rescheduleSlotNotifications()를 기다린다.
 *
 * ⚠ **현재 호출자가 없다** (2026-08-29). 딸 본인 요청으로 덮개의 [오늘은 넘어갈래]
 * 버튼을 없앴기 때문 — 미루기를 다 쓰면 나가는 길은 테스트를 보는 것뿐이다.
 * 그래도 지우지 않는 이유 둘: ⓐ 읽는 쪽(`getTodaySkipped()` → `kind: 'skipped'`)은
 * **반드시 살아 있어야 한다.** 이 변경 전에 오늘 넘어가기를 이미 쓴 사용자가 있고,
 * 그 기록을 무시하면 "넘어갔다"고 들은 사람에게 덮개가 다시 뜬다(자정에 자연 소멸).
 * ⓑ 이 기능은 4일 새 세 번 뒤집혔다 — 탈출구가 돌아올 여지가 있고, 그때 되살리는
 * 비용보다 여기 남겨두는 비용이 싸다. 되살리는 자리는 `TestGateOverlay`의 렌더
 * 삼항 마지막 `null`이다.
 */
export async function skipTestToday(): Promise<void> {
  await writeMeta([[KEY_SKIP_DAY, String(todayEpochDay())]]);

  const { rescheduleSlotNotifications } = await import('./notifications');
  await rescheduleSlotNotifications();
}

/**
 * __DEV__ 전용 QA 도구. 오늘의 미루기·넘어가기 기록만 지운다 — 예약 설정
 * (test_alarm_enabled/test_alarm_hour/pending 3키)은 절대 건드리지 않는다
 * (lib/habitQueries.ts의 deleteTodaySlotRecords()와 동일한 관행: __DEV__
 * 전용이라 감수하는 범위를 명확히 좁게 잡는다).
 *
 * 이게 없으면 실기기 QA에서 미루기(snooze)를 SNOOZE_LIMIT(1)회 쓰는 순간
 * canSnooze가 false로 굳어 그날은 덮개를 다시 볼 수 없다.
 */
/**
 * 예약 설정(켬/끔·시각·pending)을 통째로 지워 **"한 번도 설정한 적 없는" 상태**로 되돌린다.
 * `__DEV__` QA 전용 — 설정 화면의 개발자 도구에서만 부른다. 기본값이 켜짐으로 바뀐 뒤로는
 * (getTestAlarmConfig 참고) **초기화 결과가 "꺼짐"이 아니라 "켜짐 + 기본 시각"** 이다.
 *
 * 필요한 이유: setTestAlarm()의 비대칭(켜기는 즉시, 끄기·시각 변경은 내일부터) 때문에
 * **한 번 켜면 같은 날 안에는 되돌릴 수 없다** — current.enabled가 계속 true라
 * isTurningOn이 오늘은 영영 false다. 그 비대칭은 회피를 막는 제품 설계이므로 손대지 않고,
 * 대신 개발 빌드에만 우회로를 둔다. 미루기·넘어가기 기록은 clearTodayTestGateState() 담당.
 */
export async function resetTestAlarmConfig(): Promise<void> {
  await deleteMeta([...CONFIG_KEYS]);

  const { rescheduleSlotNotifications } = await import('./notifications');
  await rescheduleSlotNotifications();
}

export async function clearTodayTestGateState(): Promise<void> {
  await deleteMeta([KEY_SNOOZE_DAY, KEY_SNOOZE_COUNT, KEY_SNOOZE_UNTIL_MS, KEY_SKIP_DAY]);

  const { rescheduleSlotNotifications } = await import('./notifications');
  await rescheduleSlotNotifications();
}
