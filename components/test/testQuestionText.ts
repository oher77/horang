/**
 * 테스트 문항 표시 텍스트 유틸 (단어장 앱 만들기.md "테스트 화면 구성" — "2개의 컬럼
 * (문제, 답)으로 이루어진 테이블").
 *
 * 유형별 문제/정답 텍스트:
 * - word_to_meaning: 영단어 제시 → 학생이 뜻을 입력
 * - meaning_to_word: 한국어 뜻 제시 → 학생이 영단어를 입력
 * - writing: 쓰기 문제(스펠링 힌트/문법변형 등) 제시 → 학생이 답을 입력
 */

import type { TestQuestion } from '../../lib/reviewQueries';

export function questionPrompt(q: TestQuestion): string {
  if (q.kind === 'word_to_meaning') return q.headword;
  if (q.kind === 'meaning_to_word') return q.meaning_ko ?? '(뜻 정보 없음)';
  // writing
  const parts = [q.writing_prompt_ko, q.writing_hint].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : q.headword;
}

export function questionAnswer(q: TestQuestion): string {
  if (q.kind === 'word_to_meaning') return q.meaning_ko ?? '(뜻 정보 없음)';
  if (q.kind === 'meaning_to_word') return q.headword;
  // writing
  const alt = q.writing_answer_alt ? ` (${q.writing_answer_alt})` : '';
  return `${q.writing_answer ?? '(정답 정보 없음)'}${alt}`;
}

export function kindLabel(kind: TestQuestion['kind']): string {
  switch (kind) {
    case 'word_to_meaning':
      return '단어 → 뜻';
    case 'meaning_to_word':
      return '뜻 → 단어';
    case 'writing':
      return '쓰기';
  }
}

/** TTS로 읽어줄 대상: 항상 영단어(headword) 쪽. 예문엔 발음 듣기를 넣지 않는다는
 * 기획서 규칙과 별개로, 테스트 화면에서는 "각 영단어를 클릭하면 발음을 들을 수 있다"는
 * 단어장 화면 규칙을 그대로 준용해 헤드워드가 어느 컬럼에 있든 TTS로 들을 수 있게 한다. */
export function ttsWord(q: TestQuestion): string {
  return q.headword;
}
