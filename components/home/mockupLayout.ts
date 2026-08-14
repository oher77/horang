/**
 * 홈 화면 배치 — `design/호랑이잉글리시.png`(1179 × 3333) 좌표가 원본이다.
 *
 * ── 왜 절대좌표인가 ────────────────────────────────────────────────────
 * 에셋을 시안에서 **1:1로 잘라냈고**(에셋마다 투명 여백도 없음), 아래 좌표는
 * 각 에셋을 시안 이미지에 대고 **템플릿 매칭**해 찾은 실측값이다(버튼 3종은
 * 오차 0.9~1.6/px = 사실상 정확).
 *
 * 세로 나열 + 간격(gap)으로 재현할 수 없다. 시안에서 **잔디가 호랑이 발을 167px
 * 덮고 있어서**(y: 호랑이 431~1542, 잔디 1369~1988) 간격 방식으로는 표현이 안 된다.
 * `%`나 `gap`을 어림잡다가 실제로 레이아웃이 무너졌다(2026-08-11).
 *
 * ── 쓰는 법 ───────────────────────────────────────────────────────────
 *   const s = screenWidth / MOCKUP.width;      // 시안 px → 화면 px
 *   style={{ position:'absolute', left: P.x*s, top: (P.y - MOCKUP.topInset)*s,
 *            width: P.w*s, height: P.h*s }}
 *
 * ── 렌더 순서 주의 ────────────────────────────────────────────────────
 * **잔디를 호랑이보다 나중에** 그린다 — 시안에서 잔디가 호랑이 발을 덮는다.
 * (2026-08-14 정정. 그 전엔 반대로 알고 순서가 뒤바뀌어 있어 호랑이가 잔디 위에
 *  떠 있는 것처럼 보였다.)
 *
 * 잔디 이미지 위쪽은 풀잎 끝이라 거의 투명해서, 순서만 바꾸면 발이 풀 사이로 비치는
 * 시안 모습이 그대로 나온다 — 마스킹 같은 건 필요 없다.
 * 겹치는 구간(시안 y 1369–1542)에 든 호랑이 부분은 발과 말풍선 아래 끝 16px뿐이고,
 * `GrassGauge`가 `pointerEvents="none"`이라 터치는 그대로 통과한다.
 */

export const MOCKUP = {
  width: 1179,
  height: 3333,
  /** 시안 상단의 다이나믹 아일랜드 그림이 끝나는 y. 화면 좌표로 옮길 때 이만큼 뺀다. */
  topInset: 140,
} as const;

export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const PLACE = {
  sun: { x: 57, y: 222, w: 251, h: 227 },
  tiger: { x: 58, y: 431, w: 1060, h: 1111 },
  grass: { x: 130, y: 1369, w: 928, h: 619 },
  review: { x: 157, y: 2015, w: 866, h: 247 },
  pronunciation: { x: 133, y: 2264, w: 867, h: 248 },
  test: { x: 129, y: 2527, w: 875, h: 248 },
  flower: { x: 270, y: 2899, w: 135, h: 171 },
  ribbon: { x: 732, y: 2901, w: 176, h: 190 },
  mountains: { x: 0, y: 3192, w: 1179, h: 141 },
} as const satisfies Record<string, Placement>;

/** 시안 절대좌표 → 화면 스타일. `s`는 `screenWidth / MOCKUP.width`. */
export function place(p: Placement, s: number) {
  return {
    position: 'absolute' as const,
    left: p.x * s,
    top: (p.y - MOCKUP.topInset) * s,
    width: p.w * s,
    height: p.h * s,
  };
}

/** 캔버스 전체 높이(화면 px). 시안이 화면보다 길어 세로 스크롤된다(가이드 §7). */
export function canvasHeight(s: number) {
  return (MOCKUP.height - MOCKUP.topInset) * s;
}
