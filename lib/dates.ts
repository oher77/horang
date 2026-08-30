/**
 * epoch day 유틸 (설계.md §1.4)
 *
 * 규칙:
 * - `*_day` (epoch day): 디바이스 로컬 캘린더 날짜의 정수 일련번호
 *   (1970-01-01 = 0). `Date.UTC(로컬 연, 월, 일) / 86400000`.
 *   복습 "-N일 전 학습한 Day"는 `created_day = today - N` 정수 비교로 인덱스를 탄다.
 * - `*_ms` (epoch ms): `Date.now()` 스냅샷. 로컬 표시·월별 그룹핑용.
 *
 * 주의: 전 코드가 이 파일의 `todayEpochDay()` / `toEpochDay()` 하나만 사용해야
 * 타임존/DST 혼선을 막을 수 있다 (설계.md §6-8).
 */

const MS_PER_DAY = 86400000;

/**
 * 주어진 Date(기본값: 현재 시각)의 로컬 캘린더 날짜 기준 epoch day를 계산한다.
 * 로컬 연/월/일을 UTC 자정 ms로 환산해 나누므로 항상 정확한 정수이며, 타임존
 * 부호(UTC±)와 무관하게 기기 로컬 자정이 하루의 경계가 된다.
 */
export function toEpochDay(date: Date = new Date()): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY;
}

/** 오늘의 epoch day. */
export function todayEpochDay(): number {
  return toEpochDay(new Date());
}

/** 현재 epoch ms 스냅샷 (표시/로그용). `Date.now()`의 얇은 래퍼 — 일관성을 위해 이 함수만 사용). */
export function nowEpochMs(): number {
  return Date.now();
}

/** epoch day → 해당 캘린더 날짜의 UTC 자정 Date 객체 (연/월/일은 UTC 게터로 읽을 것). */
export function epochDayToDate(epochDay: number): Date {
  return new Date(epochDay * MS_PER_DAY);
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;

/**
 * epoch day → 요일 한 글자. epochDayToDate는 "로컬 캘린더 날짜의 UTC 자정"을 돌려주므로
 * 반드시 UTC 필드로 읽는다 — getDay()를 쓰면 시간대에 따라 하루씩 밀린다
 * (epochDayToDateString이 UTC 필드를 쓰는 것과 같은 이유).
 */
export function weekdayLabel(epochDay: number): string {
  return WEEKDAYS[epochDayToDate(epochDay).getUTCDay()];
}

/**
 * epoch ms → "HH:MM" (분까지, 24시간제). `*_ms`는 `Date.now()` 스냅샷이라 로컬 필드로
 * 읽는 게 맞다 — epoch **day** 쪽(epochDayToDateString/요일)이 UTC 필드를 쓰는 것과
 * 반대이니 헷갈리지 말 것. 용돈 장부가 지급 시각을 보여줄 때 쓴다.
 */
export function hourMinute(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * epoch day → "YYYY-MM-DD" 형식 문자열 (표시용).
 * epochDay*MS_PER_DAY는 해당 로컬 캘린더 날짜의 UTC 자정이므로, UTC 필드로
 * 읽으면 toEpochDay에 들어갔던 원래의 로컬 연/월/일이 그대로 복원된다.
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
