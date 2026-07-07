/**
 * Income(용돈 장부) 전용 쿼리 (설계.md §1.3 income_rule/test_session DDL,
 * §4.4 나의 업적/설정 화면 쿼리 매핑, §5 Q-INCOME-FOR-SCORE/Q-INCOME-MONTH/Q-RECENT5)
 *
 * 실물 결제 연동 없음 — "이 점수면 얼마"를 income_rule로 매칭해 test_session에
 * 스냅샷 저장하고, 부모가 지급했는지 사용자가 직접 체크하는 장부 개념
 * (단어장 앱 만들기.md "나의 업적 화면 구성" 참고).
 */

import { getUserDb } from './db';

/** 점수→Income 매핑 규칙 1행 (income_rule). */
export interface IncomeRule {
  id: number;
  min_score: number;
  amount: number;
}

/**
 * 점수→Income 금액 기본값 (설계.md §6-11 "Income 규칙 편집 UI" 미결 —
 * 기획서·설계.md 어디에도 구체 금액이 확정돼 있지 않아 임의 기본값을 정함.
 * lib/reviewQueries.ts의 WRITING_RATIO와 동일한 패턴: 상수로 분리해 추후 설정
 * 화면에서 income_rule 테이블 값을 직접 편집하면 바로 반영되도록 함).
 *
 * 100점 만점 기준 4구간 — 90/80/70점 문턱, 1000/800/500/300원.
 */
export const DEFAULT_INCOME_RULES: ReadonlyArray<{ min_score: number; amount: number }> = [
  { min_score: 100, amount: 1000 },
  { min_score: 90, amount: 800 },
  { min_score: 70, amount: 500 },
  { min_score: 50, amount: 300 },
];

/**
 * income_rule 테이블이 비어 있으면 기본 규칙을 채운다 (lib/db.ts의 ensureUserDb는
 * 이번 작업 소유권 밖이라 스키마 마이그레이션만 하고 시드는 하지 않음 — 여기서
 * lazy seed로 보완). 이미 규칙이 있으면(사용자가 설정에서 편집한 경우 포함)
 * 아무 것도 하지 않는다.
 */
export async function ensureIncomeRules(): Promise<void> {
  const userDb = getUserDb();
  const row = await userDb.getFirstAsync<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM income_rule',
  );
  if (row && row.cnt > 0) return;

  await userDb.withTransactionAsync(async () => {
    for (const rule of DEFAULT_INCOME_RULES) {
      await userDb.runAsync(
        'INSERT INTO income_rule (min_score, amount) VALUES (?, ?)',
        [rule.min_score, rule.amount],
      );
    }
  });
}

/**
 * 점수(100점 환산)에 매칭되는 Income 금액 (Q-INCOME-FOR-SCORE).
 * 매칭 규칙이 없으면(seed 실패 등 방어적 상황) 0원.
 */
export async function getIncomeForScore(score100: number): Promise<number> {
  const userDb = getUserDb();
  await ensureIncomeRules();
  const row = await userDb.getFirstAsync<{ amount: number }>(
    'SELECT amount FROM income_rule WHERE min_score <= ? ORDER BY min_score DESC LIMIT 1',
    [score100],
  );
  return row?.amount ?? 0;
}

/** 월별 Income 목록 1행 (Q-RECENT5 확장 — 장부 화면은 전체 월 목록이 필요). */
export interface IncomeSessionRow {
  sessionId: number;
  takenMs: number;
  dayId: number;
  dayIndex: number;
  score100: number | null;
  incomeAmount: number | null;
  paid: boolean;
}

/**
 * 이번 달(로컬 기준) test_session 목록을 최신순으로 반환한다 (장부 화면 월별 목록).
 * Q-INCOME-MONTH의 월 경계 계산과 동일하게 JS에서 이번 달 시작/다음달 시작 ms를 구해
 * taken_ms 범위로 좁힌다.
 */
export async function getIncomeSessionsThisMonth(): Promise<IncomeSessionRow[]> {
  const userDb = getUserDb();
  const { startMs, nextStartMs } = currentMonthRangeMs();

  const rows = await userDb.getAllAsync<{
    id: number;
    taken_ms: number;
    day_id: number;
    day_index: number;
    score100: number | null;
    income_amount: number | null;
    paid: number;
  }>(
    `SELECT ts.id, ts.taken_ms, ts.day_id, d.day_index, ts.score100, ts.income_amount, ts.paid
     FROM test_session ts JOIN day d ON d.id = ts.day_id
     WHERE ts.taken_ms >= ? AND ts.taken_ms < ?
     ORDER BY ts.taken_ms DESC`,
    [startMs, nextStartMs],
  );

  return rows.map((r) => ({
    sessionId: r.id,
    takenMs: r.taken_ms,
    dayId: r.day_id,
    dayIndex: r.day_index,
    score100: r.score100,
    incomeAmount: r.income_amount,
    paid: r.paid === 1,
  }));
}

/** 이달 Income 합 (Q-INCOME-MONTH). */
export async function getMonthIncomeTotal(): Promise<number> {
  const userDb = getUserDb();
  const { startMs, nextStartMs } = currentMonthRangeMs();

  const row = await userDb.getFirstAsync<{ month_income: number }>(
    `SELECT COALESCE(SUM(income_amount),0) AS month_income
     FROM test_session
     WHERE taken_ms >= ? AND taken_ms < ?`,
    [startMs, nextStartMs],
  );
  return row?.month_income ?? 0;
}

/**
 * 지급 여부 토글 (부모가 준 돈 체크 — 결제 연동 없음, 장부 체크만).
 * user.db에 즉시 반영한다.
 */
export async function setSessionPaid(sessionId: number, paid: boolean): Promise<void> {
  const userDb = getUserDb();
  await userDb.runAsync('UPDATE test_session SET paid = ? WHERE id = ?', [paid ? 1 : 0, sessionId]);
}

/** 로컬 기준 이번 달 시작 ms / 다음 달 시작 ms. */
function currentMonthRangeMs(): { startMs: number; nextStartMs: number } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { startMs: start.getTime(), nextStartMs: nextStart.getTime() };
}
