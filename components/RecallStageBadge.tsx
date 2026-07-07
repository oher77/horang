/**
 * 기억 인출 실패 단계 배지 (단어장 앱 만들기.md: "한번 기억이 안 난 것 ~ 다섯 번
 * 기억 안 난 것, 총 5단계"). recall_stage 0(실패 없음)은 무배지, 1~5는 단계별로
 * 진하기가 강해지는 색+숫자 배지로 표시한다.
 */

import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

interface RecallStageBadgeProps {
  stage: number; // 0~5
}

// 단계가 올라갈수록(더 자주 까먹을수록) 경고색이 진해진다.
const STAGE_COLORS = ['#eee', '#ffe9b3', '#ffcf7a', '#ff9f43', '#ff6b6b', '#c0392b'];

function RecallStageBadgeImpl({ stage }: RecallStageBadgeProps) {
  if (stage <= 0) {
    return <View style={styles.emptySlot} />;
  }

  const color = STAGE_COLORS[Math.min(stage, STAGE_COLORS.length - 1)];

  return (
    <View style={[styles.badge, { backgroundColor: color }]}>
      <Text style={styles.badgeText}>{stage}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  emptySlot: {
    width: 22,
    height: 22,
  },
  badge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#fff',
  },
});

export default memo(RecallStageBadgeImpl);
