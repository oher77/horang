/**
 * __DEV__ 전용 QA 픽스처 시더 — 용돈 장부 주별 집계 개편(lib/ledgerQueries.ts, 2026-08-30)을
 * 확인하려면 test_session/habit_bonus에 여러 주치 기록이 있어야 하는데, 개발 기기의
 * user.db(Expo Go 컨테이너)에는 그런 기록이 없다(TestFlight 컨테이너와 별개 —
 * .claude/agent-memory 참고). 실사용으로 채우려면 몇 주가 걸리므로 결정적 픽스처를
 * 즉시 심고/지운다.
 *
 * 범위는 "완료된 직전 3주"를 매번 다시 계산한다(상수로 박지 않음) — weekIndexOf/weekRangeOf
 * (lib/ledgerQueries.ts)로 오늘이 속한 주(w)를 구해 [w-3, w-1] 구간을 쓴다. 언제 눌러도
 * 유효한 범위가 나오게 하기 위함.
 *
 * 스키마는 절대 건드리지 않는다(가드레일) — 기존 테이블에 INSERT/DELETE만 한다.
 */

import { getUserDb } from './db';
import { epochDayToDate, REVIEW_OFFSETS, todayEpochDay } from './dates';
import { getHabitBonusAmounts } from './habitQueries';
import { getIncomeForScore } from './incomeQueries';
import { weekIndexOf, weekRangeOf } from './ledgerQueries';

/** seedLedgerFixture()의 결과 요약 — 설정 화면 Alert에 그대로 노출된다. */
export interface LedgerSeedResult {
  weeks: number; // 심은 주 수
  fullDays: number; // 4/4 달성일 수
  slots: number; // 심은 retrieval_session 행 수
  bonuses: number; // 심은 habit_bonus 행 수
  testSessions: number; // 심은 test_session 행 수 (day 행이 없으면 0)
  skippedTests: boolean; // day 테이블이 비어 test_session을 건너뛰었는가
  startDay: number;
  endDay: number;
}

const DAYS_IN_FIXTURE = 21; // offset 0(오늘 직전 3주 시작)..20 — 완료된 3주 전체
const ALL_SLOT_INDICES = [0, 1, 2, 3];

/** 슬롯별 그럴듯한 시각(로컬 hour) — slot_config 기본값(§7.2) 각 창의 중간값에 가깝게. */
const SLOT_HOUR: Record<number, number> = { 0: 9, 1: 13, 2: 17, 3: 21 };

/**
 * offset 3(하루)만 2/4로 비워 "쉬는 날"을 재현한다. 나머지 20일은 4/4.
 *
 * offset은 **startDay(가장 오래된 날)부터의 경과일**이다 — offset 0이 최신이 아니다.
 * 쉬는 날을 앞쪽(offset 3)에 두는 것이 이 픽스처의 핵심: 그래야 뒤쪽 17일이 끊김 없이
 * 이어져 오늘 기준 getCurrentStreak()이 17을 반환한다. 뒤쪽에 두면 현재 스트릭이 3으로
 * 떨어져 "열심히 하는 아이"라는 픽스처의 전제가 무너진다.
 */
const PARTIAL_OFFSET = 3;
const PARTIAL_SLOTS = [0, 1]; // 2/4로 채울 슬롯 인덱스

/** 점수 순환 배열 — 90~100 위주, 결정적. */
const SCORE_CYCLE = [100, 95, 90, 100, 95, 85, 100] as const;

/**
 * 하루에 몇 개의 복습 Day를 통과한 것으로 칠지. 복습 보너스는 슬롯마다 다시 지급되므로
 * (§7.4 — 매 슬롯마다 복습 Day 전부를 다시 훑는다) 4/4인 날에는 4 × 4 = 16건이 쌓인다.
 *
 * 실제 스케줄 REVIEW_OFFSETS(-1/-3/-7/-14/-30/-60/-120일) 중 3주차 아이에게 도달하는
 * 앞의 4개만 쓴다는 뜻이다.
 */
const REVIEW_DAYS_PER_DAY = 4;

/**
 * 픽스처 시작일(offset 0)에 아이가 하고 있던 커리큘럼 Day 번호 — 복습 Day 번호의 기준점.
 * -14일 복습이 Day 1 아래로 내려가지 않으려면 15 이상이어야 한다.
 */
const CURRICULUM_DAY_AT_START = 21;

/**
 * 그 날 복습한 것으로 칠 **Day 번호** 목록 (REVIEW_OFFSETS 앞 4개 = -1/-3/-7/-14일 전).
 *
 * **day 테이블을 조회하지 않는다.** kind 문자열 안의 숫자를 소비하는 곳은 장부 라벨의
 * 정규식(/^review_day_(\d+)_s\d+$/, app/achievements/index.tsx:81)뿐이고 day 행에
 * 조인하지 않기 때문이다. 실제 day id를 쓰면 개발 기기의 day 행 수에 건수가 끌려간다 —
 * 4개 미만이면 복습이 조용히 줄어 16건인 날이 아예 안 생긴다(2026-08-30 실기기에서 발생).
 *
 * 반환값은 항상 서로 다른 4개라 UNIQUE(local_day, kind)에 걸리지 않는다.
 */
function reviewDayNumbers(offset: number): number[] {
  const current = CURRICULUM_DAY_AT_START + offset;
  return REVIEW_OFFSETS.slice(0, REVIEW_DAYS_PER_DAY).map((back) => current - back);
}

/**
 * [startDay, endDay] 범위 + 가장 오래된 주(paid=1 대상) 범위를 계산한다 —
 * "완료된 직전 3주"를 호출 시점마다 새로 구한다(상수로 박지 않음).
 */
function fixtureRange(): {
  startDay: number;
  endDay: number;
  oldestWeekStart: number;
  oldestWeekEnd: number;
} {
  const w = weekIndexOf(todayEpochDay());
  const oldest = weekRangeOf(w - 3);
  const endDay = weekRangeOf(w - 1).endDay;
  return {
    startDay: oldest.startDay,
    endDay,
    oldestWeekStart: oldest.startDay,
    oldestWeekEnd: oldest.endDay,
  };
}

/**
 * 오늘까지의 스트릭을 실제 recordSlotPart() 로직과 동일한 방식으로 재현한다:
 * "그 날이 4/4가 된 순간, 그 날(cursor)부터 과거 방향(cursor 감소)으로 끊김 없이
 * 센 연속 일수". epochDay가 클수록 최신이므로 cursor를 감소시키는 것이 과거로
 * 가는 방향이다(lib/habitQueries.ts recordSlotPart의 스트릭 재계산 블록과 동일 알고리즘).
 */
function streakAsOf(epochDay: number, fullDaySet: Set<number>): number {
  let streak = 0;
  let cursor = epochDay;
  while (fullDaySet.has(cursor)) {
    streak += 1;
    cursor -= 1;
  }
  return streak;
}

/**
 * __DEV__ QA 전용. 완료된 직전 3주(21일)에 결정적 픽스처를 심는다.
 * 항상 clearLedgerFixture()를 먼저 호출해 멱등하게 만든다(test_session에는
 * UNIQUE 제약이 없어 두 번 누르면 중복 삽입되기 때문).
 */
export async function seedLedgerFixture(): Promise<LedgerSeedResult> {
  if (!__DEV__) throw new Error('seedLedgerFixture는 __DEV__ 전용입니다.');

  await clearLedgerFixture();

  const db = getUserDb();
  const { startDay, endDay, oldestWeekStart, oldestWeekEnd } = fixtureRange();
  const bonusAmounts = await getHabitBonusAmounts();

  const dayRows = await db.getAllAsync<{ id: number }>('SELECT id FROM day ORDER BY id ASC');
  const dayIds = dayRows.map((r) => r.id);
  const hasDays = dayIds.length > 0;

  let slots = 0;
  let bonuses = 0;
  let testSessions = 0;
  let fullDaysCount = 0;

  // 4/4 달성일 집합(스트릭 재계산용) — offset 0(가장 오래됨)..20(가장 최신).
  const fullDaySet = new Set<number>();
  for (let offset = 0; offset < DAYS_IN_FIXTURE; offset += 1) {
    if (offset !== PARTIAL_OFFSET) fullDaySet.add(startDay + offset);
  }

  await db.withTransactionAsync(async () => {
    let cycleIndex = 0;

    // 오래된 날짜부터 최신 날짜 순으로 심는다(offset 0 → 20) — 스트릭을 실제 지급
    // 순서와 동일하게 누적 계산하기 위해서다.
    for (let offset = 0; offset < DAYS_IN_FIXTURE; offset += 1) {
      const epochDay = startDay + offset;
      const isFullDay = offset !== PARTIAL_OFFSET;
      const slotIndices = isFullDay ? ALL_SLOT_INDICES : PARTIAL_SLOTS;
      // 지급 상태: 가장 오래된 주(weekRangeOf(w-3))만 paid=1.
      const paid = epochDay >= oldestWeekStart && epochDay <= oldestWeekEnd ? 1 : 0;

      // 그 날 복습한 것으로 칠 Day 번호 목록 — day 테이블과 무관하게 항상 4개.
      const reviewDayIds = reviewDayNumbers(offset);

      // retrieval_session (슬롯 완성) — 완료 슬롯마다 1행.
      for (const slotIndex of slotIndices) {
        const dayId = hasDays ? dayIds[(offset + slotIndex) % dayIds.length] : null;
        const doneMs = localMsAt(epochDay, SLOT_HOUR[slotIndex]);
        await db.runAsync(
          'INSERT INTO retrieval_session (local_day, slot_index, source, day_id, done_ms) VALUES (?, ?, ?, ?, ?)',
          [epochDay, slotIndex, 'today', dayId, doneMs],
        );
        slots += 1;

        // slot_pass_{slotIndex} 보너스 — 완료 슬롯마다.
        const passMs = doneMs;
        const passResult = await db.runAsync(
          'INSERT OR IGNORE INTO habit_bonus (local_day, kind, amount, paid, created_ms) VALUES (?, ?, ?, ?, ?)',
          [epochDay, `slot_pass_${slotIndex}`, bonusAmounts.slotPass, paid, passMs],
        );
        if (passResult.changes > 0) bonuses += 1;

        // review_day_{dayId}_s{slotIndex} — 복습 Day 1개 통과당 1건. 슬롯마다 다시 지급된다
        // (실제 지급 로직 recordSlotPart()와 동일한 kind 형식이어야 장부의
        // habitBonusLabel()이 "Day N 복습"으로 읽는다 — /^review_day_(\d+)_s\d+$/).
        for (const reviewDayId of reviewDayIds) {
          const reviewResult = await db.runAsync(
            'INSERT OR IGNORE INTO habit_bonus (local_day, kind, amount, paid, created_ms) VALUES (?, ?, ?, ?, ?)',
            [
              epochDay,
              `review_day_${reviewDayId}_s${slotIndex}`,
              bonusAmounts.reviewDay,
              paid,
              doneMs,
            ],
          );
          if (reviewResult.changes > 0) bonuses += 1;
        }
      }

      if (isFullDay) {
        fullDaysCount += 1;
        const lastSlotMs = localMsAt(epochDay, SLOT_HOUR[3]);

        // full_day 보너스
        const fullDayResult = await db.runAsync(
          'INSERT INTO habit_bonus (local_day, kind, amount, paid, created_ms) VALUES (?, ?, ?, ?, ?)',
          [epochDay, 'full_day', bonusAmounts.fullDay, paid, lastSlotMs],
        );
        if (fullDayResult.changes > 0) bonuses += 1;

        // 스트릭 보너스 — recordSlotPart와 동일한 알고리즘으로 그 날 시점 스트릭을 구함.
        const streak = streakAsOf(epochDay, fullDaySet);
        if (streak > 0 && streak % 7 === 0) {
          const streak7Result = await db.runAsync(
            'INSERT INTO habit_bonus (local_day, kind, amount, paid, created_ms) VALUES (?, ?, ?, ?, ?)',
            [epochDay, 'streak7', bonusAmounts.streak7, paid, lastSlotMs],
          );
          if (streak7Result.changes > 0) bonuses += 1;
        }
        if (streak === 14) {
          const streak14Result = await db.runAsync(
            'INSERT INTO habit_bonus (local_day, kind, amount, paid, created_ms) VALUES (?, ?, ?, ?, ?)',
            [epochDay, 'streak14', bonusAmounts.streak14, paid, lastSlotMs],
          );
          if (streak14Result.changes > 0) bonuses += 1;
        }
      }

      // test_session — offset 3(쉬는 날)만 빼고 20일, 하루 1건.
      if (offset !== PARTIAL_OFFSET && hasDays) {
        const score100 = SCORE_CYCLE[cycleIndex % SCORE_CYCLE.length];
        cycleIndex += 1;
        const incomeAmount = await getIncomeForScore(score100);
        const dayId = dayIds[offset % dayIds.length];
        const takenMs = localMsAt(epochDay, SLOT_HOUR[1]); // 오후 시간대에 응시한 것으로
        const totalCount = 20;
        const correctCount = Math.round((score100 / 100) * totalCount);

        await db.runAsync(
          `INSERT INTO test_session (day_id, taken_day, taken_ms, total_count, correct_count, score100, income_amount, paid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [dayId, epochDay, takenMs, totalCount, correctCount, score100, incomeAmount, paid],
        );
        testSessions += 1;
      }
    }
  });

  return {
    weeks: 3,
    fullDays: fullDaysCount,
    slots,
    bonuses,
    testSessions,
    skippedTests: !hasDays,
    startDay,
    endDay,
  };
}

/**
 * 로컬 캘린더 날짜(epochDay) + 로컬 hour → epoch ms.
 *
 * `epochDay * 86400000`은 그 날짜의 **UTC** 자정이라 로컬 hour를 그냥 더하면 타임존만큼
 * 밀린다(KST면 +9시간 → 21시 슬롯이 다음날 06시가 된다). 정렬만 놓고 보면 전부 같은 폭으로
 * 밀려 무해하지만, getMonthIncomeTotal()·getMonthHabitBonusTotal()이 taken_ms/created_ms
 * **범위**로 월을 자르므로 월말 항목이 다음 달 합계로 새어 들어간다. epochDayToDate()로
 * 캘린더 날짜를 되찾아 로컬 시각으로 만든다.
 */
function localMsAt(epochDay: number, hour: number): number {
  const d = epochDayToDate(epochDay); // 해당 캘린더 날짜의 UTC 자정 (연/월/일은 UTC 게터로)
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour).getTime();
}

/**
 * __DEV__ QA 전용. seedLedgerFixture()가 심은 것과 같은 방식으로 범위를 재계산해
 * 그 범위(완료된 직전 3주)의 habit_bonus/test_session/retrieval_session만 지운다.
 * 지운 총 행 수를 반환한다.
 */
export async function clearLedgerFixture(): Promise<number> {
  if (!__DEV__) throw new Error('clearLedgerFixture는 __DEV__ 전용입니다.');

  const db = getUserDb();
  const { startDay, endDay } = fixtureRange();

  let total = 0;
  await db.withTransactionAsync(async () => {
    const habitResult = await db.runAsync(
      'DELETE FROM habit_bonus WHERE local_day >= ? AND local_day <= ?',
      [startDay, endDay],
    );
    total += habitResult.changes;

    const testResult = await db.runAsync(
      'DELETE FROM test_session WHERE taken_day >= ? AND taken_day <= ?',
      [startDay, endDay],
    );
    total += testResult.changes;

    const retrievalResult = await db.runAsync(
      'DELETE FROM retrieval_session WHERE local_day >= ? AND local_day <= ?',
      [startDay, endDay],
    );
    total += retrievalResult.changes;
  });

  return total;
}
