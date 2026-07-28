/**
 * 자랑하기 리포트 화면 (설계.md §6-13).
 *
 * 부모가 궁금해할 성장 지표를 카드로 모아, 카드 영역을 이미지로 캡처해
 * (react-native-view-shot) 카톡/메시지로 공유한다(expo-sharing). 두 모듈 모두 Expo Go
 * 번들에 포함돼 dev build가 필요 없다.
 *
 * 카드에는 긍정 지표만 싣는다: "안 외운 단어"는 하락 그래프로 착시가 생기므로, 감소분을
 * "이번 주에 정복한 단어 N개"라는 상승 양수로 뒤집어 보여준다(bragQueries의 conqueredCount).
 * 자랑거리가 하나도 없으면 안내 문구를 띄우고 공유 버튼을 비활성화한다.
 */

import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';

import { AssetCurveChart, ScoreBarChart, shortDateLabel, type ScoreBar } from '../../components/StatCharts';
import { getBragReport, WINDOW_DAYS, type BragReport } from '../../lib/bragQueries';
import { toEpochDay, todayEpochDay } from '../../lib/dates';

/** 카드 차트에 보여줄 추이 길이(일). 30일 전체는 카드에 과하게 촘촘해 최근 구간만 쓴다. */
const CARD_TREND_DAYS = 14;

// "자랑 발사 🚀" 완료 축포 — 공유 시트가 닫히면 화면 하단에서 로켓이 부채꼴로 터진다.
// ① 확산(감속) → ② 이탈(일부는 낙하, 일부는 가던 방향으로 가속해 화면 밖으로).
const ROCKET_COUNT = 16;
/** ① 확산 구간 길이. */
const ROCKET_FLIGHT_MS = 550;
const ROCKET_FADE_IN_MS = 40;
/** 발사 순간 톡 튀어오르는 시간. */
const ROCKET_POP_MS = 110;
/** ② 이탈 구간 길이 — 이 사이에 화면 밖으로 완전히 빠져나간다. */
const ROCKET_EXIT_MS = 420;
/** 떨어지는 로켓이 머리를 아래로 돌리는 시간. */
const ROCKET_TURN_MS = 140;
/** 발사 웨이브 수 — 전부 동시에 튀지 않고 이 단계로 나뉘어 순차 발사된다. */
const BURST_STAGES = 7;
const BURST_STAGE_GAP_MS = 60;
/** 축포 전체 지속 = 마지막 웨이브가 이탈까지 마치는 시점. 이 뒤에 오버레이를 언마운트한다. */
const BURST_DURATION_MS =
  (BURST_STAGES - 1) * BURST_STAGE_GAP_MS + ROCKET_FLIGHT_MS + ROCKET_EXIT_MS;
/** 발사 부채꼴 각도(라디안). 위쪽(-90°)을 중심으로 이만큼 좌우로 퍼진다. */
const BURST_SPREAD_RAD = (Math.PI * 2) / 3; // 120°
/** 이탈 이동 거리 — 화면 높이만큼 보내 확실히 밖으로 내보낸다(세로 고정 앱). */
const EXIT_DISTANCE = Dimensions.get('window').height;

export default function BragScreen() {
  const [report, setReport] = useState<BragReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  // 축포 트리거 — 값이 바뀔 때마다 RocketBurst를 새 key로 remount해 매번 처음부터 터진다.
  // 0이면 아직 발사 전(렌더 안 함).
  const [burstKey, setBurstKey] = useState(0);

  // 캡처 대상(카드 컨테이너) ref — 이 View의 경계만 PNG로 렌더된다.
  const cardRef = useRef<View>(null);

  useEffect(() => {
    let cancelled = false;
    getBragReport()
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleShare = useCallback(async () => {
    setSharing(true);
    try {
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        Alert.alert('공유를 사용할 수 없어요', '이 기기에서는 공유 기능을 쓸 수 없습니다.');
        return;
      }
      const uri = await captureRef(cardRef, { format: 'png', quality: 1, result: 'tmpfile' });
      await Sharing.shareAsync(uri, {
        mimeType: 'image/png',
        dialogTitle: '호랑이 잉글리시 자랑하기 리포트',
        UTI: 'public.png',
      });
      // 공유 시트가 닫히면(전송·취소 모두) 발사 완료로 보고 축포를 터뜨린다.
      setBurstKey((k) => k + 1);
    } catch (err) {
      Alert.alert('공유 실패', err instanceof Error ? err.message : String(err));
    } finally {
      setSharing(false);
    }
  }, []);

  const hasAnyBrag =
    report !== null &&
    (report.streak >= 1 ||
      report.missionDone > 0 ||
      report.learnedWordsTotal > 0 ||
      report.memorizedNow > 0 ||
      report.conqueredCount > 0 ||
      report.pronResolvedRecent > 0 ||
      report.recentScores.length > 0 ||
      report.monthIncomeTotal > 0);

  // 기간 라벨: 최근 WINDOW_DAYS ~ 오늘.
  const today = todayEpochDay();
  const periodLabel = `${shortDateLabel(today - (WINDOW_DAYS - 1))} – ${shortDateLabel(today)}`;

  return (
    <View style={styles.flexFill}>
      <Stack.Screen options={{ title: '자랑하기' }} />

      <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
        {error && <Text style={styles.error}>{error}</Text>}

        {!error && !report && <ActivityIndicator style={styles.loading} size="large" />}

        {!error && report && (
          <>
            {/* 캡처 대상: 흰 배경 카드 묶음 */}
            <View ref={cardRef} collapsable={false} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardHeaderTitle}>🐯 호랑이 잉글리시 자랑하기 리포트</Text>
                <Text style={styles.cardHeaderPeriod}>{periodLabel}</Text>
              </View>

              {!hasAnyBrag ? (
                <View style={styles.emptyBlock}>
                  {/* 자랑거리가 없을 때만 보이는 화면 — 공유가 막혀 있어 부모에게 갈 일이
                      없는 아이 전용 영역이라 카드 안쪽과 달리 격려하는 톤으로 쓴다. */}
                  <Text style={styles.emptyText}>아직 발사할 자랑이 없어요 🚀</Text>
                  <Text style={styles.emptySubText}>
                    단어장을 훑고 테스트를 보면 자랑거리가 차곡차곡 쌓입니다.
                  </Text>
                </View>
              ) : (
                <>
                  {report.streak >= 1 && (
                    <StatBlock emoji="🔥" title="연속 학습">
                      <Text style={styles.bigNumber}>{report.streak}일 연속</Text>
                      <Text style={styles.blockCaption}>
                        하루 4회 인출을 모두 채운 날만 셉니다.
                      </Text>
                    </StatBlock>
                  )}

                  {report.missionDone > 0 && (
                    <StatBlock emoji="⏰" title="이번 주 분산 학습 미션">
                      <View style={styles.numberRow}>
                        <Text style={styles.bigNumber}>
                          {report.missionDone}
                          <Text style={styles.numberSuffix}>/{report.missionTotal}칸</Text>
                        </Text>
                        {report.missionTotal > 0 && (
                          <Text style={styles.deltaUp}>
                            {Math.round((report.missionDone / report.missionTotal) * 100)}%
                          </Text>
                        )}
                      </View>
                      <Text style={styles.blockCaption}>
                        몰아서 한 번보다 나눠서 여러 번이 장기 기억에 유리합니다.
                      </Text>
                    </StatBlock>
                  )}

                  {report.learnedWordsTotal > 0 && (
                    <StatBlock emoji="📚" title="누적 학습 단어">
                      <View style={styles.numberRow}>
                        <Text style={styles.bigNumber}>{report.learnedWordsTotal}개</Text>
                        {report.learnedWordsRecent > 0 && (
                          <Text style={styles.deltaUp}>이번 주 +{report.learnedWordsRecent}</Text>
                        )}
                      </View>
                      <Text style={styles.blockCaption}>실제로 학습을 시작한 단어장 기준입니다.</Text>
                    </StatBlock>
                  )}

                  {report.memorizedNow > 0 && (
                    <StatBlock emoji="🧠" title="암기 자산 곡선">
                      <View style={styles.numberRow}>
                        <Text style={styles.bigNumber}>{report.memorizedNow}개</Text>
                        {report.memorizedDelta > 0 && (
                          <Text style={styles.deltaUp}>이번 주 +{report.memorizedDelta}</Text>
                        )}
                      </View>
                      <Text style={styles.blockCaption}>
                        장기기억에 저장된 단어 — 가장 최근 테스트에서 정답으로 확인된 단어 수입니다.
                      </Text>
                      <AssetCurveChart
                        points={report.memorizedTrend.slice(-CARD_TREND_DAYS)}
                        valueOf={(p) => p.correctCount}
                      />
                    </StatBlock>
                  )}

                  {report.conqueredCount > 0 && (
                    <StatBlock emoji="⚔️" title="이번 주에 정복한 단어">
                      <Text style={styles.conquerNumber}>+{report.conqueredCount}개</Text>
                      <Text style={styles.blockCaption}>
                        오답이던 단어가 정답으로 뒤집힌 수입니다. 배울수록 늘기 마련인
                        &apos;안 외워진 단어&apos;를 오히려 줄였습니다.
                      </Text>
                    </StatBlock>
                  )}

                  {report.pronResolvedRecent > 0 && (
                    <StatBlock emoji="🗣️" title="정복한 발음">
                      <Text style={styles.bigNumber}>+{report.pronResolvedRecent}개</Text>
                      <Text style={styles.blockCaption}>
                        발음이 헷갈린다고 표시했다가 스스로 해결한 단어입니다
                        {report.pronResolvedTotal > report.pronResolvedRecent
                          ? `. 누적 ${report.pronResolvedTotal}개`
                          : ''}
                        .
                      </Text>
                    </StatBlock>
                  )}

                  {report.recentScores.length > 0 && (
                    <StatBlock emoji="💯" title="최근 5일 점수">
                      {(report.scoreAvg !== null || report.scoreBest !== null) && (
                        <Text style={styles.blockCaption}>
                          평균 {report.scoreAvg ?? '-'}점 · 최고 {report.scoreBest ?? '-'}점
                        </Text>
                      )}
                      <ScoreBarChart
                        bars={[...report.recentScores].reverse().map<ScoreBar>((item) => ({
                          key: String(item.session_id),
                          value: item.score100 ?? 0,
                          topLabel: String(item.score100 ?? '-'),
                          bottomLabel: shortDateLabel(toEpochDay(new Date(item.taken_ms))),
                        }))}
                        emptyText="최근 5일간 치른 테스트가 없어요."
                      />
                    </StatBlock>
                  )}

                  {/* 다른 카드는 주간이지만 이 항목만 월 기준(주간 합계 쿼리 없음) —
                      오해가 없도록 제목에 "이번 달"을 명시한다. */}
                  {report.monthIncomeTotal > 0 && (
                    <StatBlock emoji="💰" title="이번 달 적립 용돈">
                      <Text style={styles.bigNumber}>
                        {report.monthIncomeTotal.toLocaleString()}원
                      </Text>
                      <Text style={styles.blockCaption}>
                        테스트 점수와 습관 보너스로 적립된 금액입니다.
                      </Text>
                    </StatBlock>
                  )}

                  {report.costPerWord !== null && (
                    <StatBlock emoji="🧾" title="이번 달 단어당 비용">
                      <Text style={styles.bigNumber}>
                        {report.costPerWord.toLocaleString()}원
                      </Text>
                      <Text style={styles.blockCaption}>
                        이번 달 적립 용돈 {report.monthIncomeTotal.toLocaleString()}원 ÷ 새로 암기한
                        단어 {report.monthMemorizedGain}개. 단어 하나를 장기기억에 남기는 데 든
                        비용입니다.
                      </Text>
                    </StatBlock>
                  )}
                </>
              )}

              {/* 미지급 용돈 안내 — 자랑 지표가 아니라 부모님에게 전하는 알림이라
                  항상 맨 아래에 두고 색·톤을 구분한다(hasAnyBrag 판정에도 넣지 않는다:
                  자랑거리가 하나도 없는데 청구서만 있는 리포트를 보내지 않기 위함). */}
              {report.unpaidTotal > 0 && (
                <View style={styles.unpaidBlock}>
                  <Text style={styles.unpaidTitle}>💌 미지급 용돈</Text>
                  <Text style={styles.unpaidAmount}>{report.unpaidTotal.toLocaleString()}원</Text>
                  <Text style={styles.unpaidCaption}>
                    {report.unpaidCount}건이 부모님 확인을 기다리고 있습니다.
                  </Text>
                </View>
              )}

              <Text style={styles.stamp}>🐯 호랑이 잉글리시가 인증합니다</Text>
            </View>

            <Pressable
              style={[styles.shareButton, (!hasAnyBrag || sharing) && styles.shareButtonDisabled]}
              onPress={handleShare}
              disabled={!hasAnyBrag || sharing}
            >
              {/* 캡처 대상(cardRef) 바깥 = 아이만 보는 UI라 밝은 톤. 카드 안쪽(부모가
                  받아보는 영역)은 신뢰·전문 톤으로 구분해 쓴다. */}
              <Text style={styles.shareButtonText}>
                {sharing ? '발사 준비 중…' : '자랑 발사 🚀'}
              </Text>
            </Pressable>
          </>
        )}
      </ScrollView>

      {/* ScrollView 바깥(화면 루트)에 둬야 스크롤 위치와 무관하게 화면 전체를 덮는다. */}
      {burstKey > 0 && <RocketBurst key={burstKey} onDone={() => setBurstKey(0)} />}
    </View>
  );
}

/**
 * 발사 완료 축포 — 화면 하단 중앙에서 로켓들이 부채꼴로 흩어지며 사라진다.
 * pointerEvents="none"으로 터지는 동안에도 화면 조작을 막지 않고, BURST_DURATION_MS 후
 * onDone으로 스스로 언마운트를 요청한다(잔여 애니메이션 노드를 남기지 않기 위함).
 */
function RocketBurst({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, BURST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  // 각 로켓의 방향·거리·크기는 마운트 시 1회만 뽑는다 — 리렌더로 궤적이 바뀌면 안 된다.
  const rockets = useMemo(
    () =>
      Array.from({ length: ROCKET_COUNT }, (_, i) => {
        // 부채꼴을 균등 분할하되 살짝 흔들어(jitter) 기계적인 배열로 보이지 않게 한다.
        const angle =
          -Math.PI / 2 +
          ((i + 0.5) / ROCKET_COUNT - 0.5) * BURST_SPREAD_RAD +
          (Math.random() - 0.5) * 0.25;
        const distance = 170 + Math.random() * 170;
        return {
          id: i,
          dx: Math.cos(angle) * distance,
          dy: Math.sin(angle) * distance, // 음수 = 위로
          // 🚀 이모지는 우상단(-45°)을 향하므로 진행 방향에 맞추려면 +45° 보정.
          rotateDeg: (angle * 180) / Math.PI + 45,
          // i % BURST_STAGES라 각 웨이브가 부채꼴 전체에 고르게 흩어진다.
          delayMs: (i % BURST_STAGES) * BURST_STAGE_GAP_MS,
          size: 22 + Math.random() * 16,
          // 확산 후 진로: true면 가던 방향으로 가속, false면 낙하.
          isFlyer: Math.random() < 0.5,
        };
      }),
    [],
  );

  return (
    <View style={styles.burstOverlay} pointerEvents="none">
      {rockets.map((r) => (
        <Rocket key={r.id} {...r} />
      ))}
    </View>
  );
}

/**
 * 축포 로켓 1개 — ① 지정 방향으로 감속하며 퍼진 뒤, ② 화면 밖으로 이탈한다.
 * isFlyer면 가던 방향 그대로 가속해 날아가고(자세 전환 없음), 아니면 머리를 아래로
 * 돌려 낙하한다. 소멸은 페이드가 아니라 화면 이탈로 처리한다.
 */
function Rocket({
  dx,
  dy,
  rotateDeg,
  delayMs,
  size,
  isFlyer,
}: {
  dx: number;
  dy: number;
  rotateDeg: number;
  delayMs: number;
  size: number;
  isFlyer: boolean;
}) {
  const progress = useSharedValue(0);
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.5);
  const exit = useSharedValue(0);
  const turn = useSharedValue(0);

  // 이탈 벡터 — 솟구치는 쪽은 확산 방향의 단위벡터를 연장, 떨어지는 쪽은 수직 낙하.
  const len = Math.hypot(dx, dy) || 1;
  const exitDx = isFlyer ? (dx / len) * EXIT_DISTANCE : 0;
  const exitDy = isFlyer ? (dy / len) * EXIT_DISTANCE : EXIT_DISTANCE;
  /** 낙하 시 자세(🚀는 우상단 기준이라 아래쪽이 135°). 솟구치면 진행 방향 유지. */
  const exitRotateDeg = isFlyer ? rotateDeg : 135;

  useEffect(() => {
    progress.value = withDelay(
      delayMs,
      withTiming(1, { duration: ROCKET_FLIGHT_MS, easing: Easing.out(Easing.quad) }),
    );
    scale.value = withDelay(
      delayMs,
      withTiming(1, { duration: ROCKET_POP_MS, easing: Easing.out(Easing.back(1.8)) }),
    );
    opacity.value = withDelay(delayMs, withTiming(1, { duration: ROCKET_FADE_IN_MS }));

    // ② 이탈 — 확산이 멈추는 순간 시작.
    const exitDelayMs = delayMs + ROCKET_FLIGHT_MS;
    exit.value = withDelay(
      exitDelayMs,
      withTiming(1, {
        duration: ROCKET_EXIT_MS,
        easing: isFlyer ? Easing.in(Easing.cubic) : Easing.in(Easing.quad),
      }),
    );
    if (!isFlyer) {
      turn.value = withDelay(exitDelayMs, withTiming(1, { duration: ROCKET_TURN_MS }));
    }

    return () => {
      cancelAnimation(progress);
      cancelAnimation(opacity);
      cancelAnimation(scale);
      cancelAnimation(exit);
      cancelAnimation(turn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const style = useAnimatedStyle(() => {
    const rot = rotateDeg + (exitRotateDeg - rotateDeg) * turn.value;
    return {
      opacity: opacity.value,
      transform: [
        { translateX: dx * progress.value + exitDx * exit.value },
        { translateY: dy * progress.value + exitDy * exit.value },
        { scale: scale.value },
        { rotate: `${rot}deg` },
      ],
    };
  });

  return <Animated.Text style={[styles.rocket, { fontSize: size }, style]}>🚀</Animated.Text>;
}

/** 자랑 카드 내부 1블록 — 이모지+제목 헤더 + 내용. */
function StatBlock({
  emoji,
  title,
  children,
}: {
  emoji: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.block}>
      <Text style={styles.blockTitle}>
        {emoji} {title}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  flexFill: {
    flex: 1,
  },
  scroll: {
    flex: 1,
    backgroundColor: '#fff',
  },
  container: {
    padding: 16,
    gap: 16,
  },
  loading: {
    marginTop: 48,
  },
  error: {
    color: '#c0392b',
    textAlign: 'center',
    marginTop: 24,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ffe0c2',
    padding: 20,
    gap: 20,
  },
  cardHeader: {
    alignItems: 'center',
  },
  cardHeaderTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#ff8a34',
  },
  cardHeaderPeriod: {
    marginTop: 4,
    fontSize: 12,
    color: '#999',
  },
  block: {
    backgroundColor: '#f7f7f7',
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  blockTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#333',
  },
  numberRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
  },
  bigNumber: {
    fontSize: 28,
    fontWeight: '800',
    color: '#222',
  },
  /** 큰 숫자 뒤에 붙는 "/28칸" 같은 보조 단위 — 숫자보다 작고 흐리게. */
  numberSuffix: {
    fontSize: 16,
    fontWeight: '700',
    color: '#888',
  },
  deltaUp: {
    fontSize: 15,
    fontWeight: '700',
    color: '#2e7d32',
  },
  conquerNumber: {
    fontSize: 26,
    fontWeight: '800',
    color: '#c0392b',
  },
  blockCaption: {
    fontSize: 13,
    color: '#666',
  },
  emptyBlock: {
    alignItems: 'center',
    padding: 16,
    gap: 8,
  },
  emptyText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
    textAlign: 'center',
  },
  emptySubText: {
    fontSize: 13,
    color: '#999',
    textAlign: 'center',
  },
  unpaidBlock: {
    alignItems: 'center',
    backgroundColor: '#fff8ee',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#ffd9a8',
    borderStyle: 'dashed',
    padding: 16,
    gap: 4,
  },
  unpaidTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#b45309',
  },
  unpaidAmount: {
    fontSize: 24,
    fontWeight: '800',
    color: '#b45309',
  },
  unpaidCaption: {
    fontSize: 12,
    color: '#a1783c',
    textAlign: 'center',
  },
  stamp: {
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '700',
    color: '#ff8a34',
  },
  shareButton: {
    backgroundColor: '#ff8a34',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  shareButtonDisabled: {
    opacity: 0.5,
  },
  shareButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  // 축포 오버레이 — 화면을 덮되 조작은 통과시킨다. 로켓은 inset 없는 absolute라
  // 부모의 정렬(하단 중앙)을 시작점으로 삼아 전부 한 점에서 출발한다(Yoga 규칙).
  burstOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 120,
  },
  rocket: {
    position: 'absolute',
  },
});
