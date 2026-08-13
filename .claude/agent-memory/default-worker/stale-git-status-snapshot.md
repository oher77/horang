---
name: stale-git-status-snapshot
description: The git status/asset-inventory given at task assignment can go stale mid-session in this multi-worker project — verify with git log/ls before trusting "asset X doesn't exist" claims
metadata:
  type: feedback
---

On 2026-08-11, a worker task for `components/home/TigerHero.tsx` was assigned
with an explicit premise: "only `tiger_hero.png` exists, `tiger-body.png` /
`tiger-face-normal.png` / `tiger-eye-shut.png` are unmade — build a whole-image
transform fallback." Checking `git log --oneline -- assets/images/tiger-body.png
...` before writing any code showed commit `071dd80` had already added exactly
those three files (correct 1060×1111 canvas, correct content bounding boxes)
— the task's premise was simply out of date relative to the repo's actual
current state.

**Why**: this project runs several `default-worker`/other-agent sessions in
parallel against the same working tree during a single orchestration round
(see [[horang-home-screen-renewal]]). Assets and code can land from a sibling
worker or the user between when the orchestrator composed a task's context and
when this worker actually starts executing it. The `gitStatus` block injected
at conversation start is a snapshot, not a live view.

**How to apply**: for any task whose instructions assert "file X doesn't exist
yet" or "asset Y hasn't arrived," don't take that as given if the task is about
to build a fallback for that absence — run `git log --oneline -- <path>` and/or
`ls`/`Glob` on the actual paths first. If the premise turns out wrong, prefer
building against the *real*, more-complete current state (it's strictly better
engineering and avoids throwaway work) rather than the stale fallback — but
flag the discrepancy explicitly in the completion report rather than silently
deviating. In this instance the orchestrator was notified independently and
sent a correction mid-task confirming the same finding, which validated this
approach.
