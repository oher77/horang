/**
 * 호랑이 제스처 사운드 (design/홈화면-에셋-가이드.md §0, §2-4).
 *
 * 사운드 파일(assets/sounds/{roar,purr,huh,yelp}.m4a)이 아직 없다 — 딸이 직접 녹음
 * 예정. 지금은 재생 없이 __DEV__에서 콘솔 로그만 남기는 no-op이다.
 *
 * ── 파일 도착 후 채울 것 ──────────────────────────────────────────────
 * - `expo-audio` 사용 (expo-av는 SDK 54에서 deprecated). 아직 설치되지 않았으므로
 *   import·설치는 이 파일이 아니라 별도 작업에서 한다 (Expo Go 가드레일 — 새 네이티브
 *   의존성은 임의로 추가하지 않는다).
 * - 앱 시작 시(App.tsx 또는 _layout.tsx) 4개 사운드를 미리 로드해 둘 것 — 탭 후 로딩되면
 *   그림과 소리가 어긋난다.
 * - `setAudioModeAsync({ playsInSilentMode: true })` 필요 — iOS 무음 스위치가 기본값이면
 *   소리가 아예 안 난다.
 * - `playTigerSound()` 호출 시 이전 소리를 반드시 멈추고 재생할 것 (이 앱의 기존 TTS
 *   패턴과 동일: stop() 후 play()). §2-4 "재생 중이면 재요청 무시" 같은 세부 규칙은
 *   이벤트별로 다르므로(예: pet은 재생 중 재요청 무시, tap은 매번 새로 재생) 호출부
 *   (TigerHero.tsx)에서 판단하고 이 함수는 단순 재생/정지만 담당하게 유지할 것.
 */
export type TigerSound = 'roar' | 'purr' | 'huh' | 'yelp';

export function playTigerSound(sound: TigerSound): void {
  if (__DEV__) {
    console.log(`[TigerSound] play "${sound}" (no-op — 사운드 파일 미도착)`);
  }
}

export function stopTigerSound(): void {
  if (__DEV__) {
    console.log('[TigerSound] stop (no-op — 사운드 파일 미도착)');
  }
}
