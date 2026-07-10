/**
 * 발음 체크 장부 + 홈 통계 전용 쿼리
 * (설계.md §4.4 낯가림 단어/나의 업적 쿼리 매핑, §5 Q-SCARY-TOP10 / Q-RECENT5 /
 * Q-WORD-STATE-TREND / Q-INCOME-TREND, §1.3 test_item.pron_confused)
 *
 * 2-DB 구조 원칙(설계.md §1.1)을 그대로 따른다: user.db에서 test_item/test_session을
 * 집계하고, content.db에서 headword를 조회해 애플리케이션 레벨로 합친다.
 */

import { getContentDb, getUserDb } from './db';
import { nowEpochMs, todayEpochDay } from './dates';

/** 낯가림 단어 1건 (Q-SCARY-TOP10: 오답 1회↑ 단어, 오답횟수 내림차순 상위 10). */
export interface ScaryWord {
  content_word_id: number;
  headword: string;
  wrong_count: number;
}

/**
 * 오답(is_wrong=1) 1회 이상인 단어를 오답 횟수순으로 상위 10개 조회한다.
 * idx_testitem_wrong 부분 인덱스를 태운다 (설계.md §5 Q-SCARY-TOP10).
 */
export async function getScaryWordsTop10(): Promise<ScaryWord[]> {
  const userDb = getUserDb();
  const contentDb = getContentDb();

  const rows = await userDb.getAllAsync<{ content_word_id: number; wrong_cnt: number }>(
    `SELECT content_word_id, COUNT(*) AS wrong_cnt
     FROM test_item
     WHERE is_wrong = 1
     GROUP BY content_word_id
     HAVING wrong_cnt >= 1
     ORDER BY wrong_cnt DESC
     LIMIT 10`,
  );

  if (rows.length === 0) return [];

  const wordIds = rows.map((r) => r.content_word_id);
  const placeholders = wordIds.map(() => '?').join(',');
  const wordRows = await contentDb.getAllAsync<{ id: number; headword: string }>(
    `SELECT id, headword FROM word WHERE id IN (${placeholders})`,
    wordIds,
  );
  const headwordById = new Map(wordRows.map((w) => [w.id, w.headword]));

  return rows.map((r) => ({
    content_word_id: r.content_word_id,
    headword: headwordById.get(r.content_word_id) ?? '(삭제된 단어)', // tombstone (설계.md §3.4)
    wrong_count: r.wrong_cnt,
  }));
}

/** 최근 5일 테스트 점수 1건 (Q-RECENT5). */
export interface RecentScore {
  session_id: number;
  taken_ms: number;
  day_id: number;
  day_index: number;
  score100: number | null;
  income_amount: number | null;
  paid: number;
}

/**
 * 오늘 기준 최근 5일(taken_day >= today-4)의 테스트 점수를 최신순으로 조회한다.
 * idx_session_takenday 인덱스를 태운다 (설계.md §5 Q-RECENT5).
 */
export async function getRecentScores(): Promise<RecentScore[]> {
  const userDb = getUserDb();
  const today = todayEpochDay();

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
     WHERE ts.taken_day >= ?
     ORDER BY ts.taken_ms DESC`,
    [today - 4],
  );

  return rows.map((r) => ({
    session_id: r.id,
    taken_ms: r.taken_ms,
    day_id: r.day_id,
    day_index: r.day_index,
    score100: r.score100,
    income_amount: r.income_amount,
    paid: r.paid,
  }));
}

/** 단어별 정답/오답 상태 추이 1포인트 (Q-WORD-STATE-TREND, 일별). */
export interface WordStatePoint {
  day: number; // epoch day
  correctCount: number; // 그 날 기준, 지금까지 테스트된 고유 단어 중 최신 결과가 정답인 단어 수
  wrongCount: number; // 최신 결과가 오답인 단어 수
}

/**
 * 최근 `days`일(오늘 포함)의 단어 정답/오답 상태 추이를 조회한다 (Q-WORD-STATE-TREND).
 *
 * "정답 누적"이 아니라 "지금 시점 기준 최신 결과가 정답/오답인 고유 단어 수"이므로
 * (재채점으로 정답↔오답이 뒤집힐 수 있어 단순 누적 합으로는 표현 불가), 전체
 * test_item ⋈ test_session을 taken_ms 오름차순으로 1회 읽어 JS에서 단어별 최신
 * 상태를 갱신하며 taken_day 경계마다 스냅샷을 남기는 단일 패스로 계산한다
 * (SQL 윈도우 함수로는 "단어별 최신 상태의 시계열"을 표현하기 어려움).
 *
 * 스냅샷이 없는 날(그 날 테스트가 없었던 날)은 직전 스냅샷을 이월(carry-forward)한다.
 * 윈도우 시작일 이전에 이미 확정된 상태가 있으면 그 최신 스냅샷을 시드로 이월하고,
 * 전체 데이터가 없을 때만 0/0에서 시작한다.
 */
export async function getWordStateTrend(days = 30): Promise<WordStatePoint[]> {
  const userDb = getUserDb();
  const today = todayEpochDay();

  const rows = await userDb.getAllAsync<{
    content_word_id: number;
    is_wrong: number;
    taken_day: number;
  }>(
    `SELECT ti.content_word_id AS content_word_id, ti.is_wrong AS is_wrong, ts.taken_day AS taken_day
     FROM test_item ti
     JOIN test_session ts ON ts.id = ti.session_id
     ORDER BY ts.taken_ms ASC, ti.id ASC`,
  );

  const latestWrongByWord = new Map<number, boolean>();
  let correctCount = 0;
  let wrongCount = 0;
  // taken_day 오름차순으로 행이 들어오므로, 같은 날짜 키를 여러 번 덮어써도 마지막에
  // 남는 값은 항상 "그 날 마지막 테스트까지 반영된" 누적 상태다.
  const snapshotByDay = new Map<number, { correctCount: number; wrongCount: number }>();

  for (const row of rows) {
    const isWrong = row.is_wrong === 1;
    const wasWrong = latestWrongByWord.get(row.content_word_id);
    if (wasWrong === undefined) {
      if (isWrong) wrongCount += 1;
      else correctCount += 1;
    } else if (wasWrong !== isWrong) {
      if (isWrong) {
        correctCount -= 1;
        wrongCount += 1;
      } else {
        wrongCount -= 1;
        correctCount += 1;
      }
    }
    latestWrongByWord.set(row.content_word_id, isWrong);
    snapshotByDay.set(row.taken_day, { correctCount, wrongCount });
  }

  const startDay = today - (days - 1);
  const series: WordStatePoint[] = [];
  // 윈도우 시작 이전의 최신 스냅샷을 시드로 — 이게 없으면 40일 전에 정답 처리된 뒤
  // 테스트 공백이 이어진 단어들이 윈도우 초반에 0으로 잘못 표시된다.
  let carry = { correctCount: 0, wrongCount: 0 };
  let carryDay = Number.NEGATIVE_INFINITY;
  for (const [day, snap] of snapshotByDay) {
    if (day < startDay && day > carryDay) {
      carryDay = day;
      carry = snap;
    }
  }
  for (let day = startDay; day <= today; day++) {
    const snap = snapshotByDay.get(day);
    if (snap) carry = snap;
    series.push({ day, correctCount: carry.correctCount, wrongCount: carry.wrongCount });
  }

  return series;
}

/** 월별 Income 합계 1포인트 (Q-INCOME-TREND — test_session + habit_bonus 병합). */
export interface MonthlyIncomePoint {
  yearMonth: string; // 'YYYY-MM' (로컬타임 기준)
  total: number;
}

/** 'YYYY-MM' 키 생성 (로컬타임). */
function yearMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 오늘이 속한 달부터 역산해 최근 `count`개월의 'YYYY-MM' 키를 오래된→최신 순으로 만든다. */
function recentYearMonths(count: number, end: Date = new Date()): string[] {
  const months: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    months.push(yearMonthKey(new Date(end.getFullYear(), end.getMonth() - i, 1)));
  }
  return months;
}

/**
 * 최근 `monthCount`개월의 월별 Income 합계(test_session.income_amount +
 * habit_bonus.amount)를 조회한다 (Q-INCOME-TREND). 월 귀속은 로컬타임 —
 * SQLite `strftime(..., 'localtime')`으로 그룹핑한다(설계.md §1.4 관행).
 * 데이터 없는 달은 0으로 채우고, 오래된 달→최신 달 오름차순으로 반환한다.
 */
export async function getMonthlyIncomeTotals(monthCount = 6): Promise<MonthlyIncomePoint[]> {
  const userDb = getUserDb();

  const [testRows, bonusRows] = await Promise.all([
    userDb.getAllAsync<{ ym: string; total: number }>(
      `SELECT strftime('%Y-%m', taken_ms / 1000, 'unixepoch', 'localtime') AS ym,
              COALESCE(SUM(income_amount), 0) AS total
       FROM test_session
       WHERE income_amount IS NOT NULL
       GROUP BY ym`,
    ),
    userDb.getAllAsync<{ ym: string; total: number }>(
      `SELECT strftime('%Y-%m', created_ms / 1000, 'unixepoch', 'localtime') AS ym,
              COALESCE(SUM(amount), 0) AS total
       FROM habit_bonus
       GROUP BY ym`,
    ),
  ]);

  const totalsByMonth = new Map<string, number>();
  for (const row of testRows) {
    totalsByMonth.set(row.ym, (totalsByMonth.get(row.ym) ?? 0) + row.total);
  }
  for (const row of bonusRows) {
    totalsByMonth.set(row.ym, (totalsByMonth.get(row.ym) ?? 0) + row.total);
  }

  return recentYearMonths(monthCount).map((yearMonth) => ({
    yearMonth,
    total: totalsByMonth.get(yearMonth) ?? 0,
  }));
}

/** 발음 헷갈림 체크 단어 1건 (발음 체크 장부용 — 설계.md §1.3 pron_confused 집계). */
export interface PronunciationConfusedWord {
  content_word_id: number;
  headword: string;
  confused_count: number; // pron_confused=1로 체크된 누적 횟수
  last_checked_ms: number; // 가장 최근 체크된 세션의 taken_ms
  resolved_ms: number | null; // 해소 시각 (해소됨 목록에서만 non-null 의미 사용)
}

/** 발음 체크 장부 조회 결과: 활성(헷갈리는 중) / 해소됨 두 목록. */
export interface PronunciationLedger {
  active: PronunciationConfusedWord[];
  resolved: PronunciationConfusedWord[];
}

/**
 * 발음 헷갈림(pron_confused=1) 체크 단어를 활성/해소됨으로 나눠 조회한다 (설계.md §6-10
 * 해소 UX, 2026-07-09 확정: A안 셀프 해소 + 재발 자동 복귀).
 *
 * 활성/해소 판정은 시각 비교로 파생한다: 해소 기록(pron_resolution.resolved_ms)이 없거나,
 * 해소 이후 테스트에서 다시 체크됐으면(last_checked_ms > resolved_ms) 활성. 재발 시 별도
 * 쓰기 없이 자동으로 활성 목록에 복귀한다. 두 목록 모두 최근 체크일 내림차순.
 */
export async function getPronunciationLedger(): Promise<PronunciationLedger> {
  const userDb = getUserDb();
  const contentDb = getContentDb();

  const rows = await userDb.getAllAsync<{
    content_word_id: number;
    confused_count: number;
    last_checked_ms: number;
    resolved_ms: number | null;
  }>(
    // pr.resolved_ms는 GROUP BY 키(content_word_id)에 1:1이라 그룹 내 상수 — SQLite bare column 안전.
    `SELECT ti.content_word_id AS content_word_id,
            COUNT(*) AS confused_count,
            MAX(ts.taken_ms) AS last_checked_ms,
            pr.resolved_ms AS resolved_ms
     FROM test_item ti
     JOIN test_session ts ON ts.id = ti.session_id
     LEFT JOIN pron_resolution pr ON pr.content_word_id = ti.content_word_id
     WHERE ti.pron_confused = 1
     GROUP BY ti.content_word_id
     ORDER BY last_checked_ms DESC`,
  );

  if (rows.length === 0) return { active: [], resolved: [] };

  const wordIds = rows.map((r) => r.content_word_id);
  const placeholders = wordIds.map(() => '?').join(',');
  const wordRows = await contentDb.getAllAsync<{ id: number; headword: string }>(
    `SELECT id, headword FROM word WHERE id IN (${placeholders})`,
    wordIds,
  );
  const headwordById = new Map(wordRows.map((w) => [w.id, w.headword]));

  const items = rows.map((r) => ({
    content_word_id: r.content_word_id,
    headword: headwordById.get(r.content_word_id) ?? '(삭제된 단어)', // tombstone (설계.md §3.4)
    confused_count: r.confused_count,
    last_checked_ms: r.last_checked_ms,
    resolved_ms: r.resolved_ms,
  }));

  return {
    active: items.filter((it) => it.resolved_ms === null || it.last_checked_ms > it.resolved_ms),
    resolved: items.filter((it) => it.resolved_ms !== null && it.last_checked_ms <= it.resolved_ms),
  };
}

/** 발음 헷갈림 해소 체크 — 단어당 1행 upsert (재해소 시 시각 갱신). */
export async function resolvePronunciation(contentWordId: number): Promise<void> {
  const userDb = getUserDb();
  await userDb.runAsync(
    `INSERT INTO pron_resolution (content_word_id, resolved_ms) VALUES (?, ?)
     ON CONFLICT(content_word_id) DO UPDATE SET resolved_ms = excluded.resolved_ms`,
    [contentWordId, nowEpochMs()],
  );
}

/** 해소 되돌리기 — 해소 기록 삭제로 활성 목록에 복귀시킨다. */
export async function unresolvePronunciation(contentWordId: number): Promise<void> {
  const userDb = getUserDb();
  await userDb.runAsync('DELETE FROM pron_resolution WHERE content_word_id = ?', [contentWordId]);
}
