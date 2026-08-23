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
 * NanumJungHagSaeng (아래 두 값 모두 **텍스트 크기 배율 1.0, `allowFontScaling={false}`
 * 전제**에서만 유효하다 — 다른 배율에서 잰 값은 아래 ★ 참조):
 *   `lineHeightEm` 1.15 — TTF hhea에서 계산 (ascent 0.920 − descent −0.230).
 *   `glyphCenterEm` 0.65 — TTF 계산값 0.675에서 실기기를 보고 살짝 내린 값(2026-08-23).
 *   계산값보다 작다 = 글자를 계산 위치보다 조금 아래에 놓는다는 뜻이다.
 *
 * ☞ **조정 방향**: 값을 **키우면 글자가 올라가고, 줄이면 내려간다**
 *   (`top = centerY − glyphCenterEm × fontSize`이므로 값이 클수록 top이 작아진다).
 *   이동량은 `Δ × fontSize`라 **큰 글자가 더 많이 움직인다** — 0.025를 바꾸면
 *   "DAY N"(288)은 7px, 날짜·단어수(107)는 2.7px 움직인다.
 *   그래서 **한 항목만 어긋나 보이면 이 상수가 아니라 그 항목의 `centerY`를 고칠 것.**
 *   이 상수는 전 항목이 같은 방향으로 치우쳤을 때만 손댄다.
 *
 * ★ 2026-08-14에 한 번 0.820으로 잘못 고쳤던 이력: 실기기 스크린샷을 쟀더니
 *   0.801~0.836(평균 0.820)이 나와서 "TTF 계산은 틀렸다, 기기를 재야 한다"고
 *   결론 내렸는데, 원인은 **측정한 기기의 iOS "텍스트 크기" 설정이 1.235배로
 *   켜져 있었던 것**이었다(당시 `<Text>`에 `allowFontScaling`을 안 걸어둬서 이
 *   설정이 그대로 반영됐다). 0.675 × 1.235 = 0.834 — 실측 범위와 정확히 맞아떨어진다.
 *   즉 **TTF 계산이 틀린 게 아니라 측정 조건(배율)을 통제하지 않은 것이 틀렸다.**
 *   지금은 모든 `<Text>`에 `allowFontScaling={false}`를 걸어 OS 배율이 레이아웃에
 *   개입하지 못하게 막았으므로, 계산값 0.675로 되돌린다.
 *
 * 다른 폰트로 바꿀 때 (한 번만 하면 된다):
 *   1. `lineHeightEm` — 새 TTF의 hhea에서 (ascender − descender + lineGap) / unitsPerEm
 *   2. `glyphCenterEm` — 일단 TTF 지표로 계산해 넣고 빌드 → 기기 스크린샷을 시안과
 *      비교해 "글자가 목표보다 N px 아래" 를 재고, `현재값 + N / fontSize` 로 보정.
 *      **다시 잴 때는 반드시 텍스트 크기 슬라이더를 4번째(정중앙, 배율 1.0)에 두고,
 *      대상 `<Text>`에 `allowFontScaling={false}`가 걸려 있는지 먼저 확인할 것** —
 *      그렇지 않으면 이번처럼 배율이 섞여 들어간 오염값을 재측정하게 된다.
 *      크기가 다른 글자 여러 개로 재면 같은 값으로 수렴하는지 확인할 수 있다.
 */
export const HANDWRITING_METRICS = {
  lineHeightEm: 1.15,
  glyphCenterEm: 0.65,
} as const;

/**
 * ── 손글씨 전체 크기 손잡이 ─────────────────────────────────────────────
 *
 * 홈·스플래시 손글씨 `fontSize`에 일괄로 곱해지는 배수. **기본값 1 — 지금은 각
 * `fontSize` 상수 자체가 이미 최종 크기다.** 전체를 한꺼번에 키우거나 줄이고 싶을
 * 때만 건드린다(폰트를 바꿔 체감 크기가 달라졌을 때 등). 항목 하나만 조절하려면
 * 이게 아니라 그 항목의 `fontSize`를 고칠 것.
 *
 * ── 왜 이런 손잡이가 있나 (2026-08-22~23) ────────────────────────────
 * 원래 fontSize 값(87 / 233 / 150 / 133 / 167 / 95 / 26)은 개발 기기에서 눈으로
 * 튜닝한 것인데, 그 기기의 iOS "텍스트 크기" 설정이 **1.235배**(슬라이더 6/7)로
 * 켜져 있었고 당시엔 `allowFontScaling`을 막아두지 않아 화면엔 그 배율이 곱해져
 * 나왔다. 즉 **그 숫자들은 "화면에 보이던 크기"가 아니었다.**
 * 배율을 차단하면서 1.235를 이 상수에 담아 보정했다가, **신경 쓸 숫자를 남기지
 * 않으려고 각 fontSize에 반올림해 흡수시켰다**(2026-08-23):
 *   87 → 107 · 233 → 288 · 150 → 185 · 133 → 164 · 167 → 206 · 95 → 117 · 26 → 32
 * 그래서 지금 이 값은 1이다. 반올림 오차는 최대 0.45 디자인 px(0.15pt)로 무시된다.
 *
 * ★ 이 값은 `glyphCenterEm`과 **역할이 다르다.** `glyphCenterEm`은 폰트의 성질이라
 *   폰트를 바꿀 때만 달라지고, 이 값은 "얼마나 크게 보이고 싶은가"라는 디자인
 *   결정이다. 예전 `glyphCenterEm` 0.82는 이 둘이 섞인 잡종이었다(0.675 × 1.235
 *   = 0.834). 섞어서 쓰면 크기를 바꿀 때마다 위치가 틀어진다.
 *
 * 쓰는 법: **fontSize 상수 정의부에서 한 번만 곱한다.** 사용처에서 곱하지 말 것 —
 * `handwritingTop()`·`handwritingLineHeight()`가 같은 fontSize를 읽어가야 위치가
 * 맞는데, 사용처에서 곱하면 셋 중 하나를 빠뜨리기 쉽다.
 */
export const HANDWRITING_TUNED_SCALE = 1;

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
