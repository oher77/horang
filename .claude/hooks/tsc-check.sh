#!/bin/bash
# PostToolUse(Edit|Write) 훅: .ts/.tsx 파일 수정 시 프로젝트 전체 타입체크.
# 실패하면 exit 2 → 모델에게 에러 내용이 전달된다 (asyncRewake).
# 워커(서브에이전트)가 검증을 깜빡해도 시스템이 잡아주는 층.

FP=$(python3 -c "import json,sys; print((json.load(sys.stdin).get('tool_input') or {}).get('file_path',''))" 2>/dev/null)

case "$FP" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

cd "$(dirname "$0")/../.." || exit 0

OUT=$(npx tsc --noEmit 2>&1)
STATUS=$?
if [ $STATUS -ne 0 ]; then
  echo "[자동 타입체크] tsc --noEmit 실패 (수정 파일: ${FP}):"
  echo "$OUT" | head -30
  exit 2
fi
exit 0
