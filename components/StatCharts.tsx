/**
 * 통계 차트 공용 컴포넌트 (라이브러리 없이 순수 View 기반).
 *
 * 업적 화면([app/achievements/index.tsx])과 자랑 리포트 화면([app/brag/index.tsx])이
 * 공유한다. FlashList 등 서드파티 모듈 없이 RN 내장 View로만
 * 그린다는 §4.5 가드레일을 그대로 따른다.
 */

import { StyleSheet, Text, View } from 'react-native';

import { epochDayToDateString } from '../lib/dates';
import type { WordStatePoint } from '../lib/statsQueries';

export const BAR_MAX_HEIGHT = 80;
export const TREND_MAX_HEIGHT = 60;

/** epoch day → "7/10" 축약 날짜 라벨 (앞자리 0 제거). */
export function shortDateLabel(day: number): string {
  const [, month, date] = epochDayToDateString(day).split('-');
  return `${Number(month)}/${Number(date)}`;
}

/**
 * 일별 30일 추이 막대 그래프. y스케일은 시리즈 최댓값 기준 정규화하고, 최댓값이 0이면
 * 플레이스홀더 텍스트로 대체한다. 값 라벨은 마지막(오늘) 막대 위에만 표시하고, 날짜 라벨은
 * 첫날/중간/오늘 3개만 좌/중/우로 표시한다(슬롯 폭이 좁아 전부 표시하면 말줄임됨).
 */
export function DailyTrendBarChart({
  points,
  valueOf,
  color,
  emptyText = '아직 테스트 기록이 없어요.',
}: {
  points: WordStatePoint[];
  valueOf: (p: WordStatePoint) => number;
  color: string;
  emptyText?: string;
}) {
  const values = points.map(valueOf);
  const max = Math.max(0, ...values);

  if (max === 0) {
    return <Text style={styles.emptyText}>{emptyText}</Text>;
  }

  const midIndex = Math.floor((points.length - 1) / 2);

  return (
    <View>
      <View style={styles.trendRow}>
        {points.map((p, index) => {
          const value = valueOf(p);
          const barHeight = value > 0 ? Math.max((value / max) * TREND_MAX_HEIGHT, 2) : 0;
          const isLast = index === points.length - 1;
          return (
            <View key={p.day} style={styles.trendBarItem}>
              {/* 마지막 슬롯 폭(~12px)에 갇히면 숫자가 잘리므로, 고정폭 우측정렬로
                  차트 안쪽(왼쪽)을 향해 넘치게 한다. */}
              <Text style={[styles.trendValueLabel, isLast && styles.trendValueLabelLast]}>
                {isLast ? value : ''}
              </Text>
              <View style={styles.trendBarTrack}>
                <View style={[styles.trendBarFill, { height: barHeight, backgroundColor: color }]} />
              </View>
            </View>
          );
        })}
      </View>
      <View style={styles.trendDateRow}>
        <Text style={styles.trendDateLabel}>{shortDateLabel(points[0].day)}</Text>
        <Text style={styles.trendDateLabel}>{shortDateLabel(points[midIndex].day)}</Text>
        <Text style={styles.trendDateLabel}>{shortDateLabel(points[points.length - 1].day)}</Text>
      </View>
    </View>
  );
}

/** 막대 그래프 1칸 데이터 — 값, 상단 값 라벨, 하단 x축 라벨. */
export interface ScoreBar {
  key: string;
  value: number; // 막대 높이 정규화 기준값
  topLabel: string; // 막대 위 표기 (점수/금액 등, 빈 문자열이면 생략)
  bottomLabel: string; // 막대 아래 x축 표기 (날짜/월 등)
}

/**
 * 값 막대 그래프(최근 5일 점수·월별 Income 미니 차트 공용). max 기준 정규화하고,
 * max가 0이면 emptyText로 대체한다.
 */
export function ScoreBarChart({ bars, emptyText }: { bars: ScoreBar[]; emptyText: string }) {
  const max = Math.max(0, ...bars.map((b) => b.value));

  if (max === 0) {
    return <Text style={styles.emptyText}>{emptyText}</Text>;
  }

  return (
    <View style={styles.barRow}>
      {bars.map((b) => {
        const barHeight = b.value > 0 ? Math.max((b.value / max) * BAR_MAX_HEIGHT, 2) : 0;
        return (
          <View key={b.key} style={styles.barItem}>
            <Text style={styles.barScoreLabel}>{b.topLabel}</Text>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { height: barHeight }]} />
            </View>
            <Text style={styles.barDateLabel}>{b.bottomLabel}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  emptyText: {
    fontSize: 13,
    color: '#999',
  },
  barRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'flex-end',
    marginBottom: 16,
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
  trendRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  trendBarItem: {
    flex: 1,
    alignItems: 'center',
  },
  trendBarTrack: {
    width: 4,
    height: TREND_MAX_HEIGHT,
    justifyContent: 'flex-end',
  },
  trendBarFill: {
    width: 4,
    borderRadius: 2,
  },
  trendValueLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#444',
    marginBottom: 2,
    height: 14,
  },
  trendValueLabelLast: {
    width: 44,
    textAlign: 'right',
    alignSelf: 'flex-end',
  },
  trendDateRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  trendDateLabel: {
    fontSize: 9,
    color: '#999',
  },
});
