/**
 * 오늘 단어장 조회/생성 쿼리 (설계.md §5 Q — "오늘 단어장 생성, 전 Day 중복 금지")
 *
 * 2-DB 구조라 content.db/user.db 교차 참조는 애플리케이션 레벨 조인으로 처리한다
 * (설계.md §1.1). day_word.content_word_id UNIQUE 제약이 전 Day 걸친 단어 중복을
 * DB 레벨에서 물리적으로 보장한다.
 */

import { getContentDb, getUserDb } from './db';
import { nowEpochMs, todayEpochDay } from './dates';

/** content.db word 행 (헤드워드 + 대표 뜻 1개 join 결과). */
export interface WordWithMeaning {
  id: number;
  headword: string;
  meaning_ko: string | null;
}

/** 오늘 단어장(Day) 1건 + 단어 목록. */
export interface DayWithWords {
  id: number;
  day_index: number;
  created_day: number;
  created_ms: number;
  is_started: number;
  words_count: number;
  words: DayWordRow[];
}

/** day_word 1행 + content.db에서 조인한 headword/뜻. */
export interface DayWordRow {
  id: number;
  content_word_id: number;
  position: number;
  recall_stage: number;
  headword: string;
  meaning_ko: string | null;
}

const NEW_DAY_RANDOM_BUFFER_MULTIPLIER = 3; // usedSet 필터링 후에도 N개를 채우기 위한 여유분 배수

/** settings.words_per_day 값을 읽는다 (없으면 기본값 20 — §1.3 DEFAULT와 동일). */
async function getWordsPerDay(): Promise<number> {
  const userDb = getUserDb();
  const row = await userDb.getFirstAsync<{ words_per_day: number }>(
    'SELECT words_per_day FROM settings WHERE id = 1',
  );
  return row?.words_per_day ?? 20;
}

/**
 * 오늘(로컬 자정 기준 epoch day) 단어장을 조회하거나, 없으면 새로 생성한다.
 * 하루 1개 규칙 + 전 Day 중복 금지(day_word.content_word_id UNIQUE)를 보장한다.
 */
export async function ensureTodayDay(): Promise<DayWithWords> {
  const userDb = getUserDb();
  const today = todayEpochDay();

  let existing = await userDb.getFirstAsync<{
    id: number;
    day_index: number;
    created_day: number;
    created_ms: number;
    is_started: number;
    words_count: number;
  }>('SELECT id, day_index, created_day, created_ms, is_started, words_count FROM day WHERE created_day = ? LIMIT 1', [today]);

  // 설계.md §4.5: words_per_day 변경 시 "아직 시작하지 않은" 오늘 Day는 삭제 후
  // 새 개수로 재생성한다. 안전 조건 — ① is_started=0 (단어장 화면을 연 적 없음)
  // ② 이 Day를 참조하는 test_session이 없음 (테스트 기록 보존). 조건을 하나라도
  // 어기면 재생성하지 않는다 (학습 이력 불변 원칙).
  if (existing && existing.is_started === 0) {
    const wordsPerDay = await getWordsPerDay();
    if (existing.words_count !== wordsPerDay) {
      const tested = await userDb.getFirstAsync<{ cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM test_session WHERE day_id = ?',
        [existing.id],
      );
      if ((tested?.cnt ?? 0) === 0) {
        const staleId = existing.id;
        await userDb.withTransactionAsync(async () => {
          await userDb.runAsync('DELETE FROM day_word WHERE day_id = ?', [staleId]);
          await userDb.runAsync('DELETE FROM day WHERE id = ?', [staleId]);
        });
        existing = null;
      }
    }
  }

  const day = existing ?? (await createTodayDay(today));
  const words = await getDayWords(day.id);

  return { ...day, words };
}

/**
 * 단어장 화면을 열었을 때 호출 — is_started=1 기록. 이후 words_per_day를 바꿔도
 * 이 Day는 재생성 대상에서 제외된다 (오늘의 학습 흔적 보호).
 */
export async function markDayStarted(dayId: number): Promise<void> {
  const userDb = getUserDb();
  await userDb.runAsync('UPDATE day SET is_started = 1 WHERE id = ? AND is_started = 0', [dayId]);
}

/** 새 Day를 생성한다. 미사용 단어 풀에서 랜덤 N개를 뽑아 day_word에 배정한다. */
async function createTodayDay(today: number): Promise<{
  id: number;
  day_index: number;
  created_day: number;
  created_ms: number;
  is_started: number;
  words_count: number;
}> {
  const userDb = getUserDb();
  const contentDb = getContentDb();
  const wordsPerDay = await getWordsPerDay();

  // 이미 어떤 Day에도 배정된 단어 id 집합 (usedSet)
  const usedRows = await userDb.getAllAsync<{ content_word_id: number }>(
    'SELECT content_word_id FROM day_word',
  );
  const usedSet = new Set(usedRows.map((r) => r.content_word_id));

  // content.db 전체 word 중 랜덤으로 넉넉히 뽑은 뒤 JS에서 usedSet 필터
  const bufferSize = Math.max(wordsPerDay * NEW_DAY_RANDOM_BUFFER_MULTIPLIER, wordsPerDay + 50);
  const candidates = await contentDb.getAllAsync<{ id: number }>(
    'SELECT id FROM word ORDER BY RANDOM() LIMIT ?',
    [bufferSize],
  );

  let selected = candidates.map((c) => c.id).filter((id) => !usedSet.has(id));

  // 버퍼로도 부족하면(미사용 풀이 매우 적을 때) 전체 미사용 word에서 다시 채운다.
  if (selected.length < wordsPerDay) {
    const allWords = await contentDb.getAllAsync<{ id: number }>('SELECT id FROM word');
    const remaining = allWords.map((w) => w.id).filter((id) => !usedSet.has(id) && !selected.includes(id));
    selected = selected.concat(remaining);
  }

  selected = selected.slice(0, wordsPerDay); // 소진 시 가능한 만큼만 생성 (설계.md §5)

  const nowMs = nowEpochMs();

  let dayId = 0;
  let dayIndex = 0;

  await userDb.withTransactionAsync(async () => {
    const maxRow = await userDb.getFirstAsync<{ max_index: number | null }>(
      'SELECT MAX(day_index) AS max_index FROM day',
    );
    dayIndex = (maxRow?.max_index ?? 0) + 1;

    const result = await userDb.runAsync(
      'INSERT INTO day (day_index, created_day, created_ms, is_started, words_count) VALUES (?, ?, ?, 0, ?)',
      [dayIndex, today, nowMs, selected.length],
    );
    dayId = result.lastInsertRowId;

    for (let i = 0; i < selected.length; i += 1) {
      await userDb.runAsync(
        'INSERT INTO day_word (day_id, content_word_id, position, recall_stage) VALUES (?, ?, ?, 0)',
        [dayId, selected[i], i],
      );
    }
  });

  return {
    id: dayId,
    day_index: dayIndex,
    created_day: today,
    created_ms: nowMs,
    is_started: 0,
    words_count: selected.length,
  };
}

/** dayId로 day_index를 조회한다 (화면 타이틀 "Day{n}" 표시용). 없으면 null. */
export async function getDayIndex(dayId: number): Promise<number | null> {
  const userDb = getUserDb();
  const row = await userDb.getFirstAsync<{ day_index: number }>(
    'SELECT day_index FROM day WHERE id = ?',
    [dayId],
  );
  return row ? row.day_index : null;
}

/** 특정 Day의 단어 목록을 position 순으로, content.db의 headword/대표 뜻과 조인해 반환한다. */
export async function getDayWords(dayId: number): Promise<DayWordRow[]> {
  const userDb = getUserDb();
  const contentDb = getContentDb();

  const dayWords = await userDb.getAllAsync<{
    id: number;
    content_word_id: number;
    position: number;
    recall_stage: number;
  }>('SELECT id, content_word_id, position, recall_stage FROM day_word WHERE day_id = ? ORDER BY position', [dayId]);

  if (dayWords.length === 0) return [];

  const wordIds = dayWords.map((dw) => dw.content_word_id);
  const placeholders = wordIds.map(() => '?').join(',');

  const wordRows = await contentDb.getAllAsync<{ id: number; headword: string }>(
    `SELECT id, headword FROM word WHERE id IN (${placeholders})`,
    wordIds,
  );
  const meaningRows = await contentDb.getAllAsync<{ word_id: number; meaning_ko: string }>(
    `SELECT word_id, meaning_ko FROM meaning WHERE word_id IN (${placeholders}) ORDER BY sort_order LIMIT 1000`,
    wordIds,
  );

  const headwordById = new Map(wordRows.map((w) => [w.id, w.headword]));
  const meaningById = new Map<number, string>();
  for (const m of meaningRows) {
    if (!meaningById.has(m.word_id)) meaningById.set(m.word_id, m.meaning_ko); // 대표 뜻(sort_order 최우선) 1개만
  }

  return dayWords.map((dw) => ({
    id: dw.id,
    content_word_id: dw.content_word_id,
    position: dw.position,
    recall_stage: dw.recall_stage,
    headword: headwordById.get(dw.content_word_id) ?? '(삭제된 단어)', // tombstone 렌더링 (설계.md §3.4)
    meaning_ko: meaningById.get(dw.content_word_id) ?? null,
  }));
}
