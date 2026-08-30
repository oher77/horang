/**
 * 용돈 장부 세부내역 바텀시트 (2026-08-30 개편) — components/WordDetailSheet.tsx의
 * 구현 패턴(RN Modal transparent + reanimated 슬라이드업 220ms + gesture-handler
 * Pan 드래그 닫기 + 배경 탭 닫기)을 그대로 따른다. 신규 패키지 설치 없음.
 *
 * 2단 드릴다운이지만 Modal은 하나만 띄운다 — 내부 스택(최대 2단)을 이 컴포넌트가
 * 직접 관리하고 내용만 교체한다:
 *   1단 'days'    — 날짜별 합계 목록 (주 행에서 열었을 때 시작점)
 *   1단 'entries' — 개별 항목 목록 (오늘 행에서 열었을 때 시작점, 뒤로가기 없음)
 *   2단 'entries' — 1단 'days'에서 날짜 행을 탭했을 때. 헤더에 뒤로 버튼(← 주 전체)
 *
 * 데이터 조회는 이 컴포넌트가 하지 않는다 — 화면(app/achievements/index.tsx)이
 * 메모리 캐시를 갖고 있고, 이 시트는 넘겨받은 데이터를 렌더만 한다(스펙 §3.5/§3.6).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { hourMinute, weekdayLabel } from '../lib/dates';
import type { DayLedgerSummary, LedgerEntry } from '../lib/ledgerQueries';

const SLIDE_DURATION = 220;
const DRAG_CLOSE_THRESHOLD = 120;

/** 단 전환(1단↔2단) 연출 — iOS 내비게이션 push/pop과 같은 방향으로 가로 슬라이드 + 페이드.
 * 들어갈 때는 오른쪽에서, 뒤로 갈 때는 왼쪽에서 들어온다. 나가는 화면은 따로 그리지 않는다
 * (한 번에 한 단만 렌더하는 구조라 두 단을 겹쳐 밀려면 스택을 통째로 다시 짜야 하는데,
 * 시트 안의 짧은 이동이라 들어오는 쪽만 움직여도 방향이 읽힌다). */
const STEP_SHIFT = 24;
const STEP_DURATION = 190;

/** 시트가 처음 여는 화면. 'days'면 날짜별 합계에서 시작(주 행), 'entries'면 개별
 * 항목에서 바로 시작(오늘 합계 행) — 스펙 §3.5. */
export type LedgerSheetRootMode = 'days' | 'entries';

interface LedgerDetailSheetProps {
  visible: boolean;
  /** 시트를 처음 열 때의 표시 모드 (닫힌 뒤 재사용 시 이 값으로 스택이 초기화됨). */
  rootMode: LedgerSheetRootMode;
  /** 헤더 타이틀 (예: "이번주 받은 용돈", "8/11~8/17", "오늘 받은 용돈"). */
  title: string;
  loading: boolean;
  error: string | null;
  /** rootMode='days'일 때 1단에 보여줄 날짜별 합계. */
  daySummaries: DayLedgerSummary[] | null;
  /** rootMode='entries'일 때 1단에 보여줄 개별 항목(오늘 합계 행). */
  rootEntries: LedgerEntry[] | null;
  /** 날짜 행을 탭했을 때 2단에 보여줄 개별 항목을 조회해 온다 (캐시는 호출측 책임). */
  onRequestDayEntries: (epochDay: number) => Promise<LedgerEntry[]>;
  /** 개별 항목 라벨(테스트=Day{dayIndex} 테스트, 습관=habitBonusLabel(kind) 결과)를
   * 만들어 준다 — 라벨 로직은 app/achievements/index.tsx의 기존 함수를 그대로 위임받는다. */
  labelFor: (entry: LedgerEntry) => string;
  /** epoch day → "M/D" 표시 문자열. */
  formatDay: (epochDay: number) => string;
  onClose: () => void;
}

type DrillState =
  | { level: 1; mode: 'days' }
  | { level: 1; mode: 'entries' }
  | { level: 2; mode: 'entries'; epochDay: number; entries: LedgerEntry[] | null; loading: boolean; error: string | null };

export default function LedgerDetailSheet({
  visible,
  rootMode,
  title,
  loading,
  error,
  daySummaries,
  rootEntries,
  onRequestDayEntries,
  labelFor,
  formatDay,
  onClose,
}: LedgerDetailSheetProps) {
  const translateY = useSharedValue(400);
  const stepX = useSharedValue(0);
  const stepOpacity = useSharedValue(1);
  const [mounted, setMounted] = useState(visible);
  const [drill, setDrill] = useState<DrillState>({ level: 1, mode: rootMode });

  // 단 전환 방향을 알려면 직전 단을 기억해야 한다. 시트를 다시 열 때 1로 되돌리지 않으면
  // 지난번 2단이 남아 "뒤로 가는" 방향으로 열린다.
  const prevLevelRef = useRef(1);

  useEffect(() => {
    if (drill.level === prevLevelRef.current) return;
    const goingDeeper = drill.level > prevLevelRef.current;
    prevLevelRef.current = drill.level;
    stepX.value = goingDeeper ? STEP_SHIFT : -STEP_SHIFT;
    stepOpacity.value = 0;
    stepX.value = withTiming(0, { duration: STEP_DURATION, easing: Easing.out(Easing.quad) });
    stepOpacity.value = withTiming(1, { duration: STEP_DURATION });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drill.level]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setDrill({ level: 1, mode: rootMode });
      prevLevelRef.current = 1;
      stepX.value = 0;
      stepOpacity.value = 1;
      translateY.value = withTiming(0, { duration: SLIDE_DURATION });
    } else if (mounted) {
      translateY.value = withTiming(400, { duration: SLIDE_DURATION }, (finished) => {
        if (finished) runOnJS(setMounted)(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, rootMode]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleOpenDay = useCallback(
    (epochDay: number) => {
      setDrill({ level: 2, mode: 'entries', epochDay, entries: null, loading: true, error: null });
      onRequestDayEntries(epochDay)
        .then((entries) => {
          setDrill((prev) =>
            prev.level === 2 && prev.epochDay === epochDay ? { ...prev, entries, loading: false } : prev,
          );
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setDrill((prev) =>
            prev.level === 2 && prev.epochDay === epochDay ? { ...prev, error: message, loading: false } : prev,
          );
        });
    },
    [onRequestDayEntries],
  );

  const handleBackToWeek = useCallback(() => {
    setDrill({ level: 1, mode: 'days' });
  }, []);

  const dragGesture = Gesture.Pan()
    .onUpdate((e) => {
      if (e.translationY > 0) translateY.value = e.translationY;
    })
    .onEnd((e) => {
      if (e.translationY > DRAG_CLOSE_THRESHOLD) {
        runOnJS(handleClose)();
      } else {
        translateY.value = withTiming(0, { duration: 160 });
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const stepStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: stepX.value }],
    opacity: stepOpacity.value,
  }));

  if (!mounted) return null;

  const headerTitle = drill.level === 2 ? formatDay(drill.epochDay) : title;

  return (
    <Modal transparent visible animationType="none" onRequestClose={handleClose}>
      <Pressable style={styles.backdrop} onPress={handleClose} />

      <GestureDetector gesture={dragGesture}>
        <Animated.View style={[styles.sheet, sheetStyle]}>
          <View style={styles.dragHandle} />

          {/* 헤더도 함께 움직인다 — 타이틀이 "8/23~8/29" ↔ "8/26"으로 같이 바뀌므로
              내용만 밀면 제목만 툭 갈아끼워져 오히려 눈에 띈다. 드래그 손잡이는 고정. */}
          <Animated.View style={[styles.step, stepStyle]}>
            <View style={styles.headerRow}>
              {drill.level === 2 && (
                <Pressable onPress={handleBackToWeek} hitSlop={8} style={styles.backButton}>
                  <Text style={styles.backButtonText}>{'←'}</Text>
                </Pressable>
              )}
              <Text style={styles.headerTitle}>{headerTitle}</Text>
            </View>

            {drill.level === 1 && loading && <ActivityIndicator style={styles.loading} />}
            {drill.level === 1 && error && <Text style={styles.errorText}>{error}</Text>}

            {drill.level === 1 && drill.mode === 'days' && !loading && !error && (
              <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
                {(!daySummaries || daySummaries.length === 0) && (
                  <Text style={styles.emptyText}>내역이 없어요.</Text>
                )}
                {daySummaries?.map((day) => (
                  <Pressable
                    key={day.epochDay}
                    style={({ pressed }) => [styles.row, styles.dayRow, pressed && styles.dayRowPressed]}
                    onPress={() => handleOpenDay(day.epochDay)}
                    hitSlop={4}
                  >
                    <Text style={styles.rowLabel}>
                      {formatDay(day.epochDay)}
                      <Text style={styles.rowMeta}>{`  ${weekdayLabel(day.epochDay)}`}</Text>
                    </Text>
                    <Text style={styles.rowAmount}>{day.total.toLocaleString()}원</Text>
                  </Pressable>
                ))}
                <View style={styles.bottomSpacer} />
              </ScrollView>
            )}

            {drill.level === 1 && drill.mode === 'entries' && !loading && !error && (
              <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
                <EntryList entries={rootEntries} labelFor={labelFor} />
                <View style={styles.bottomSpacer} />
              </ScrollView>
            )}

            {drill.level === 2 && (
              <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
                {drill.loading && <ActivityIndicator style={styles.loading} />}
                {drill.error && <Text style={styles.errorText}>{drill.error}</Text>}
                {!drill.loading && !drill.error && <EntryList entries={drill.entries} labelFor={labelFor} />}
                <View style={styles.bottomSpacer} />
              </ScrollView>
            )}
          </Animated.View>
        </Animated.View>
      </GestureDetector>
    </Modal>
  );
}

function EntryList({
  entries,
  labelFor,
}: {
  entries: LedgerEntry[] | null;
  labelFor: (entry: LedgerEntry) => string;
}) {
  if (!entries || entries.length === 0) {
    return <Text style={styles.emptyText}>내역이 없어요.</Text>;
  }
  return (
    <>
      {entries.map((entry) => (
        <View key={entry.key} style={styles.row}>
          <View style={styles.rowLeft}>
            <Text style={styles.rowLabel}>
              {labelFor(entry)}
              <Text style={styles.rowMeta}>{`  ${hourMinute(entry.ms)}`}</Text>
            </Text>
            {entry.source === 'test' && entry.score100 !== null && (
              <Text style={styles.rowSub}>{entry.score100}점</Text>
            )}
          </View>
          <Text style={styles.rowAmount}>{entry.amount.toLocaleString()}원</Text>
        </View>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '75%',
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 24,
  },
  dragHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#ddd',
    marginBottom: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  backButton: {
    marginRight: 8,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  backButtonText: {
    fontSize: 20,
    color: '#666',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#222',
  },
  // 단 전환 래퍼. flexShrink로 시트의 maxHeight(75%) 안에서 줄어들게 한다 — 안에 있는
  // ScrollView도 같은 이유로 flexShrink다. 예전 `maxHeight:'100%'`는 부모(시트)가
  // maxHeight만 갖고 height가 없어 퍼센트가 확실히 풀리지 않는 자리였다.
  step: {
    flexShrink: 1,
  },
  scroll: {
    flexShrink: 1,
  },
  loading: {
    marginVertical: 24,
  },
  errorText: {
    fontSize: 14,
    color: '#c0392b',
    textAlign: 'center',
    paddingVertical: 24,
  },
  emptyText: {
    fontSize: 13,
    color: '#999',
    textAlign: 'center',
    paddingVertical: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  // 날짜 행만 누를 수 있으므로 여기에만 회색 블록을 깐다 — 개별 항목 행은 누를 데가
  // 아니라 평평하게 둔다(둘 다 블록이면 어느 쪽이 눌리는지 알 수 없다).
  dayRow: {
    backgroundColor: '#f4f4f5',
    borderRadius: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderBottomWidth: 0,
  },
  dayRowPressed: {
    backgroundColor: '#e8e8ea',
  },
  rowMeta: {
    fontSize: 12,
    fontWeight: '400',
    color: '#aaa',
  },
  rowLeft: {
    flex: 1,
  },
  rowLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#222',
  },
  rowSub: {
    marginTop: 2,
    fontSize: 12,
    color: '#999',
  },
  rowAmount: {
    fontSize: 15,
    fontWeight: '700',
    color: '#b45309',
  },
  bottomSpacer: {
    height: 12,
  },
});
