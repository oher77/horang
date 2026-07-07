import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ViewToken } from 'react-native';

import DayWordRow, { ROW_HEIGHT } from '../../components/DayWordRow';
import WordDetailSheet from '../../components/WordDetailSheet';
import { getDayWords, type DayWordRow as DayWordRowData } from '../../lib/queries';
import { useSettingsStore } from '../../lib/settings';
import { adjustRecallStage } from '../../lib/study';
import { getWordDetail, type WordDetail } from '../../lib/wordDetail';

// stagger: 컬럼 일괄 가림 시 "현재 화면에 보이는 행"에만 index*STAGGER_MS 지연 적용
// (설계.md §4.5). 화면 밖 행은 FlatList가 언마운트하므로 자연히 대상에서 빠진다.
const STAGGER_MS = 15;
const PEEK_DURATION_MS = 1400;

type ColumnKey = 'word' | 'meaning';

export default function DayScreen() {
  const { dayId } = useLocalSearchParams<{ dayId: string }>();
  const [words, setWords] = useState<DayWordRowData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { level } = useSettingsStore();

  // 예문 바텀시트 상태 (사용자 확정 UX: 가려지지 않은 행 탭 → 상세 시트)
  const [sheetVisible, setSheetVisible] = useState(false);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sheetDetail, setSheetDetail] = useState<WordDetail | null>(null);

  // 컬럼 전체 가림 토글 (헤더 눈아이콘). 화면 로컬 UI 상태 — DB 미저장(설계.md §4.5).
  const [columnHidden, setColumnHidden] = useState<Record<ColumnKey, boolean>>({
    word: false,
    meaning: false,
  });

  // 개별 셀 "잠깐 보이기" — dayWordId별로 컬럼 peek 타이머 관리
  const [peekMap, setPeekMap] = useState<Record<number, Partial<Record<ColumnKey, boolean>>>>({});
  const peekTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // 현재 화면에 보이는 행의 인덱스 집합 → stagger 지연 계산 기준(설계.md §4.5)
  const [visibleIndexes, setVisibleIndexes] = useState<number[]>([]);
  const minVisibleIndexRef = useRef(0);

  useEffect(() => {
    const id = Number(dayId);
    if (!Number.isFinite(id)) {
      setError('잘못된 단어장 id입니다.');
      return;
    }
    getDayWords(id)
      .then(setWords)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [dayId]);

  useEffect(() => {
    return () => {
      // 화면 이탈 시 pending peek 타이머 정리
      peekTimers.current.forEach((t) => clearTimeout(t));
      peekTimers.current.clear();
    };
  }, []);

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const indexes = viewableItems
      .map((v) => v.index)
      .filter((i): i is number => i !== null && i !== undefined);
    setVisibleIndexes(indexes);
    if (indexes.length > 0) {
      minVisibleIndexRef.current = Math.min(...indexes);
    }
  }).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 30 }).current;

  const toggleColumn = useCallback((column: ColumnKey) => {
    setColumnHidden((prev) => ({ ...prev, [column]: !prev[column] }));
  }, []);

  const handleTapCell = useCallback((dayWordId: number, column: ColumnKey) => {
    const key = `${dayWordId}:${column}`;
    const existingTimer = peekTimers.current.get(key);
    if (existingTimer) clearTimeout(existingTimer);

    setPeekMap((prev) => ({
      ...prev,
      [dayWordId]: { ...prev[dayWordId], [column]: true },
    }));

    const timer = setTimeout(() => {
      setPeekMap((prev) => {
        const next = { ...prev[dayWordId] };
        delete next[column];
        return { ...prev, [dayWordId]: next };
      });
      peekTimers.current.delete(key);
    }, PEEK_DURATION_MS);
    peekTimers.current.set(key, timer);
  }, []);

  const handleSwipeStage = useCallback((dayWordId: number, delta: number) => {
    // 낙관적 갱신 + user.db 영속 (설계.md §5: recall_stage = MAX(0,MIN(5, ...)))
    setWords((prev) =>
      prev
        ? prev.map((w) =>
            w.id === dayWordId
              ? { ...w, recall_stage: Math.max(0, Math.min(5, w.recall_stage + delta)) }
              : w,
          )
        : prev,
    );
    adjustRecallStage(dayWordId, delta).catch(() => {
      // 실패 시에도 화면 크래시는 막는다. 재조회로 정합성 복구를 원하면 추후 재조회 추가 가능.
    });
  }, []);

  const minVisibleIndex = visibleIndexes.length > 0 ? Math.min(...visibleIndexes) : minVisibleIndexRef.current;

  const handleOpenDetail = useCallback(
    (contentWordId: number) => {
      setSheetVisible(true);
      setSheetLoading(true);
      setSheetError(null);
      setSheetDetail(null);
      getWordDetail(contentWordId, level)
        .then((detail) => setSheetDetail(detail))
        .catch((err: unknown) => setSheetError(err instanceof Error ? err.message : String(err)))
        .finally(() => setSheetLoading(false));
    },
    [level],
  );

  const handleCloseSheet = useCallback(() => {
    setSheetVisible(false);
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: DayWordRowData; index: number }) => {
      const peek = peekMap[item.id];
      const staggerDelay = Math.max(0, index - minVisibleIndex) * STAGGER_MS;
      return (
        <DayWordRow
          item={item}
          index={index}
          isAlt={index % 2 === 1}
          wordHidden={columnHidden.word}
          meaningHidden={columnHidden.meaning}
          peekWord={Boolean(peek?.word)}
          peekMeaning={Boolean(peek?.meaning)}
          columnHideDelayMs={staggerDelay}
          onSwipeStage={handleSwipeStage}
          onTapCell={handleTapCell}
          onOpenDetail={handleOpenDetail}
        />
      );
    },
    [peekMap, columnHidden, minVisibleIndex, handleSwipeStage, handleTapCell, handleOpenDetail],
  );

  const keyExtractor = useCallback((item: DayWordRowData) => String(item.id), []);

  const getItemLayout = useCallback(
    (_: unknown, index: number) => ({
      length: ROW_HEIGHT,
      offset: ROW_HEIGHT * index,
      index,
    }),
    [],
  );

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: '오늘의 단어장' }} />

      {error && <Text style={styles.error}>{error}</Text>}

      {!error && !words && <ActivityIndicator style={styles.loading} />}

      {!error && words && (
        <>
          <View style={[styles.row, styles.headerRow]}>
            <View style={styles.stageCell} />
            <Text style={styles.numberCell}>#</Text>
            <HeaderEyeCell
              label="영단어"
              hidden={columnHidden.word}
              onToggle={() => toggleColumn('word')}
              style={styles.wordCell}
            />
            <View style={styles.speakerButton} />
            <HeaderEyeCell
              label="뜻"
              hidden={columnHidden.meaning}
              onToggle={() => toggleColumn('meaning')}
              style={styles.meaningCell}
            />
          </View>

          {/*
            §4.5 100+행 테이블 가상화 전략: RN 내장 FlatList (FlashList는 Expo Go
            미포함이라 금지). initialNumToRender/windowSize로 보이는 15~20행만 렌더.
            onViewableItemsChanged로 가시 행 인덱스를 추적해 stagger 지연 계산에 쓴다.
          */}
          <FlatList
            data={words}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            getItemLayout={getItemLayout}
            initialNumToRender={18}
            windowSize={5}
            maxToRenderPerBatch={8}
            removeClippedSubviews
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
          />
        </>
      )}

      <WordDetailSheet
        visible={sheetVisible}
        loading={sheetLoading}
        error={sheetError}
        detail={sheetDetail}
        onClose={handleCloseSheet}
      />
    </View>
  );
}

function HeaderEyeCell({
  label,
  hidden,
  onToggle,
  style,
}: {
  label: string;
  hidden: boolean;
  onToggle: () => void;
  style: object;
}) {
  return (
    <Pressable style={[styles.headerEyeCell, style]} onPress={onToggle} hitSlop={8}>
      <Text style={styles.headerText}>{label}</Text>
      <Text style={styles.eyeIcon}>{hidden ? '🙈' : '👁️'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  loading: {
    marginTop: 40,
  },
  error: {
    margin: 24,
    color: '#c0392b',
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 44,
    paddingHorizontal: 12,
  },
  headerRow: {
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
    backgroundColor: '#f5f5f5',
  },
  headerText: {
    fontWeight: '700',
    color: '#444',
    fontSize: 14,
  },
  headerEyeCell: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  eyeIcon: {
    fontSize: 14,
  },
  stageCell: {
    width: 28,
  },
  numberCell: {
    width: 28,
    fontSize: 13,
    color: '#999',
  },
  wordCell: {
    width: 100,
  },
  speakerButton: {
    width: 32,
  },
  meaningCell: {
    flex: 1,
    marginLeft: 4,
  },
});
