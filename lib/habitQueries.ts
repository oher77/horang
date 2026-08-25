/**
 * 하루 4회 분산 인출 습관 시스템 — 데이터 계층 (설계.md §7, §7.6 미결 4)
 *
 * 슬롯(시간창) 설정·판정, 인출 세션 기록, 스트릭 파생, 습관 보너스(§7.4) 조회를
 * 담당한다. 화면 레이어는 이 모듈의 export만 사용하고 retrieval_session /
 * slot_part / slot_config / habit_bonus 테이블에 직접 접근하지 않는다.
 *
 * 2026-08-24: 복습이 슬롯 조건에 편입되며 의미가 바뀌었다(§7.6 미결 4).
 * - `slot_part` 1행 = "오늘 이 슬롯에서 이 Day를 인출했다"(조각). 오늘 단어장이든
 *   복습 Day든 같은 사실이라 종류 구분 컬럼이 없다 — 오늘 몫인지 복습 몫인지는
 *   조회 시점에 getSlotRequirement()의 집합과 대조해 파생한다.
 * - `retrieval_session` 1행은 이제 "슬롯 완성"(그 슬롯에 필요한 조각이 전부 모인
 *   순간)만 기록한다. 스키마·의미(§7.5 스트릭 파생, getTodaySlots, 4/4 보너스)는
 *   그대로라 이 문서가 바뀐 걸 몰라도 되는 하위 함수가 많다 — slot_part라는 새
 *   앞단계만 추가됐을 뿐, "슬롯이 찼다"의 정의(local_day, slot_index당 1행)는
 *   불변이기 때문.
 *
 * 날짜는 lib/dates.ts의 todayEpochDay()/nowEpochMs()만 사용(§1.4 규약). 슬롯
 * hour 판정에 필요한 로컬 hour 추출만 예외적으로 이 파일 안에서 new Date(ms).getHours()를
 * 쓴다(작업 지시의 가드레일).
 */

import { getUserDb } from './db';
import { daysAgo, nowEpochMs, REVIEW_OFFSETS, todayEpochDay } from './dates';

/**
 * 습관 보너스 금액 기본값(설정에서 변경 가능, app_meta) — 설계.md §7.4.
 * income_rule과 축이 달라 섞지 않는다. app_meta에 사용자 편집값이 없을 때의
 * 폴백 기본값으로만 쓰인다(2026-07-09부터 편집 가능 — getHabitBonusAmounts 참고).
 *
 * 2026-07-11: 슬롯 통과(slotPass)·장기 스트릭 마일스톤(streak14/30/60/100) 5종 추가
 * (사용자 요청). 기존 fullDay/streak7은 유지.
 */
export const DEFAULT_HABIT_BONUS = {
  fullDay: 200, // 하루 4/4 달성 보너스(원)
  streak7: 500, // 7일 연속 달성 시 추가 보너스(원). 7·14·21…일마다 지급(주기)
  // 오늘 단어장 1회 통과 보너스(원). 슬롯당 1회(하루 최대 4회). **슬롯 완성이 아니라
  // 오늘 단어장 조각이 기록되는 순간 즉시 지급**된다(2026-08-25 변경 — 그 전에는 슬롯이
  // 완성돼야 나왔다). 필드·app_meta 키 이름이 slotPass인 것은 2026-07-11 도입 당시
  // "슬롯 통과 == 오늘 단어장 통과"였기 때문이며, 이름만 옛것이고 뜻은 어긋나지 않는다.
  slotPass: 10,
  streak14: 4000, // 14일 연속 달성 마일스톤(원)
  streak30: 20000, // 30일 연속 달성 마일스톤(원)
  streak60: 50000, // 60일 연속 달성 마일스톤(원)
  streak100: 100000, // 100일 연속 달성 마일스톤(원)
  reviewDay: 10, // 복습 Day 1개 통과(원). 슬롯당 1회 → 하루 최대 (복습 Day 수 × 4)회
} as const;

type HabitBonusKind = keyof typeof DEFAULT_HABIT_BONUS;

const HABIT_BONUS_APP_META_KEY: Record<HabitBonusKind, string> = {
  fullDay: 'habit_bonus_full_day_amount',
  streak7: 'habit_bonus_streak7_amount',
  slotPass: 'habit_bonus_slot_pass_amount',
  streak14: 'habit_bonus_streak14_amount',
  streak30: 'habit_bonus_streak30_amount',
  streak60: 'habit_bonus_streak60_amount',
  streak100: 'habit_bonus_streak100_amount',
  reviewDay: 'habit_bonus_review_day_amount',
};

const HABIT_BONUS_KINDS = Object.keys(HABIT_BONUS_APP_META_KEY) as HabitBonusKind[];

/**
 * 습관 보너스 금액을 app_meta에서 읽는다(설정 화면 편집값). 키가 없으면(최초
 * 설치·미편집) DEFAULT_HABIT_BONUS 폴백 — lazy read, 시드 INSERT 불필요
 * (lib/notifications.ts의 app_meta 읽기 관행과 동일).
 */
export async function getHabitBonusAmounts(): Promise<Record<HabitBonusKind, number>> {
  const db = getUserDb();
  const keys = HABIT_BONUS_KINDS.map((kind) => HABIT_BONUS_APP_META_KEY[kind]);
  const rows = await db.getAllAsync<{ key: string; value: string }>(
    `SELECT key, value FROM app_meta WHERE key IN (${keys.map(() => '?').join(', ')})`,
    keys,
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const result = {} as Record<HabitBonusKind, number>;
  for (const kind of HABIT_BONUS_KINDS) {
    const raw = map.get(HABIT_BONUS_APP_META_KEY[kind]);
    const parsed = raw !== undefined ? Number(raw) : DEFAULT_HABIT_BONUS[kind];
    result[kind] = Number.isFinite(parsed) ? parsed : DEFAULT_HABIT_BONUS[kind];
  }
  return result;
}

/**
 * 습관 보너스 금액 편집(설정 화면). 0 이상의 정수만 허용 — updateIncomeRuleAmount와
 * 동일한 검증 관행. 이미 기록된 과거 habit_bonus.amount는 기록 시점의 스냅샷이라
 * 소급 변경되지 않는다(recordRetrievalSession 참고) — 새로 확정되는 보너스부터 적용.
 */
export async function updateHabitBonusAmount(kind: HabitBonusKind, amount: number): Promise<void> {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error('보너스 금액은 0 이상의 정수여야 합니다.');
  }
  const key = HABIT_BONUS_APP_META_KEY[kind];
  const db = getUserDb();
  await db.runAsync(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(amount)],
  );
}

const TOTAL_SLOTS = 4;

/** 슬롯 하나의 시간창. [startHour, endHour) 반열림 구간(§7.1). */
export interface SlotWindow {
  slotIndex: number;
  startHour: number;
  endHour: number;
}

/**
 * slot_config 4행을 slot_index 오름차순으로 반환한다. lib/db.ts의 ensureUserDb()가
 * 이미 lazy seed를 보장하지만, 방어적으로 여기서도 비어 있으면 채운다(ensureIncomeRules와
 * 동일한 lazy seed 관행 — §7.2 마이그레이션 절차 2).
 */
export async function getSlotConfig(): Promise<SlotWindow[]> {
  const db = getUserDb();
  await ensureSlotConfigSeeded(db);

  const rows = await db.getAllAsync<{ slot_index: number; start_hour: number; end_hour: number }>(
    'SELECT slot_index, start_hour, end_hour FROM slot_config ORDER BY slot_index ASC',
  );
  return rows.map((r) => ({
    slotIndex: r.slot_index,
    startHour: r.start_hour,
    endHour: r.end_hour,
  }));
}

/** db.ts의 seed와 동일한 기본값(§7.2). getUserDb()만으로 재시드가 필요한 방어적 경로용. */
const DEFAULT_SLOT_CONFIG: ReadonlyArray<SlotWindow> = [
  { slotIndex: 0, startHour: 6, endHour: 10 },
  { slotIndex: 1, startHour: 10, endHour: 15 },
  { slotIndex: 2, startHour: 15, endHour: 20 },
  { slotIndex: 3, startHour: 20, endHour: 24 },
];

async function ensureSlotConfigSeeded(db: ReturnType<typeof getUserDb>): Promise<void> {
  const row = await db.getFirstAsync<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM slot_config');
  if (row && row.cnt > 0) return;

  await db.withTransactionAsync(async () => {
    for (const slot of DEFAULT_SLOT_CONFIG) {
      await db.runAsync(
        'INSERT INTO slot_config (slot_index, start_hour, end_hour) VALUES (?, ?, ?)',
        [slot.slotIndex, slot.startHour, slot.endHour],
      );
    }
  });
}

/**
 * 슬롯 설정을 갱신한다(설정 화면 저장 경로, §7.3).
 * 검증: 4개 슬롯 각각 start<end, 정수 0~24, 정렬 후 겹침 금지(인접 접합은 허용
 * — slot[i].end <= slot[i+1].start). 위반 시 저장하지 않고 한국어 메시지로 throw.
 */
export async function updateSlotConfig(slots: SlotWindow[]): Promise<void> {
  if (slots.length !== TOTAL_SLOTS) {
    throw new Error('슬롯은 정확히 4개여야 합니다.');
  }

  for (const slot of slots) {
    if (
      !Number.isInteger(slot.startHour) ||
      !Number.isInteger(slot.endHour) ||
      slot.startHour < 0 ||
      slot.startHour > 24 ||
      slot.endHour < 0 ||
      slot.endHour > 24
    ) {
      throw new Error('슬롯 시각은 0~24 사이의 정수여야 합니다.');
    }
    if (slot.startHour >= slot.endHour) {
      throw new Error('각 슬롯은 시작 시각이 종료 시각보다 빨라야 합니다.');
    }
  }

  const sorted = [...slots].sort((a, b) => a.startHour - b.startHour);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].endHour > sorted[i + 1].startHour) {
      throw new Error('슬롯 시간대가 겹칠 수 없습니다.');
    }
  }

  const db = getUserDb();
  await db.withTransactionAsync(async () => {
    for (const slot of slots) {
      await db.runAsync(
        'UPDATE slot_config SET start_hour = ?, end_hour = ? WHERE slot_index = ?',
        [slot.startHour, slot.endHour, slot.slotIndex],
      );
    }
  });
}

/** ms 시각의 로컬 hour(0~23)를 추출한다. 슬롯 판정용 로컬 Date 연산은 이 함수로만 모은다. */
function localHourOf(ms: number): number {
  return new Date(ms).getHours();
}

/**
 * 주어진 시각(기본: 지금)의 로컬 hour가 속한 슬롯 인덱스를 반환한다.
 * 06시 이전(데드존)이거나 설정된 4슬롯 어디에도 속하지 않으면 null(§7.1).
 */
export async function currentSlotIndex(now: Date = new Date()): Promise<number | null> {
  const hour = localHourOf(now.getTime());
  const slots = await getSlotConfig();
  const hit = slots.find((s) => hour >= s.startHour && hour < s.endHour);
  return hit ? hit.slotIndex : null;
}

/** 오늘(todayEpochDay()) 확정 슬롯 4칸을 boolean[4]로 반환한다 (Q-HABIT-TODAY, §7.5). */
export async function getTodaySlots(): Promise<boolean[]> {
  const db = getUserDb();
  const today = todayEpochDay();
  const rows = await db.getAllAsync<{ slot_index: number }>(
    'SELECT slot_index FROM retrieval_session WHERE local_day = ?',
    [today],
  );
  const filled = new Set(rows.map((r) => r.slot_index));
  return Array.from({ length: TOTAL_SLOTS }, (_, i) => filled.has(i));
}

/** 특정 local_day에 확정된 slot_index 집합(Set) — 스트릭 계산용 내부 헬퍼. */
async function getFullDaysDesc(db: ReturnType<typeof getUserDb>): Promise<number[]> {
  const rows = await db.getAllAsync<{ local_day: number }>(
    `SELECT local_day
     FROM retrieval_session
     GROUP BY local_day
     HAVING COUNT(DISTINCT slot_index) = ?
     ORDER BY local_day DESC`,
    [TOTAL_SLOTS],
  );
  return rows.map((r) => r.local_day);
}

/**
 * 연속 달성 일수 (Q-HABIT-STREAK, §7.5). 4/4 달성한 날만 카운트하며, 최신일부터
 * 끊김 없이 센다. 오늘이 아직 4/4 전이면 어제부터 연속을 센다(오늘은 "진행 중").
 */
export async function getCurrentStreak(): Promise<number> {
  const db = getUserDb();
  const fullDays = await getFullDaysDesc(db);
  if (fullDays.length === 0) return 0;

  const today = todayEpochDay();
  const fullDaySet = new Set(fullDays);

  let cursor = fullDaySet.has(today) ? today : today - 1;
  let streak = 0;
  while (fullDaySet.has(cursor)) {
    streak += 1;
    cursor -= 1;
  }
  return streak;
}

/** day.created_day == todayEpochDay() 여부. 오늘 몫/복습 몫을 가르는 데 쓰인다(§7.6 미결 4). */
export async function isTodayDay(dayId: number): Promise<boolean> {
  const db = getUserDb();
  const row = await db.getFirstAsync<{ created_day: number }>(
    'SELECT created_day FROM day WHERE id = ?',
    [dayId],
  );
  if (!row) return false;
  return row.created_day === todayEpochDay();
}

/**
 * 오늘 슬롯 하나를 채우는 데 필요한 Day 집합(§7.6 미결 4).
 *
 * 오프셋은 반드시 lib/dates.ts의 REVIEW_OFFSETS를 쓴다 — lib/reviewQueries.ts의
 * getReviewDays()와 동일한 원본을 보게 하기 위해서다(복습 화면이 보여주는 대상과
 * 슬롯이 요구하는 대상이 어긋나면 안 된다). getReviewDays() 자체를 import하지
 * 않는 이유는 모듈 간 결합을 늘리지 않기 위함 — 여기서는 id만 필요하다.
 */
export interface SlotRequirement {
  /** 오늘 생성된 Day의 id. 아직 없으면 null(홈이 ensureTodayDay로 만들기 전). */
  todayDayId: number | null;
  /** 오늘의 복습 대상 Day id — 최근순(-1 → -120). 복습 화면 정렬(created_day DESC)과 동일. */
  reviewDayIds: number[];
  /** todayDayId(있으면) + reviewDayIds. 이 전부가 slot_part에 있어야 슬롯 완성. */
  requiredDayIds: number[];
}

/**
 * getSlotRequirement() 구현. todayDayId가 null이면(홈이 아직 오늘 Day를 만들지
 * 않은 극히 드문 경로) 요구 집합은 복습 Day만으로 구성된다 — 실사용에서는 홈
 * 화면이 항상 ensureTodayDay()로 먼저 만들어두므로 도달하기 어려운 경로다.
 */
export async function getSlotRequirement(): Promise<SlotRequirement> {
  const db = getUserDb();
  const today = todayEpochDay();

  const todayRow = await db.getFirstAsync<{ id: number }>(
    'SELECT id FROM day WHERE created_day = ? LIMIT 1',
    [today],
  );
  const todayDayId = todayRow?.id ?? null;

  const reviewTargetDays = daysAgo([...REVIEW_OFFSETS], today);
  const placeholders = reviewTargetDays.map(() => '?').join(',');
  const reviewRows = await db.getAllAsync<{ id: number }>(
    `SELECT id FROM day WHERE created_day IN (${placeholders}) ORDER BY created_day DESC`,
    reviewTargetDays,
  );
  const reviewDayIds = reviewRows.map((r) => r.id);

  const requiredDayIds = todayDayId !== null ? [todayDayId, ...reviewDayIds] : [...reviewDayIds];

  return { todayDayId, reviewDayIds, requiredDayIds };
}

/** 전구 3상태(§7.6 미결 4). empty=꺼짐 / partial=지지직 / full=완전 점등. */
export type SlotState = 'empty' | 'partial' | 'full';

/**
 * 오늘 4슬롯의 상태(getTodaySlots()의 3상태 확장판, 홈 게이지용).
 *
 * 판정: retrieval_session에 행이 있으면 'full', 없고 slot_part에 행이 하나라도
 * 있으면 'partial', 둘 다 없으면 'empty'.
 *
 * 스펙 문구는 "단어장만 본 경우 = 지지직"이지만, 구현은 "조각이 하나라도 있고
 * 아직 미완성"으로 더 넓게 잡는다 — 복습을 먼저 하고 단어장을 나중에 여는
 * 순서도 똑같이 지지직으로 보여주는 게 맞기 때문(흔한 경우, 즉 단어장을 먼저
 * 여는 경우에는 두 정의가 동일하게 동작한다).
 */
export async function getTodaySlotStates(): Promise<SlotState[]> {
  const db = getUserDb();
  const today = todayEpochDay();

  const fullRows = await db.getAllAsync<{ slot_index: number }>(
    'SELECT DISTINCT slot_index FROM retrieval_session WHERE local_day = ?',
    [today],
  );
  const fullSet = new Set(fullRows.map((r) => r.slot_index));

  const partRows = await db.getAllAsync<{ slot_index: number }>(
    'SELECT DISTINCT slot_index FROM slot_part WHERE local_day = ?',
    [today],
  );
  const partSet = new Set(partRows.map((r) => r.slot_index));

  return Array.from({ length: TOTAL_SLOTS }, (_, i): SlotState => {
    if (fullSet.has(i)) return 'full';
    if (partSet.has(i)) return 'partial';
    return 'empty';
  });
}

/**
 * 오늘 특정 슬롯에서 이미 통과한 Day id 목록(복습 목록의 완료 표시용).
 * slotIndex가 null(데드존)이면 빈 배열.
 */
export async function getSlotPassedDayIds(slotIndex: number | null): Promise<number[]> {
  if (slotIndex === null) return [];
  const db = getUserDb();
  const today = todayEpochDay();
  const rows = await db.getAllAsync<{ day_id: number }>(
    'SELECT day_id FROM slot_part WHERE local_day = ? AND slot_index = ?',
    [today, slotIndex],
  );
  return rows.map((r) => r.day_id);
}

/**
 * 오늘 이 Day를 몇 번 통과했나(체류 임계의 "차수" 계산용, 0이면 오늘 첫 통과).
 *
 * 기존 getTodaySessionCount()를 대체한다 — 그건 retrieval_session 행 수를 셌는데
 * 이제 그 테이블은 "슬롯 완성"만 기록해서 단어장을 훑은 횟수와 일치하지 않는다.
 * slot_part는 (local_day, slot_index, day_id) 단위로 조각을 남기므로, 특정
 * dayId가 오늘 몇 개 슬롯에서 통과됐는지를 세면 그 Day를 몇 번 훑었는지가 된다.
 */
export async function getTodayPassCount(dayId: number): Promise<number> {
  const db = getUserDb();
  const today = todayEpochDay();
  const row = await db.getFirstAsync<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM slot_part WHERE local_day = ? AND day_id = ?',
    [today, dayId],
  );
  return row?.cnt ?? 0;
}

/**
 * 이 Day가 오늘 슬롯 크레딧을 받을 수 있는가 = 오늘 Day이거나 오늘의 복습 대상 Day.
 * 단어장 화면의 트래킹 활성 게이트가 쓴다(전에는 isTodayDay 단독이었다, §7.6 미결 4).
 */
export async function isSlotEligibleDay(dayId: number): Promise<boolean> {
  const req = await getSlotRequirement();
  return req.requiredDayIds.includes(dayId);
}

/** recordSlotPart()의 결과 — 이번 호출로 무엇이 확정/지급됐는지. */
export interface RecordResult {
  /** 이번 호출로 조각(slot_part)이 새로 기록됐는지. false면 이미 이 슬롯에서 이 Day를 통과함. */
  partRecorded: boolean;
  /** 이번 호출로 슬롯이 완성됐는지(= retrieval_session에 1행 생성). 보상·배너의 트리거. */
  slotCompleted: boolean;
  slotIndex: number | null;
  /** 기록 후 이 슬롯에서 아직 남은 Day id(최근순). 연쇄 복습 버튼·"N개 남음" 배너용. */
  remainingDayIds: number[];
  fullDayBonusPaid: boolean; // 이번에 4/4 보너스가 지급됐는지
  streakBonusPaid: boolean; // 이번에 7일 주기 보너스가 지급됐는지
  streakDays: number; // 기록 후 스트릭
  // 이번 호출에서 실제로 새로 INSERT된(각 runAsync의 changes > 0) 보너스만 담는다
  // (2026-07-12 추가, 화면의 동전 애니메이션/배너 실지급액 표시용). amount는 지급
  // 시점의 스냅샷 값 그대로 — bonusAmounts 재조회 없이 그대로 담는다.
  paidBonuses: { kind: string; amount: number }[];
}

/**
 * 슬롯 조각 1개를 확정 기록한다(§7.1~§7.4, §7.6 미결 4).
 *
 * 기존 recordRetrievalSession()을 대체한다. 슬롯 하나를 채우려면 오늘 Day +
 * 오늘의 복습 대상 Day 전부가 각각 1회씩 필요해졌으므로, 이 함수는 "조각 하나
 * 기록"만 담당하고 "슬롯 완성" 여부는 조각을 모아본 뒤 판정한다.
 *
 * 순서: getSlotRequirement()로 오늘 요구 집합을 구해 dayId가 그 안에 없으면
 * 미기록(조기 반환) → currentSlotIndex(데드존이면 미기록) →
 * slot_part에 INSERT OR IGNORE(UNIQUE(local_day,slot_index,day_id)가 조각 중복 방지,
 * changes==0이면 이미 이 슬롯에서 통과한 Day) → 복습 Day면 슬롯별 복습 보너스
 * INSERT OR IGNORE → 그 슬롯에 필요한 조각이 전부 모였는지 확인 → 모였으면
 * retrieval_session에 INSERT OR IGNORE(= 슬롯 완성) → 완성된 경로에서만 기존
 * slot_pass/4-4/streak7/마일스톤 보너스 체인을 그대로 이어붙인다. 전체를
 * 트랜잭션으로 묶는다.
 */
export async function recordSlotPart(dayId: number): Promise<RecordResult> {
  const db = getUserDb();
  const bonusAmounts = await getHabitBonusAmounts();
  const req = await getSlotRequirement();

  if (!req.requiredDayIds.includes(dayId)) {
    const streakDays = await getCurrentStreak();
    return {
      partRecorded: false,
      slotCompleted: false,
      slotIndex: null,
      remainingDayIds: [],
      fullDayBonusPaid: false,
      streakBonusPaid: false,
      streakDays,
      paidBonuses: [],
    };
  }

  const slotIndex = await currentSlotIndex();
  if (slotIndex === null) {
    const streakDays = await getCurrentStreak();
    return {
      partRecorded: false,
      slotCompleted: false,
      slotIndex: null,
      remainingDayIds: [],
      fullDayBonusPaid: false,
      streakBonusPaid: false,
      streakDays,
      paidBonuses: [],
    };
  }

  const today = todayEpochDay();
  const doneMs = nowEpochMs();

  let partRecorded = false;
  let slotCompleted = false;
  let fullDayBonusPaid = false;
  let streakBonusPaid = false;
  const paidBonuses: { kind: string; amount: number }[] = [];

  await db.withTransactionAsync(async () => {
    const partResult = await db.runAsync(
      'INSERT OR IGNORE INTO slot_part (local_day, slot_index, day_id, done_ms) VALUES (?, ?, ?, ?)',
      [today, slotIndex, dayId, doneMs],
    );
    partRecorded = partResult.changes > 0;
    if (!partRecorded) return;

    // ── 조각 보상은 **즉시** 지급한다 (2026-08-25 사용자 확정) ─────────────────
    // 슬롯 완성까지 기다리지 않는다. 한 가지를 끝낼 때마다 바로 보상이 와야 다음 것을
    // 하게 되고, 복습이 남은 상태에서 "아무것도 못 받았다"가 되면 오늘 단어장을 본
    // 노력 자체가 없던 일이 된다. **슬롯 완성은 보상 축이 아니라 전구 점등·스트릭·
    // 4/4 보너스의 축으로 남는다** — 즉시 보상(조각)과 누적 보상(슬롯)을 분리한 것.
    // 어느 쪽이든 kind에 슬롯 번호가 들어가 UNIQUE(local_day,kind)가 슬롯당 1회를 보장한다.
    if (dayId === req.todayDayId) {
      // 오늘 단어장 통과. **kind는 `slot_pass_${slotIndex}` 그대로 둔다**(2026-07-11 도입) —
      // 이름은 옛 이름이지만 과거 행의 뜻과 어긋나지 않는다. 복습 편입 전에는
      // "슬롯 통과 == 오늘 단어장 통과"였으므로 지난 기록도 같은 의미다. 새 kind를
      // 만들면 장부 라벨 분기와 app_meta 금액 키(habit_bonus_slot_pass_amount, 사용자가
      // 설정에서 편집한 값이 들어 있다)가 둘로 갈라져 이득 없이 복잡해진다.
      const todayPassResult = await db.runAsync(
        'INSERT OR IGNORE INTO habit_bonus (local_day, kind, amount, paid, created_ms) VALUES (?, ?, ?, 0, ?)',
        [today, `slot_pass_${slotIndex}`, bonusAmounts.slotPass, doneMs],
      );
      if (todayPassResult.changes > 0) {
        paidBonuses.push({ kind: `slot_pass_${slotIndex}`, amount: bonusAmounts.slotPass });
      }
    } else {
      // 복습 Day 통과 (배지 수 비례 금지 — 우스와이프를 많이 할수록 버는 구조가 되면
      // 자기채점의 신뢰가 무너진다. Day 개수는 달력이 정하므로 조작할 수 없다).
      const reviewBonusResult = await db.runAsync(
        'INSERT OR IGNORE INTO habit_bonus (local_day, kind, amount, paid, created_ms) VALUES (?, ?, ?, 0, ?)',
        [today, `review_day_${dayId}_s${slotIndex}`, bonusAmounts.reviewDay, doneMs],
      );
      if (reviewBonusResult.changes > 0) {
        paidBonuses.push({ kind: `review_day_${dayId}_s${slotIndex}`, amount: bonusAmounts.reviewDay });
      }
    }

    // 슬롯 완성 판정: 이 슬롯에서 통과된 Day 집합이 오늘 요구 집합을 전부 포함하는가
    const passedRows = await db.getAllAsync<{ day_id: number }>(
      'SELECT day_id FROM slot_part WHERE local_day = ? AND slot_index = ?',
      [today, slotIndex],
    );
    const passedSet = new Set(passedRows.map((r) => r.day_id));
    const isSlotComplete = req.requiredDayIds.every((id) => passedSet.has(id));
    if (!isSlotComplete) return;

    const source = dayId === req.todayDayId ? 'today' : 'review';
    const sessionResult = await db.runAsync(
      'INSERT OR IGNORE INTO retrieval_session (local_day, slot_index, source, day_id, done_ms) VALUES (?, ?, ?, ?, ?)',
      [today, slotIndex, source, dayId, doneMs],
    );
    slotCompleted = sessionResult.changes > 0;
    if (!slotCompleted) return;

    // ★ 슬롯 통과 보너스(slot_pass_*)는 여기 없다 — 2026-08-25에 위쪽 "조각 즉시 지급"
    //   블록으로 옮겼다. 이 블록이 담당하는 것은 **누적 보상**뿐이다(4/4, 스트릭, 마일스톤).

    // 4/4 보너스: 이번 기록으로 오늘 슬롯이 모두 찼는지 확인
    const filledRow = await db.getFirstAsync<{ cnt: number }>(
      'SELECT COUNT(DISTINCT slot_index) AS cnt FROM retrieval_session WHERE local_day = ?',
      [today],
    );
    const isFullDay = (filledRow?.cnt ?? 0) === TOTAL_SLOTS;

    if (isFullDay) {
      const fullDayResult = await db.runAsync(
        'INSERT OR IGNORE INTO habit_bonus (local_day, kind, amount, paid, created_ms) VALUES (?, ?, ?, 0, ?)',
        [today, 'full_day', bonusAmounts.fullDay, doneMs],
      );
      fullDayBonusPaid = fullDayResult.changes > 0;
      if (fullDayBonusPaid) {
        paidBonuses.push({ kind: 'full_day', amount: bonusAmounts.fullDay });
      }

      // 스트릭 재계산 (이 트랜잭션 내 최신 상태 반영) — 오늘이 방금 4/4가 됐으므로 오늘부터 역산
      const fullDays = await getFullDaysDesc(db);
      const fullDaySet = new Set(fullDays);
      let cursor = today;
      let streak = 0;
      while (fullDaySet.has(cursor)) {
        streak += 1;
        cursor -= 1;
      }

      if (streak > 0 && streak % 7 === 0) {
        const streakResult = await db.runAsync(
          'INSERT OR IGNORE INTO habit_bonus (local_day, kind, amount, paid, created_ms) VALUES (?, ?, ?, 0, ?)',
          [today, 'streak7', bonusAmounts.streak7, doneMs],
        );
        streakBonusPaid = streakResult.changes > 0;
        if (streakBonusPaid) {
          paidBonuses.push({ kind: 'streak7', amount: bonusAmounts.streak7 });
        }
      }

      // 장기 스트릭 마일스톤(14/30/60/100일, 2026-07-11 추가): 재계산된 스트릭 값이
      // 정확히 일치할 때만 지급. streak7과 달리 주기(%)가 아니라 1회성 마일스톤 —
      // local_day가 kind에 없으므로 스트릭이 끊겼다 같은 날짜 수만큼 재도달하면
      // 다른 local_day에서 자연히 재지급된다(의도된 동작). 같은 날 슬롯을 여러 번
      // 채워 이 블록에 재진입해도 UNIQUE(local_day,kind)가 중복 지급을 막는다.
      const MILESTONES: { days: number; kind: 'streak14' | 'streak30' | 'streak60' | 'streak100' }[] = [
        { days: 14, kind: 'streak14' },
        { days: 30, kind: 'streak30' },
        { days: 60, kind: 'streak60' },
        { days: 100, kind: 'streak100' },
      ];
      const milestone = MILESTONES.find((m) => m.days === streak);
      if (milestone) {
        const milestoneResult = await db.runAsync(
          'INSERT OR IGNORE INTO habit_bonus (local_day, kind, amount, paid, created_ms) VALUES (?, ?, ?, 0, ?)',
          [today, milestone.kind, bonusAmounts[milestone.kind], doneMs],
        );
        if (milestoneResult.changes > 0) {
          paidBonuses.push({ kind: milestone.kind, amount: bonusAmounts[milestone.kind] });
        }
      }
    }
  });

  // 트랜잭션 밖에서 남은 Day 재조회 — partRecorded가 false였던 경로(이미 통과한 Day를
  // 다시 훑은 경우)에서도 화면이 "남은 복습" 표시에 쓸 수 있도록 항상 채운다.
  const passedNowRows = await db.getAllAsync<{ day_id: number }>(
    'SELECT day_id FROM slot_part WHERE local_day = ? AND slot_index = ?',
    [today, slotIndex],
  );
  const passedNowSet = new Set(passedNowRows.map((r) => r.day_id));
  const remainingDayIds = req.requiredDayIds.filter((id) => !passedNowSet.has(id));

  const streakDays = await getCurrentStreak();

  return {
    partRecorded,
    slotCompleted,
    slotIndex,
    remainingDayIds,
    fullDayBonusPaid,
    streakBonusPaid,
    streakDays,
    paidBonuses,
  };
}

/**
 * habit_bonus 1행 (용돈 장부 연동, §7.4).
 * kind는 'full_day' | 'streak7' | 'slot_pass_0'~'slot_pass_3' | 'streak14' |
 * 'streak30' | 'streak60' | 'streak100' | 'review_day_{dayId}_s{slotIndex}' 중
 * 하나(2026-07-11 5종 추가, 2026-08-24 review_day_* 추가). slot_pass_N·review_day_*는
 * 슬롯 번호/Day id가 접미사로 붙는 동적 문자열이라 리터럴 유니온 대신 string으로 둔다.
 * 새 kind를 추가하면 app/achievements/index.tsx의 habitBonusLabel() 분기도 같이
 * 추가해야 장부에 원문자열이 노출되지 않는다(§7.6 미결 4 — 이 파일은 app/를 건드리지
 * 않으므로 후속 작업에서 처리할 것).
 */
export interface HabitBonusRow {
  id: number;
  local_day: number;
  kind: string;
  amount: number;
  paid: boolean;
  created_ms: number;
}

/** 'YYYY-MM' → 해당 월의 [시작 ms, 다음달 시작 ms) 범위. incomeQueries.currentMonthRangeMs와 동일한 로컬타임 방식. */
function monthRangeMs(yearMonth: string): { startMs: number; nextStartMs: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!match) {
    throw new Error('yearMonth는 "YYYY-MM" 형식이어야 합니다.');
  }
  const year = Number(match[1]);
  const month = Number(match[2]); // 1~12
  const start = new Date(year, month - 1, 1);
  const nextStart = new Date(year, month, 1);
  return { startMs: start.getTime(), nextStartMs: nextStart.getTime() };
}

/** 특정 월('YYYY-MM')의 habit_bonus 목록 (created_ms 로컬타임 기준, 최신순). */
export async function listHabitBonusesForMonth(yearMonth: string): Promise<HabitBonusRow[]> {
  const db = getUserDb();
  const { startMs, nextStartMs } = monthRangeMs(yearMonth);

  const rows = await db.getAllAsync<{
    id: number;
    local_day: number;
    kind: string;
    amount: number;
    paid: number;
    created_ms: number;
  }>(
    `SELECT id, local_day, kind, amount, paid, created_ms
     FROM habit_bonus
     WHERE created_ms >= ? AND created_ms < ?
     ORDER BY created_ms DESC`,
    [startMs, nextStartMs],
  );

  return rows.map((r) => ({
    id: r.id,
    local_day: r.local_day,
    kind: r.kind,
    amount: r.amount,
    paid: r.paid === 1,
    created_ms: r.created_ms,
  }));
}

/** 특정 월('YYYY-MM')의 habit_bonus 합계(원). */
export async function getMonthHabitBonusTotal(yearMonth: string): Promise<number> {
  const db = getUserDb();
  const { startMs, nextStartMs } = monthRangeMs(yearMonth);

  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM habit_bonus
     WHERE created_ms >= ? AND created_ms < ?`,
    [startMs, nextStartMs],
  );
  return row?.total ?? 0;
}

/**
 * 미지급(paid=0) habit_bonus 전체 기간 목록을 최신순으로 반환한다 (용돈 장부
 * "미지급 우선 + 펼치기" 개편용, getUnpaidIncomeSessions와 동일한 취지 —
 * 이번 달로 좁히면 지난달 미지급 보너스가 시야에서 사라진다).
 */
export async function listUnpaidHabitBonuses(): Promise<HabitBonusRow[]> {
  const db = getUserDb();

  const rows = await db.getAllAsync<{
    id: number;
    local_day: number;
    kind: string;
    amount: number;
    paid: number;
    created_ms: number;
  }>(
    `SELECT id, local_day, kind, amount, paid, created_ms
     FROM habit_bonus
     WHERE paid = 0
     ORDER BY created_ms DESC`,
  );

  return rows.map((r) => ({
    id: r.id,
    local_day: r.local_day,
    kind: r.kind,
    amount: r.amount,
    paid: r.paid === 1,
    created_ms: r.created_ms,
  }));
}

/** 습관 보너스 지급 여부 토글 (부모 지급 체크, test_session.paid와 동일 개념). */
export async function setHabitBonusPaid(id: number, paid: boolean): Promise<void> {
  const db = getUserDb();
  await db.runAsync('UPDATE habit_bonus SET paid = ? WHERE id = ?', [paid ? 1 : 0, id]);
}

/** deleteTodaySlotRecords()가 지운 행 수. */
export interface DeletedSlotRecords {
  parts: number; // slot_part (조각)
  sessions: number; // retrieval_session (슬롯 완성)
  bonuses: number; // habit_bonus (오늘 지급된 습관 보너스 전부)
}

/**
 * __DEV__ QA 전용 (2026-08-25): 오늘의 슬롯 기록 일체를 지워 처음부터 다시 테스트할 수
 * 있게 한다. deleteTodayTestSession()(lib/reviewQueries.ts)과 같은 취지 — 설정 화면의
 * 개발용 섹션에서만 호출되며 프로덕션 UI에는 진입점이 없다.
 *
 * 이게 없으면 슬롯을 한 번 채운 뒤 **다음 시간대가 열릴 때까지(최대 5시간)** 전구 점등·
 * 배너·동전·연쇄 버튼을 다시 볼 수 없다. 슬롯당 1회 제약이 DB 차원(UNIQUE)이라 화면
 * 조작으로는 우회가 불가능하기 때문.
 *
 * 지우는 것은 **오늘(local_day = todayEpochDay()) 것만**이다:
 * - `slot_part` — 조각. 지우면 전구가 꺼지고 복습 목록의 ✓도 사라진다.
 * - `retrieval_session` — 슬롯 완성. 지우면 오늘이 4/4에서 빠지므로 **스트릭도 오늘분만
 *   줄어든다**(어제까지의 기록은 그대로 — 스트릭은 로그에서 파생하므로 자동 반영).
 * - `habit_bonus` — 오늘 지급된 습관 보너스 전부. **부모가 이미 지급 체크(paid=1)한
 *   것도 함께 사라진다** — 개발용이라 감수한다.
 *
 * 테스트 수입(test_session)과 학습 진행(day_word.recall_stage)은 건드리지 않는다.
 */
export async function deleteTodaySlotRecords(): Promise<DeletedSlotRecords> {
  const db = getUserDb();
  const today = todayEpochDay();

  let parts = 0;
  let sessions = 0;
  let bonuses = 0;

  await db.withTransactionAsync(async () => {
    parts = (await db.runAsync('DELETE FROM slot_part WHERE local_day = ?', [today])).changes;
    sessions = (await db.runAsync('DELETE FROM retrieval_session WHERE local_day = ?', [today]))
      .changes;
    bonuses = (await db.runAsync('DELETE FROM habit_bonus WHERE local_day = ?', [today])).changes;
  });

  return { parts, sessions, bonuses };
}

/**
 * 지금까지 단어장 세션(슬롯 조각)을 한 번이라도 끝냈는가 — 홈 알림 opt-in 덮개의
 * 노출 조건 중 하나(첫 세션 이후에만 물어본다). `slot_part`에 행이 하나라도 있으면
 * true (날짜 무관 — 전체 이력 기준).
 */
export async function hasCompletedAnySession(): Promise<boolean> {
  const db = getUserDb();
  const row = await db.getFirstAsync<{ x: number }>('SELECT 1 AS x FROM slot_part LIMIT 1');
  return row != null;
}
