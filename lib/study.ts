/**
 * 단어장 학습 인터랙션 — 기억 인출 실패 단계(recall_stage) read/write (설계.md §1.3, §5)
 *
 * `day_word.recall_stage`는 DDL에 이미 정의되어 있다(0~5, 스와이프 증감).
 * db.ts/queries.ts를 건드리지 않고 getUserDb()의 기존 핸들만 재사용한다
 * (이중 초기화 방지).
 *
 * 주의: DDL 주석은 "0~5"라 되어 있으나 CLAUDE.md 도메인 규칙 및 기획 원문은
 * "총 5단계(1회~5회 실패)"를 명시한다. 그래서 이 모듈은 0(미실패)~5(5회 실패)의
 * 6개 값 중 화면에서는 0~5 범위를 그대로 쓰되, 실제 "단계 배지"는 1~5만 표시하고
 * 0은 무배지로 다룬다 (완료 보고에 근거 명시).
 */

import { getUserDb } from './db';

export const RECALL_STAGE_MIN = 0;
export const RECALL_STAGE_MAX = 5;

/**
 * day_word.recall_stage를 delta만큼 증감하고(0~5 클램프), 갱신된 값을 반환한다.
 * 우스와이프 delta=+1, 좌스와이프 delta=-1 (설계.md §5 recall_stage 스와이프 쿼리).
 */
export async function adjustRecallStage(dayWordId: number, delta: number): Promise<number> {
  const userDb = getUserDb();
  await userDb.runAsync(
    'UPDATE day_word SET recall_stage = MAX(?, MIN(?, recall_stage + ?)) WHERE id = ?',
    [RECALL_STAGE_MIN, RECALL_STAGE_MAX, delta, dayWordId],
  );
  const row = await userDb.getFirstAsync<{ recall_stage: number }>(
    'SELECT recall_stage FROM day_word WHERE id = ?',
    [dayWordId],
  );
  return row?.recall_stage ?? RECALL_STAGE_MIN;
}
