/**
 * 단어 상세 조회 — 예문 바텀시트 전용 (사용자 확정 UX: 단어장 행 탭 → 바텀시트).
 *
 * content.db에서 word_id + 설정된 난이도(level)로 meanings 전부 + examples를
 * level로 필터해 품사별 1개씩 조회한다(설계.md §1.2 example.level 1|2|3).
 *
 * lib/queries.ts는 수정 금지 지시에 따라 별도 파일로 분리.
 */

import { getContentDb } from './db';
import type { DifficultyLevel } from './settings';

export interface MeaningItem {
  id: number;
  pos: string;
  meaning_ko: string;
  sort_order: number;
}

export interface ExampleItem {
  id: number;
  pos: string;
  level: number;
  en: string;
  ko: string | null;
}

export interface WordDetail {
  wordId: number;
  headword: string;
  meanings: MeaningItem[];
  examples: ExampleItem[];
}

/**
 * word_id + level로 headword/뜻 전부/예문(해당 난이도, 품사별 1개)을 조회한다.
 * 삭제된 단어(headword 없음)면 null을 반환한다(설계.md §3.4 tombstone 방어).
 */
export async function getWordDetail(wordId: number, level: DifficultyLevel): Promise<WordDetail | null> {
  const contentDb = getContentDb();

  const wordRow = await contentDb.getFirstAsync<{ id: number; headword: string }>(
    'SELECT id, headword FROM word WHERE id = ?',
    [wordId],
  );
  if (!wordRow) return null;

  const meanings = await contentDb.getAllAsync<MeaningItem>(
    'SELECT id, pos, meaning_ko, sort_order FROM meaning WHERE word_id = ? ORDER BY sort_order',
    [wordId],
  );

  // 품사별 1개씩: pos당 sort_order가 가장 앞선 예문만 남긴다(자바스크립트에서 중복 제거).
  const exampleRows = await contentDb.getAllAsync<ExampleItem>(
    'SELECT id, pos, level, en, ko FROM example WHERE word_id = ? AND level = ? ORDER BY pos, sort_order',
    [wordId, level],
  );
  const examplesByPos = new Map<string, ExampleItem>();
  for (const ex of exampleRows) {
    if (!examplesByPos.has(ex.pos)) examplesByPos.set(ex.pos, ex);
  }

  return {
    wordId: wordRow.id,
    headword: wordRow.headword,
    meanings,
    examples: Array.from(examplesByPos.values()),
  };
}
