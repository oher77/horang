/**
 * 하루 4회 분산 인출 습관 시스템 — 데이터 계층 (설계.md §7)
 *
 * 슬롯(시간창) 설정·판정, 인출 세션 기록, 스트릭 파생, 습관 보너스(§7.4) 조회를
 * 담당한다. 화면 레이어는 이 모듈의 export만 사용하고 retrieval_session /
 * slot_config / habit_bonus 테이블에 직접 접근하지 않는다.
 *
 * 날짜는 lib/dates.ts의 todayEpochDay()/nowEpochMs()만 사용(§1.4 규약). 슬롯
 * hour 판정에 필요한 로컬 hour 추출만 예외적으로 이 파일 안에서 new Date(ms).getHours()를
 * 쓴다(작업 지시의 가드레일).
 */

import { getUserDb } from './db';
import { nowEpochMs, todayEpochDay } from './dates';

/** 습관 보너스 금액 기본값 (설계.md §7.4). income_rule과 축이 달라 섞지 않는다. */
export const DEFAULT_HABIT_BONUS = {
  fullDay: 200, // 하루 4/4 달성 보너스(원)
  streak7: 500, // 7일 연속 달성 시 추가 보너스(원). 7·14·21…일마다 지급(주기)
} as const;

const TOTAL_SLOTS = 4;

/** 슬롯 하나의 시간창. [startHour, endHour) 반열림 구간(§7.1). */
export interface SlotWindow {
  slotIndex: number;
  startHour: number;
  endHour: number;
}

/**
 * slot_config 4행을 slot_index 오름차순으로 반환한다. lib/db.ts의 ensureUserDb()가
 * 이미 lazy seed를 보장하지만, 방어적으로 여기서도 비어 있으면 채운다(ensureIncomeRules와
 * 동일한 lazy seed 관행 — §7.2 마이그레이션 절차 2).
 */
export async function getSlotConfig(): Promise<SlotWindow[]> {
  const db = getUserDb();
  await ensureSlotConfigSeeded(db);

  const rows = await db.getAllAsync<{ slot_index: number; start_hour: number; end_hour: number }>(
    'SELECT slot_index, start_hour, end_hour FROM slot_config ORDER BY slot_index ASC',
  );
  return rows.map((r) => ({
    slotIndex: r.slot_index,
    startHour: r.start_hour,
    endHour: r.end_hour,
  }));
}

/** db.ts의 seed와 동일한 기본값(§7.2). getUserDb()만으로 재시드가 필요한 방어적 경로용. */
const DEFAULT_SLOT_CONFIG: ReadonlyArray<SlotWindow> = [
  { slotIndex: 0, startHour: 6, endHour: 10 },
  { slotIndex: 1, startHour: 10, endHour: 15 },
  { slotIndex: 2, startHour: 15, endHour: 20 },
  { slotIndex: 3, startHour: 20, endHour: 24 },
];

async function ensureSlotConfigSeeded(db: ReturnType<typeof getUserDb>): Promise<void> {
  const row = await db.getFirstAsync<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM slot_config');
  if (row && row.cnt > 0) return;

  await db.withTransactionAsync(async () => {
    for (const slot of DEFAULT_SLOT_CONFIG) {
      await db.runAsync(
        'INSERT INTO slot_config (slot_index, start_hour, end_hour) VALUES (?, ?, ?)',
        [slot.slotIndex, slot.startHour, slot.endHour],
      );
    }
  });
}

/**
 * 슬롯 설정을 갱신한다(설정 화면 저장 경로, §7.3).
 * 검증: 4개 슬롯 각각 start<end, 정수 0~24, 정렬 후 겹침 금지(인접 접합은 허용
 * — slot[i].end <= slot[i+1].start). 위반 시 저장하지 않고 한국어 메시지로 throw.
 */
export async function updateSlotConfig(slots: SlotWindow[]): Promise<void> {
  if (slots.length !== TOTAL_SLOTS) {
    throw new Error('슬롯은 정확히 4개여야 합니다.');
  }

  for (const slot of slots) {
    if (
      !Number.isInteger(slot.startHour) ||
      !Number.isInteger(slot.endHour) ||
      slot.startHour < 0 ||
      slot.startHour > 24 ||
      slot.endHour < 0 ||
      slot.endHour > 24
    ) {
      throw new Error('슬롯 시각은 0~24 사이의 정수여야 합니다.');
    }
    if (slot.startHour >= slot.endHour) {
      throw new Error('각 슬롯은 시작 시각이 종료 시각보다 빨라야 합니다.');
    }
  }

  const sorted = [...slots].sort((a, b) => a.startHour - b.startHour);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].endHour > sorted[i + 1].startHour) {
      throw new Error('슬롯 시간대가 겹칠 수 없습니다.');
    }
  }

  const db = getUserDb();
  await db.withTransactionAsync(async () => {
    for (const slot of slots) {
      await db.runAsync(
        'UPDATE slot_config SET start_hour = ?, end_hour = ? WHERE slot_index = ?',
        [slot.startHour, slot.endHour, slot.slotIndex],
      );
    }
  });
}

/** ms 시각의 로컬 hour(0~23)를 추출한다. 슬롯 판정용 로컬 Date 연산은 이 함수로만 모은다. */
function localHourOf(ms: number): number {
  return new Date(ms).getHours();
}

/**
 * 주어진 시각(기본: 지금)의 로컬 hour가 속한 슬롯 인덱스를 반환한다.
 * 06시 이전(데드존)이거나 설정된 4슬롯 어디에도 속하지 않으면 null(§7.1).
 */
export async function currentSlotIndex(now: Date = new Date()): Promise<number | null> {
  const hour = localHourOf(now.getTime());
  const slots = await getSlotConfig();
  const hit = slots.find((s) => hour >= s.startHour && hour < s.endHour);
  return hit ? hit.slotIndex : null;
}

/** 오늘(todayEpochDay()) 확정 슬롯 4칸을 boolean[4]로 반환한다 (Q-HABIT-TODAY, §7.5). */
export async function getTodaySlots(): Promise<boolean[]> {
  const db = getUserDb();
  const today = todayEpochDay();
  const rows = await db.getAllAsync<{ slot_index: number }>(
    'SELECT slot_index FROM retrieval_session WHERE local_day = ?',
    [today],
  );
  const filled = new Set(rows.map((r) => r.slot_index));
  return Array.from({ length: TOTAL_SLOTS }, (_, i) => filled.has(i));
}

/** 특정 local_day에 확정된 slot_index 집합(Set) — 스트릭 계산용 내부 헬퍼. */
async function getFullDaysDesc(db: ReturnType<typeof getUserDb>): Promise<number[]> {
  const rows = await db.getAllAsync<{ local_day: number }>(
    `SELECT local_day
     FROM retrieval_session
     GROUP BY local_day
     HAVING COUNT(DISTINCT slot_index) = ?
     ORDER BY local_day DESC`,
    [TOTAL_SLOTS],
  );
  return rows.map((r) => r.local_day);
}

/**
 * 연속 달성 일수 (Q-HABIT-STREAK, §7.5). 4/4 달성한 날만 카운트하며, 최신일부터
 * 끊김 없이 센다. 오늘이 아직 4/4 전이면 어제부터 연속을 센다(오늘은 "진행 중").
 */
export async function getCurrentStreak(): Promise<number> {
  const db = getUserDb();
  const fullDays = await getFullDaysDesc(db);
  if (fullDays.length === 0) return 0;

  const today = todayEpochDay();
  const fullDaySet = new Set(fullDays);

  let cursor = fullDaySet.has(today) ? today : today - 1;
  let streak = 0;
  while (fullDaySet.has(cursor)) {
    streak += 1;
    cursor -= 1;
  }
  return streak;
}

/** 오늘 retrieval_session 행이 하나도 없으면 true (§7.1 첫 세션 체류 임계 판단용). */
export async function isFirstSessionOfToday(): Promise<boolean> {
  const db = getUserDb();
  const today = todayEpochDay();
  const row = await db.getFirstAsync<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM retrieval_session WHERE local_day = ?',
    [today],
  );
  return (row?.cnt ?? 0) === 0;
}

/** day.created_day == todayEpochDay() 여부 (Phase 1은 오늘 단어장만 인정, §7.6 미결 4). */
export async function isTodayDay(dayId: number): Promise<boolean> {
  const db = getUserDb();
  const row = await db.getFirstAsync<{ created_day: number }>(
    'SELECT created_day FROM day WHERE id = ?',
    [dayId],
  );
  if (!row) return false;
  return row.created_day === todayEpochDay();
}

/** recordRetrievalSession()의 결과 — 이번 호출로 무엇이 확정/지급됐는지. */
export interface RecordResult {
  recorded: boolean; // 이번 호출로 새 슬롯이 기록됐는지
  slotIndex: number | null; // 귀속 슬롯 (데드존/미기록이면 null 가능)
  fullDayBonusPaid: boolean; // 이번에 4/4 보너스가 지급됐는지
  streakBonusPaid: boolean; // 이번에 7일 주기 보너스가 지급됐는지
  streakDays: number; // 기록 후 스트릭
}

/**
 * 인출 세션 1회를 확정 기록한다 (§7.1~§7.4).
 *
 * 순서: isTodayDay 검사(아니면 미기록) → currentSlotIndex(데드존이면 미기록) →
 * INSERT OR IGNORE(UNIQUE(local_day,slot_index)가 멱등 보장, changes==0이면 미기록) →
 * 기록됐고 오늘 4/4가 되면 habit_bonus에 'full_day' INSERT OR IGNORE →
 * 스트릭 재계산, streak%7==0이면 'streak7' INSERT OR IGNORE. 전체를 트랜잭션으로 묶는다.
 */
export async function recordRetrievalSession(dayId: number): Promise<RecordResult> {
  const db = getUserDb();

  const isToday = await isTodayDay(dayId);
  if (!isToday) {
    const streakDays = await getCurrentStreak();
    return { recorded: false, slotIndex: null, fullDayBonusPaid: false, streakBonusPaid: false, streakDays };
  }

  const slotIndex = await currentSlotIndex();
  if (slotIndex === null) {
    const streakDays = await getCurrentStreak();
    return { recorded: false, slotIndex: null, fullDayBonusPaid: false, streakBonusPaid: false, streakDays };
  }

  const today = todayEpochDay();
  const doneMs = nowEpochMs();

  let recorded = false;
  let fullDayBonusPaid = false;
  let streakBonusPaid = false;

  await db.withTransactionAsync(async () => {
    const insertResult = await db.runAsync(
      'INSERT OR IGNORE INTO retrieval_session (local_day, slot_index, source, day_id, done_ms) VALUES (?, ?, ?, ?, ?)',
      [today, slotIndex, 'today', dayId, doneMs],
    );
    recorded = insertResult.changes > 0;
    if (!recorded) return;

    // 4/4 보너스: 이번 기록으로 오늘 슬롯이 모두 찼는지 확인
    const filledRow = await db.getFirstAsync<{ cnt: number }>(
      'SELECT COUNT(DISTINCT slot_index) AS cnt FROM retrieval_session WHERE local_day = ?',
      [today],
    );
    const isFullDay = (filledRow?.cnt ?? 0) === TOTAL_SLOTS;

    if (isFullDay) {
      const fullDayResult = await db.runAsync(
        'INSERT OR IGNORE INTO habit_bonus (local_day, kind, amount, paid, created_ms) VALUES (?, ?, ?, 0, ?)',
        [today, 'full_day', DEFAULT_HABIT_BONUS.fullDay, doneMs],
      );
      fullDayBonusPaid = fullDayResult.changes > 0;

      // 스트릭 재계산 (이 트랜잭션 내 최신 상태 반영) — 오늘이 방금 4/4가 됐으므로 오늘부터 역산
      const fullDays = await getFullDaysDesc(db);
      const fullDaySet = new Set(fullDays);
      let cursor = today;
      let streak = 0;
      while (fullDaySet.has(cursor)) {
        streak += 1;
        cursor -= 1;
      }

      if (streak > 0 && streak % 7 === 0) {
        const streakResult = await db.runAsync(
          'INSERT OR IGNORE INTO habit_bonus (local_day, kind, amount, paid, created_ms) VALUES (?, ?, ?, 0, ?)',
          [today, 'streak7', DEFAULT_HABIT_BONUS.streak7, doneMs],
        );
        streakBonusPaid = streakResult.changes > 0;
      }
    }
  });

  const streakDays = await getCurrentStreak();

  return { recorded, slotIndex, fullDayBonusPaid, streakBonusPaid, streakDays };
}

/** habit_bonus 1행 (용돈 장부 연동, §7.4). */
export interface HabitBonusRow {
  id: number;
  local_day: number;
  kind: 'full_day' | 'streak7';
  amount: number;
  paid: boolean;
  created_ms: number;
}

/** 'YYYY-MM' → 해당 월의 [시작 ms, 다음달 시작 ms) 범위. incomeQueries.currentMonthRangeMs와 동일한 로컬타임 방식. */
function monthRangeMs(yearMonth: string): { startMs: number; nextStartMs: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!match) {
    throw new Error('yearMonth는 "YYYY-MM" 형식이어야 합니다.');
  }
  const year = Number(match[1]);
  const month = Number(match[2]); // 1~12
  const start = new Date(year, month - 1, 1);
  const nextStart = new Date(year, month, 1);
  return { startMs: start.getTime(), nextStartMs: nextStart.getTime() };
}

/** 특정 월('YYYY-MM')의 habit_bonus 목록 (created_ms 로컬타임 기준, 최신순). */
export async function listHabitBonusesForMonth(yearMonth: string): Promise<HabitBonusRow[]> {
  const db = getUserDb();
  const { startMs, nextStartMs } = monthRangeMs(yearMonth);

  const rows = await db.getAllAsync<{
    id: number;
    local_day: number;
    kind: string;
    amount: number;
    paid: number;
    created_ms: number;
  }>(
    `SELECT id, local_day, kind, amount, paid, created_ms
     FROM habit_bonus
     WHERE created_ms >= ? AND created_ms < ?
     ORDER BY created_ms DESC`,
    [startMs, nextStartMs],
  );

  return rows.map((r) => ({
    id: r.id,
    local_day: r.local_day,
    kind: r.kind as 'full_day' | 'streak7',
    amount: r.amount,
    paid: r.paid === 1,
    created_ms: r.created_ms,
  }));
}

/** 특정 월('YYYY-MM')의 habit_bonus 합계(원). */
export async function getMonthHabitBonusTotal(yearMonth: string): Promise<number> {
  const db = getUserDb();
  const { startMs, nextStartMs } = monthRangeMs(yearMonth);

  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM habit_bonus
     WHERE created_ms >= ? AND created_ms < ?`,
    [startMs, nextStartMs],
  );
  return row?.total ?? 0;
}

/** 습관 보너스 지급 여부 토글 (부모 지급 체크, test_session.paid와 동일 개념). */
export async function setHabitBonusPaid(id: number, paid: boolean): Promise<void> {
  const db = getUserDb();
  await db.runAsync('UPDATE habit_bonus SET paid = ? WHERE id = ?', [paid ? 1 : 0, id]);
}
