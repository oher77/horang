/**
 * 통계 차트 공용 컴포넌트.
 *
 * 업적 화면([app/achievements/index.tsx])과 자랑 리포트 화면([app/brag/index.tsx])이
 * 공유한다. 막대류는 RN 내장 View로 그리고(§4.5 가드레일), 곡선이 필요한
 * AssetCurveChart만 react-native-svg를 쓴다(Expo Go 번들 포함 모듈).
 */

import { useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

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
    // 차트 라벨은 SVG 좌표에 맞춰 배치되므로 OS 텍스트 크기 배율이 들어오면 어긋난다.
    return <Text allowFontScaling={false} style={styles.emptyText}>{emptyText}</Text>;
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
              <Text
                allowFontScaling={false}
                style={[styles.trendValueLabel, isLast && styles.trendValueLabelLast]}
              >
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
        <Text allowFontScaling={false} style={styles.trendDateLabel}>
          {shortDateLabel(points[0].day)}
        </Text>
        <Text allowFontScaling={false} style={styles.trendDateLabel}>
          {shortDateLabel(points[midIndex].day)}
        </Text>
        <Text allowFontScaling={false} style={styles.trendDateLabel}>
          {shortDateLabel(points[points.length - 1].day)}
        </Text>
      </View>
    </View>
  );
}

const CURVE_HEIGHT = 112;
const CURVE_PAD_X = 14;
/**
 * 곡선이 그려지는 영역의 상하 여백. 위쪽에는 최고점 값 라벨이 얹히므로 라벨 높이만큼
 * 확보돼야 위 요소(제목·증감 배지)와 붙어 보이지 않는다. CURVE_HEIGHT도 함께 키워
 * 곡선 자체의 진폭(innerH)은 유지한다.
 */
const CURVE_PAD_Y = 26;

/**
 * 점들을 부드러운 곡선 path(d 속성)로 잇는다. 각 구간의 중간 x를 제어점으로 쓰는
 * 표준 방식 — 꺾임 없이 이어지면서 원래 값을 정확히 지난다.
 */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i += 1) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const midX = (prev.x + cur.x) / 2;
    d += ` C ${midX} ${prev.y}, ${midX} ${cur.y}, ${cur.x} ${cur.y}`;
  }
  return d;
}

/**
 * 암기 자산 곡선 — 우상향 추세를 한눈에 보여주는 미니 라인 차트.
 * 축·격자 없이 시작/끝 값만 라벨로 찍고, 최고점 높이에 점선 기준선을 둔다.
 * 폭은 onLayout으로 측정해 카드 폭에 맞춘다.
 */
export function AssetCurveChart({
  points,
  valueOf,
  unit = '단어',
  emptyText = '아직 기록이 부족해요.',
}: {
  points: WordStatePoint[];
  valueOf: (p: WordStatePoint) => number;
  unit?: string;
  emptyText?: string;
}) {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const values = points.map(valueOf);
  const enoughData = values.length >= 2 && Math.max(...values) > 0;

  return (
    <View style={styles.curveWrap} onLayout={onLayout}>
      {!enoughData ? (
        <Text allowFontScaling={false} style={styles.emptyText}>{emptyText}</Text>
      ) : (
        width > 0 && <CurveBody width={width} values={values} unit={unit} />
      )}
    </View>
  );
}

function CurveBody({ width, values, unit }: { width: number; values: number[]; unit: string }) {
  const innerW = Math.max(1, width - CURVE_PAD_X * 2);
  const innerH = CURVE_HEIGHT - CURVE_PAD_Y * 2;

  const min = Math.min(...values);
  const max = Math.max(...values);
  // 값이 전부 같으면(span 0) 0으로 나누지 않도록 중앙 높이에 평평하게 그린다.
  const span = max - min || 1;

  const pts = values.map((v, i) => ({
    x: CURVE_PAD_X + (i / (values.length - 1)) * innerW,
    y: CURVE_PAD_Y + (1 - (v - min) / span) * innerH,
  }));

  const first = pts[0];
  const last = pts[pts.length - 1];
  const startValue = values[0];
  const endValue = values[values.length - 1];

  return (
    <View>
      <Svg width={width} height={CURVE_HEIGHT}>
        {/* 최고점 기준선 — 곡선이 어디까지 올라왔는지 눈으로 잡아주는 점선 */}
        <Line
          x1={CURVE_PAD_X}
          y1={CURVE_PAD_Y}
          x2={width - CURVE_PAD_X}
          y2={CURVE_PAD_Y}
          stroke="#E7D5AC"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        <Path
          d={smoothPath(pts)}
          stroke="#E09B2D"
          strokeWidth={3}
          strokeLinecap="round"
          fill="none"
        />
        <Circle cx={first.x} cy={first.y} r={4} fill="#E09B2D" />
        <Circle cx={last.x} cy={last.y} r={5} fill="#E09B2D" />
      </Svg>

      {/* 값 라벨은 SVG Text 대신 RN Text로 — 폰트·자간이 앱의 다른 숫자와 동일해진다. */}
      <Text allowFontScaling={false} style={[styles.curveStartLabel, { left: CURVE_PAD_X }]}>
        {startValue}
        {unit}
      </Text>
      <Text allowFontScaling={false} style={[styles.curveEndLabel, { right: CURVE_PAD_X }]}>
        {endValue}
        {unit}
      </Text>
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
    return <Text allowFontScaling={false} style={styles.emptyText}>{emptyText}</Text>;
  }

  return (
    <View style={styles.barRow}>
      {bars.map((b) => {
        const barHeight = b.value > 0 ? Math.max((b.value / max) * BAR_MAX_HEIGHT, 2) : 0;
        return (
          <View key={b.key} style={styles.barItem}>
            <Text allowFontScaling={false} style={styles.barScoreLabel}>{b.topLabel}</Text>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { height: barHeight }]} />
            </View>
            <Text allowFontScaling={false} style={styles.barDateLabel}>{b.bottomLabel}</Text>
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
  curveWrap: {
    backgroundColor: '#FFF9EE',
    borderRadius: 10,
    paddingVertical: 8,
    justifyContent: 'center',
    minHeight: CURVE_HEIGHT,
  },
  // 시작값은 곡선 왼쪽 아래에, 끝값은 오른쪽 위에 — 우상향 흐름을 시선으로 따라가게 한다.
  // 두 라벨 모두 크림 박스 안쪽에 두어 위아래 요소와 붙지 않게 한다.
  curveStartLabel: {
    position: 'absolute',
    bottom: 2,
    fontSize: 11,
    fontWeight: '600',
    color: '#A98B5B',
  },
  curveEndLabel: {
    position: 'absolute',
    top: 2,
    fontSize: 15,
    fontWeight: '700',
    color: '#3A2D16',
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
