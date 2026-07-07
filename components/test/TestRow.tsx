/**
 * 테스트 테이블 1행 (단어장 앱 만들기.md "테스트 화면 구성").
 *
 * 채점 전(grading): [문제 | 답 input] 2컬럼.
 * 채점 후(graded/그 이후): [문제 | 내 답(읽기전용) | 정답 | 발음확인(TTS) | 오답(X 토글) | 발음헷갈림(토글)] 로 컬럼이 늘어난다
 * ("점수 메기기 버튼을 클릭하면 정답 컬럼과 발음확인 컬럼, 오답 체크, 발음 헷갈림 컬럼이 생성된다").
 *
 * 오답 체크는 학생이 자기 답과 정답을 스스로 비교해 클릭하는 자기채점 — 자동 정답
 * 판정 로직 없음(설계.md/이번 임무 지시 "자기채점 원칙" 그대로).
 */

import * as Speech from 'expo-speech';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { TestQuestion } from '../../lib/reviewQueries';
import { kindLabel, questionAnswer, questionPrompt, ttsWord } from './testQuestionText';

export const ROW_MIN_HEIGHT = 56;

interface TestRowProps {
  index: number;
  question: TestQuestion;
  graded: boolean;
  userAnswer: string;
  isWrong: boolean;
  pronConfused: boolean;
  onChangeAnswer: (text: string) => void;
  onToggleWrong: () => void;
  onTogglePronConfused: () => void;
}

function TestRowImpl({
  index,
  question,
  graded,
  userAnswer,
  isWrong,
  pronConfused,
  onChangeAnswer,
  onToggleWrong,
  onTogglePronConfused,
}: TestRowProps) {
  const handleSpeak = () => {
    Speech.stop();
    Speech.speak(ttsWord(question), { language: 'en-US' });
  };

  return (
    <View style={[styles.row, index % 2 === 1 && styles.rowAlt]}>
      <View style={styles.numberCell}>
        <Text style={styles.numberText}>{index + 1}</Text>
      </View>

      <View style={styles.promptCell}>
        <Text style={styles.kindLabel}>{kindLabel(question.kind)}</Text>
        <Text style={styles.promptText}>{questionPrompt(question)}</Text>
      </View>

      {!graded && (
        <View style={styles.answerCell}>
          <TextInput
            style={styles.answerInput}
            value={userAnswer}
            onChangeText={onChangeAnswer}
            placeholder="답 입력"
            placeholderTextColor="#bbb"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      )}

      {graded && (
        <>
          <View style={styles.answerCell}>
            <Text style={styles.userAnswerText} numberOfLines={2}>
              {userAnswer || '(무응답)'}
            </Text>
          </View>

          <View style={styles.correctAnswerCell}>
            <Text style={styles.correctAnswerText} numberOfLines={2}>
              {questionAnswer(question)}
            </Text>
          </View>

          <Pressable style={styles.pronCell} onPress={handleSpeak} hitSlop={8}>
            <Text style={styles.pronIcon}>🔊</Text>
          </Pressable>

          <Pressable
            style={[styles.wrongCell, isWrong && styles.wrongCellActive]}
            onPress={onToggleWrong}
            hitSlop={8}
          >
            <Text style={[styles.wrongMark, isWrong && styles.wrongMarkActive]}>{isWrong ? 'X' : ''}</Text>
          </Pressable>

          <Pressable
            style={[styles.pronConfusedCell, pronConfused && styles.pronConfusedCellActive]}
            onPress={onTogglePronConfused}
            hitSlop={8}
          >
            <Text style={styles.pronConfusedMark}>{pronConfused ? '👂' : ''}</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: ROW_MIN_HEIGHT,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  rowAlt: {
    backgroundColor: '#fafafa',
  },
  numberCell: {
    width: 24,
  },
  numberText: {
    fontSize: 12,
    color: '#999',
  },
  promptCell: {
    width: 110,
    paddingRight: 6,
  },
  kindLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: '#ff8a34',
  },
  promptText: {
    marginTop: 2,
    fontSize: 14,
    fontWeight: '700',
    color: '#222',
  },
  answerCell: {
    flex: 1,
    paddingRight: 6,
  },
  answerInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
    color: '#222',
  },
  userAnswerText: {
    fontSize: 13,
    color: '#444',
  },
  correctAnswerCell: {
    flex: 1,
    paddingRight: 6,
  },
  correctAnswerText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#2e7d32',
  },
  pronCell: {
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pronIcon: {
    fontSize: 16,
  },
  wrongCell: {
    width: 32,
    height: 32,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  wrongCellActive: {
    backgroundColor: '#fdecea',
    borderColor: '#c0392b',
  },
  wrongMark: {
    fontSize: 16,
    fontWeight: '800',
    color: 'transparent',
  },
  wrongMarkActive: {
    color: '#c0392b',
  },
  pronConfusedCell: {
    width: 32,
    height: 32,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  pronConfusedCellActive: {
    backgroundColor: '#fff1e6',
    borderColor: '#ff8a34',
  },
  pronConfusedMark: {
    fontSize: 14,
  },
});

export default memo(TestRowImpl);
