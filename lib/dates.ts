/**
 * epoch day 유틸 (설계.md §1.4)
 *
 * 규칙:
 * - `*_day` (epoch day): 디바이스 로컬 자정 기준 정수 일련번호.
 *   `Math.floor(epochMs_of_local_midnight / 86400000)`.
 *   복습 "-N일 전 학습한 Day"는 `created_day = today - N` 정수 비교로 인덱스를 탄다.
 * - `*_ms` (epoch ms): `Date.now()` 스냅샷. 로컬 표시·월별 그룹핑용.
 *
 * 주의: 전 코드가 이 파일의 `todayEpochDay()` / `toEpochDay()` 하나만 사용해야
 * 타임존/DST 혼선을 막을 수 있다 (설계.md §6-8).
 */

const MS_PER_DAY = 86400000;

/**
 * 주어진 Date(기본값: 현재 시각)의 "로컬 자정" 기준 epoch day를 계산한다.
 * 로컬 자정 시각의 epoch ms를 하루(86400000ms)로 나눈 값이므로, UTC epoch day와는
 * 디바이스 타임존에 따라 다를 수 있다(의도된 동작 — 기기 로컬 기준 "하루" 경계).
 */
export function toEpochDay(date: Date = new Date()): number {
  const localMidnight = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  return Math.floor(localMidnight.getTime() / MS_PER_DAY);
}

/** 오늘의 epoch day. */
export function todayEpochDay(): number {
  return toEpochDay(new Date());
}

/** 현재 epoch ms 스냅샷 (표시/로그용). `Date.now()`의 얇은 래퍼 — 일관성을 위해 이 함수만 사용). */
export function nowEpochMs(): number {
  return Date.now();
}

/** epoch day → 해당 로컬 자정의 Date 객체. */
export function epochDayToDate(epochDay: number): Date {
  return new Date(epochDay * MS_PER_DAY);
}

/**
 * epoch day → "YYYY-MM-DD" 형식 문자열 (표시용).
 * epochDayToDate가 반환하는 Date는 UTC 기준 epochDay*MS_PER_DAY 시각이므로,
 * 로컬 자정으로 만들어진 값을 다시 로컬 캘린더 필드로 읽어야 왕복이 일관된다.
 * (toEpochDay가 로컬 필드로 만든 Date를 UTC ms로 환산했으므로, 여기서는 UTC
 * 필드로 읽어 원래의 로컬 연/월/일을 복원한다.)
 */
export function epochDayToDateString(epochDay: number): string {
  const d = epochDayToDate(epochDay);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** offset(일) 목록으로부터 epoch day 목록을 만든다. 예: reviewOffsets([1,3,7]) → [today-1, today-3, today-7] */
export function daysAgo(offsets: number[], today: number = todayEpochDay()): number[] {
  return offsets.map((offset) => today - offset);
}

/** 복습 스케줄 오프셋 (설계.md 핵심 도메인 규칙: -1/-3/-7/-14/-30/-60/-120일) */
export const REVIEW_OFFSETS = [1, 3, 7, 14, 30, 60, 120] as const;
