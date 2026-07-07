#!/usr/bin/env python3
"""
gen_content.py — 호랑이 잉글리시 콘텐츠 생성 파이프라인 (Claude Batch API)

설계.md §3.1(파이프라인 흐름) / §3.2(검증 규칙) 참조.

build/words.final.json (words + writing_items) 을 입력으로 받아
Claude Batch API용 요청 파일을 만들고(build-requests), 배치를 제출하고(submit),
상태를 조회하고(status), 결과를 받아 content.json으로 정리하고(fetch),
생성된 콘텐츠를 검증한다(validate).

서브커맨드:
  build-requests  words.final.json → build/batch_requests.jsonl (로컬, API 호출 없음)
  submit          batch_requests.jsonl → Claude Batch API 제출 → build/batch_id.txt
  status          batch_id.txt의 배치 상태 조회
  fetch           배치 결과 스트림 → build/content.json (+ build/batch_errors.json)
  validate        content.json 검증 → review/content_sample.csv 생성
  repair          validate의 (c) 커버리지 누락 word만 일반 API로 재생성 → content.json 패치

환경: 시스템 Python 3.9. match문 등 3.10+ 문법 사용 금지.
"""

import argparse
import csv
import json
import os
import random
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# ---------------------------------------------------------------------------
# 상수
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-opus-4-8"
WORD_MAX_TOKENS = 3000
WRITING_MAX_TOKENS = 500

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROMPT_DIR = PROJECT_ROOT / "scripts" / "prompt"
DEFAULT_BUILD_DIR = PROJECT_ROOT / "build"
DEFAULT_REVIEW_DIR = PROJECT_ROOT / "review"

WORDS_FINAL_JSON = DEFAULT_BUILD_DIR / "words.final.json"
BATCH_REQUESTS_JSONL = DEFAULT_BUILD_DIR / "batch_requests.jsonl"
BATCH_ID_TXT = DEFAULT_BUILD_DIR / "batch_id.txt"
CONTENT_JSON = DEFAULT_BUILD_DIR / "content.json"
BATCH_ERRORS_JSON = DEFAULT_BUILD_DIR / "batch_errors.json"
CONTENT_SAMPLE_CSV = DEFAULT_REVIEW_DIR / "content_sample.csv"

# 배치 API 상한 (안전 확인용)
BATCH_MAX_REQUESTS = 100_000
BATCH_MAX_BYTES = 256 * 1024 * 1024  # 256MB

VALID_POS = {"n", "v", "a", "ad", "prep", "conj", "pron", "int", "aux", "det", "phrase"}


# ---------------------------------------------------------------------------
# 프롬프트 로딩
# ---------------------------------------------------------------------------

def _read_required(path: Path) -> str:
    if not path.is_file():
        sys.stderr.write(
            "오류: 프롬프트 파일이 없습니다: {0}\n"
            "  (scripts/prompt/ 디렉터리에 다른 에이전트가 작성 중인 파일일 수 있습니다.\n"
            "   --prompt-dir 옵션으로 임시 디렉터리를 지정해 테스트할 수 있습니다.)\n".format(path)
        )
        sys.exit(1)
    return path.read_text(encoding="utf-8")


def _read_json_required(path: Path):
    text = _read_required(path)
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        sys.stderr.write("오류: JSON 파싱 실패: {0} ({1})\n".format(path, e))
        sys.exit(1)


class Prompts(object):
    """scripts/prompt/ 아래 프롬프트 파일 묶음을 로드해 보관한다."""

    def __init__(self, prompt_dir: Path):
        self.prompt_dir = prompt_dir
        self.word_system = _read_required(prompt_dir / "system.txt")
        self.word_user_template = _read_required(prompt_dir / "user_template.txt")
        self.word_schema = _read_json_required(prompt_dir / "schema.json")
        self.writing_system = _read_required(prompt_dir / "writing_system.txt")
        self.writing_user_template = _read_required(prompt_dir / "writing_user_template.txt")
        self.writing_schema = _read_json_required(prompt_dir / "writing_schema.json")


# ---------------------------------------------------------------------------
# 공통 유틸
# ---------------------------------------------------------------------------

def load_words_final(path: Path):
    if not path.is_file():
        sys.stderr.write("오류: 입력 파일이 없습니다: {0}\n".format(path))
        sys.exit(1)
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def build_params(model: str, max_tokens: int, system: str, user_content: str, schema: dict) -> dict:
    """Batch API 요청의 params 블록 구성.

    주의: temperature/top_p/top_k/thinking 파라미터는 절대 넣지 않는다.
    claude-opus-4-8 등 4.7+ 계열 모델에서 400 에러를 유발한다.
    """
    return {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user_content}],
        "output_config": {
            "format": {
                "type": "json_schema",
                "schema": schema,
            }
        },
    }


def find_missing_level_coverage(content_words: dict, target_word_ids: set):
    """validate의 (c) 검사 로직: word_id -> pos별 level 1/2/3 예문 커버리지 누락 계산.

    반환: (word_id, pos, sorted(missing_levels)) 튜플의 리스트.
    target_word_ids에 없는 word_id는 건너뛴다 (needs_review 등으로 애초에
    생성 대상이 아니었던 word).
    """
    result = []
    for wid, entry in content_words.items():
        if wid not in target_word_ids:
            continue
        meanings = entry.get("meanings", [])
        examples = entry.get("examples", [])
        pos_set = set(m.get("pos") for m in meanings)
        levels_by_pos = {}
        for ex in examples:
            pos = ex.get("pos")
            level = ex.get("level")
            levels_by_pos.setdefault(pos, set()).add(level)
        for pos in pos_set:
            have_levels = levels_by_pos.get(pos, set())
            missing = {1, 2, 3} - have_levels
            if missing:
                result.append((wid, pos, sorted(missing)))
    return result


def build_word_user_content(prompts, word: dict, extra_line: str = None) -> str:
    """word 하나에 대한 user 메시지 본문 조립 (build-requests와 동일 템플릿).

    extra_line이 주어지면 끝에 강조 줄을 덧붙인다 (repair에서 사용).
    """
    pos_hint = word.get("pos_hint")
    pos_hint_display = pos_hint if pos_hint is not None else "미지정"
    user_content = prompts.word_user_template.format(
        headword=word["headword"],
        pos_hint=pos_hint_display,
    )
    if extra_line:
        user_content = user_content + "\n\n" + extra_line
    return user_content


# ---------------------------------------------------------------------------
# 서브커맨드: build-requests
# ---------------------------------------------------------------------------

def cmd_build_requests(args):
    prompts = Prompts(Path(args.prompt_dir))
    data = load_words_final(Path(args.input))

    words = data.get("words", [])
    writing_items = data.get("writing_items", [])

    target_words = [w for w in words if not w.get("needs_review")]
    skipped_review_words = len(words) - len(target_words)

    # writing_items 대상: answer가 null인 것. 단, word_id가 null이면
    # {headword} 플레이스홀더를 채울 수 없으므로 렌더링이 불가능하다 —
    # 이런 항목은 사람 검수(word_review 큐) 대상이지 LLM 생성 대상이 아니다.
    target_writing = []
    skipped_writing_no_answer_needed = 0
    skipped_writing_no_word_id = 0
    for wi in writing_items:
        if wi.get("answer") is not None:
            skipped_writing_no_answer_needed += 1
            continue
        if wi.get("word_id") is None:
            skipped_writing_no_word_id += 1
            continue
        target_writing.append(wi)

    words_by_id = {w["id"]: w for w in words}

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    total_chars = 0
    request_count = 0

    with out_path.open("w", encoding="utf-8") as out:
        for w in target_words:
            user_content = build_word_user_content(prompts, w)
            params = build_params(
                model=args.model,
                max_tokens=WORD_MAX_TOKENS,
                system=prompts.word_system,
                user_content=user_content,
                schema=prompts.word_schema,
            )
            record = {"custom_id": "word-{0}".format(w["id"]), "params": params}
            line = json.dumps(record, ensure_ascii=False)
            out.write(line + "\n")
            total_chars += len(prompts.word_system) + len(user_content)
            request_count += 1

        for wi in target_writing:
            word = words_by_id.get(wi["word_id"])
            if word is None:
                # word_id가 words.final.json 내 word 목록에 없는 댕글링 참조.
                # 안전하게 스킵하고 통계에 반영한다 (정상 데이터라면 발생하지 않아야 함).
                skipped_writing_no_word_id += 1
                continue
            headword = word["headword"]
            # hint가 없으면 "없음"으로 렌더링한다 — writing_system.txt가
            # "없으면 '없음'"이라고 명시적으로 규정하고 있다.
            hint_display = wi.get("hint") if wi.get("hint") else "없음"
            user_content = prompts.writing_user_template.format(
                headword=headword,
                kind=wi.get("kind") or "",
                prompt_ko=wi.get("prompt_ko") or "",
                raw=wi.get("raw") or "",
                hint=hint_display,
            )
            params = build_params(
                model=args.model,
                max_tokens=WRITING_MAX_TOKENS,
                system=prompts.writing_system,
                user_content=user_content,
                schema=prompts.writing_schema,
            )
            record = {"custom_id": "writing-{0}".format(wi["id"]), "params": params}
            line = json.dumps(record, ensure_ascii=False)
            out.write(line + "\n")
            total_chars += len(prompts.writing_system) + len(user_content)
            request_count += 1

    file_size = out_path.stat().st_size
    approx_input_tokens = int(total_chars / 3.5)

    print("=== build-requests 완료 ===")
    print("출력 파일: {0}".format(out_path))
    print("파일 크기: {0:,} bytes".format(file_size))
    print()
    print("대상 word: {0}개 (needs_review=1이라 제외: {1}개)".format(
        len(target_words), skipped_review_words))
    print("대상 writing_item: {0}개".format(len(target_writing)))
    print("  - 이미 answer 채워져 스킵: {0}개".format(skipped_writing_no_answer_needed))
    print("  - word_id 없어(또는 댕글링) 스킵: {0}개 (사람 검수 대상, LLM 생성 불가)".format(
        skipped_writing_no_word_id))
    print()
    print("총 요청 수: {0}".format(request_count))
    print("예상 입력 토큰(대략, 문자수/3.5): {0:,}".format(approx_input_tokens))
    print()
    if request_count > BATCH_MAX_REQUESTS:
        print("경고: 요청 수 {0}개가 배치 최대치 {1}개를 초과합니다.".format(
            request_count, BATCH_MAX_REQUESTS))
    if file_size > BATCH_MAX_BYTES:
        print("경고: 파일 크기 {0:,} bytes가 배치 최대치 {1:,} bytes를 초과합니다.".format(
            file_size, BATCH_MAX_BYTES))


# ---------------------------------------------------------------------------
# 서브커맨드: submit
# ---------------------------------------------------------------------------

def cmd_submit(args):
    requests_path = Path(args.input)
    if not requests_path.is_file():
        sys.stderr.write(
            "오류: {0}가 없습니다. 먼저 build-requests를 실행하세요.\n".format(requests_path)
        )
        sys.exit(1)

    batch_id_path = Path(args.batch_id_file)
    if batch_id_path.is_file() and not args.force:
        sys.stderr.write(
            "오류: {0}가 이미 존재합니다 (기존 batch_id: {1}).\n"
            "  중복 제출을 방지하기 위해 거부합니다. 재제출하려면 --force를 사용하세요.\n".format(
                batch_id_path, batch_id_path.read_text(encoding="utf-8").strip()
            )
        )
        sys.exit(1)

    file_size = requests_path.stat().st_size
    print("요청 파일: {0} ({1:,} bytes)".format(requests_path, file_size))
    if file_size > BATCH_MAX_BYTES:
        sys.stderr.write(
            "오류: 파일 크기 {0:,} bytes가 배치 최대치 {1:,} bytes를 초과합니다. "
            "요청을 나눠서 제출해야 합니다.\n".format(file_size, BATCH_MAX_BYTES)
        )
        sys.exit(1)

    requests_list = []
    with requests_path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as e:
                sys.stderr.write(
                    "오류: {0}의 {1}번째 줄 JSON 파싱 실패: {2}\n".format(
                        requests_path, line_no, e
                    )
                )
                sys.exit(1)
            requests_list.append(record)

    if len(requests_list) > BATCH_MAX_REQUESTS:
        sys.stderr.write(
            "오류: 요청 수 {0}개가 배치 최대치 {1}개를 초과합니다.\n".format(
                len(requests_list), BATCH_MAX_REQUESTS
            )
        )
        sys.exit(1)

    print("요청 수: {0}".format(len(requests_list)))

    try:
        import anthropic
    except ImportError:
        sys.stderr.write(
            "오류: anthropic 패키지가 설치되어 있지 않습니다. "
            "'python3 -m pip install anthropic'을 실행하세요.\n"
        )
        sys.exit(1)

    client = anthropic.Anthropic()
    batch = client.messages.batches.create(requests=requests_list)

    batch_id_path.parent.mkdir(parents=True, exist_ok=True)
    batch_id_path.write_text(batch.id, encoding="utf-8")

    print("배치 제출 완료.")
    print("batch_id: {0}".format(batch.id))
    print("processing_status: {0}".format(batch.processing_status))
    print("저장 위치: {0}".format(batch_id_path))


# ---------------------------------------------------------------------------
# 서브커맨드: status
# ---------------------------------------------------------------------------

def _read_batch_id(batch_id_path: Path) -> str:
    if not batch_id_path.is_file():
        sys.stderr.write(
            "오류: {0}가 없습니다. 먼저 submit을 실행하세요.\n".format(batch_id_path)
        )
        sys.exit(1)
    batch_id = batch_id_path.read_text(encoding="utf-8").strip()
    if not batch_id:
        sys.stderr.write("오류: {0} 파일이 비어 있습니다.\n".format(batch_id_path))
        sys.exit(1)
    return batch_id


def cmd_status(args):
    batch_id = _read_batch_id(Path(args.batch_id_file))

    try:
        import anthropic
    except ImportError:
        sys.stderr.write(
            "오류: anthropic 패키지가 설치되어 있지 않습니다. "
            "'python3 -m pip install anthropic'을 실행하세요.\n"
        )
        sys.exit(1)

    client = anthropic.Anthropic()
    batch = client.messages.batches.retrieve(batch_id)

    print("batch_id: {0}".format(batch.id))
    print("processing_status: {0}".format(batch.processing_status))
    counts = batch.request_counts
    print("request_counts:")
    print("  processing: {0}".format(counts.processing))
    print("  succeeded:  {0}".format(counts.succeeded))
    print("  errored:    {0}".format(counts.errored))
    print("  canceled:   {0}".format(counts.canceled))
    print("  expired:    {0}".format(counts.expired))


# ---------------------------------------------------------------------------
# 서브커맨드: fetch
# ---------------------------------------------------------------------------

def _parse_custom_id(custom_id: str):
    """'word-123' → ('word', 123), 'writing-45' → ('writing', 45)"""
    if custom_id.startswith("word-"):
        return "word", custom_id[len("word-"):]
    if custom_id.startswith("writing-"):
        return "writing", custom_id[len("writing-"):]
    return None, custom_id


def cmd_fetch(args):
    batch_id = _read_batch_id(Path(args.batch_id_file))

    try:
        import anthropic
    except ImportError:
        sys.stderr.write(
            "오류: anthropic 패키지가 설치되어 있지 않습니다. "
            "'python3 -m pip install anthropic'을 실행하세요.\n"
        )
        sys.exit(1)

    client = anthropic.Anthropic()

    content_words = {}
    content_writing = {}
    errors = []

    succeeded_count = 0
    failed_count = 0
    observed_model = None

    for result in client.messages.batches.results(batch_id):
        custom_id = result.custom_id
        kind, item_id = _parse_custom_id(custom_id)

        result_type = result.result.type

        if result_type != "succeeded":
            failed_count += 1
            reason = result_type
            if result_type == "errored":
                err = result.result.error
                reason = "errored: {0}".format(getattr(err, "message", str(err)))
            errors.append({"custom_id": custom_id, "reason": reason})
            continue

        message = result.result.message
        if observed_model is None:
            observed_model = getattr(message, "model", None)

        if message.stop_reason in ("refusal", "max_tokens"):
            failed_count += 1
            errors.append({
                "custom_id": custom_id,
                "reason": "stop_reason={0}".format(message.stop_reason),
            })
            continue

        # structured output: content[0].text에 JSON 문자열
        try:
            text = message.content[0].text
            parsed = json.loads(text)
        except (IndexError, AttributeError, json.JSONDecodeError) as e:
            failed_count += 1
            errors.append({
                "custom_id": custom_id,
                "reason": "parse_error: {0}".format(e),
            })
            continue

        if kind == "word":
            content_words[item_id] = {
                "meanings": parsed.get("meanings", []),
                "examples": parsed.get("examples", []),
            }
            succeeded_count += 1
        elif kind == "writing":
            content_writing[item_id] = {
                "answer": parsed.get("answer"),
                "answer_alt": parsed.get("answer_alt"),
                "note": parsed.get("note"),
            }
            succeeded_count += 1
        else:
            failed_count += 1
            errors.append({
                "custom_id": custom_id,
                "reason": "unrecognized custom_id prefix",
            })

    # meta.model은 --model 인자값이 아니라 실제 배치 응답에서 관측된 모델명을
    # 우선한다 (build-requests와 fetch를 서로 다른 --model로 실행했을 때
    # 기록이 실제와 어긋나는 것을 방지). 응답이 하나도 없으면 인자값으로 폴백.
    meta_model = observed_model if observed_model is not None else args.model

    output = {
        "meta": {
            "model": meta_model,
            "batch_id": batch_id,
            "generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        },
        "words": content_words,
        "writing": content_writing,
    }

    content_path = Path(args.output)
    content_path.parent.mkdir(parents=True, exist_ok=True)
    with content_path.open("w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
        f.write("\n")

    errors_path = Path(args.errors_output)
    if errors:
        errors_path.parent.mkdir(parents=True, exist_ok=True)
        with errors_path.open("w", encoding="utf-8") as f:
            json.dump({"errors": errors}, f, ensure_ascii=False, indent=2)
            f.write("\n")
    elif errors_path.is_file():
        # 이전 실패가 없어졌다면 (재실행으로 전부 성공) 오류 파일을 정리한다.
        errors_path.unlink()

    print("=== fetch 완료 ===")
    print("성공: {0}건".format(succeeded_count))
    print("실패: {0}건".format(failed_count))
    print("출력: {0}".format(content_path))
    if errors:
        print("오류 상세: {0}".format(errors_path))


# ---------------------------------------------------------------------------
# 서브커맨드: validate
# ---------------------------------------------------------------------------

def cmd_validate(args):
    content_path = Path(args.input)
    if not content_path.is_file():
        sys.stderr.write("오류: {0}가 없습니다. 먼저 fetch를 실행하세요.\n".format(content_path))
        sys.exit(1)
    with content_path.open("r", encoding="utf-8") as f:
        content = json.load(f)

    words_final_path = Path(args.words_final)
    words_final = load_words_final(words_final_path)
    all_words = words_final.get("words", [])
    all_writing = words_final.get("writing_items", [])
    words_by_id = {w["id"]: w for w in all_words}
    writing_by_id = {str(wi["id"]): wi for wi in all_writing}

    target_word_ids = set(
        str(w["id"]) for w in all_words if not w.get("needs_review")
    )
    target_writing_ids = set()
    for wi in all_writing:
        if wi.get("answer") is not None:
            continue
        if wi.get("word_id") is None:
            continue
        target_writing_ids.add(str(wi["id"]))

    content_words = content.get("words", {})
    content_writing = content.get("writing", {})

    violations = []

    # (a) 모든 대상 word id 존재
    missing_word_ids = sorted(target_word_ids - set(content_words.keys()), key=lambda x: int(x))
    if missing_word_ids:
        violations.append(
            "(a) content.json에 없는 대상 word id {0}개: {1}{2}".format(
                len(missing_word_ids),
                missing_word_ids[:20],
                " ... (생략)" if len(missing_word_ids) > 20 else "",
            )
        )

    # (b) word마다 meanings >= 1
    no_meanings = []
    for wid, entry in content_words.items():
        if wid not in target_word_ids:
            continue
        if not entry.get("meanings"):
            no_meanings.append(wid)
    if no_meanings:
        violations.append(
            "(b) meanings가 비어있는 word {0}개: {1}{2}".format(
                len(no_meanings), sorted(no_meanings, key=lambda x: int(x))[:20],
                " ... (생략)" if len(no_meanings) > 20 else "",
            )
        )

    # (c) 각 meaning의 pos마다 level 1,2,3 예문 각 1개 이상
    missing_coverage_tuples = find_missing_level_coverage(content_words, target_word_ids)
    missing_level_coverage = [
        "word {0} pos={1} 누락 level={2}".format(wid, pos, missing)
        for wid, pos, missing in missing_coverage_tuples
    ]
    if missing_level_coverage:
        violations.append(
            "(c) pos별 level 1/2/3 예문 커버리지 누락 {0}건: {1}{2}".format(
                len(missing_level_coverage),
                missing_level_coverage[:20],
                " ... (생략)" if len(missing_level_coverage) > 20 else "",
            )
        )

    # (d) 난이도 단조성: level1 en 단어수 <= level3 en 단어수 (경고만, 실패 아님)
    monotonicity_warnings = []
    for wid, entry in content_words.items():
        if wid not in target_word_ids:
            continue
        examples = entry.get("examples", [])
        by_pos_level = {}
        for ex in examples:
            key = (ex.get("pos"), ex.get("level"))
            by_pos_level.setdefault(key, []).append(ex.get("en", ""))
        pos_set = set(k[0] for k in by_pos_level.keys())
        for pos in pos_set:
            l1_examples = by_pos_level.get((pos, 1), [])
            l3_examples = by_pos_level.get((pos, 3), [])
            if not l1_examples or not l3_examples:
                continue
            l1_words = len(l1_examples[0].split())
            l3_words = len(l3_examples[0].split())
            if l1_words > l3_words:
                monotonicity_warnings.append(
                    "word {0} pos={1}: level1 단어수({2}) > level3 단어수({3})".format(
                        wid, pos, l1_words, l3_words
                    )
                )

    # (e) writing answer 전부 채워짐
    # 예외: kind=usage는 writing_system.txt 규칙상 채점 불가능한 문제라
    # answer=""(빈 문자열)가 정당한 출력이다(설계.md §2.5 e형 "보통 NULL"
    # 관례와 일치). usage가 아닌 항목만 answer 누락을 위반으로 취급한다.
    missing_writing_answer = []
    usage_blank_answers = []
    for wiid in target_writing_ids:
        entry = content_writing.get(wiid)
        kind = writing_by_id.get(wiid, {}).get("kind")
        has_answer = entry is not None and bool(entry.get("answer"))
        if has_answer:
            continue
        if kind == "usage":
            usage_blank_answers.append(wiid)
        else:
            missing_writing_answer.append(wiid)
    if missing_writing_answer:
        violations.append(
            "(e) answer가 비어있는 writing_item {0}개: {1}".format(
                len(missing_writing_answer),
                sorted(missing_writing_answer, key=lambda x: int(x)),
            )
        )

    print("=== validate 결과 ===")
    if violations:
        print("위반 사항 ({0}건):".format(len(violations)))
        for v in violations:
            print("  - {0}".format(v))
    else:
        print("위반 사항 없음 (a/b/c/e 전부 통과)")

    if usage_blank_answers:
        print(
            "참고: kind=usage라 answer가 정당하게 빈 값인 writing_item {0}개 "
            "(위반 아님): {1}".format(
                len(usage_blank_answers),
                sorted(usage_blank_answers, key=lambda x: int(x)),
            )
        )

    print()
    if monotonicity_warnings:
        print("경고 (d, 난이도 단조성 — 실패 아님) {0}건:".format(len(monotonicity_warnings)))
        for w in monotonicity_warnings[:20]:
            print("  - {0}".format(w))
        if len(monotonicity_warnings) > 20:
            print("  ... (생략)")
    else:
        print("난이도 단조성 경고 없음")

    # 무작위 50단어 스팟체크 CSV
    sample_word_ids = [wid for wid in content_words.keys() if wid in target_word_ids]
    random.seed(42)
    sample_size = min(50, len(sample_word_ids))
    sample_ids = random.sample(sample_word_ids, sample_size) if sample_size else []

    sample_csv_path = Path(args.sample_output)
    sample_csv_path.parent.mkdir(parents=True, exist_ok=True)
    with sample_csv_path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["word_id", "headword", "pos", "meaning_ko", "level", "en", "ko"])
        for wid in sample_ids:
            entry = content_words[wid]
            word = words_by_id.get(int(wid), {})
            headword = word.get("headword", "")
            meanings = entry.get("meanings", [])
            examples = entry.get("examples", [])
            examples_by_pos = {}
            for ex in examples:
                examples_by_pos.setdefault(ex.get("pos"), []).append(ex)
            for m in meanings:
                pos = m.get("pos")
                meaning_ko = m.get("meaning_ko")
                pos_examples = sorted(
                    examples_by_pos.get(pos, []), key=lambda e: e.get("level", 0)
                )
                if not pos_examples:
                    writer.writerow([wid, headword, pos, meaning_ko, "", "", ""])
                    continue
                for ex in pos_examples:
                    writer.writerow([
                        wid, headword, pos, meaning_ko,
                        ex.get("level"), ex.get("en"), ex.get("ko"),
                    ])

    print()
    print("스팟체크 샘플 CSV: {0} ({1}단어)".format(sample_csv_path, sample_size))


# ---------------------------------------------------------------------------
# 서브커맨드: repair
# ---------------------------------------------------------------------------

REPAIR_EXTRA_LINE = (
    "중요: meanings에 포함한 모든 pos에 대해 level 1, 2, 3 예문을 각각 1개 이상 반드시 포함하라."
)
REPAIR_CONCURRENCY = 3


def _compute_repair_targets(content_path: Path, words_final_path: Path):
    """validate의 (a)/(c) 로직을 재사용해 재생성이 필요한 word_id 집합을 계산한다.

    반환: (target_word_ids: list[str] (정렬됨), content: dict, words_by_id: dict,
           missing_detail: list[(wid, pos, missing_levels)])
    """
    if not content_path.is_file():
        sys.stderr.write("오류: {0}가 없습니다. 먼저 fetch를 실행하세요.\n".format(content_path))
        sys.exit(1)
    with content_path.open("r", encoding="utf-8") as f:
        content = json.load(f)

    words_final = load_words_final(words_final_path)
    all_words = words_final.get("words", [])
    words_by_id = {w["id"]: w for w in all_words}

    target_word_ids_all = set(
        str(w["id"]) for w in all_words if not w.get("needs_review")
    )

    content_words = content.get("words", {})

    # (a)와 동일: content.json에 아예 없는 대상 word (전체 재생성 대상)
    missing_entirely = target_word_ids_all - set(content_words.keys())

    # (c)와 동일: 존재는 하지만 pos별 level 커버리지가 빠진 word
    missing_detail = find_missing_level_coverage(content_words, target_word_ids_all)
    missing_coverage_word_ids = set(wid for wid, _pos, _levels in missing_detail)

    repair_word_ids = sorted(
        missing_entirely | missing_coverage_word_ids, key=lambda x: int(x)
    )
    return repair_word_ids, content, words_by_id, missing_detail


def _repair_one_word(client, model: str, prompts, word: dict):
    """단어 하나를 일반 Messages API로 재생성한다. 성공 시 (word_id, parsed_dict),
    실패 시 예외를 그대로 올린다 (호출부에서 수집)."""
    user_content = build_word_user_content(prompts, word, extra_line=REPAIR_EXTRA_LINE)
    response = client.messages.create(
        model=model,
        max_tokens=WORD_MAX_TOKENS,
        system=prompts.word_system,
        messages=[{"role": "user", "content": user_content}],
        output_config={
            "format": {
                "type": "json_schema",
                "schema": prompts.word_schema,
            }
        },
    )
    if response.stop_reason in ("refusal", "max_tokens"):
        raise RuntimeError("stop_reason={0}".format(response.stop_reason))
    text = response.content[0].text
    parsed = json.loads(text)
    return {
        "meanings": parsed.get("meanings", []),
        "examples": parsed.get("examples", []),
    }


def cmd_repair(args):
    content_path = Path(args.input)
    words_final_path = Path(args.words_final)

    repair_word_ids, content, words_by_id, missing_detail = _compute_repair_targets(
        content_path, words_final_path
    )

    print("=== repair 대상 계산 ===")
    print("커버리지 누락 건수(pos별): {0}건".format(len(missing_detail)))
    print("재생성 대상 word 수: {0}".format(len(repair_word_ids)))
    if repair_word_ids:
        preview = repair_word_ids[:20]
        print("대상 word_id: {0}{1}".format(
            preview, " ... (생략)" if len(repair_word_ids) > 20 else ""
        ))

    if args.dry_run:
        print()
        print("--dry-run: API 호출 없이 대상 목록만 출력했습니다. (요청 수: {0})".format(
            len(repair_word_ids)
        ))
        return

    if not repair_word_ids:
        print()
        print("재생성 대상이 없습니다. 종료합니다.")
        return

    prompts = Prompts(Path(args.prompt_dir))

    missing_words = [wid for wid in repair_word_ids if int(wid) not in words_by_id]
    if missing_words:
        sys.stderr.write(
            "오류: words.final.json에 없는 word_id {0}건: {1}\n".format(
                len(missing_words), missing_words[:20]
            )
        )
        sys.exit(1)

    try:
        import anthropic
    except ImportError:
        sys.stderr.write(
            "오류: anthropic 패키지가 설치되어 있지 않습니다. "
            "'python3 -m pip install anthropic'을 실행하세요.\n"
        )
        sys.exit(1)

    # content.json 백업 (최초 1회만 — 이미 있으면 덮어쓰지 않는다)
    backup_path = content_path.with_suffix(content_path.suffix + ".bak")
    if not backup_path.is_file():
        shutil.copy2(content_path, backup_path)
        print("백업 생성: {0}".format(backup_path))
    else:
        print("백업 이미 존재 (건너뜀): {0}".format(backup_path))

    client = anthropic.Anthropic()

    content_words = content.setdefault("words", {})

    succeeded = []
    failed = []

    print()
    print("=== 재생성 시작 (동시성 {0}) ===".format(REPAIR_CONCURRENCY))

    with ThreadPoolExecutor(max_workers=REPAIR_CONCURRENCY) as executor:
        future_to_wid = {}
        for wid in repair_word_ids:
            word = words_by_id[int(wid)]
            future = executor.submit(_repair_one_word, client, args.model, prompts, word)
            future_to_wid[future] = wid

        for future in as_completed(future_to_wid):
            wid = future_to_wid[future]
            try:
                entry = future.result()
                content_words[wid] = entry
                succeeded.append(wid)
                print("  성공: word {0}".format(wid))
            except Exception as e:
                failed.append({"word_id": wid, "reason": str(e)})
                print("  실패: word {0} ({1})".format(wid, e))

    with content_path.open("w", encoding="utf-8") as f:
        json.dump(content, f, ensure_ascii=False, indent=2)
        f.write("\n")

    # 재검사: 남은 누락 수
    remaining_missing = find_missing_level_coverage(
        content.get("words", {}),
        set(str(w["id"]) for w in words_by_id.values() if not w.get("needs_review")),
    )

    print()
    print("=== repair 완료 ===")
    print("대상: {0}건".format(len(repair_word_ids)))
    print("성공: {0}건".format(len(succeeded)))
    print("실패: {0}건".format(len(failed)))
    if failed:
        print("실패 상세:")
        for f_entry in failed:
            print("  - word {0}: {1}".format(f_entry["word_id"], f_entry["reason"]))
    print()
    print("재검사(커버리지 재계산): 남은 누락 {0}건".format(len(remaining_missing)))
    if remaining_missing:
        for wid, pos, levels in remaining_missing[:20]:
            print("  - word {0} pos={1} 누락 level={2}".format(wid, pos, levels))
        if len(remaining_missing) > 20:
            print("  ... (생략)")
    print()
    print("출력: {0}".format(content_path))


# ---------------------------------------------------------------------------
# argparse 구성
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="호랑이 잉글리시 콘텐츠 생성 파이프라인 (Claude Batch API)"
    )
    parser.add_argument(
        "--model", default=DEFAULT_MODEL,
        help="사용할 Claude 모델 (기본값: {0})".format(DEFAULT_MODEL),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_build = subparsers.add_parser(
        "build-requests", help="words.final.json → batch_requests.jsonl (로컬, API 호출 없음)"
    )
    p_build.add_argument("--input", default=str(WORDS_FINAL_JSON))
    p_build.add_argument("--output", default=str(BATCH_REQUESTS_JSONL))
    p_build.add_argument("--prompt-dir", default=str(DEFAULT_PROMPT_DIR))
    p_build.set_defaults(func=cmd_build_requests)

    p_submit = subparsers.add_parser("submit", help="배치 제출")
    p_submit.add_argument("--input", default=str(BATCH_REQUESTS_JSONL))
    p_submit.add_argument("--batch-id-file", default=str(BATCH_ID_TXT))
    p_submit.add_argument("--force", action="store_true", help="batch_id.txt가 이미 있어도 재제출")
    p_submit.set_defaults(func=cmd_submit)

    p_status = subparsers.add_parser("status", help="배치 상태 조회")
    p_status.add_argument("--batch-id-file", default=str(BATCH_ID_TXT))
    p_status.set_defaults(func=cmd_status)

    p_fetch = subparsers.add_parser("fetch", help="배치 결과 → content.json")
    p_fetch.add_argument("--batch-id-file", default=str(BATCH_ID_TXT))
    p_fetch.add_argument("--output", default=str(CONTENT_JSON))
    p_fetch.add_argument("--errors-output", default=str(BATCH_ERRORS_JSON))
    p_fetch.set_defaults(func=cmd_fetch)

    p_validate = subparsers.add_parser("validate", help="content.json 검증")
    p_validate.add_argument("--input", default=str(CONTENT_JSON))
    p_validate.add_argument("--words-final", default=str(WORDS_FINAL_JSON))
    p_validate.add_argument("--sample-output", default=str(CONTENT_SAMPLE_CSV))
    p_validate.set_defaults(func=cmd_validate)

    p_repair = subparsers.add_parser(
        "repair", help="validate (c) 커버리지 누락 word만 일반 API로 재생성해 content.json 패치"
    )
    p_repair.add_argument("--input", default=str(CONTENT_JSON))
    p_repair.add_argument("--words-final", default=str(WORDS_FINAL_JSON))
    p_repair.add_argument("--prompt-dir", default=str(DEFAULT_PROMPT_DIR))
    p_repair.add_argument(
        "--dry-run", action="store_true",
        help="API 호출 없이 대상 word 목록·요청 수만 출력",
    )
    p_repair.set_defaults(func=cmd_repair)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
