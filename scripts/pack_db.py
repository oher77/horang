#!/usr/bin/env python3
"""
pack_db.py — content.db 빌드 (호랑이 잉글리시)

build/words.final.json + build/content.json → assets/db/content.db (SQLite)

DDL은 설계.md §1.2를 그대로 사용한다 (테이블/컬럼/인덱스 임의 변경 금지).
word.id 등 stable_id는 파이프라인이 부여한 값을 그대로 INSERT한다
(AUTOINCREMENT에 맡기지 않음 — 설계.md §3.4 stable_id 계약).

기존 content.db 파일이 있으면 삭제 후 재생성한다 (결정론적, 멱등).

환경: 시스템 Python 3.9. match문 등 3.10+ 문법 사용 금지.
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_WORDS_FINAL = PROJECT_ROOT / "build" / "words.final.json"
DEFAULT_CONTENT_JSON = PROJECT_ROOT / "build" / "content.json"
DEFAULT_OUTPUT_DB = PROJECT_ROOT / "assets" / "db" / "content.db"

CONTENT_VERSION = "1"
SCHEMA_VERSION = "1"

# 설계.md §1.2 DDL 전문 (그대로 사용, 변경 금지)
DDL_STATEMENTS = [
    "PRAGMA journal_mode = WAL;",
    "PRAGMA foreign_keys = ON;",
    """
    CREATE TABLE content_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    """,
    """
    CREATE TABLE lemma_group (
      id           INTEGER PRIMARY KEY,
      head_lemma   TEXT NOT NULL
    );
    """,
    """
    CREATE TABLE word (
      id             INTEGER PRIMARY KEY,
      headword       TEXT NOT NULL,
      lemma_group_id INTEGER REFERENCES lemma_group(id),
      origin         TEXT NOT NULL,
      source_row     INTEGER,
      pos_hint       TEXT,
      needs_review   INTEGER NOT NULL DEFAULT 0,
      UNIQUE(headword)
    );
    """,
    "CREATE INDEX idx_word_group  ON word(lemma_group_id);",
    "CREATE INDEX idx_word_origin ON word(origin);",
    """
    CREATE TABLE meaning (
      id         INTEGER PRIMARY KEY,
      word_id    INTEGER NOT NULL REFERENCES word(id),
      pos        TEXT NOT NULL,
      meaning_ko TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    """,
    "CREATE INDEX idx_meaning_word ON meaning(word_id);",
    """
    CREATE TABLE example (
      id          INTEGER PRIMARY KEY,
      word_id     INTEGER NOT NULL REFERENCES word(id),
      meaning_id  INTEGER REFERENCES meaning(id),
      pos         TEXT NOT NULL,
      level       INTEGER NOT NULL,
      en          TEXT NOT NULL,
      ko          TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0
    );
    """,
    "CREATE INDEX idx_example_word_level ON example(word_id, level);",
    """
    CREATE TABLE writing_item (
      id           INTEGER PRIMARY KEY,
      word_id      INTEGER REFERENCES word(id),
      kind         TEXT NOT NULL,
      prompt_ko    TEXT,
      hint         TEXT,
      answer       TEXT,
      answer_alt   TEXT,
      needs_review INTEGER NOT NULL DEFAULT 0,
      raw          TEXT NOT NULL
    );
    """,
    "CREATE INDEX idx_writing_word ON writing_item(word_id);",
    "CREATE INDEX idx_writing_kind ON writing_item(kind);",
]


def load_json_required(path: Path, label: str):
    if not path.is_file():
        sys.stderr.write(
            "오류: {0} 파일이 없습니다: {1}\n".format(label, path)
        )
        sys.exit(1)
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def create_schema(conn: sqlite3.Connection):
    cur = conn.cursor()
    for stmt in DDL_STATEMENTS:
        cur.execute(stmt)
    conn.commit()


def insert_content_meta(conn: sqlite3.Connection, word_count: int):
    cur = conn.cursor()
    cur.executemany(
        "INSERT INTO content_meta (key, value) VALUES (?, ?)",
        [
            ("content_version", CONTENT_VERSION),
            ("word_count", str(word_count)),
            ("schema_version", SCHEMA_VERSION),
        ],
    )
    conn.commit()


def insert_lemma_groups(conn: sqlite3.Connection, lemma_groups):
    cur = conn.cursor()
    rows = [(lg["id"], lg["head_lemma"]) for lg in lemma_groups]
    cur.executemany(
        "INSERT INTO lemma_group (id, head_lemma) VALUES (?, ?)", rows
    )
    conn.commit()
    return len(rows)


def insert_words(conn: sqlite3.Connection, words):
    cur = conn.cursor()
    rows = [
        (
            w["id"],
            w["headword"],
            w.get("lemma_group_id"),
            w["origin"],
            w.get("source_row"),
            w.get("pos_hint"),
            1 if w.get("needs_review") else 0,
        )
        for w in words
    ]
    cur.executemany(
        """
        INSERT INTO word (id, headword, lemma_group_id, origin, source_row, pos_hint, needs_review)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    conn.commit()
    return len(rows)


def insert_meanings_and_examples(conn: sqlite3.Connection, words, content_words):
    """content.json의 words[word_id] = {meanings, examples} 를 meaning/example 테이블에 채운다.

    meaning.id / example.id는 스키마상 자동증가(파이프라인이 부여하는 stable_id 대상이
    아님 — word.id만 stable_id 계약 대상, 설계.md §3.4)이므로 AUTOINCREMENT(암묵적
    rowid)에 맡긴다. meaning_id 연결은 같은 word 내 pos로 매칭한다.
    """
    cur = conn.cursor()
    meaning_count = 0
    example_count = 0

    target_word_ids = set(str(w["id"]) for w in words if not w.get("needs_review"))

    for word_id_str in sorted(content_words.keys(), key=lambda x: int(x)):
        if word_id_str not in target_word_ids:
            continue
        entry = content_words[word_id_str]
        word_id = int(word_id_str)

        # meaning 삽입 후 pos → meaning_id 매핑 구성 (동일 pos 여러 meaning이면 첫 것 사용)
        pos_to_meaning_id = {}
        for m in entry.get("meanings", []):
            cur.execute(
                "INSERT INTO meaning (word_id, pos, meaning_ko, sort_order) VALUES (?, ?, ?, ?)",
                (word_id, m["pos"], m["meaning_ko"], m.get("sort_order", 0)),
            )
            meaning_count += 1
            if m["pos"] not in pos_to_meaning_id:
                pos_to_meaning_id[m["pos"]] = cur.lastrowid

        for ex in entry.get("examples", []):
            meaning_id = pos_to_meaning_id.get(ex["pos"])
            cur.execute(
                """
                INSERT INTO example (word_id, meaning_id, pos, level, en, ko, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    word_id,
                    meaning_id,
                    ex["pos"],
                    ex["level"],
                    ex["en"],
                    ex.get("ko"),
                    ex.get("sort_order", 0),
                ),
            )
            example_count += 1

    conn.commit()
    return meaning_count, example_count


def _blank_to_none(value):
    """빈 문자열(또는 공백만)을 None으로 정규화한다.

    writing_system.txt 규칙: kind=usage처럼 채점 불가능한 문제는 answer를
    빈 문자열 ""로 두고 note에 사유를 적도록 모델에 지시한다(설계.md §2.5
    e형 "보통 NULL" 관례와 일치). DB에는 빈 문자열이 아니라 NULL로 저장한다.
    """
    if value is None:
        return None
    if isinstance(value, str) and value.strip() == "":
        return None
    return value


def insert_writing_items(conn: sqlite3.Connection, writing_items, content_writing):
    """writing_item.id는 stable_id로 그대로 사용 (word.id와 동일한 계약 적용).

    answer/answer_alt는 content.json 값으로 채운다. content.json에 해당
    writing_id 항목이 없으면(예: word_id가 null이라 애초에 LLM 생성 대상이
    아니었던 항목) words.final.json의 기존 answer/answer_alt를 그대로 쓴다.
    양쪽 다 빈 문자열이면 NULL로 정규화한다(usage 유형 등 채점 부적합 문제).
    """
    cur = conn.cursor()
    rows = []
    for wi in writing_items:
        writing_id_str = str(wi["id"])
        content_entry = content_writing.get(writing_id_str)
        if content_entry is not None:
            answer = content_entry.get("answer")
            answer_alt = content_entry.get("answer_alt")
        else:
            answer = wi.get("answer")
            answer_alt = wi.get("answer_alt")

        answer = _blank_to_none(answer)
        answer_alt = _blank_to_none(answer_alt)

        rows.append((
            wi["id"],
            wi.get("word_id"),
            wi["kind"],
            wi.get("prompt_ko"),
            wi.get("hint"),
            answer,
            answer_alt,
            1 if wi.get("needs_review") else 0,
            wi["raw"],
        ))

    cur.executemany(
        """
        INSERT INTO writing_item (id, word_id, kind, prompt_ko, hint, answer, answer_alt, needs_review, raw)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    conn.commit()
    return len(rows)


def build_db(words_final_path: Path, content_json_path: Path, output_path: Path):
    words_final = load_json_required(words_final_path, "words.final.json")
    content = load_json_required(content_json_path, "content.json")

    words = words_final.get("words", [])
    lemma_groups = words_final.get("lemma_groups", [])
    writing_items = words_final.get("writing_items", [])
    content_words = content.get("words", {})
    content_writing = content.get("writing", {})

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists():
        output_path.unlink()

    conn = sqlite3.connect(str(output_path))
    try:
        create_schema(conn)
        insert_content_meta(conn, len(words))
        lemma_group_count = insert_lemma_groups(conn, lemma_groups)
        word_count = insert_words(conn, words)
        meaning_count, example_count = insert_meanings_and_examples(conn, words, content_words)
        writing_count = insert_writing_items(conn, writing_items, content_writing)
    finally:
        conn.close()

    return {
        "content_meta": 3,
        "lemma_group": lemma_group_count,
        "word": word_count,
        "meaning": meaning_count,
        "example": example_count,
        "writing_item": writing_count,
    }


def main():
    parser = argparse.ArgumentParser(
        description="words.final.json + content.json → content.db (SQLite)"
    )
    parser.add_argument("--words-final", default=str(DEFAULT_WORDS_FINAL))
    parser.add_argument("--content-json", default=str(DEFAULT_CONTENT_JSON))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT_DB))
    args = parser.parse_args()

    words_final_path = Path(args.words_final)
    content_json_path = Path(args.content_json)
    output_path = Path(args.output)

    if not content_json_path.is_file():
        sys.stderr.write(
            "오류: content.json이 없습니다: {0}\n"
            "  gen_content.py fetch를 먼저 실행해 content.json을 생성하세요.\n".format(
                content_json_path
            )
        )
        sys.exit(1)

    counts = build_db(words_final_path, content_json_path, output_path)

    print("=== pack_db 완료 ===")
    print("출력: {0}".format(output_path))
    print("테이블별 행 수:")
    for table, count in counts.items():
        print("  {0}: {1}".format(table, count))


if __name__ == "__main__":
    main()
