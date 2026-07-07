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
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { setDifficultyLevel, useSettingsStore, type DifficultyLevel } from '../../lib/settings';

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
    <View style={styles.container}>
      <Stack.Screen options={{ title: '설정' }} />

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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
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
});
