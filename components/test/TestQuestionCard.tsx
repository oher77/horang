/**
 * 테스트 문항 카드 (설계.md §4.4 테스트 화면, §6-9 혼합 출제 확정사항)
 *
 * 유형별 렌더:
 * - word_to_meaning: 영단어 제시 → 학생이 스스로 뜻을 떠올린 뒤 "정답 보기"로 확인
 * - meaning_to_word: 한국어 뜻 제시 → 학생이 스스로 영단어를 떠올린 뒤 "정답 보기"로 확인
 * - writing: 쓰기 문제(스펠링 힌트/문법변형 등) 제시 → 정답 보기로 확인
 *
 * 녹음 없이 TTS만 보조 수단으로 제공하고, 채점은 전부 자기채점(맞음/오답/발음헷갈림 체크)이다.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { TestQuestion } from '../../lib/reviewQueries';

export interface SelfGradeAnswer {
  is_wrong: boolean;
  pron_confused: boolean;
}

interface Props {
  question: TestQuestion;
  index: number;
  total: number;
  onSubmit: (answer: SelfGradeAnswer) => void;
}

export function TestQuestionCard({ question, index, total, onSubmit }: Props) {
  const [revealed, setRevealed] = useState(false);
  const [pronConfused, setPronConfused] = useState(false);

  const prompt = questionPrompt(question);
  const answer = questionAnswer(question);

  const handleGrade = (isWrong: boolean) => {
    onSubmit({ is_wrong: isWrong, pron_confused: pronConfused });
    setRevealed(false);
    setPronConfused(false);
  };

  return (
    <View style={styles.card}>
      <Text style={styles.progress}>
        {index + 1} / {total}
      </Text>
      <Text style={styles.kindLabel}>{kindLabel(question.kind)}</Text>

      <Text style={styles.promptText}>{prompt}</Text>

      {!revealed && (
        <Pressable style={styles.revealButton} onPress={() => setRevealed(true)}>
          <Text style={styles.revealButtonText}>정답 보기</Text>
        </Pressable>
      )}

      {revealed && (
        <>
          <View style={styles.answerBox}>
            <Text style={styles.answerLabel}>정답</Text>
            <Text style={styles.answerText}>{answer}</Text>
          </View>

          <Pressable
            style={[styles.pronToggle, pronConfused && styles.pronToggleActive]}
            onPress={() => setPronConfused((v) => !v)}
          >
            <Text style={[styles.pronToggleText, pronConfused && styles.pronToggleTextActive]}>
              {pronConfused ? '발음 헷갈림 체크됨' : '발음 헷갈렸나요?'}
            </Text>
          </Pressable>

          <View style={styles.gradeRow}>
            <Pressable style={[styles.gradeButton, styles.correctButton]} onPress={() => handleGrade(false)}>
              <Text style={styles.gradeButtonText}>맞음</Text>
            </Pressable>
            <Pressable style={[styles.gradeButton, styles.wrongButton]} onPress={() => handleGrade(true)}>
              <Text style={styles.gradeButtonText}>틀림</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

function kindLabel(kind: TestQuestion['kind']): string {
  switch (kind) {
    case 'word_to_meaning':
      return '단어 → 뜻';
    case 'meaning_to_word':
      return '뜻 → 단어';
    case 'writing':
      return '쓰기';
  }
}

function questionPrompt(q: TestQuestion): string {
  if (q.kind === 'word_to_meaning') return q.headword;
  if (q.kind === 'meaning_to_word') return q.meaning_ko ?? '(뜻 정보 없음)';
  // writing
  const parts = [q.writing_prompt_ko, q.writing_hint].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : q.headword;
}

function questionAnswer(q: TestQuestion): string {
  if (q.kind === 'word_to_meaning') return q.meaning_ko ?? '(뜻 정보 없음)';
  if (q.kind === 'meaning_to_word') return q.headword;
  // writing
  const alt = q.writing_answer_alt ? ` (${q.writing_answer_alt})` : '';
  return `${q.writing_answer ?? '(정답 정보 없음)'}${alt}`;
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
  },
  progress: {
    fontSize: 13,
    color: '#999',
    textAlign: 'center',
  },
  kindLabel: {
    marginTop: 4,
    fontSize: 13,
    fontWeight: '600',
    color: '#ff8a34',
    textAlign: 'center',
  },
  promptText: {
    marginTop: 24,
    fontSize: 28,
    fontWeight: '700',
    color: '#222',
    textAlign: 'center',
  },
  revealButton: {
    marginTop: 40,
    alignSelf: 'center',
    backgroundColor: '#222',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 12,
  },
  revealButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  answerBox: {
    marginTop: 32,
    alignItems: 'center',
  },
  answerLabel: {
    fontSize: 12,
    color: '#999',
  },
  answerText: {
    marginTop: 6,
    fontSize: 22,
    fontWeight: '700',
    color: '#2e7d32',
    textAlign: 'center',
  },
  pronToggle: {
    marginTop: 20,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  pronToggleActive: {
    backgroundColor: '#fff1e6',
    borderColor: '#ff8a34',
  },
  pronToggleText: {
    fontSize: 13,
    color: '#666',
  },
  pronToggleTextActive: {
    color: '#ff8a34',
    fontWeight: '600',
  },
  gradeRow: {
    marginTop: 28,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
  },
  gradeButton: {
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
  },
  correctButton: {
    backgroundColor: '#2e7d32',
  },
  wrongButton: {
    backgroundColor: '#c0392b',
  },
  gradeButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});
