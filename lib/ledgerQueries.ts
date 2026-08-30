/**
 * 용돈 장부 개편(2026-08-30) 전용 쿼리 — 개별 항목 나열 대신 "기간별 집계 + 탭하면
 * 열리는 세부내역 바텀시트" 구조를 뒷받침한다. test_session(설계.md §1.3)과
 * habit_bonus(§7.4)를 병합 표현하는 LedgerEntry가 최소 단위이고, 그 위에 날짜별/주별
 * 집계를 얹는다.
 *
 * 주 경계는 일요일 시작(WEEK_ANCHOR_OFFSET=4) — epoch day 0(1970-01-01)이 목요일이므로
 * (epochDay + 4)를 7로 나눈 몫이 "일요일 시작 주"의 인덱스가 된다(1970-01-04 일요일 = day 3이
 * 몫 1의 첫날). 월요일 시작으로 되돌리려면 이 오프셋을 3으로 바꾸면 된다.
 *
 * 날짜는 전부 lib/dates.ts의 epoch day 규약(디바이스 로컬 자정 기준)을 따른다 —
 * test_session.taken_day / habit_bonus.local_day 둘 다 이미 이 규약으로 저장돼 있다
 * (설계.md §1.4). 주 묶기는 strftime/localtime을 쓰지 않고 정수 연산만 사용한다.
 */

import { getUserDb } from './db';

/** 일요일 시작 주의 앵커 오프셋 (2026-08-30 사용자 확정). 월요일 시작으로 되돌리려면 3. */
const WEEK_ANCHOR_OFFSET = 4;

/** 장부 개별 항목 1행 — test_session / habit_bonus 병합 표현. */
export interface LedgerEntry {
  key: string; // 'test-123' | 'habit-45'
  source: 'test' | 'habit';
  id: number;
  epochDay: number; // test_session.taken_day | habit_bonus.local_day
  ms: number; // 정렬 키 (taken_ms | created_ms)
  dayIndex: number | null; // test만 (day.day_index)
  kind: string | null; // habit만 (habit_bonus.kind)
  score100: number | null; // test만
  amount: number;
  paid: boolean;
}

/** 주별 집계 1행. */
export interface WeekLedgerSummary {
  weekIndex: number;
  startDay: number; // epoch day (일요일)
  endDay: number; // startDay + 6 (토요일)
  total: number;
  entryCount: number;
  paidCount: number;
}

/** 날짜별 집계 1행. */
export interface DayLedgerSummary {
  epochDay: number;
  total: number;
  entryCount: number;
}

/** epoch day가 속한 주의 인덱스 (일요일 시작). */
export function weekIndexOf(epochDay: number): number {
  return Math.floor((epochDay + WEEK_ANCHOR_OFFSET) / 7);
}

/** 주 인덱스 → [startDay(일요일), endDay(토요일)] epoch day 범위. */
export function weekRangeOf(weekIndex: number): { startDay: number; endDay: number } {
  const startDay = weekIndex * 7 - WEEK_ANCHOR_OFFSET;
  return { startDay, endDay: startDay + 6 };
}

interface TestRow {
  id: number;
  taken_day: number;
  taken_ms: number;
  day_index: number;
  score100: number | null;
  income_amount: number | null;
  paid: number;
}

interface HabitRow {
  id: number;
  local_day: number;
  created_ms: number;
  kind: string;
  amount: number;
  paid: number;
}

function testRowToEntry(r: TestRow): LedgerEntry {
  return {
    key: `test-${r.id}`,
    source: 'test',
    id: r.id,
    epochDay: r.taken_day,
    ms: r.taken_ms,
    dayIndex: r.day_index,
    kind: null,
    score100: r.score100,
    amount: r.income_amount ?? 0,
    paid: r.paid === 1,
  };
}

function habitRowToEntry(r: HabitRow): LedgerEntry {
  return {
    key: `habit-${r.id}`,
    source: 'habit',
    id: r.id,
    epochDay: r.local_day,
    ms: r.created_ms,
    dayIndex: null,
    kind: r.kind,
    score100: null,
    amount: r.amount,
    paid: r.paid === 1,
  };
}

/** 특정 날짜(epoch day)의 개별 항목 전체 — 세부내역 시트의 "entries" 모드와, 섹션 맨 위
 * 오늘 미리보기(화면에서 5건으로 잘라 쓴다)가 함께 쓴다. 전 기간 최신 N건을 뽑던
 * getRecentLedgerEntries는 미리보기가 "오늘"로 좁혀지며(2026-08-30) 쓰임이 없어져 지웠다. */
export async function getLedgerEntriesForDay(epochDay: number): Promise<LedgerEntry[]> {
  const userDb = getUserDb();

  const [testRows, habitRows] = await Promise.all([
    userDb.getAllAsync<TestRow>(
      `SELECT ts.id, ts.taken_day, ts.taken_ms, d.day_index, ts.score100, ts.income_amount, ts.paid
       FROM test_session ts JOIN day d ON d.id = ts.day_id
       WHERE ts.taken_day = ?`,
      [epochDay],
    ),
    userDb.getAllAsync<HabitRow>(
      `SELECT id, local_day, created_ms, kind, amount, paid
       FROM habit_bonus
       WHERE local_day = ?`,
      [epochDay],
    ),
  ]);

  const merged = [...testRows.map(testRowToEntry), ...habitRows.map(habitRowToEntry)];
  merged.sort((a, b) => b.ms - a.ms);
  return merged;
}

/** [startDay, endDay] 범위(양끝 포함)의 합계 금액 — "오늘"/"이번주" 합계 행용. */
export async function getLedgerTotalForRange(startDay: number, endDay: number): Promise<number> {
  const userDb = getUserDb();

  const [testRow, habitRow] = await Promise.all([
    userDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(income_amount), 0) AS total
       FROM test_session
       WHERE taken_day >= ? AND taken_day <= ?`,
      [startDay, endDay],
    ),
    userDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM habit_bonus
       WHERE local_day >= ? AND local_day <= ?`,
      [startDay, endDay],
    ),
  ]);

  return (testRow?.total ?? 0) + (habitRow?.total ?? 0);
}

/**
 * 기록이 있는 모든 주의 집계, 최신순. 두 테이블을 각각 주 단위로 GROUP BY한 뒤
 * JS에서 weekIndex 기준으로 합친다.
 *
 * SQLite 정수 나눗셈은 음수를 0쪽으로 절단하므로 `taken_day + WEEK_ANCHOR_OFFSET`이
 * 음수가 되면 `Math.floor`와 결과가 갈리지만, 그러려면 기록이 1969-12-28 이전이어야
 * 한다. 이 앱의 데이터 범위(2026년)에서는 전부 양수라 실제로는 문제되지 않는다.
 */
export async function getWeeklyLedgerSummaries(): Promise<WeekLedgerSummary[]> {
  const userDb = getUserDb();

  const [testRows, habitRows] = await Promise.all([
    userDb.getAllAsync<{ week_index: number; total: number; cnt: number; paid_cnt: number }>(
      `SELECT (taken_day + ${WEEK_ANCHOR_OFFSET}) / 7 AS week_index,
              COALESCE(SUM(income_amount), 0) AS total,
              COUNT(*) AS cnt,
              SUM(CASE WHEN paid = 1 THEN 1 ELSE 0 END) AS paid_cnt
       FROM test_session
       GROUP BY week_index`,
    ),
    userDb.getAllAsync<{ week_index: number; total: number; cnt: number; paid_cnt: number }>(
      `SELECT (local_day + ${WEEK_ANCHOR_OFFSET}) / 7 AS week_index,
              COALESCE(SUM(amount), 0) AS total,
              COUNT(*) AS cnt,
              SUM(CASE WHEN paid = 1 THEN 1 ELSE 0 END) AS paid_cnt
       FROM habit_bonus
       GROUP BY week_index`,
    ),
  ]);

  const byWeek = new Map<number, WeekLedgerSummary>();
  const merge = (row: { week_index: number; total: number; cnt: number; paid_cnt: number }) => {
    const existing = byWeek.get(row.week_index);
    if (existing) {
      existing.total += row.total;
      existing.entryCount += row.cnt;
      existing.paidCount += row.paid_cnt;
    } else {
      const { startDay, endDay } = weekRangeOf(row.week_index);
      byWeek.set(row.week_index, {
        weekIndex: row.week_index,
        startDay,
        endDay,
        total: row.total,
        entryCount: row.cnt,
        paidCount: row.paid_cnt,
      });
    }
  };
  testRows.forEach(merge);
  habitRows.forEach(merge);

  return Array.from(byWeek.values()).sort((a, b) => b.weekIndex - a.weekIndex);
}

/**
 * [startDay, endDay] 범위 안에서 기록이 있는 날짜별 집계, 최신순 (세부내역 시트
 * 1단 "days" 모드 — 주 행을 탭했을 때).
 */
export async function getDailyLedgerSummaries(
  startDay: number,
  endDay: number,
): Promise<DayLedgerSummary[]> {
  const userDb = getUserDb();

  const [testRows, habitRows] = await Promise.all([
    userDb.getAllAsync<{ epoch_day: number; total: number; cnt: number }>(
      `SELECT taken_day AS epoch_day, COALESCE(SUM(income_amount), 0) AS total, COUNT(*) AS cnt
       FROM test_session
       WHERE taken_day >= ? AND taken_day <= ?
       GROUP BY taken_day`,
      [startDay, endDay],
    ),
    userDb.getAllAsync<{ epoch_day: number; total: number; cnt: number }>(
      `SELECT local_day AS epoch_day, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS cnt
       FROM habit_bonus
       WHERE local_day >= ? AND local_day <= ?
       GROUP BY local_day`,
      [startDay, endDay],
    ),
  ]);

  const byDay = new Map<number, DayLedgerSummary>();
  const merge = (row: { epoch_day: number; total: number; cnt: number }) => {
    const existing = byDay.get(row.epoch_day);
    if (existing) {
      existing.total += row.total;
      existing.entryCount += row.cnt;
    } else {
      byDay.set(row.epoch_day, { epochDay: row.epoch_day, total: row.total, entryCount: row.cnt });
    }
  };
  testRows.forEach(merge);
  habitRows.forEach(merge);

  return Array.from(byDay.values()).sort((a, b) => b.epochDay - a.epochDay);
}

/**
 * [startDay, endDay] 범위의 test_session·habit_bonus paid 여부를 일괄 변경한다
 * (주 단위 일괄 지급 — 한 주에 200행 넘을 수 있어 행마다 UPDATE하지 않고 테이블당
 * 1쿼리씩 총 2쿼리로 처리).
 */
export async function setRangePaid(startDay: number, endDay: number, paid: boolean): Promise<void> {
  const userDb = getUserDb();
  const paidValue = paid ? 1 : 0;

  await userDb.withTransactionAsync(async () => {
    await userDb.runAsync(
      'UPDATE test_session SET paid = ? WHERE taken_day >= ? AND taken_day <= ?',
      [paidValue, startDay, endDay],
    );
    await userDb.runAsync(
      'UPDATE habit_bonus SET paid = ? WHERE local_day >= ? AND local_day <= ?',
      [paidValue, startDay, endDay],
    );
  });
}
