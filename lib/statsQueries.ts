/**
 * 발음 체크 장부 + 홈 통계 전용 쿼리
 * (설계.md §4.4 낯가림 단어/나의 업적 쿼리 매핑, §5 Q-SCARY-TOP10 / Q-RECENT5 /
 * Q-CORRECT-CUMULATIVE, §1.3 test_item.pron_confused)
 *
 * 2-DB 구조 원칙(설계.md §1.1)을 그대로 따른다: user.db에서 test_item/test_session을
 * 집계하고, content.db에서 headword를 조회해 애플리케이션 레벨로 합친다.
 */

import { getContentDb, getUserDb } from './db';
import { todayEpochDay } from './dates';

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

/** 정답 누적 추이 1포인트 (Q-CORRECT-CUMULATIVE). */
export interface CorrectCumulativePoint {
  taken_ms: number;
  correct_count: number;
  cumulative_correct: number;
}

/**
 * 세션별 correct_count의 시간순 누적 추이를 조회한다.
 * expo-sqlite 번들 SQLite는 윈도우 함수를 지원하므로 SQL에서 직접 누적한다
 * (설계.md §5 Q-CORRECT-CUMULATIVE — 미지원 환경 대비 JS 누적 대안 언급이 있었으나,
 * 이 프로젝트의 expo-sqlite는 지원 확인됨).
 */
export async function getCorrectCumulative(): Promise<CorrectCumulativePoint[]> {
  const userDb = getUserDb();

  return userDb.getAllAsync<CorrectCumulativePoint>(
    `SELECT taken_ms, correct_count,
            SUM(correct_count) OVER (ORDER BY taken_ms) AS cumulative_correct
     FROM test_session
     ORDER BY taken_ms`,
  );
}

/** 발음 헷갈림 체크 단어 1건 (발음 체크 장부용 — 설계.md §1.3 pron_confused 집계). */
export interface PronunciationConfusedWord {
  content_word_id: number;
  headword: string;
  confused_count: number; // pron_confused=1로 체크된 누적 횟수
  last_checked_ms: number; // 가장 최근 체크된 세션의 taken_ms
}

/**
 * 발음 헷갈림(pron_confused=1) 체크가 남은 단어를, 최근 체크일 기준 내림차순으로 조회한다.
 *
 * 설계.md/기획서에 "해소 처리(체크 해제)" 방식이 명시돼 있지 않다 — 기획서는 채점 화면에서
 * 체크가 생성되는 시점만 규정하고(§단어장 앱 만들기.md L50), 이 장부에서의 리셋 액션은
 * 없다. 따라서 이번 구현은 test_item.pron_confused=1 전체를 단어 단위로 집계해 보여주는
 * "누적 기록" 뷰로 처리한다 (개별 해소/삭제 없음 — 아래 완료 보고에 명시).
 */
export async function getPronunciationConfusedWords(): Promise<PronunciationConfusedWord[]> {
  const userDb = getUserDb();
  const contentDb = getContentDb();

  const rows = await userDb.getAllAsync<{
    content_word_id: number;
    confused_count: number;
    last_checked_ms: number;
  }>(
    `SELECT ti.content_word_id AS content_word_id,
            COUNT(*) AS confused_count,
            MAX(ts.taken_ms) AS last_checked_ms
     FROM test_item ti
     JOIN test_session ts ON ts.id = ti.session_id
     WHERE ti.pron_confused = 1
     GROUP BY ti.content_word_id
     ORDER BY last_checked_ms DESC`,
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
    confused_count: r.confused_count,
    last_checked_ms: r.last_checked_ms,
  }));
}
