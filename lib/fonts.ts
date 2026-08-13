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
