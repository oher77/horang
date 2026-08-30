/**
 * 설정 화면 — 난이도(고1/고2/고3) 선택 (설계.md §4.4 Q-SETTINGS).
 *
 * 설계.md §4.2 화면 트리는 Drawer 하위 `settings.tsx`를 가정하지만, 현재 앱은
 * Drawer 미도입 상태로 app/day, app/review, app/test가 전부 평평한 스택 라우트다.
 * 그 컨벤션을 따라 `app/settings/index.tsx`로 둔다.
 *
 * 난이도는 user.db.settings.level에 영속(§1.3 DDL에 이미 정의된 컬럼 — 별도
 * app_meta 키 불필요). lib/settings.ts의 모듈 싱글턴 스토어로 전역 반영.
 */

import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from 'react-native';

import { epochDayToDateString } from '../../lib/dates';
import { clearLedgerFixture, seedLedgerFixture } from '../../lib/devSeed';
import {
  deleteTodaySlotRecords,
  getHabitBonusAmounts,
  updateHabitBonusAmount,
} from '../../lib/habitQueries';
import {
  getIncomeRules,
  updateIncomeRuleAmount,
  type IncomeRule,
} from '../../lib/incomeQueries';
import {
  isNotificationsEnabled,
  rescheduleSlotNotifications,
  resetNotifyOptInAsk,
  scheduleTestNotification,
  setNotificationsEnabled,
} from '../../lib/notifications';
import { deleteTodayTestSession } from '../../lib/reviewQueries';
import {
  setDifficultyLevel,
  setSlots,
  setWordsPerDay,
  useSettingsStore,
  type DifficultyLevel,
  type SlotWindow,
} from '../../lib/settings';
import {
  clearTodayTestGateState,
  DEFAULT_ALARM_HOUR,
  getTestAlarmConfig,
  resetTestAlarmConfig,
  setTestAlarm,
  type TestAlarmConfig,
} from '../../lib/testSchedule';

const LEVEL_OPTIONS: { level: DifficultyLevel; label: string; hint: string }[] = [
  { level: 1, label: '고1', hint: '짧고 평이한 예문' },
  { level: 2, label: '고2', hint: '중간 난이도 예문' },
  { level: 3, label: '고3', hint: '복문·추상적 예문' },
];

export default function SettingsScreen() {
  // 개발자 도구의 "테스트 예약 설정 초기화"가 app_meta를 직접 지우므로, 이미 마운트된
  // TestAlarmSection의 로컬 state(스위치·시각)가 옛 값 그대로 남는다. key를 바꿔 통째로
  // 다시 마운트시켜 화면과 DB를 일치시킨다. __DEV__ 전용 경로라 배포 빌드에선 안 쓰인다.
  const [alarmSectionKey, setAlarmSectionKey] = useState(0);
  const { level, loaded } = useSettingsStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 홈의 알림 옵트인 덮개가 { pathname: '/settings', params: { focus: 'notifications' } }로
  // 딥링크한다 — 파라미터 이름/값은 고정 계약. 도착 시 알림 섹션까지 스크롤 + 하이라이트.
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const scrollRef = useRef<ScrollView>(null);
  const [notifySectionY, setNotifySectionY] = useState<number | null>(null);
  const [notifyHighlight, setNotifyHighlight] = useState(false);
  const didScrollToNotifyRef = useRef(false);

  useEffect(() => {
    if (focus !== 'notifications') return;
    if (notifySectionY === null) return;
    if (didScrollToNotifyRef.current) return;
    didScrollToNotifyRef.current = true;

    // contentContainer padding(20)만큼 섹션이 이미 안쪽으로 밀려 그려지지만, onLayout의
    // y는 형제 View들 간 상대좌표(같은 padded 컨테이너 기준)라 padding을 다시 더하지
    // 않는다 — styles.contentContainer의 padding: 20 확인 완료.
    scrollRef.current?.scrollTo({ y: Math.max(0, notifySectionY - 16), animated: true });
    setNotifyHighlight(true);
  }, [focus, notifySectionY]);

  useEffect(() => {
    if (!notifyHighlight) return;
    const timer = setTimeout(() => setNotifyHighlight(false), 2500);
    return () => clearTimeout(timer);
  }, [notifyHighlight]);

  const handleSelect = useCallback(async (next: DifficultyLevel) => {
    if (next === level) return;
    setSaving(true);
    setError(null);
    try {
      await setDifficultyLevel(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [level]);

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
    >
      <Stack.Screen options={{ title: '설정' }} />

      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <View>
          <Text style={styles.sectionTitle}>난이도</Text>
          <Text style={styles.sectionDesc}>단어장 예문의 난이도를 선택하세요. 뜻은 난이도와 무관하게 항상 전부 표시됩니다.</Text>

          <View style={styles.options}>
            {LEVEL_OPTIONS.map((opt) => {
              const selected = loaded && level === opt.level;
              return (
                <Pressable
                  key={opt.level}
                  style={[styles.optionCard, selected && styles.optionCardSelected]}
                  onPress={() => handleSelect(opt.level)}
                  disabled={saving}
                  hitSlop={8}
                >
                  <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>{opt.label}</Text>
                  <Text style={styles.optionHint}>{opt.hint}</Text>
                  {selected && <Text style={styles.selectedMark}>선택됨</Text>}
                </Pressable>
              );
            })}
          </View>

          {error && <Text style={styles.error}>{error}</Text>}

          <WordsPerDaySection />

          <SlotConfigSection />

          <TestAlarmSection key={alarmSectionKey} />

          <NotificationSection onLayoutY={setNotifySectionY} highlight={notifyHighlight} />

          <IncomeRulesSection />

          <HabitBonusSection />

          {__DEV__ && (
            <DevToolsSection onTestAlarmReset={() => setAlarmSectionKey((k) => k + 1)} />
          )}
        </View>
      </TouchableWithoutFeedback>
    </ScrollView>
  );
}

/**
 * 개발용 도구 섹션 (2026-07-20) — __DEV__(Expo Go/개발 빌드)에서만 렌더되고
 * TestFlight/배포 빌드에는 나타나지 않는다. QA 도구 모음:
 * - 오늘 테스트 기록 삭제: "하루 1회" 게이트에 막혀 테스트 화면을 재확인할 수 없는 문제 해소
 * - 오늘 슬롯 기록 삭제: "슬롯당 1회" 제약이 DB UNIQUE라 화면 조작으로 우회가 안 되고,
 *   한 번 채우면 다음 시간대까지(최대 5시간) 전구 점등·배너·동전·연쇄 버튼을 다시 볼 수
 *   없다 (2026-08-25 추가)
 * - 알림 테스트: 전구 미션 알림 섹션에 있다가 QA 전용이라 이쪽으로 이동 (2026-07-20)
 */
function DevToolsSection({ onTestAlarmReset }: { onTestAlarmReset: () => void }) {
  const [busy, setBusy] = useState(false);

  const handleTestNotification = useCallback(async () => {
    setBusy(true);
    try {
      const ok = await scheduleTestNotification();
      if (ok) {
        Alert.alert('테스트 알림 예약됨', '5초 후 알림이 옵니다. 홈 화면으로 나가서 확인해보세요.');
      } else {
        Alert.alert('알림 권한이 필요해요', '설정 앱에서 알림을 허용해주세요.');
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const handleDeleteTodayTest = useCallback(() => {
    Alert.alert(
      '오늘 테스트 기록 삭제',
      '오늘 응시한 테스트 세션과 용돈 반영이 삭제되고, 테스트를 다시 볼 수 있게 됩니다.',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '삭제',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              const deleted = await deleteTodayTestSession();
              Alert.alert(
                deleted > 0 ? '삭제되었습니다' : '오늘 세션이 없습니다',
                deleted > 0
                  ? '테스트 화면에 다시 들어가면 새로 응시할 수 있습니다.'
                  : '오늘 응시한 테스트가 없어 삭제할 것이 없습니다.',
              );
            } catch (err) {
              Alert.alert('삭제 실패', err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }, []);

  const handleDeleteTodaySlots = useCallback(() => {
    Alert.alert(
      '오늘 슬롯 기록 삭제',
      '오늘의 조각·슬롯 완성·습관 보너스가 모두 삭제되어 전구가 처음 상태로 돌아갑니다.\n\n' +
        '오늘분 스트릭도 함께 빠집니다(어제까지는 그대로). 이미 지급 체크한 보너스도 사라집니다.',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '삭제',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              const { parts, sessions, bonuses } = await deleteTodaySlotRecords();
              const total = parts + sessions + bonuses;
              Alert.alert(
                total > 0 ? '삭제되었습니다' : '오늘 기록이 없습니다',
                total > 0
                  ? `조각 ${parts} / 슬롯 완성 ${sessions} / 보너스 ${bonuses}건을 지웠습니다.\n홈으로 나가면 전구가 꺼져 있습니다.`
                  : '오늘 기록된 슬롯 활동이 없어 지울 것이 없습니다.',
              );
            } catch (err) {
              Alert.alert('삭제 실패', err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }, []);

  const handleResetNotifyOptInAsk = useCallback(() => {
    Alert.alert(
      '알림 물어보기 기록 삭제',
      '"알림 켤까?" 화면을 다시 볼 수 있게 물어본 기록을 지웁니다. 알림 켬/끔 설정 자체는 그대로입니다.\n\n' +
        '노출 조건: 오늘 앞 시간대를 전부 놓치고 마지막 시간대에 와서야 단어장을 처음 훑은 날, 홈으로 돌아왔을 때 뜹니다 — 이 기록을 지워야 그 조건을 다시 재현해 QA할 수 있습니다.',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '삭제',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await resetNotifyOptInAsk();
              Alert.alert(
                '삭제되었습니다',
                '오늘 앞 시간대를 전부 놓치고 마지막 시간대에 단어장을 처음 훑은 뒤 홈으로 돌아오면 다시 뜹니다.',
              );
            } catch (err) {
              Alert.alert('삭제 실패', err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }, []);

  const handleResetTestAlarm = useCallback(() => {
    Alert.alert(
      '테스트 예약 설정 초기화',
      '켬/끔·시각 설정이 "한 번도 설정한 적 없는" 상태로 돌아갑니다. 한 번 켜면 끄기·시각 변경이 내일부터라 같은 날 되돌릴 수 없는데, 그 우회로입니다(개발 빌드 전용).',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '초기화',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await resetTestAlarmConfig();
              onTestAlarmReset();
              Alert.alert(
                '초기화되었습니다',
                // 기본값이 켜짐으로 바뀐 뒤(lib/testSchedule.ts getTestAlarmConfig)
                // 초기화 결과는 "꺼짐"이 아니라 "켜짐 + 기본 시각"이다.
                `기본 상태(켜짐 · ${DEFAULT_ALARM_HOUR}시)로 돌아갔습니다.`,
              );
            } catch (err) {
              Alert.alert('초기화 실패', err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }, [onTestAlarmReset]);

  const handleSeedLedgerFixture = useCallback(() => {
    Alert.alert(
      '장부 테스트 데이터 심기 (3주)',
      '완료된 직전 3주에 결정적 테스트 데이터를 심습니다. 기존에 심어둔 것이 있으면 먼저 지우고 다시 심습니다(실제 학습 기록은 건드리지 않습니다).',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '심기',
          onPress: async () => {
            setBusy(true);
            try {
              const result = await seedLedgerFixture();
              const rangeText = `${epochDayToDateString(result.startDay)} ~ ${epochDayToDateString(result.endDay)}`;
              const lines = [
                `기간: ${rangeText}`,
                `완주일: ${result.fullDays}일`,
                `슬롯 완성: ${result.slots}건`,
                `습관 보너스: ${result.bonuses}건`,
                result.skippedTests
                  ? '테스트 기록: day 행이 없어 건너뜀'
                  : `테스트 기록: ${result.testSessions}건`,
              ];
              Alert.alert('심었습니다', lines.join('\n'));
            } catch (err) {
              Alert.alert('심기 실패', err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }, []);

  const handleClearLedgerFixture = useCallback(() => {
    Alert.alert(
      '장부 테스트 데이터 지우기',
      '완료된 직전 3주 범위의 테스트 세션·습관 보너스·슬롯 완성 기록을 지웁니다.',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '지우기',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              const deleted = await clearLedgerFixture();
              Alert.alert(
                deleted > 0 ? '지웠습니다' : '지울 것이 없습니다',
                deleted > 0 ? `총 ${deleted}행을 지웠습니다.` : '해당 범위에 기록이 없습니다.',
              );
            } catch (err) {
              Alert.alert('지우기 실패', err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }, []);

  const handleClearTestGateState = useCallback(() => {
    Alert.alert(
      '오늘 미루기·넘어가기 기록 삭제',
      '오늘 사용한 미루기 횟수와 오늘 넘어가기 기록이 삭제됩니다. 예약 설정(켬/끔·시각)은 그대로입니다.',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '삭제',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await clearTodayTestGateState();
              Alert.alert('삭제되었습니다', '미루기를 다시 쓸 수 있고, 오늘 넘어가기도 초기화됐습니다.');
            } catch (err) {
              Alert.alert('삭제 실패', err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }, []);

  return (
    <View style={styles.incomeSection}>
      <Text style={styles.sectionTitle}>개발용 도구</Text>
      <Text style={styles.sectionDesc}>
        QA 전용 — Expo Go/개발 빌드에서만 보이고 배포 앱에는 나타나지 않습니다.
      </Text>

      <Pressable
        style={[styles.testButton, busy && styles.testButtonDisabled]}
        onPress={handleDeleteTodaySlots}
        disabled={busy}
      >
        <Text style={styles.testButtonText}>오늘 슬롯 기록 삭제</Text>
      </Pressable>

      <Pressable
        style={[styles.testButton, busy && styles.testButtonDisabled]}
        onPress={handleDeleteTodayTest}
        disabled={busy}
      >
        <Text style={styles.testButtonText}>오늘 테스트 기록 삭제</Text>
      </Pressable>

      <Pressable
        style={[styles.testButton, busy && styles.testButtonDisabled]}
        onPress={handleClearTestGateState}
        disabled={busy}
      >
        <Text style={styles.testButtonText}>오늘 미루기·넘어가기 기록 삭제</Text>
      </Pressable>

      <Pressable
        style={[styles.testButton, busy && styles.testButtonDisabled]}
        onPress={handleResetNotifyOptInAsk}
        disabled={busy}
      >
        <Text style={styles.testButtonText}>알림 물어보기 기록 삭제</Text>
      </Pressable>

      <Pressable
        style={[styles.testButton, busy && styles.testButtonDisabled]}
        onPress={handleResetTestAlarm}
        disabled={busy}
      >
        <Text style={styles.testButtonText}>테스트 예약 설정 초기화</Text>
      </Pressable>

      <Pressable
        style={[styles.testButton, busy && styles.testButtonDisabled]}
        onPress={handleTestNotification}
        disabled={busy}
      >
        <Text style={styles.testButtonText}>알림 테스트 (5초 후)</Text>
      </Pressable>

      <Pressable
        style={[styles.testButton, busy && styles.testButtonDisabled]}
        onPress={handleSeedLedgerFixture}
        disabled={busy}
      >
        <Text style={styles.testButtonText}>장부 테스트 데이터 심기 (3주)</Text>
      </Pressable>

      <Pressable
        style={[styles.testButton, busy && styles.testButtonDisabled]}
        onPress={handleClearLedgerFixture}
        disabled={busy}
      >
        <Text style={styles.testButtonText}>장부 테스트 데이터 지우기</Text>
      </Pressable>
    </View>
  );
}

/**
 * 하루 단어 수(settings.words_per_day) 편집 섹션.
 * IncomeRulesSection과 동일한 TextInput(number-pad)+onBlur 즉시저장 패턴이나,
 * 값 자체가 이미 settingsStore(useSettingsStore)에 있으므로 화면 로컬로 다시
 * fetch하지 않고 스토어를 직접 구독한다(income_rule은 스토어에 없는 값이라 로컬 fetch).
 */
function WordsPerDaySection() {
  const { wordsPerDay, loaded } = useSettingsStore();
  const [draft, setDraft] = useState('');
  const [draftInitialized, setDraftInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [rowError, setRowError] = useState('');

  // 스토어 로드가 끝나면 draft 초기값을 1회 채운다(이후 사용자 입력을 덮어쓰지 않음).
  useEffect(() => {
    if (loaded && !draftInitialized) {
      setDraft(String(wordsPerDay));
      setDraftInitialized(true);
    }
  }, [loaded, draftInitialized, wordsPerDay]);

  const handleChangeText = useCallback((text: string) => {
    // 숫자만 허용(음수/소수점 입력 자체를 막아 즉시 피드백)
    const digitsOnly = text.replace(/[^0-9]/g, '');
    setDraft(digitsOnly);
    setSaved(false);
  }, []);

  const handleBlur = useCallback(async () => {
    setRowError('');

    if (draft === '') {
      // 빈 입력은 저장하지 않고 이전 값으로 되돌린다.
      setDraft(String(wordsPerDay));
      return;
    }

    const next = Number(draft);
    if (!Number.isInteger(next) || next < 1 || next > 200) {
      setRowError('1~200 사이의 숫자만 입력하세요.');
      setDraft(String(wordsPerDay));
      return;
    }

    if (next === wordsPerDay) return; // 변경 없음

    setSaving(true);
    try {
      await setWordsPerDay(next);
      setSaved(true);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : String(err));
      setDraft(String(wordsPerDay));
    } finally {
      setSaving(false);
    }
  }, [draft, wordsPerDay]);

  return (
    <View style={styles.incomeSection}>
      <Text style={styles.sectionTitle}>하루 단어 수</Text>
      <Text style={styles.sectionDesc}>
        하루에 새로 배울 단어 개수를 설정하세요.{'\n'}
        이미 공부를 시작한 단어장은 바뀌지 않습니다.
      </Text>

      <View style={styles.incomeRow}>
        <Text style={styles.incomeRowLabel}>하루 단어 수</Text>
        <View style={styles.incomeInputWrap}>
          <TextInput
            style={styles.incomeInput}
            keyboardType="number-pad"
            value={draft}
            onChangeText={handleChangeText}
            onBlur={handleBlur}
            editable={!saving}
            maxLength={3}
          />
          <Text style={styles.incomeWon}>개</Text>
        </View>
      </View>

      {rowError ? <Text style={styles.error}>{rowError}</Text> : null}
      {saved && <Text style={styles.savedText}>저장되었습니다.</Text>}
    </View>
  );
}

/**
 * 인출 시간대 4구간(slot_config) 편집 섹션 (설계.md §7.3).
 *
 * TextInput 대신 스테퍼(+/- 버튼)로 시(hour)를 조정한다 — 이 화면은 키보드가
 * 입력을 가리는 문제를 이미 한 번 고친 이력이 있어(git log), 애초에 키보드를
 * 띄우지 않는 UI를 택한다. 검증 규칙(start<end, 겹침 금지, 0~24)은
 * lib/habitQueries.ts의 updateSlotConfig가 이미 수행하므로 여기서 중복
 * 구현하지 않는다 — 스테퍼는 0~24 범위 밖으로만 못 나가게 clamp한다.
 *
 * 슬롯당 한 행씩 두 스테퍼(시작/종료)를 보여주고, 각 스테퍼 변경 시 즉시
 * settingsStore.setSlots()로 저장을 시도한다(다른 항목과 동일한 낙관적
 * 갱신 + 실패 롤백 패턴 — 스토어 쪽에서 처리).
 */
function SlotConfigSection() {
  const { slots, loaded } = useSettingsStore();
  const [saving, setSaving] = useState(false);
  const [sectionError, setSectionError] = useState('');

  const handleChangeHour = useCallback(
    async (slotIndex: number, field: 'startHour' | 'endHour', delta: number) => {
      const current = slots.find((s) => s.slotIndex === slotIndex);
      if (!current) return;

      const nextValue = clampHour(current[field] + delta);
      if (nextValue === current[field]) return; // 범위 끝에서는 변화 없음

      const nextSlots: SlotWindow[] = slots.map((s) =>
        s.slotIndex === slotIndex ? { ...s, [field]: nextValue } : s,
      );

      setSectionError('');
      setSaving(true);
      try {
        await setSlots(nextSlots);
        // 슬롯 시간이 바뀌면 예약된 알림도 새 시각 기준으로 다시 계산해야 한다.
        await rescheduleSlotNotifications();
      } catch (err) {
        setSectionError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [slots],
  );

  return (
    <View style={styles.incomeSection}>
      <Text style={styles.sectionTitle}>인출 시간대 4구간</Text>
      <Text style={styles.sectionDesc}>
        하루를 4개 시간대로 나눠 그 안에서 한 번씩 단어장을 훑으면 게이지가 채워집니다.{'\n'}
        각 구간은 시작보다 종료가 늦어야 하고, 서로 겹칠 수 없습니다.
      </Text>

      {!loaded && <Text style={styles.optionHint}>불러오는 중…</Text>}

      <View style={styles.incomeRows}>
        {slots.map((slot) => (
          <View key={slot.slotIndex} style={styles.slotRow}>
            <Text style={styles.incomeRowLabel}>{`구간 ${slot.slotIndex + 1}`}</Text>
            <View style={styles.slotSteppers}>
              <HourStepper
                value={slot.startHour}
                disabled={saving}
                onDecrement={() => handleChangeHour(slot.slotIndex, 'startHour', -1)}
                onIncrement={() => handleChangeHour(slot.slotIndex, 'startHour', 1)}
              />
              <Text style={styles.slotTilde}>~</Text>
              <HourStepper
                value={slot.endHour}
                disabled={saving}
                onDecrement={() => handleChangeHour(slot.slotIndex, 'endHour', -1)}
                onIncrement={() => handleChangeHour(slot.slotIndex, 'endHour', 1)}
              />
            </View>
          </View>
        ))}
      </View>

      {sectionError ? <Text style={styles.error}>{sectionError}</Text> : null}
    </View>
  );
}

function clampHour(hour: number): number {
  return Math.min(24, Math.max(0, hour));
}

/**
 * hour 값을 -/+ 버튼으로 조정하는 스테퍼. 키보드를 띄우지 않는다.
 * min/max는 optional — 생략 시 기존 호출부(슬롯 시간대, 0~24)와 동일하게 동작한다.
 * (2026-08-25: 테스트 타임 설정 섹션이 0~23 범위로 쓰기 위해 추가 — 상한에서 버튼을
 * 비활성화해야 "눌리는데 반응 없는" 고장 난 버튼처럼 보이지 않는다.)
 */
function HourStepper({
  value,
  disabled,
  onDecrement,
  onIncrement,
  min = 0,
  max = 24,
}: {
  value: number;
  disabled: boolean;
  onDecrement: () => void;
  onIncrement: () => void;
  min?: number;
  max?: number;
}) {
  return (
    <View style={styles.stepper}>
      <Pressable
        style={styles.stepperButton}
        onPress={onDecrement}
        disabled={disabled || value <= min}
        hitSlop={8}
      >
        <Text style={styles.stepperButtonText}>-</Text>
      </Pressable>
      <Text style={styles.stepperValue}>{String(value).padStart(2, '0')}시</Text>
      <Pressable
        style={styles.stepperButton}
        onPress={onIncrement}
        disabled={disabled || value >= max}
        hitSlop={8}
      >
        <Text style={styles.stepperButtonText}>+</Text>
      </Pressable>
    </View>
  );
}

/**
 * 테스트 타임 설정 섹션 (2026-08-25, 딸 피드백 기반).
 *
 * 배경: "버튼을 누르는 결정"이 무서운 것이지 테스트 자체가 무서운 게 아니므로,
 * 정한 시각이 되면 홈에 덮개가 떠서 그 결정을 없앤다.
 *
 * 켜기는 즉시, 끄기·시각 변경은 내일부터 적용된다(lib/testSchedule.ts의
 * setTestAlarm 참고 — 불안한 순간에 설정으로 도망가는 길을 막는 장치). 화면에
 * pending이 있으면 스위치/스테퍼는 "방금 고른 값"(pending 기준)을 보여주고,
 * 그 아래 안내 문구로 "오늘은 아직 이전 값"임을 설명한다.
 */
function TestAlarmSection() {
  const [config, setConfig] = useState<TestAlarmConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sectionError, setSectionError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getTestAlarmConfig()
      .then((cfg) => {
        if (cancelled) return;
        setConfig(cfg);
        setLoaded(true);
      })
      .catch((err) => {
        if (!cancelled) {
          setSectionError(err instanceof Error ? err.message : String(err));
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 화면에 보여줄 값: pending이 있으면 pending 기준(방금 고른 값), 없으면 확정값.
  const displayEnabled = config ? (config.pending ? config.pending.enabled : config.enabled) : false;
  const displayHour = config ? (config.pending ? config.pending.hour : config.hour) : DEFAULT_ALARM_HOUR;

  const applyChange = useCallback(async (next: { enabled: boolean; hour: number }) => {
    setSectionError('');
    setBusy(true);
    try {
      const result = await setTestAlarm(next);
      setConfig(result);
    } catch (err) {
      setSectionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleToggle = useCallback(
    (next: boolean) => {
      applyChange({ enabled: next, hour: displayHour });
    },
    [applyChange, displayHour],
  );

  const handleChangeHour = useCallback(
    (delta: number) => {
      const nextHour = Math.min(23, Math.max(0, displayHour + delta));
      if (nextHour === displayHour) return;
      applyChange({ enabled: displayEnabled, hour: nextHour });
    },
    [applyChange, displayEnabled, displayHour],
  );

  const pending = config?.pending ?? null;

  return (
    <View style={styles.incomeSection}>
      <Text style={styles.sectionTitle}>테스트 타임 설정</Text>
      <Text style={styles.sectionDesc}>
        정한 시각이 되면 홈 화면에 떠요. 바로 하기 어려우면 30분 한 번 미룰 수 있어요.{'\n'}
        <Text style={styles.sectionDescSub}>
          켜는 건 바로, 끄거나 시각을 바꾸는 건 내일부터 적용돼요. 알림을 받으려면 아래 ‘전구 미션 알림’도 켜세요.
        </Text>
      </Text>

      {!loaded && <Text style={styles.optionHint}>불러오는 중…</Text>}

      <View style={styles.incomeRow}>
        <Text style={styles.incomeRowLabel}>정해진 시각에 테스트하기</Text>
        <Switch value={displayEnabled} onValueChange={handleToggle} disabled={!loaded || busy} />
      </View>

      <View style={[styles.slotRow, { marginTop: 10 }, !displayEnabled && styles.rowDimmed]}>
        <Text style={styles.incomeRowLabel}>테스트 시각</Text>
        <HourStepper
          value={displayHour}
          disabled={!loaded || busy || !displayEnabled}
          onDecrement={() => handleChangeHour(-1)}
          onIncrement={() => handleChangeHour(1)}
          max={23}
        />
      </View>

      {pending && (
        <Text style={styles.pendingNotice}>
          {pending.enabled
            ? `내일부터 ${String(pending.hour).padStart(2, '0')}시로 바뀌어요. 오늘은 지금 설정 그대로예요.`
            : '내일부터 꺼져요. 오늘은 지금 설정 그대로예요.'}
        </Text>
      )}

      {sectionError ? <Text style={styles.error}>{sectionError}</Text> : null}
    </View>
  );
}

/**
 * 시간대 미션 알림 섹션 (설계.md §7.6, 2026-07-09 구현).
 * 스위치로 켬/끔(app_meta.notifications_enabled 영속) + 테스트 알림 버튼.
 * 권한 거부 시 iOS 설정 앱의 앱 페이지로 데려가고(2026-08-26), 돌아와서 권한이
 * 실제로 생기면 스위치를 자동으로 켠다.
 *
 * onLayoutY/highlight: 홈의 알림 옵트인 덮개가 이 섹션으로 딥링크할 때
 * 부모(SettingsScreen)가 스크롤·하이라이트하기 위해 쓰는 optional 훅.
 */
function NotificationSection({
  onLayoutY,
  highlight,
}: {
  onLayoutY?: (y: number) => void;
  highlight?: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  // 권한을 요청했다가 거부된 상태에서 사용자가 설정 앱에 다녀왔는지를 기억하는
  // "의사(wanted)" 플래그. 여기 담는 건 앱 스위치 값이 아니라 의도뿐이다 —
  // 권한이 없는데 스위치만 미리 켜두면 "켰는데 알림이 안 오는" 거짓말하는
  // 스위치가 되므로, 실제 저장(setNotificationsEnabled)은 권한이 실제로
  // 생겼을 때만 한다. 메모리 전용이라 앱 재시작 시 소실되는 건 의도된 동작.
  const wantedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    isNotificationsEnabled()
      .then((value) => {
        if (!cancelled) {
          setEnabled(value);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 설정 앱에서 알림을 허용하고 앱으로 돌아왔을 때, 의사(wantedRef)가 남아있으면
  // 저장을 한 번 더 시도한다. 권한이 여전히 없으면 팝업 없이 즉시 false가
  // 돌아오므로(iOS 팝업은 생애 1회) 사용자에게 아무 방해가 없고, 다음 복귀에
  // 또 시도된다.
  useEffect(() => {
    let cancelled = false;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (!wantedRef.current) return;
      setNotificationsEnabled(true)
        .then((result) => {
          if (cancelled) return;
          if (result) {
            setEnabled(true);
            wantedRef.current = false;
          }
        })
        .catch(() => {
          // 실패해도 wantedRef를 유지 — 다음 복귀에 다시 시도.
        });
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  const handleToggle = useCallback(async (next: boolean) => {
    if (!next) {
      wantedRef.current = false;
    }
    setEnabled(next); // 즉시 반영(낙관적 갱신)
    setBusy(true);
    try {
      const result = await setNotificationsEnabled(next);
      setEnabled(result);
      if (next && !result) {
        wantedRef.current = true;
        Alert.alert(
          '알림 권한이 필요해요',
          'iOS 설정에서 호랑잉글리시 알림을 허용해야 알림을 보낼 수 있어요. 허용하고 돌아오면 자동으로 켜져요.',
          [
            { text: '나중에', style: 'cancel' },
            { text: '설정 열기', onPress: () => { Linking.openSettings().catch(() => {}); } },
          ],
        );
      }
    } catch {
      setEnabled(!next); // 실패 시 원위치
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <View
      style={[styles.incomeSection, highlight && styles.sectionHighlight]}
      onLayout={onLayoutY ? (e) => onLayoutY(e.nativeEvent.layout.y) : undefined}
    >
      <Text style={styles.sectionTitle}>전구 미션 알림</Text>
      <Text style={styles.sectionDesc}>
        각 시간대가 시작될 때, 그리고 테스트 타임이 되면 알림으로 알려드려요. 이미 완료한 시간대는 알림이 오지 않습니다.
      </Text>

      <View style={styles.incomeRow}>
        <Text style={styles.incomeRowLabel}>알림 받기</Text>
        <Switch value={enabled} onValueChange={handleToggle} disabled={!loaded || busy} />
      </View>
    </View>
  );
}

/**
 * 테스트 점수별 용돈(income_rule.amount) 편집 섹션.
 * 구간(min_score)은 고정 — 화면에는 표시만 하고 편집 불가. 금액만 TextInput으로
 * 수정해 blur 시 즉시 user.db에 저장한다(다른 설정 항목과 동일한 즉시반영 패턴).
 */
function IncomeRulesSection() {
  const [rules, setRules] = useState<IncomeRule[]>([]);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [savedId, setSavedId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<Record<number, string>>({});

  useEffect(() => {
    let cancelled = false;
    getIncomeRules()
      .then((rows) => {
        if (cancelled) return;
        setRules(rows);
        setDrafts(Object.fromEntries(rows.map((r) => [r.id, String(r.amount)])));
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChangeText = useCallback((ruleId: number, text: string) => {
    // 숫자만 허용(음수/소수점 입력 자체를 막아 즉시 피드백)
    const digitsOnly = text.replace(/[^0-9]/g, '');
    setDrafts((prev) => ({ ...prev, [ruleId]: digitsOnly }));
    setSavedId(null);
  }, []);

  const handleBlur = useCallback(async (rule: IncomeRule) => {
    const draft = drafts[rule.id] ?? '';
    setRowError((prev) => ({ ...prev, [rule.id]: '' }));

    if (draft === '') {
      // 빈 입력은 저장하지 않고 이전 값으로 되돌린다.
      setDrafts((prev) => ({ ...prev, [rule.id]: String(rule.amount) }));
      return;
    }

    const amount = Number(draft);
    if (!Number.isInteger(amount) || amount < 0) {
      setRowError((prev) => ({ ...prev, [rule.id]: '0 이상의 숫자만 입력하세요.' }));
      setDrafts((prev) => ({ ...prev, [rule.id]: String(rule.amount) }));
      return;
    }

    if (amount === rule.amount) return; // 변경 없음

    setSavingId(rule.id);
    try {
      await updateIncomeRuleAmount(rule.id, amount);
      setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, amount } : r)));
      setSavedId(rule.id);
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [rule.id]: err instanceof Error ? err.message : String(err),
      }));
      setDrafts((prev) => ({ ...prev, [rule.id]: String(rule.amount) }));
    } finally {
      setSavingId(null);
    }
  }, [drafts]);

  return (
    <View style={styles.incomeSection}>
      <Text style={styles.sectionTitle}>테스트 점수별 용돈</Text>
      <Text style={styles.sectionDesc}>
        점수 구간별 지급 금액을 수정할 수 있습니다. 구간 기준은 고정입니다.
        이미 채점된 지난 테스트의 용돈에는 소급 적용되지 않고, 다음 테스트부터 새 금액이 적용됩니다.
      </Text>

      {!loaded && <Text style={styles.optionHint}>불러오는 중…</Text>}

      <View style={styles.incomeRows}>
        {rules.map((rule) => (
          <View key={rule.id} style={styles.incomeRow}>
            <Text style={styles.incomeRowLabel}>{rule.min_score}점 이상</Text>
            <View style={styles.incomeInputWrap}>
              <TextInput
                style={styles.incomeInput}
                keyboardType="number-pad"
                value={drafts[rule.id] ?? ''}
                onChangeText={(text) => handleChangeText(rule.id, text)}
                onBlur={() => handleBlur(rule)}
                editable={savingId !== rule.id}
                maxLength={6}
              />
              <Text style={styles.incomeWon}>원</Text>
            </View>
          </View>
        ))}
      </View>

      {Object.entries(rowError).map(([ruleId, msg]) =>
        msg ? (
          <Text key={ruleId} style={styles.error}>{msg}</Text>
        ) : null,
      )}
      {savedId !== null && <Text style={styles.savedText}>저장되었습니다.</Text>}
    </View>
  );
}

/** 습관 보너스 편집 행 kind 유니온 — lib/habitQueries.ts의 updateHabitBonusAmount 인자와 동일. */
type HabitBonusKind =
  | 'fullDay'
  | 'streak7'
  | 'slotPass'
  | 'reviewDay'
  | 'streak14'
  | 'streak30'
  | 'streak60'
  | 'streak100';

/** 습관 보너스 편집 행 정의(§B-2). 2026-07-11: 슬롯 통과·장기 스트릭 마일스톤 5종 추가.
 * 2026-08-24: 복습 슬롯 편입(§7.6 미결 4)으로 reviewDay 추가 — slotPass 바로 다음
 * (둘 다 소액·고빈도라 나란히 두는 게 읽기 좋다). */
const HABIT_BONUS_ROWS: { kind: HabitBonusKind; label: string }[] = [
  // 2026-08-25: slotPass의 라벨을 "미션 1개 통과" → "오늘 단어장 통과"로. 지급 시점이
  // 슬롯 완성에서 오늘 단어장 조각 기록으로 옮겨졌다(즉시 보상). 필드명은 옛 이름 유지 —
  // app_meta 키(habit_bonus_slot_pass_amount)에 사용자 편집값이 들어 있어 바꾸면 초기화된다.
  { kind: 'slotPass', label: '오늘 단어장 통과' },
  { kind: 'reviewDay', label: '복습 1개 통과' },
  { kind: 'fullDay', label: '하루 4회 완주' },
  { kind: 'streak7', label: '7일 연속' },
  { kind: 'streak14', label: '14일 연속' },
  { kind: 'streak30', label: '30일 연속' },
  { kind: 'streak60', label: '60일 연속' },
  { kind: 'streak100', label: '100일 연속' },
];

const HABIT_BONUS_KINDS = HABIT_BONUS_ROWS.map((row) => row.kind);

/**
 * 습관 보너스 금액(하루 4회 완주 / 7일 연속 / 미션 통과 / 14·30·60·100일 연속) 편집 섹션.
 * IncomeRulesSection과 동일한 TextInput(number-pad)+onBlur 즉시저장 패턴이나,
 * 대상이 income_rule처럼 DB 목록이 아니라 고정 7행(app_meta 키 7개)이라 drafts를
 * kind로 키잉한다.
 */
function HabitBonusSection() {
  const [amounts, setAmounts] = useState<Record<HabitBonusKind, number> | null>(null);
  const [drafts, setDrafts] = useState<Record<HabitBonusKind, string>>(
    Object.fromEntries(HABIT_BONUS_KINDS.map((k) => [k, ''])) as Record<HabitBonusKind, string>,
  );
  const [loaded, setLoaded] = useState(false);
  const [savingKind, setSavingKind] = useState<HabitBonusKind | null>(null);
  const [savedKind, setSavedKind] = useState<HabitBonusKind | null>(null);
  const [rowError, setRowError] = useState<Record<HabitBonusKind, string>>(
    Object.fromEntries(HABIT_BONUS_KINDS.map((k) => [k, ''])) as Record<HabitBonusKind, string>,
  );

  useEffect(() => {
    let cancelled = false;
    getHabitBonusAmounts()
      .then((result) => {
        if (cancelled) return;
        setAmounts(result);
        setDrafts(
          Object.fromEntries(HABIT_BONUS_KINDS.map((k) => [k, String(result[k])])) as Record<HabitBonusKind, string>,
        );
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChangeText = useCallback((kind: HabitBonusKind, text: string) => {
    // 숫자만 허용(음수/소수점 입력 자체를 막아 즉시 피드백)
    const digitsOnly = text.replace(/[^0-9]/g, '');
    setDrafts((prev) => ({ ...prev, [kind]: digitsOnly }));
    setSavedKind(null);
  }, []);

  const handleBlur = useCallback(async (kind: HabitBonusKind) => {
    if (!amounts) return;
    const draft = drafts[kind];
    const current = amounts[kind];
    setRowError((prev) => ({ ...prev, [kind]: '' }));

    if (draft === '') {
      // 빈 입력은 저장하지 않고 이전 값으로 되돌린다.
      setDrafts((prev) => ({ ...prev, [kind]: String(current) }));
      return;
    }

    const amount = Number(draft);
    if (!Number.isInteger(amount) || amount < 0) {
      setRowError((prev) => ({ ...prev, [kind]: '0 이상의 숫자만 입력하세요.' }));
      setDrafts((prev) => ({ ...prev, [kind]: String(current) }));
      return;
    }

    if (amount === current) return; // 변경 없음

    setSavingKind(kind);
    try {
      await updateHabitBonusAmount(kind, amount);
      setAmounts((prev) => (prev ? { ...prev, [kind]: amount } : prev));
      setSavedKind(kind);
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [kind]: err instanceof Error ? err.message : String(err),
      }));
      setDrafts((prev) => ({ ...prev, [kind]: String(current) }));
    } finally {
      setSavingKind(null);
    }
  }, [amounts, drafts]);

  return (
    <View style={styles.incomeSection}>
      <Text style={styles.sectionTitle}>습관 보너스</Text>
      <Text style={styles.sectionDesc}>
        인출 습관 목표를 달성했을 때 지급되는 보너스 금액을 수정할 수 있습니다.
        이미 확정된 지난 보너스에는 소급 적용되지 않고, 다음 달성부터 새 금액이 적용됩니다.
      </Text>

      {!loaded && <Text style={styles.optionHint}>불러오는 중…</Text>}

      <View style={styles.incomeRows}>
        {HABIT_BONUS_ROWS.map((row) => (
          <View key={row.kind} style={styles.incomeRow}>
            <Text style={styles.incomeRowLabel}>{row.label}</Text>
            <View style={styles.incomeInputWrap}>
              <TextInput
                style={styles.incomeInput}
                keyboardType="number-pad"
                value={drafts[row.kind]}
                onChangeText={(text) => handleChangeText(row.kind, text)}
                onBlur={() => handleBlur(row.kind)}
                editable={savingKind !== row.kind}
                maxLength={6}
              />
              <Text style={styles.incomeWon}>원</Text>
            </View>
          </View>
        ))}
      </View>

      {HABIT_BONUS_KINDS.map((kind) =>
        rowError[kind] ? (
          <Text key={kind} style={styles.error}>{rowError[kind]}</Text>
        ) : null,
      )}
      {savedKind !== null && <Text style={styles.savedText}>저장되었습니다.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  contentContainer: {
    padding: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#222',
  },
  sectionDesc: {
    fontSize: 13,
    color: '#888',
    marginTop: 6,
    marginBottom: 20,
    lineHeight: 18,
  },
  sectionDescSub: {
    color: '#aaa',
  },
  options: {
    gap: 12,
  },
  optionCard: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    padding: 16,
  },
  optionCardSelected: {
    borderColor: '#ff8a34',
    backgroundColor: '#fff6ee',
  },
  optionLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
  },
  optionLabelSelected: {
    color: '#ff8a34',
  },
  optionHint: {
    fontSize: 13,
    color: '#888',
    marginTop: 4,
  },
  selectedMark: {
    marginTop: 8,
    fontSize: 12,
    fontWeight: '600',
    color: '#ff8a34',
  },
  error: {
    marginTop: 20,
    color: '#c0392b',
    textAlign: 'center',
  },
  incomeSection: {
    marginTop: 36,
  },
  // 딥링크로 도착했을 때 2.5초간 켜지는 표식. 테두리+padding이 아니라 배경 틴트만
  // 쓰는 이유: padding을 넣으면 하이라이트가 켜지고 꺼질 때 섹션 높이가 변해 아래
  // 내용이 출렁인다. 좌우는 음수 마진으로 넓힌 만큼 padding으로 되밀어 글자 위치가
  // 그대로다 — 레이아웃 이동이 양쪽 축 모두 0이다.
  sectionHighlight: {
    backgroundColor: '#fff1e0',
    borderRadius: 12,
    marginHorizontal: -12,
    paddingHorizontal: 12,
  },
  incomeRows: {
    marginTop: 16,
    gap: 10,
  },
  incomeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  incomeRowLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#333',
  },
  incomeInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  incomeInput: {
    minWidth: 70,
    textAlign: 'right',
    fontSize: 15,
    fontWeight: '600',
    color: '#333',
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  incomeWon: {
    fontSize: 14,
    color: '#666',
  },
  slotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  slotSteppers: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  slotTilde: {
    fontSize: 14,
    color: '#888',
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stepperButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#ccc',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
  },
  stepperValue: {
    minWidth: 44,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  savedText: {
    marginTop: 12,
    fontSize: 13,
    color: '#2e8b57',
    textAlign: 'center',
  },
  rowDimmed: {
    opacity: 0.4,
  },
  pendingNotice: {
    marginTop: 12,
    fontSize: 13,
    color: '#ff8a34',
    lineHeight: 18,
  },
  testButton: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#ff8a34',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  testButtonDisabled: {
    opacity: 0.5,
  },
  testButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ff8a34',
  },
});
