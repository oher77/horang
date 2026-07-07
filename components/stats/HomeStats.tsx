/**
 * 홈 통계 컴포넌트 (설계.md §4.4 "나의 업적" 쿼리 매핑 중 Q-RECENT5 / Q-SCARY-TOP10 부분).
 *
 * props 없이 자체 로드하는 완결형 컴포넌트 — 오케스트레이터가 app/index.tsx 등에
 * <HomeStats />로 그대로 붙이면 된다. 그래프 라이브러리 금지 규약(신규 npm 패키지
 * 금지)에 따라 최근 5일 점수는 View/Text로 자체 구현한 막대 그래프, 낯가림 Top10은
 * 순위 목록으로 표시한다.
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { epochDayToDateString, toEpochDay } from '../../lib/dates';
import { getRecentScores, getScaryWordsTop10, type RecentScore, type ScaryWord } from '../../lib/statsQueries';

const BAR_MAX_HEIGHT = 80;

export default function HomeStats() {
  const [recentScores, setRecentScores] = useState<RecentScore[] | null>(null);
  const [scaryWords, setScaryWords] = useState<ScaryWord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    Promise.all([getRecentScores(), getScaryWordsTop10()])
      .then(([scores, scary]) => {
        setRecentScores(scores);
        setScaryWords(scary);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) {
    return (
      <View style={styles.container}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  if (!recentScores || !scaryWords) {
    return (
      <View style={styles.container}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <RecentScoresSection scores={recentScores} />
      <ScaryWordsSection words={scaryWords} />
    </View>
  );
}

function RecentScoresSection({ scores }: { scores: RecentScore[] }) {
  // Q-RECENT5는 최신순(DESC)으로 오므로, 그래프는 시간 흐름대로 보이도록 뒤집는다.
  const chronological = [...scores].reverse();

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>최근 5일 점수</Text>

      {chronological.length === 0 ? (
        <Text style={styles.emptyText}>최근 5일간 치른 테스트가 없어요.</Text>
      ) : (
        <View style={styles.barRow}>
          {chronological.map((item) => {
            const score = item.score100 ?? 0;
            const barHeight = Math.max((score / 100) * BAR_MAX_HEIGHT, 2);
            return (
              <View key={item.session_id} style={styles.barItem}>
                <Text style={styles.barScoreLabel}>{item.score100 ?? '-'}</Text>
                <View style={styles.barTrack}>
                  <View style={[styles.barFill, { height: barHeight }]} />
                </View>
                <Text style={styles.barDateLabel}>
                  {epochDayToDateString(toEpochDay(new Date(item.taken_ms))).slice(5)}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

function ScaryWordsSection({ words }: { words: ScaryWord[] }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>낯가림 단어 Top10</Text>

      {words.length === 0 ? (
        <Text style={styles.emptyText}>아직 오답이 없어요.</Text>
      ) : (
        <View style={styles.scaryList}>
          {words.map((word, index) => (
            <View key={word.content_word_id} style={styles.scaryRow}>
              <Text style={styles.scaryRank}>{index + 1}</Text>
              <Text style={styles.scaryWord} numberOfLines={1}>
                {word.headword}
              </Text>
              <Text style={styles.scaryCount}>{word.wrong_count}회</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 20,
  },
  section: {
    backgroundColor: '#f7f7f7',
    borderRadius: 12,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#222',
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 13,
    color: '#999',
  },
  error: {
    color: '#c0392b',
    textAlign: 'center',
  },
  barRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'flex-end',
  },
  barItem: {
    alignItems: 'center',
    width: 48,
  },
  barScoreLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#444',
    marginBottom: 4,
  },
  barTrack: {
    width: 20,
    height: BAR_MAX_HEIGHT,
    justifyContent: 'flex-end',
  },
  barFill: {
    width: 20,
    borderRadius: 4,
    backgroundColor: '#ff8a34',
  },
  barDateLabel: {
    marginTop: 6,
    fontSize: 11,
    color: '#999',
  },
  scaryList: {
    gap: 8,
  },
  scaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  scaryRank: {
    width: 20,
    fontSize: 13,
    fontWeight: '700',
    color: '#ff8a34',
  },
  scaryWord: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#222',
  },
  scaryCount: {
    fontSize: 13,
    color: '#888',
  },
});
