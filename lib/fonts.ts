/**
 * 앱 전역 손글씨 폰트 (design/홈화면-에셋-가이드.md §5).
 *
 * 딸 시안의 글씨체와 맞추기 위한 폰트다. 로딩은 `app/_layout.tsx`의 초기화 게이트에서
 * 한 번에 처리하므로(깜빡임 방지) 화면 쪽에서는 이 상수만 쓰면 된다.
 *
 * `assets/fonts/`에 후보 폰트가 여러 개 들어 있다 — 실기기에서 비교해 보고 고르려고
 * 미리 넣어둔 것이다. **바꾸려면 아래 두 줄만 고치면 된다.**
 */
export const HANDWRITING_FONT = 'NanumJungHagSaeng';

export const FONT_ASSETS = {
  [HANDWRITING_FONT]: require('../assets/fonts/NanumJungHagSaeng.ttf'),
} as const;

/**
 * ── 손글씨 폰트의 세로 지표 — **폰트를 바꾸면 이 두 값만 다시 재면 된다** ──────
 *
 * 글자를 "시안의 글자 중심"에 정확히 놓기 위한 값이다. 예전에는 항목마다 실측 보정값을
 * 하나씩 박아뒀는데(7개), 폰트를 바꾸면 전부 다시 재야 해서 이 방식으로 바꿨다.
 *
 * `lineHeightEm` — 폰트 자연 줄높이 = (hhea ascender − descender + lineGap) / unitsPerEm.
 *   **이보다 작게 주면 iOS가 베이스라인을 재배치해 글자가 아래로 밀린다.**
 *   (`lineHeight: fontSize`(=1.0em)로 뒀다가 실제로 0.13~0.23em씩 밀렸다 — 2026-08-14)
 *
 * `glyphCenterEm` — 글자 잉크의 세로 중심이 줄 상자 top에서 떨어진 거리.
 *   줄 상자 중심(= lineHeightEm/2)과 다르다. ascent가 크면 글자가 상자 위쪽에 몰려
 *   잉크 중심이 아래로 내려간다.
 *
 * NanumJungHagSaeng:
 *   `lineHeightEm` 1.15 — TTF hhea에서 계산 (ascent 0.920 − descent −0.230).
 *   `glyphCenterEm` 0.820 — **실기기 스크린샷 측정값.**
 *
 * ★ `glyphCenterEm`은 TTF에서 계산하면 안 된다. TTF 지표 + 데스크톱 렌더로 구하면
 *   0.675가 나오는데 iOS 실제 값은 0.820이었다(2026-08-14). 렌더러마다 줄 상자 안에서
 *   베이스라인을 잡는 방식이 달라서다. **반드시 기기 화면을 재서 구할 것.**
 *
 * 다른 폰트로 바꿀 때 (한 번만 하면 된다):
 *   1. `lineHeightEm` — 새 TTF의 hhea에서 (ascender − descender + lineGap) / unitsPerEm
 *   2. `glyphCenterEm` — 일단 대충 넣고 빌드 → 기기 스크린샷을 시안과 비교해
 *      "글자가 목표보다 N px 아래" 를 재고, `현재값 + N / fontSize` 로 확정.
 *      크기가 다른 글자 여러 개로 재면 같은 값으로 수렴하는지 확인할 수 있다
 *      (2026-08-14 실측: 87/150/233px 다섯 군데가 0.801~0.836으로 수렴, 평균 0.820).
 */
export const HANDWRITING_METRICS = {
  lineHeightEm: 1.15,
  glyphCenterEm: 0.82,
} as const;

/**
 * 글자 잉크 중심이 `centerY`에 오도록 `<Text>`의 `top`을 구한다.
 * 입력·출력 모두 **디자인 px** — 화면에 쓸 때 scale을 곱한다.
 */
export function handwritingTop(centerY: number, fontSize: number): number {
  return centerY - HANDWRITING_METRICS.glyphCenterEm * fontSize;
}

/** 압축(=글자 밀림)을 피하는 줄 높이. 디자인 px. */
export function handwritingLineHeight(fontSize: number): number {
  return HANDWRITING_METRICS.lineHeightEm * fontSize;
}
