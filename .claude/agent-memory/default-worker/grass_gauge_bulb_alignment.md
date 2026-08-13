---
name: grass-gauge-bulb-alignment
description: How bulb sockets in grass-box.png were measured/aligned with bulbs.png and bulb-glow.png for the home screen habit gauge
metadata:
  type: project
---

`components/home/GrassGauge.tsx` implements the 3-layer bulb gauge from
`design/홈화면-에셋-가이드.md` §1. The guide gives a formula for bulb centers
*within bulbs.png's own width* (12.5/37.5/62.5/87.5%) but never states where
`bulbs.png` sits on top of `grass-box.png` — that offset had to be measured.

**Non-obvious finding**: the 4 "gray" bulb-socket shapes visible in
`assets/images/grass-box.png` are not actually gray pixels — they are
semi-transparent black (`rgb(0,0,0)` at ~alpha 60-90/255) brush strokes over
the green grass, which only *look* gray when composited on a white viewer
background. A naive "find gray pixels" script (r≈g≈b, mid-brightness) finds
nothing; you have to threshold on near-black RGB with low-but-nonzero alpha.

**Why**: needed to programmatically find the bounding box of the socket group
to position the `bulbs.png` overlay and `bulb-glow.png` correctly, since the
guide only specifies the intra-image formula, not the placement on the
background.

**How to apply**: If the bulb art is redrawn or re-measured later, reuse this
approach — threshold `r<40 & g<40 & b<40 & alpha>15` (via PIL/numpy) rather
than looking for literal gray. Measured result baked into `GrassGauge.tsx` as
the `BULB_REGION` constant (`left: 0.154, top: 0.399, width: 0.685` as
fractions of grass-box.png's own 928×619 canvas). This is flagged in the
component's own comments as needing real-device tuning — the 4 sockets are
hand-drawn and not perfectly evenly spaced (measured centers ≈ 22.1% / 40.6%
/ 58.5% / 77.1% of grass-box width, vs. the idealized uniform 12.5/37.5/62.5/
87.5% the guide's formula assumes for bulbs.png alone).

Related: [[horang-home-screen-renewal]] (project memory to be filed by
whichever agent next touches the home screen).
