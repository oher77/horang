#!/bin/bash
# Stop/SubagentStop 훅: 턴 종료 시점에 전체 타입체크 1회.
# 원래 PostToolUse(Edit|Write)마다 실행했으나, 다중 Edit 연쇄의 중간 상태(스타일
# 추가 전에 JSX가 먼저 저장된 시점 등)를 에러로 통보하는 오탐이 잦아 2026-07-11
# 턴 종료 검사로 이동. "워커가 검증을 깜빡해도 시스템이 잡는다"는 본래 목적은
# 턴 종료 1회 검사로 충분히 달성된다.
# 실패 시 exit 2 → stderr가 모델에게 전달돼 턴이 이어진다.

INPUT=$(cat)
# 이 훅의 통보로 이미 이어진 턴이면 재검사하지 않는다 (무한 루프 방지).
ACTIVE=$(printf '%s' "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('stop_hook_active', False))" 2>/dev/null)
[ "$ACTIVE" = "True" ] && exit 0

cd "$(dirname "$0")/../.." || exit 0

# 작업 트리에 수정/신규 .ts·.tsx가 없으면 tsc를 건너뛴다 (TS 무관 턴의 낭비 방지).
if ! git status --porcelain 2>/dev/null | grep -qE '\.tsx?$'; then
  exit 0
fi

OUT=$(npx tsc --noEmit 2>&1)
if [ $? -ne 0 ]; then
  {
    echo "[자동 타입체크] 턴 종료 검사에서 tsc --noEmit 실패:"
    echo "$OUT" | head -30
  } >&2
  exit 2
fi
exit 0
