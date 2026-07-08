/**
 * 설정 전역 상태 (설계.md §4.3 settingsStore, §1.3 user.db.settings)
 *
 * 설계.md §1.3 DDL에 이미 `settings.level`(1/2/3 = 고1/2/3, 예문 난이도) 컬럼이
 * 정의돼 있으므로 별도 app_meta 키가 아니라 이 컬럼을 그대로 사용한다.
 * (lib/db.ts의 ensureUserDb()가 INSERT OR IGNORE로 id=1 기본행(level=1)을 보장한다.)
 *
 * Zustand는 package.json에 없어 신규 설치가 금지되므로(가드레일), 모듈 싱글턴 +
 * 구독자 목록 패턴으로 최소 전역 스토어를 구현한다. React 바인딩은
 * `useSettingsStore()` 훅(useSyncExternalStore)으로 제공한다.
 */

import { useSyncExternalStore } from 'react';
import { getUserDb } from './db';

export type DifficultyLevel = 1 | 2 | 3;

interface SettingsState {
  level: DifficultyLevel;
  wordsPerDay: number;
  loaded: boolean;
}

let state: SettingsState = {
  level: 1,
  wordsPerDay: 20,
  loaded: false,
};

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function setState(patch: Partial<SettingsState>) {
  state = { ...state, ...patch };
  emit();
}

/** 앱 시작 시 1회 호출 (app/_layout.tsx의 initDatabases() 완료 후). user.db.settings를 읽어 스토어에 반영한다. */
export async function loadSettings(): Promise<void> {
  const userDb = getUserDb();
  const row = await userDb.getFirstAsync<{ level: number; words_per_day: number }>(
    'SELECT level, words_per_day FROM settings WHERE id = 1',
  );
  setState({
    level: normalizeLevel(row?.level),
    wordsPerDay: row?.words_per_day ?? 20,
    loaded: true,
  });
}

/** 난이도 변경 — user.db에 즉시 영속 후 스토어 갱신(낙관적 갱신 후 실패 시 롤백). */
export async function setDifficultyLevel(level: DifficultyLevel): Promise<void> {
  const prev = state.level;
  setState({ level }); // 즉시 반영(설정 화면 반응성)
  try {
    const userDb = getUserDb();
    await userDb.runAsync('UPDATE settings SET level = ? WHERE id = 1', [level]);
  } catch (err) {
    setState({ level: prev }); // 저장 실패 시 롤백
    throw err;
  }
}

/**
 * 하루 단어 수 변경 — user.db에 즉시 영속 후 스토어 갱신(낙관적 갱신 후 실패 시 롤백).
 * 1~200 사이 정수만 허용(설정 화면 입력 검증과 동일 규칙 — 방어적으로 여기서도 재검증).
 *
 * 설계.md §4.5(라인 438)는 words_per_day 변경 시 is_started=0인 미시작 Day를 삭제해
 * 새 N으로 재생성하는 정책까지 규정하지만, 이번 작업 범위는 설정값 저장까지이며
 * ensureTodayDay()/createTodayDay() 로직은 소유권 밖이라 변경하지 않는다. 즉,
 * 이미 생성된 오늘 Day는 이 함수 호출만으로는 재생성되지 않고, 다음 Day부터
 * 새 값이 적용된다(§4.5 재생성 정책 자체는 별도 작업으로 남겨둠).
 */
export async function setWordsPerDay(wordsPerDay: number): Promise<void> {
  if (!Number.isInteger(wordsPerDay) || wordsPerDay < 1 || wordsPerDay > 200) {
    throw new Error('하루 단어 수는 1~200 사이의 정수여야 합니다.');
  }
  const prev = state.wordsPerDay;
  setState({ wordsPerDay }); // 즉시 반영(설정 화면 반응성)
  try {
    const userDb = getUserDb();
    await userDb.runAsync('UPDATE settings SET words_per_day = ? WHERE id = 1', [wordsPerDay]);
  } catch (err) {
    setState({ wordsPerDay: prev }); // 저장 실패 시 롤백
    throw err;
  }
}

function normalizeLevel(value: number | null | undefined): DifficultyLevel {
  return value === 2 || value === 3 ? value : 1;
}

/** 현재 스냅샷 (React 바깥에서 즉시 값이 필요할 때). */
export function getSettingsSnapshot(): SettingsState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React 컴포넌트에서 설정 상태를 구독하는 훅. */
export function useSettingsStore(): SettingsState {
  return useSyncExternalStore(subscribe, getSettingsSnapshot, getSettingsSnapshot);
}
