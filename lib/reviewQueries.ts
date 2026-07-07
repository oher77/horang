/**
 * 복습/테스트 전용 쿼리 (설계.md §5 Q-REVIEW-DAYS, Q-TEST-POOL, §1.3 test_session/test_item DDL)
 *
 * 2-DB 구조 원칙(설계.md §1.1)을 그대로 따른다: user.db에서 day/day_word를 조회하고,
 * content.db에서 headword/뜻/writing_item을 조회해 애플리케이션 레벨로 합친다.
 */

import { getContentDb, getUserDb } from './db';
import { daysAgo, nowEpochMs, REVIEW_OFFSETS, todayEpochDay } from './dates';
import { getIncomeForScore } from './incomeQueries';

/** 복습 대상 Day 1건 (Q-REVIEW-DAYS). */
export interface ReviewDay {
  id: number;
  day_index: number;
  created_day: number;
  created_ms: number;
  is_started: number;
  words_count: number;
  offset: number; // 오늘 기준 며칠 전에 생성됐는지 (1/3/7/14/30/60/120 중 하나)
}

/**
 * 오늘 기준 -1/-3/-7/-14/-30/-60/-120일에 생성된 Day 목록을 최근순으로 반환한다.
 * 해당 오프셋에 Day가 없으면 결과에서 자연히 빠진다 (설계.md §5 Q-REVIEW-DAYS 그대로).
 */
export async function getReviewDays(): Promise<ReviewDay[]> {
  const userDb = getUserDb();
  const today = todayEpochDay();
  const targetDays = daysAgo([...REVIEW_OFFSETS], today);
  const placeholders = targetDays.map(() => '?').join(',');

  const rows = await userDb.getAllAsync<{
    id: number;
    day_index: number;
    created_day: number;
    created_ms: number;
    is_started: number;
    words_count: number;
  }>(
    `SELECT id, day_index, created_day, created_ms, is_started, words_count
     FROM day
     WHERE created_day IN (${placeholders})
     ORDER BY created_day DESC`,
    targetDays,
  );

  return rows.map((row) => ({
    ...row,
    offset: today - row.created_day,
  }));
}

/** 테스트 문제 유형. */
export type TestQuestionKind = 'word_to_meaning' | 'meaning_to_word' | 'writing';

/** 테스트 출제 1문항. */
export interface TestQuestion {
  content_word_id: number;
  kind: TestQuestionKind;
  headword: string;
  meaning_ko: string | null;
  // writing 유형에서만 채워짐
  writing_prompt_ko?: string | null;
  writing_hint?: string | null;
  writing_answer?: string | null;
  writing_answer_alt?: string | null;
}

const WRITING_RATIO = 0.3; // writing_item이 있는 단어 중 이 비율만큼 writing 문제로 출제 (설계.md §6-9: 비율은 구현 시 기본값)

/**
 * 출제 풀(Q-TEST-POOL: 당일 Day + 복습 대상 Day의 단어)을 조회해 랜덤 셔플하고,
 * 혼합 출제(단어→뜻 / 뜻→단어 / 쓰기)로 변환한다.
 *
 * 혼합 비율 기본값(설계.md §6-9 "유형별 비율은 구현 시 기본값을 정해 사용자 확인" 대응):
 * - writing_item이 있는 단어 중 30%는 쓰기 문제로 출제
 * - 나머지는 단어→뜻과 뜻→단어를 50:50으로 섞음
 */
export async function getTestPool(todayDayId: number): Promise<TestQuestion[]> {
  const userDb = getUserDb();
  const contentDb = getContentDb();
  const today = todayEpochDay();
  const reviewDays = daysAgo([...REVIEW_OFFSETS], today);
  const placeholders = reviewDays.map(() => '?').join(',');

  const dayWordRows = await userDb.getAllAsync<{ content_word_id: number }>(
    `SELECT DISTINCT dw.content_word_id
     FROM day_word dw
     JOIN day d ON d.id = dw.day_id
     WHERE d.id = ?
        OR d.created_day IN (${placeholders})`,
    [todayDayId, ...reviewDays],
  );

  const wordIds = dayWordRows.map((r) => r.content_word_id);
  if (wordIds.length === 0) return [];

  const wp = wordIds.map(() => '?').join(',');

  const wordRows = await contentDb.getAllAsync<{ id: number; headword: string }>(
    `SELECT id, headword FROM word WHERE id IN (${wp})`,
    wordIds,
  );
  const meaningRows = await contentDb.getAllAsync<{ word_id: number; meaning_ko: string }>(
    `SELECT word_id, meaning_ko FROM meaning WHERE word_id IN (${wp}) ORDER BY sort_order`,
    wordIds,
  );
  const writingRows = await contentDb.getAllAsync<{
    word_id: number;
    prompt_ko: string | null;
    hint: string | null;
    answer: string | null;
    answer_alt: string | null;
  }>(
    `SELECT word_id, prompt_ko, hint, answer, answer_alt
     FROM writing_item
     WHERE word_id IN (${wp}) AND needs_review = 0 AND answer IS NOT NULL`,
    wordIds,
  );

  const headwordById = new Map(wordRows.map((w) => [w.id, w.headword]));
  const meaningById = new Map<number, string>();
  for (const m of meaningRows) {
    if (!meaningById.has(m.word_id)) meaningById.set(m.word_id, m.meaning_ko);
  }
  const writingById = new Map<number, (typeof writingRows)[number]>();
  for (const w of writingRows) {
    if (!writingById.has(w.word_id)) writingById.set(w.word_id, w);
  }

  const shuffled = shuffle(wordIds.filter((id) => headwordById.has(id)));

  const questions: TestQuestion[] = shuffled.map((wordId) => {
    const headword = headwordById.get(wordId) ?? '(삭제된 단어)';
    const meaning_ko = meaningById.get(wordId) ?? null;
    const writing = writingById.get(wordId);

    let kind: TestQuestionKind;
    if (writing && Math.random() < WRITING_RATIO) {
      kind = 'writing';
    } else {
      kind = Math.random() < 0.5 ? 'word_to_meaning' : 'meaning_to_word';
    }

    return {
      content_word_id: wordId,
      kind,
      headword,
      meaning_ko,
      writing_prompt_ko: writing?.prompt_ko ?? null,
      writing_hint: writing?.hint ?? null,
      writing_answer: writing?.answer ?? null,
      writing_answer_alt: writing?.answer_alt ?? null,
    };
  });

  return questions;
}

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** 자기채점 결과 1문항 (제출용). */
export interface TestItemResult {
  content_word_id: number;
  is_wrong: boolean;
  pron_confused: boolean;
}

/** 테스트 세션 결과 저장 결과. */
export interface SavedTestSession {
  sessionId: number;
  score100: number;
  correctCount: number;
  totalCount: number;
  incomeAmount: number;
}

/**
 * 테스트 결과를 user.db에 저장한다 (test_session + test_item, §1.3 DDL).
 * 채점 확정 시 income_rule을 매칭해 income_amount를 스냅샷 저장한다
 * (설계.md §5 Q-INCOME-FOR-SCORE, §1.3 "income_amount -- income_rule 적용 결과(스냅샷)").
 * paid는 부모 지급 체크 전이므로 DEFAULT 0 그대로 둔다.
 */
export async function saveTestSession(
  dayId: number,
  results: TestItemResult[],
): Promise<SavedTestSession> {
  const userDb = getUserDb();
  const today = todayEpochDay();
  const nowMs = nowEpochMs();

  const totalCount = results.length;
  const correctCount = results.filter((r) => !r.is_wrong).length;
  const score100 = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;
  const incomeAmount = await getIncomeForScore(score100);

  let sessionId = 0;

  await userDb.withTransactionAsync(async () => {
    const result = await userDb.runAsync(
      `INSERT INTO test_session (day_id, taken_day, taken_ms, total_count, correct_count, score100, income_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [dayId, today, nowMs, totalCount, correctCount, score100, incomeAmount],
    );
    sessionId = result.lastInsertRowId;

    for (const r of results) {
      await userDb.runAsync(
        `INSERT INTO test_item (session_id, content_word_id, is_wrong, pron_confused)
         VALUES (?, ?, ?, ?)`,
        [sessionId, r.content_word_id, r.is_wrong ? 1 : 0, r.pron_confused ? 1 : 0],
      );
    }
  });

  return { sessionId, score100, correctCount, totalCount, incomeAmount };
}
