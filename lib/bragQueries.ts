/**
 * 자랑하기 리포트 데이터 집계 (설계.md §6-13).
 *
 * 화면([app/brag/index.tsx])에서 로직을 분리하기 위한 얇은 집계 레이어. 기존 통계
 * 쿼리(getCurrentStreak / getWordStateTrend / getRecentScores 등)를 조합하고, 최근
 * WINDOW_DAYS 기준 델타를 계산한다. 자랑 카드에는 긍정 지표만 싣는다는 원칙에 따라
 * "정복 수"(안 외운 단어 감소분)는 양수일 때만 자랑 대상이 되도록 그대로 반환하고,
 * 표시 여부 판단은 화면이 한다.
 *
 * 주간 인출 미션·학습 단어 수는 다른 화면에서 쓰지 않는 이 리포트 전용 집계라 여기에
 * 로컬 쿼리로 둔다.
 */

import { toEpochDay, todayEpochDay } from './dates';
import { getUserDb } from './db';
import { getCurrentStreak, getMonthHabitBonusTotal, listUnpaidHabitBonuses } from './habitQueries';
import { getMonthIncomeTotal, getUnpaidIncomeSessions } from './incomeQueries';
import {
  getPronunciationLedger,
  getRecentScores,
  getWordStateTrend,
  type RecentScore,
  type WordStatePoint,
} from './statsQueries';

/** 자랑 리포트 집계 결과. */
export interface BragReport {
  /** 연속 학습 일수 (4/4 달성 기준, §7.5). */
  streak: number;
  /** 현재 시점 "최신 결과가 정답"인 고유 단어 수(= 장기기억에 저장된 단어). */
  memorizedNow: number;
  /** 최근 WINDOW_DAYS 동안의 정답 단어 증가분(음수 가능 — 화면에서 +일 때만 강조). */
  memorizedDelta: number;
  /** 최근 WINDOW_DAYS 동안의 "안 외운 단어" 감소분을 양수로(= 이번 주에 정복한 단어 수). 음수면 자랑 대상 아님. */
  conqueredCount: number;
  /** 정답 단어 일별 추이(차트용, 오래된→최신). */
  memorizedTrend: WordStatePoint[];
  /** 최근 5일 테스트 점수(최신순 — 화면에서 뒤집어 시간순 렌더). */
  recentScores: RecentScore[];
  /** 최근 점수 평균(점수 있는 세션 기준, 반올림). 점수 없으면 null. */
  scoreAvg: number | null;
  /** 최근 점수 최고값. 점수 없으면 null. */
  scoreBest: number | null;
  /** 최근 WINDOW_DAYS 안에 "외워짐"으로 해소된 발음 단어 수(= 이번 주에 정복한 발음). */
  pronResolvedRecent: number;
  /** 누적 해소된 발음 단어 수(캡션 보조 표기용). */
  pronResolvedTotal: number;
  /**
   * 이번 달 획득 용돈 합계(테스트 수입 + 습관 보너스). 다른 지표는 주간이지만 주간
   * 합계 쿼리가 없고 월 쿼리(getMonthIncomeTotal/getMonthHabitBonusTotal)가 이미
   * 있으므로 월 기준으로 낸다 — 화면에서 "이번 달"임을 명시해 표기한다.
   */
  monthIncomeTotal: number;
  /** 이번 주에 완료한 인출 미션(슬롯) 수. */
  missionDone: number;
  /** 같은 기간의 미션 정원(실제 사용한 날 × 4). 사용 전 날짜는 분모에서 제외한다. */
  missionTotal: number;
  /** 지금까지 배운 단어 수(학습을 시작한 단어장 기준). */
  learnedWordsTotal: number;
  /** 그중 이번 주에 새로 배운 단어 수. */
  learnedWordsRecent: number;
  /** 아직 지급되지 않은 용돈 합계(테스트 수입 + 습관 보너스, 전체 기간). */
  unpaidTotal: number;
  /** 미지급 건수. */
  unpaidCount: number;
  /** 이번 달(1일 이후) 새로 암기한 단어 수. 단어당 비용의 분모. */
  monthMemorizedGain: number;
  /**
   * 이번 달 암기 단어 1개당 든 용돈(원, 반올림). monthIncomeTotal ÷ monthMemorizedGain.
   * 둘 중 하나라도 0 이하면 계산이 무의미하므로 null.
   */
  costPerWord: number | null;
}

/** 델타 계산 창(일). "이번 주" = 오늘 포함 최근 7일(화면 기간 라벨과 동일 구간). */
export const WINDOW_DAYS = 7;

/** 하루 인출 슬롯 수 (§7.1 — 하루 4회 분산 인출). */
const SLOTS_PER_DAY = 4;

/**
 * 추이 조회 길이(일). 캘린더 월 시작 직전(최대 31일 전)까지 반드시 포함해야
 * "이번 달 증가분"을 계산할 수 있으므로 한 달보다 넉넉히 잡는다.
 */
const TREND_DAYS = 40;

/** 'YYYY-MM' 이번 달 키 (로컬타임). habit_bonus 월 합계 조회용. */
function currentYearMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 이번 달 1일의 epoch day (로컬 기준). */
function monthStartEpochDay(): number {
  const d = new Date();
  return toEpochDay(new Date(d.getFullYear(), d.getMonth(), 1));
}

/**
 * 이번 주 인출 미션 달성 현황 (retrieval_session 주간 집계).
 *
 * 분모는 단순히 WINDOW_DAYS × 4로 두지 않는다 — 앱을 쓰기 시작한 지 며칠 안 된 사용자가
 * "28칸 중 8칸"처럼 부당하게 낮아 보이기 때문. 실제 사용 시작일(MIN(local_day))과 창
 * 시작일 중 늦은 쪽부터 오늘까지의 일수만 정원으로 센다.
 */
async function getWeeklyMissionStats(
  windowStartDay: number,
  today: number,
): Promise<{ done: number; total: number }> {
  const db = getUserDb();
  const [doneRow, firstRow] = await Promise.all([
    db.getFirstAsync<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM retrieval_session WHERE local_day >= ?',
      [windowStartDay],
    ),
    db.getFirstAsync<{ first_day: number | null }>(
      'SELECT MIN(local_day) AS first_day FROM retrieval_session',
    ),
  ]);

  const done = doneRow?.cnt ?? 0;
  const firstDay = firstRow?.first_day ?? null;
  if (firstDay === null) return { done: 0, total: 0 };

  const effectiveStart = Math.max(windowStartDay, firstDay);
  const activeDays = Math.max(1, today - effectiveStart + 1);
  return { done, total: activeDays * SLOTS_PER_DAY };
}

/**
 * 배운 단어 수 (누적/이번 주). day_word 전체가 아니라 **학습을 시작한**(day.is_started=1)
 * 단어장의 단어만 센다 — 오늘 자동 생성만 되고 아직 열어보지 않은 단어장을 "배웠다"고
 * 셀 수는 없기 때문.
 */
async function getLearnedWordStats(
  windowStartDay: number,
): Promise<{ total: number; recent: number }> {
  const db = getUserDb();
  const [totalRow, recentRow] = await Promise.all([
    db.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM day_word dw JOIN day d ON d.id = dw.day_id
       WHERE d.is_started = 1`,
    ),
    db.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM day_word dw JOIN day d ON d.id = dw.day_id
       WHERE d.is_started = 1 AND d.created_day >= ?`,
      [windowStartDay],
    ),
  ]);

  return { total: totalRow?.cnt ?? 0, recent: recentRow?.cnt ?? 0 };
}

/** 자랑 리포트에 필요한 모든 지표를 한 번에 집계한다. */
export async function getBragReport(): Promise<BragReport> {
  // 창 구간은 화면 기간 라벨(오늘 포함 최근 7일)과 동일하게 잡는다.
  const today = todayEpochDay();
  const windowStartDay = today - (WINDOW_DAYS - 1);

  const [
    streak,
    trend,
    recentScores,
    pronLedger,
    testIncome,
    habitBonusIncome,
    mission,
    learned,
    unpaidSessions,
    unpaidBonuses,
  ] = await Promise.all([
    getCurrentStreak(),
    getWordStateTrend(TREND_DAYS),
    getRecentScores(),
    getPronunciationLedger(),
    getMonthIncomeTotal(),
    getMonthHabitBonusTotal(currentYearMonth()),
    getWeeklyMissionStats(windowStartDay, today),
    getLearnedWordStats(windowStartDay),
    getUnpaidIncomeSessions(),
    listUnpaidHabitBonuses(),
  ]);

  // trend는 오래된→최신 순의 연속 일별 시리즈(길이 30). 마지막이 오늘, WINDOW_DAYS 전은
  // 인덱스 (length-1-WINDOW_DAYS). 창보다 데이터가 짧으면 첫 포인트를 기준으로 삼는다.
  const last = trend.length > 0 ? trend[trend.length - 1] : null;
  const baseIndex = Math.max(0, trend.length - 1 - WINDOW_DAYS);
  const base = trend.length > 0 ? trend[baseIndex] : null;

  const memorizedNow = last?.correctCount ?? 0;
  const memorizedDelta = last && base ? last.correctCount - base.correctCount : 0;
  // 안 외운 단어(wrongCount)의 감소분을 양수로 뒤집는다 → "정복한 단어 수".
  const conqueredCount = last && base ? base.wrongCount - last.wrongCount : 0;

  const scored = recentScores.filter((s): s is RecentScore & { score100: number } => s.score100 !== null);
  const scoreAvg =
    scored.length > 0 ? Math.round(scored.reduce((sum, s) => sum + s.score100, 0) / scored.length) : null;
  const scoreBest = scored.length > 0 ? Math.max(...scored.map((s) => s.score100)) : null;

  // 발음 정복: 해소 목록(resolved) 중 해소 시각이 이번 주 구간에 든 것만 센다.
  const pronResolvedTotal = pronLedger.resolved.length;
  const pronResolvedRecent = pronLedger.resolved.filter(
    (w) => w.resolved_ms !== null && toEpochDay(new Date(w.resolved_ms)) >= windowStartDay,
  ).length;

  // 미지급 용돈: 두 미지급 쿼리 모두 기간 제한 없는 전체 기간 목록이라 그대로 합산한다.
  const unpaidTotal =
    unpaidSessions.reduce((sum, s) => sum + (s.incomeAmount ?? 0), 0) +
    unpaidBonuses.reduce((sum, b) => sum + b.amount, 0);
  const unpaidCount = unpaidSessions.length + unpaidBonuses.length;

  // 단어당 비용 — 용돈이 이번 달 기준이므로 분모도 이번 달 증가분으로 맞춘다.
  // 기준선은 전월 말일(= 1일 직전)이라야 "이번 달에 늘어난 양"이 된다.
  const baselineDay = monthStartEpochDay() - 1;
  const baseline = trend.find((p) => p.day === baselineDay) ?? trend[0] ?? null;
  const monthMemorizedGain = last && baseline ? last.correctCount - baseline.correctCount : 0;
  const monthIncomeTotal = testIncome + habitBonusIncome;
  const costPerWord =
    monthMemorizedGain > 0 && monthIncomeTotal > 0
      ? Math.round(monthIncomeTotal / monthMemorizedGain)
      : null;

  return {
    streak,
    memorizedNow,
    memorizedDelta,
    conqueredCount,
    memorizedTrend: trend,
    recentScores,
    scoreAvg,
    scoreBest,
    pronResolvedRecent,
    pronResolvedTotal,
    monthIncomeTotal,
    missionDone: mission.done,
    missionTotal: mission.total,
    learnedWordsTotal: learned.total,
    learnedWordsRecent: learned.recent,
    unpaidTotal,
    unpaidCount,
    monthMemorizedGain,
    costPerWord,
  };
}
