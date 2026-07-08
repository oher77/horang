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

import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from 'react-native';

import {
  getIncomeRules,
  updateIncomeRuleAmount,
  type IncomeRule,
} from '../../lib/incomeQueries';
import {
  setDifficultyLevel,
  setWordsPerDay,
  useSettingsStore,
  type DifficultyLevel,
} from '../../lib/settings';

const LEVEL_OPTIONS: { level: DifficultyLevel; label: string; hint: string }[] = [
  { level: 1, label: '고1', hint: '짧고 평이한 예문' },
  { level: 2, label: '고2', hint: '중간 난이도 예문' },
  { level: 3, label: '고3', hint: '복문·추상적 예문' },
];

export default function SettingsScreen() {
  const { level, loaded } = useSettingsStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

          <IncomeRulesSection />
        </View>
      </TouchableWithoutFeedback>
    </ScrollView>
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
  savedText: {
    marginTop: 12,
    fontSize: 13,
    color: '#2e8b57',
    textAlign: 'center',
  },
});
