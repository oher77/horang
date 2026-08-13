---
name: horang-home-screen-renewal
description: Status of the Horang English home-screen renewal (tiger hero gestures, grass gauge) — what's built vs. what assets are still missing
metadata:
  type: project
---

Home screen renewal (design/홈화면-에셋-가이드.md) is being built by multiple parallel
workers in the same session (2026-08-11): one on `components/home/GrassGauge.tsx`
(see [[grass-gauge-bulb-alignment]]), one on `components/home/TigerHero.tsx` +
`components/home/useTigerGestures.ts` + `lib/tigerSounds.ts` (this entry), one on
`app/index.tsx` wiring them together.

**Tiger hero gesture system** (`components/home/TigerHero.tsx`,
`components/home/useTigerGestures.ts`, `lib/tigerSounds.ts`):

- Real layered structure implemented: `tiger-body.png` (static) +
  `tiger-face-normal.png` + `tiger-eye-shut.png` (both inside an animated head
  container, pivoting around axis (532,285) per guide §2). All three are
  1060×1111 canvases that stack at (0,0) with no coordinate math needed.
- 5 gestures implemented per guide §2-8: tap, tripleTap (3 taps in 1.2s),
  pet (horizontal swipe, `activeOffsetX`/`failOffsetY` — no angle math in code),
  petLong (pet held ≥1.5s), headPop (`Gesture.LongPress` press-and-release).
- Idle eye-blink implemented (110ms hard cut, 3.5–6.5s random interval, 25%
  double-blink) — paused (skipped, not truly stopped/resumed) whenever an event
  animation or petting is active.
- `useTigerGestures` is asset/animation-agnostic by design — it only emits the
  5-value `TigerEvent` union plus two lifecycle callbacks (`onPetEnd`,
  `onPressStateChange`) needed because pet/long-press are hold-and-release
  gestures, not fire-and-forget pulses. All actual `withTiming`/`withSequence`
  transform math lives in `TigerHero.tsx`.

**Still missing (as of 2026-08-11)**: `tiger-face-yawn1.png`, `tiger-face-yawn2.png`,
`tiger-claws.png`, and all 4 sound files (`roar/purr/huh/yelp.m4a`). `petLong`
(하품) currently plays head-motion-only (rotate −6°, translateY −8px per §2-7's
head-motion sub-timeline) with no mouth animation or claws — swap point is
commented as `PET_LONG_TODO` in `TigerHero.tsx`. `lib/tigerSounds.ts` is a
`__DEV__`-console-log no-op; the file's own header comment documents exactly
what to fill in once `expo-audio` + sound files land (don't add `expo-av`, it's
deprecated on SDK 54). `expo-haptics` is also not yet in `package.json` — the
haptic call in `useTigerGestures.ts` is commented out and no-ops, per the
Expo Go native-module guardrail (don't add packages speculatively).

**How to apply**: before touching tiger hero code again, check
`git log --oneline -- assets/images/tiger-*.png` to see if more asset files
have landed since this memory was written — see [[stale-git-status-snapshot]]
for why the orchestrator's initial asset-inventory claim can't be trusted at
face value.
