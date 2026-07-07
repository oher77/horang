---
name: content-pipeline
description: 뜻·예문 콘텐츠 생성 파이프라인 운영 절차 — Claude Batch API 제출/상태확인/결과회수/검증/content.db 빌드. 배치 관련 작업(제출, 상태 확인, 결과 가져오기, DB 교체)을 할 때 사용.
---

# 콘텐츠 생성 파이프라인 운영 매뉴얼

원본 정제(clean.py)부터 content.db까지의 전체 흐름은 설계.md §3. 이 문서는 실행 절차만 다룬다.

## 사전 조건

- API 키: `.claude/settings.local.json`의 `env.ANTHROPIC_API_KEY`에 저장돼 있음. 각 명령 앞에 이렇게 주입:
  ```bash
  export ANTHROPIC_API_KEY=$(python3 -c "import json; print(json.load(open('.claude/settings.local.json'))['env']['ANTHROPIC_API_KEY'])")
  ```
- anthropic SDK: `python3 -m pip install --user anthropic` (0.116.0 설치됨)
- 프롬프트/스키마: `scripts/prompt/` 6개 파일 (수정 시 배치 재제출 필요)

## 명령 순서 (모두 프로젝트 루트에서)

1. `python3 scripts/gen_content.py build-requests` — 요청 JSONL 생성 (로컬, 무비용, 멱등)
2. `python3 scripts/gen_content.py submit` — 배치 제출 (**여기서부터 과금**). batch_id는 `build/batch_id.txt`에 저장됨. 중복 제출 방지 내장 (`--force`로 무시)
3. `python3 scripts/gen_content.py status` — processing_status가 `ended`가 될 때까지 확인 (보통 수 시간, 최대 24h. 진행률이 0에서 한꺼번에 완료로 점프하는 패턴이 정상)
4. `python3 scripts/gen_content.py fetch` — 결과 회수 → `build/content.json`. 실패 건은 `build/batch_errors.json`
5. `python3 scripts/gen_content.py validate` — 자동 검증(품사 커버리지·난이도 단조성·writing answer) + `review/content_sample.csv` 생성 → **사람 스팟체크 필요 (50단어 표본)**
6. `python3 scripts/pack_db.py` — content.json → `assets/db/content.db` (기존 더미를 덮어씀. 더미 백업: `build/content.db.dummy_backup`)

## 참고/실패 대응

- 2026-07-07 제출된 배치: `msgbatch_0198kYmfkhahyzc2vAweprtc` (2,430건 = 단어 2,416 + writing 14, claude-opus-4-8, 예상 $20~35)
- fetch에서 실패 건이 나오면: batch_errors.json의 custom_id 확인 → 소수면 해당 건만 일반 API로 재생성하는 스크립트를 추가 작성 (재제출은 실패분만)
- Console의 "Spend this month"는 제출 시 max_tokens 기준 예약액이 잡힐 수 있음 — 실비용은 완료 후 Usage에서 확인
- content.db 교체 후 앱은 재시작 시 documentDir로 재복사함 (content_version 비교 — pack_db가 버전을 올림)
- 검수(word_review/writing_manual) 재반영이 필요하면: `review/*_resolved.csv` 수정 → `python3 scripts/clean.py` 재실행(멱등) → build-requests부터 다시
