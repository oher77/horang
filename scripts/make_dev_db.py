#!/usr/bin/env python3
"""
make_dev_db.py — 개발용 더미 content.db 생성 (호랑이 잉글리시)

build/words.final.json의 실제 단어 전체(2416개)를 사용하되, 뜻/예문은 개발용
더미 텍스트로 채운 content.db를 생성한다. 진짜 콘텐츠(뜻·예문 LLM 생성본)가
나오면 scripts/pack_db.py가 만드는 진짜 content.db로 파일만 교체하면 되도록,
DDL·테이블 구조는 scripts/pack_db.py와 동일하게 맞춘다.

DDL 출처: 설계.md §1.2 (scripts/pack_db.py의 DDL_STATEMENTS를 그대로 복제).
scripts/pack_db.py 자체는 다른 파이프라인(gen_content.py 이후 단계)이 사용
중이므로 이 스크립트에서는 import하지 않고 복제본을 유지한다(§임무 가드레일).

content_meta.content_version = '0' → 개발용 더미 표시(진짜는 pack_db.py가
CONTENT_VERSION="1"로 채움).

환경: 시스템 Python 3.9 호환 (match문 등 3.10+ 문법 사용 금지).

사용법:
    python3 scripts/make_dev_db.py
"""

import json
import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

WORDS_FINAL_PATH = PROJECT_ROOT / "build" / "words.final.json"
OUTPUT_DB_PATH = PROJECT_ROOT / "assets" / "db" / "content.db"

DEV_CONTENT_VERSION = "0"  # 0 = 개발용 더미
SCHEMA_VERSION = "1"

# 설계.md §1.2 DDL 전문 (scripts/pack_db.py의 DDL_STATEMENTS와 동일해야 함)
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


def load_words_final(path):
    if not path.is_file():
        sys.stderr.write("오류: words.final.json이 없습니다: {0}\n".format(path))
        sys.exit(1)
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def create_schema(conn):
    cur = conn.cursor()
    for stmt in DDL_STATEMENTS:
        cur.execute(stmt)
    conn.commit()


def insert_content_meta(conn, word_count):
    cur = conn.cursor()
    cur.executemany(
        "INSERT INTO content_meta (key, value) VALUES (?, ?)",
        [
            ("content_version", DEV_CONTENT_VERSION),
            ("word_count", str(word_count)),
            ("schema_version", SCHEMA_VERSION),
        ],
    )
    conn.commit()


def insert_lemma_groups(conn, lemma_groups):
    cur = conn.cursor()
    rows = [(lg["id"], lg["head_lemma"]) for lg in lemma_groups]
    cur.executemany("INSERT INTO lemma_group (id, head_lemma) VALUES (?, ?)", rows)
    conn.commit()
    return len(rows)


def insert_words(conn, words):
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


def _pos_hint_to_pos(pos_hint):
    """word.pos_hint(예: 'v', 'v,n', 'phrase', 'polysemous', None)로부터
    더미 meaning/example에 쓸 대표 품사 하나를 결정한다.

    실제 뜻 생성 전 단계이므로 정교할 필요 없음 — 더미 데이터 채우기 목적.
    """
    if not pos_hint:
        return "n"
    first = pos_hint.split(",")[0].strip()
    if first in ("n", "v", "a", "ad", "prep", "conj", "phrase"):
        return first
    return "n"


def insert_dummy_meanings_and_examples(conn, words):
    """뜻/예문은 개발용 더미로 채운다.

    - meaning: word당 1행. meaning_ko = "(개발용) {headword}의 뜻"
    - example: word당 level 1~3 각 1개. en = "This is a dev example for {headword}."
      ko = "(개발용 예문 번역) {headword}."
    """
    cur = conn.cursor()
    meaning_count = 0
    example_count = 0

    for w in words:
        word_id = w["id"]
        headword = w["headword"]
        pos = _pos_hint_to_pos(w.get("pos_hint"))

        cur.execute(
            "INSERT INTO meaning (word_id, pos, meaning_ko, sort_order) VALUES (?, ?, ?, ?)",
            (word_id, pos, "(개발용) {0}의 뜻".format(headword), 0),
        )
        meaning_count += 1
        meaning_id = cur.lastrowid

        for level in (1, 2, 3):
            cur.execute(
                """
                INSERT INTO example (word_id, meaning_id, pos, level, en, ko, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    word_id,
                    meaning_id,
                    pos,
                    level,
                    "This is a dev example for {0}.".format(headword),
                    "(개발용 예문 번역) {0}.".format(headword),
                    0,
                ),
            )
            example_count += 1

    conn.commit()
    return meaning_count, example_count


def _blank_to_none(value):
    if value is None:
        return None
    if isinstance(value, str) and value.strip() == "":
        return None
    return value


def insert_writing_items(conn, writing_items):
    """answer가 이미 있는 항목(검수 반영분)은 그대로 쓰고, 없는 항목은
    "(dev)"로 채워 개발 중 화면 렌더/채점 로직 테스트가 가능하게 한다.
    """
    cur = conn.cursor()
    rows = []
    for wi in writing_items:
        answer = _blank_to_none(wi.get("answer"))
        answer_alt = _blank_to_none(wi.get("answer_alt"))
        if answer is None:
            answer = "(dev)"

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


def build_dev_db(words_final_path, output_path):
    words_final = load_words_final(words_final_path)

    words = words_final.get("words", [])
    lemma_groups = words_final.get("lemma_groups", [])
    writing_items = words_final.get("writing_items", [])

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists():
        output_path.unlink()

    conn = sqlite3.connect(str(output_path))
    try:
        create_schema(conn)
        insert_content_meta(conn, len(words))
        lemma_group_count = insert_lemma_groups(conn, lemma_groups)
        word_count = insert_words(conn, words)
        meaning_count, example_count = insert_dummy_meanings_and_examples(conn, words)
        writing_count = insert_writing_items(conn, writing_items)
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
    counts = build_dev_db(WORDS_FINAL_PATH, OUTPUT_DB_PATH)
    print("=== make_dev_db 완료 (개발용 더미 content.db) ===")
    print("출력: {0}".format(OUTPUT_DB_PATH))
    print("테이블별 행 수:")
    for table, count in counts.items():
        print("  {0}: {1}".format(table, count))


if __name__ == "__main__":
    main()
