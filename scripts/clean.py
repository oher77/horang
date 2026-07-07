#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
clean.py — 호랑이 잉글리시 원본 정제 스크립트

설계.md §2 (원본 정제 + 쓰기 컬럼 파싱 규칙) §3.1 (파이프라인 흐름) §3.4 (stable_id 규약)의
유일한 구현체. 이 파일만으로 정제 단계를 재현할 수 있어야 한다.

입력:  data/voca_data.xlsx (Sheet1, 컬럼: [번호, 표제어, 파생어, 쓰기])
출력:
  build/words.json           - 정제된 word / lemma_group / writing_item (stable_id 부여됨)
  build/words.final.json     - word 레벨 검수(review/word_review.csv)가 모두 해소된 경우에만 추가 출력
  build/id_map.json          - headword -> stable_id 영속 매핑 (재실행 멱등성의 핵심)
  review/writing_manual.csv  - 쓰기 컬럼 수동보정 큐 (미해소 항목만)
  review/word_review.csv     - needs_review=1 word 목록 (한글뜻 오염 표제어 등, 미해소 항목만)

재실행 시 idempotent: 같은 headword는 항상 같은 stable_id를 받는다. 신규 headword만
기존 max_id + 1부터 순차 배정된다. 삭제된(더 이상 원본에 없는) headword의 id는
id_map에 남겨두되(결번 처리, 재사용 금지) words.json에는 포함하지 않는다.

검수 반영(선택, 하위호환):
  review/word_review_resolved.csv     - 컬럼 stable_id,decision,value,note
    decision=phrase   : needs_review=0으로 확정(phrase headword 채택, pos_hint 등은 기존 그대로)
    decision=headword : headword 텍스트를 value로 교체. stable_id(=id_map의 id)는 유지
    decision=absorb    : 해당 word를 제거하고, value로 지정된 기존 word에
                          absorbed_phrases 메타데이터로 원문을 보존
  review/writing_manual_resolved.csv  - 컬럼 raw,resolved_word,note (+선택 answer, 2026-07-07 확장)
    raw로 writing_item을 매칭해 needs_review=0으로 확정.
    resolved_word가 기존 headword와 대소문자무시 일치하면 word_id 연결(없으면 NULL 유지 - 신규 word 생성 안 함)
    answer 컬럼 3-상태(하위호환):
      컬럼 자체가 없음(구버전)      -> answer=resolved_word (기존 동작)
      컬럼 있음 + 값 빈 문자열      -> answer=NULL (word_id만 연결, 정답은 gen_content 배치가 채움)
      컬럼 있음 + 값 있음           -> answer=그 값 그대로(verbatim, LLM 생성 대상 아님)
  두 파일 모두 없으면 기존과 동일하게 동작한다(하위호환).
"""

import json
import re
import unicodedata
import sys
import csv
from pathlib import Path
from collections import OrderedDict

import pandas as pd

# ---------------------------------------------------------------------------
# 경로
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
INPUT_XLSX = ROOT / "data" / "voca_data.xlsx"
BUILD_DIR = ROOT / "build"
REVIEW_DIR = ROOT / "review"
WORDS_JSON = BUILD_DIR / "words.json"
WORDS_FINAL_JSON = BUILD_DIR / "words.final.json"
ID_MAP_JSON = BUILD_DIR / "id_map.json"
WRITING_MANUAL_CSV = REVIEW_DIR / "writing_manual.csv"
WORD_REVIEW_CSV = REVIEW_DIR / "word_review.csv"
WORD_REVIEW_RESOLVED_CSV = REVIEW_DIR / "word_review_resolved.csv"
WRITING_MANUAL_RESOLVED_CSV = REVIEW_DIR / "writing_manual_resolved.csv"

# ---------------------------------------------------------------------------
# §2.3 정규식 (설계.md 본문 그대로)
# ---------------------------------------------------------------------------
POS_ANNOT = re.compile(r'^([A-Za-z][A-Za-z\-\s]*?)\s*\(([^)]*)\)\s*$')
SLASH_VAR = re.compile(r'^\s*([A-Za-z]+)\s*/\s*([A-Za-z]+)\s*$')
PLAIN_WORD = re.compile(r'^[A-Za-z][A-Za-z\-]*$')
HANGUL_RE = re.compile(r'[가-힣]')

# §3.4 결번 방지 및 명시적 드롭 대상(§2.3 "지시문/메모" 유형): word로 만들지 않는다.
# 의도적으로 row_idx가 아니라 "정규화된 원본 표제어 문자열"을 키로 쓴다 — 원본 xlsx 앞쪽에
# 행이 추가/삭제되면 뒤쪽 row_idx가 전부 밀리므로, 위치 기반 키는 재실행 안정성이 없다
# (실제로 시뮬레이션 테스트에서 이 문제로 오분류가 재현됨). 문자열 매칭이 유일하게 안전하다.
# 근거는 각 항목 옆 주석 + 최종 보고에 상세 기재.
DROP_HEAD_TEXTS = {
    # 지시문/메모(단어 아님, 대상어가 시트에 이미 존재) — writing usage 노트로 흡수 시도, 실패시 드롭
    "ingredient 발음": "'ingredient' 표제어 이미 존재, 발음 지시일 뿐",
    "such가 형용사를 형용사를 강조하는 예문 3개": "예문 생성 지시, 대상어 'such' 표제어가 시트에 부재",
    "party (파티 말고 뜻)": "'party' 표제어 이미 존재, 의미 한정 지시일 뿐",
}

# §2.3 "문장/감탄" 유형 — 설계.md가 명시적으로 예시로 든 확정 목록(콘텐츠 매칭).
# 정규식(느낌표/어퍼스트로피 등)만으로는 "구/숙어(유효 학습 대상)"과 안정적으로 구분되지 않아
# (예: 'marry me', 'passed away', 'on your feet'은 문장부호가 전혀 없음) 설계서가 준 확정
# 예시를 그대로 리스트업한다. phrase headword로는 채택하되 표에 "판단 필요"라 명시됐으므로
# needs_review=1로 검수 큐에 얹는다(기본정책: 핵심어가 이미 있으면 흡수, 없으면 phrase 채택).
SENTENCE_EXCLAMATION_TEXTS = {
    "none of your business!",
    "marry me",
    "passed away",
    "I'm moved",
    "on your feet",
}

# [폴백 전용, 2026-07-07 최초 도입] writing_manual_resolved.csv에 행이 없는 usage 항목
# (§2.5 형식 e) 중, 대상어가 word 목록에 없어 word_id는 NULL로 남지만 "드롭하지 않고
# needs_review만 0으로 확정"하기로 결정된 건. raw 문자열 리터럴 매칭 - 위치/행 인덱스 매칭은
# 원본 행이 추가/삭제되면 깨지므로 이 파일 전체의 관례(DROP_HEAD_TEXTS 등)를 그대로 따른다.
#
# 2026-07-07 후속 검수: 이 세트의 두 항목("often의 위치", "one 의 쓰임")은 이후
# word_id 연결 + answer 텍스트까지 확정되어 review/writing_manual_resolved.csv로 이관됐다.
# 메인 루프에서 writing_resolutions(raw 매칭)가 이 세트보다 먼저 체크되므로 정상 동작 시
# 아래 분기는 두 항목에 대해 실행되지 않는다 — resolved CSV가 실수로 비워지는 경우를 위한
# 안전망으로만 남겨둔다(word_id는 잃어도 needs_review=0은 유지되도록).
WRITING_USAGE_FORCE_RESOLVED_TEXTS = {
    "문장에서 often의 위치는?",
    "one 의 쓰임에 대해 (숫자말고)",
}


def load_word_review_resolutions(path: Path):
    """review/word_review_resolved.csv -> {stable_id: {decision, value, note}}. 없으면 빈 dict(하위호환)."""
    resolutions = {}
    if not path.exists():
        return resolutions
    with open(path, 'r', encoding='utf-8', newline='') as f:
        for row in csv.DictReader(f):
            sid = int(row['stable_id'])
            resolutions[sid] = {
                'decision': (row.get('decision') or '').strip(),
                'value': (row.get('value') or '').strip(),
                'note': row.get('note') or '',
            }
    return resolutions


def load_writing_manual_resolutions(path: Path):
    """review/writing_manual_resolved.csv -> {raw: {resolved_word, answer_override, note}}. 없으면 빈 dict(하위호환).

    answer_override 3-상태 (2026-07-07 확장, 하위호환 유지):
      - 'answer' 컬럼 자체가 없는 파일(과거 포맷)        -> answer_override=None  (기존 동작: answer=resolved_word)
      - 컬럼은 있으나 해당 행 값이 빈 문자열              -> answer_override=''    (word_id만 연결, answer는 null 유지)
      - 컬럼에 값이 있음                                  -> answer_override=값    (그 값을 answer로 verbatim 사용)
    """
    resolutions = {}
    if not path.exists():
        return resolutions
    with open(path, 'r', encoding='utf-8', newline='') as f:
        reader = csv.DictReader(f)
        has_answer_col = reader.fieldnames is not None and 'answer' in reader.fieldnames
        for row in reader:
            resolutions[row['raw']] = {
                'resolved_word': (row.get('resolved_word') or '').strip(),
                'answer_override': (row.get('answer') or '').strip() if has_answer_col else None,
                'note': row.get('note') or '',
            }
    return resolutions

# ---------------------------------------------------------------------------
# 전역 정규화 (§2.1)
# ---------------------------------------------------------------------------
def normalize_text(s):
    """NFKC 정규화 + 소프트하이픈/제어문자 제거 + 공백정리."""
    if s is None:
        return None
    if not isinstance(s, str):
        return s
    s = unicodedata.normalize('NFKC', s)
    s = s.replace('\xad', '')  # 소프트하이픈 명시적 제거 (NFKC로 처리 안 됨)
    # 포맷/제어 문자(category Cf) 제거
    s = ''.join(ch for ch in s if unicodedata.category(ch) != 'Cf')
    s = s.strip()
    s = re.sub(r'\s+', ' ', s)
    return s


def is_hangul_polluted(s):
    return bool(HANGUL_RE.search(s or ''))


# ---------------------------------------------------------------------------
# stable_id 관리 (§3.4)
# ---------------------------------------------------------------------------
class IdMap:
    """headword -> stable_id 영속 매핑. 재실행해도 같은 headword는 같은 id."""

    def __init__(self, path: Path):
        self.path = path
        self.map = OrderedDict()  # headword -> id
        if path.exists():
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            # 하위 호환: {"headword_to_id": {...}, "next_id": N} 형태
            self.map = OrderedDict(data.get('headword_to_id', {}))
        self._max_id = max(self.map.values(), default=0)

    def get_or_create(self, headword: str) -> int:
        if headword in self.map:
            return self.map[headword]
        self._max_id += 1
        self.map[headword] = self._max_id
        return self._max_id

    def save(self, active_headwords):
        """
        전체 id_map은 결번 보존을 위해 지금까지 발급된 모든 headword->id를 유지한다.
        active_headwords: 이번 실행에서 실제로 words.json에 포함된 headword 집합
        (참고용 메타데이터로 함께 기록 — id 재사용 방지가 목적이라 map 자체는 절대 축소하지 않음)
        """
        BUILD_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "headword_to_id": dict(self.map),
            "max_id_ever_issued": self._max_id,
            "active_word_count": len(active_headwords),
            "retired_headwords": sorted(set(self.map.keys()) - set(active_headwords)),
        }
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# §2.3 표제어 정규화
# ---------------------------------------------------------------------------
class WordCandidate:
    """word 테이블 한 행이 될 후보. headword 확정 전까지 조립되는 중간 표현."""

    __slots__ = (
        'headword', 'origin', 'source_row', 'pos_hint', 'needs_review',
        'review_reason', 'lemma_group_label',
    )

    def __init__(self, headword, origin, source_row, pos_hint=None,
                 needs_review=0, review_reason=None, lemma_group_label=None):
        self.headword = headword
        self.origin = origin
        self.source_row = source_row
        self.pos_hint = pos_hint
        self.needs_review = needs_review
        self.review_reason = review_reason
        self.lemma_group_label = lemma_group_label or headword


def normalize_pos_hint(raw_inner: str):
    """괄호 안 내용을 pos_hint로 정규화. 한글 주석/다의 표시는 규칙에 따라 처리."""
    if raw_inner is None:
        return None
    inner = raw_inner.strip()
    if not inner:
        return None
    # 다의어 표시("다의", "다의어") 자체는 pos_hint에 보존(뜻 생성 단계 신호)
    # 콤마 구분 토큰들을 정규화: 소문자화, 공백 제거. 순수 한글 토큰(형용사 등)은 드롭.
    tokens = [t.strip() for t in inner.split(',')]
    out_tokens = []
    for t in tokens:
        if not t:
            continue
        if is_hangul_polluted(t):
            # "다의", "다의어", "조동사" 같은 한글 토큰: '다의'류만 보존, 나머지 드롭
            if '다의' in t:
                out_tokens.append('polysemous')
            # 그 외 순수 한글 주석(형용사 등)은 정보가 pos 통제어휘와 안 맞으므로 드롭
            continue
        out_tokens.append(t.lower().replace(' ', ''))
    if not out_tokens:
        return None
    return ','.join(out_tokens)


def classify_headword(raw_head: str, row_idx: int):
    """
    §2.3 규칙에 따라 원본 표제어 1개를 WordCandidate 리스트로 변환.
    - 대부분 1개 반환 (plain word, pos주석, phrase, 오염표제어)
    - 철자변이(slash)는 2개 반환 (같은 lemma_group)
    - 드롭 대상은 빈 리스트 반환
    """
    head = normalize_text(raw_head)
    if not head:
        return []

    # 지시문/메모 명시적 드롭 리스트 (콘텐츠 매칭 - row_idx 매칭은 위치가 바뀌면 깨짐)
    if head in DROP_HEAD_TEXTS:
        return []

    # 1) plain word - 가장 흔한 케이스
    if PLAIN_WORD.match(head):
        return [WordCandidate(head, 'headword', row_idx)]

    # 2) 철자변이 A/B (예: advertize/ advertise) - 슬래시 양쪽이 순수 단어
    m = SLASH_VAR.match(head)
    if m:
        a, b = m.group(1), m.group(2)
        group_label = a
        return [
            WordCandidate(a, 'headword', row_idx, lemma_group_label=group_label),
            WordCandidate(b, 'headword', row_idx, lemma_group_label=group_label),
        ]

    # 3) 품사주석/다의어 주석 word (v) / fat (a,n) / land(n, v) / lie (다의어)
    m = POS_ANNOT.match(head)
    if m:
        base = m.group(1).strip()
        inner = m.group(2)
        if PLAIN_WORD.match(base):
            pos_hint = normalize_pos_hint(inner)
            return [WordCandidate(base, 'headword', row_idx, pos_hint=pos_hint)]
        # base가 순수 단어가 아니면(거의 없음) 아래 fallthrough로

    # 4) 구/숙어 (물결 ~ 포함하거나 공백 다수 + 슬롯 패턴, 순수 한글 없음)
    has_tilde = '~' in head
    has_multi_space = len(head.split(' ')) >= 3
    if not is_hangul_polluted(head) and (has_tilde or has_multi_space or ' ' in head):
        # §2.3 "문장/감탄" 유형: 설계서가 명시한 확정 예시 목록(콘텐츠 매칭) 우선 체크.
        # 정규식(느낌표/따옴표 등)만으론 'marry me'/'passed away'/'on your feet'처럼
        # 문장부호 없는 케이스를 못 잡으므로 리스트 매칭 + 문장부호 휴리스틱 병행.
        if head in SENTENCE_EXCLAMATION_TEXTS or head.endswith('!') or "'" in head or head.rstrip().endswith('.'):
            return [WordCandidate(
                head, 'headword', row_idx, pos_hint='phrase',
                needs_review=1, review_reason='문장/감탄 표현 - phrase 채택 여부 검수 필요(§2.3)',
            )]
        return [WordCandidate(head, 'headword', row_idx, pos_hint='phrase')]

    # 5) 한국어 뜻만(표제어 오염) - 순수 한글
    if is_hangul_polluted(head):
        return [WordCandidate(
            head, 'headword', row_idx, needs_review=1,
            review_reason='한국어 뜻만 기재됨 - 목표 영단어 미확정, 알파벳 인접 힌트로 검수 필요',
        )]

    # 6) 그 외 미분류(방어적 fallback) - 통째로 검수 큐
    return [WordCandidate(
        head, 'headword', row_idx, needs_review=1,
        review_reason='자동분류 규칙에 해당하지 않는 표제어 형태 - 수동 확인 필요',
    )]


# ---------------------------------------------------------------------------
# §2.4 파생어 정규화
# ---------------------------------------------------------------------------
def split_derivative_cell(raw_cell: str, row_idx: int, group_label: str):
    """
    파생어 셀 1개 -> WordCandidate 리스트.
    strip('()') -> softhyphen/NFKC 이미 normalize_text에서 처리됨 -> split on [,/]
    -> trim, 선두 '/' 제거 -> 빈 토큰 버림 -> PLAIN_WORD면 word, 공백 포함이면 phrase.
    """
    cell = normalize_text(raw_cell)
    if not cell:
        return []

    # 바깥 괄호가 셀 전체를 감싸는 경우만 벗긴다 (부분 괄호는 유지 - 방어적)
    if cell.startswith('(') and cell.endswith(')'):
        cell = cell[1:-1].strip()

    tokens = re.split(r'[,/]', cell)
    out = []
    for tok in tokens:
        t = tok.strip()
        if not t:
            continue
        # 선두 '/' 는 split 과정에서 이미 구분자로 소비되지만, 원본에 '/ practise'처럼
        # 공백-슬래시-공백-단어 형태였다면 split 결과 t 자체가 순수 단어로 남는다.
        if t.startswith('/'):
            t = t[1:].strip()
        if not t:
            continue
        if PLAIN_WORD.match(t):
            out.append(WordCandidate(t, 'derivative', row_idx, lemma_group_label=group_label))
        else:
            # 공백 포함 -> phrase. 물음표 등 문장부호 포함 -> 검수 필요 표시.
            needs_review = 1 if re.search(r'[?!.]', t) else 0
            reason = '파생어 분해 결과가 문장형 - phrase 채택 여부 검수 필요' if needs_review else None
            out.append(WordCandidate(
                t, 'derivative', row_idx, pos_hint='phrase',
                needs_review=needs_review, review_reason=reason,
                lemma_group_label=group_label,
            ))
    return out


# ---------------------------------------------------------------------------
# §2.5 쓰기 컬럼 파싱
# ---------------------------------------------------------------------------
INFLECTION_RE = re.compile(r'^([A-Za-z]+)\s*(?:의|\s|가)')
BLANK_PHRASE_RE = re.compile(r'\(\s*\)')  # 괄호 안 공백(빈칸) - 다양한 공백 길이 대응
SPELLING_HINT_RE = re.compile(r'^(.*?):\s*([A-Za-z_]+)\s*$')


def find_neighbor_heads(head_series, row_idx):
    """알파벳 정렬 시트 가정 하 위/아래 최근접 non-null 표제어. §2.5 수동보정 큐 힌트용."""
    n = len(head_series)
    prev_head = None
    i = row_idx - 1
    while i >= 0:
        v = head_series.iloc[i]
        if pd.notna(v):
            prev_head = v
            break
        i -= 1
    next_head = None
    i = row_idx + 1
    while i < n:
        v = head_series.iloc[i]
        if pd.notna(v):
            next_head = v
            break
        i += 1
    return prev_head, next_head


def parse_writing_cell(raw_cell, row_idx, same_row_headword, head_series):
    """
    §2.5 규칙에 따라 쓰기 셀 1개 -> writing_item dict (word_id는 나중에 resolve).

    중요: 여기서 결정하는 것은 kind/prompt_ko/hint/target_headword까지다.
    writing_item.needs_review는 "목표 단어(word_id) 확정 여부"만 반영하는 플래그이므로
    (§2.5 파싱 파이프라인 산출 1~3번 — answer 텍스트 완성 여부와는 별개 축) 이 함수에서는
    설정하지 않고, 메인 루프에서 word_id resolve 결과로 일괄 계산한다.
    force_manual=True인 경우만 word_id가 있어도 강제로 수동보정 큐에 얹는다
    (목표단어 자체가 불안정한 phrase/문장형 후보 등 방어적 케이스).

    반환: dict with keys: kind, prompt_ko, hint, answer, answer_alt,
                          raw, target_headword(추정/확정, None 가능),
                          force_manual(bool), guessed_word, note
    """
    cell = normalize_text(raw_cell)
    result = {
        'kind': None,
        'prompt_ko': None,
        'hint': None,
        'answer': None,
        'answer_alt': None,
        'raw': cell,
        'target_headword': None,
        'force_manual': False,
        'guessed_word': None,
        'note': None,
    }

    prev_head, next_head = find_neighbor_heads(head_series, row_idx)

    # b) 문법변형 메모: "eat의 과거형", "catch의 동사변형", "man의 복수형", "leaf의 복수형", "tear 가 동사일 때 과거형"
    m = INFLECTION_RE.match(cell)
    if m and ('변형' in cell or '과거형' in cell or '복수형' in cell or '진행형' in cell or '형' in cell):
        base_word = m.group(1)
        result['kind'] = 'inflection'
        result['prompt_ko'] = cell
        # §2.5 형식b: "메모 안의 영단어가 곧 원형" - 표제어 있으면 표제어 우선, 없어도 메모의 원형으로 자동확정
        result['target_headword'] = same_row_headword or base_word
        result['note'] = (
            f'문법변형 메모, 원형={base_word} (목표단어 자동확정: 메모에 원형 명시). '
            f'정답(변형형 문자열)은 gen_content 단계에서 채움'
        )
        return result

    # d) 구/관용 빈칸: "(   ) a break: 휴식하다", "예를 들어: (   ) example"
    if BLANK_PHRASE_RE.search(cell):
        result['kind'] = 'phrase'
        result['prompt_ko'] = cell
        result['target_headword'] = same_row_headword
        result['note'] = '구/관용 빈칸 - 목표단어는 같은행 표제어로 확정, 빈칸 정답(문맥어)은 검수/LLM 필요'
        if not same_row_headword:
            result['guessed_word'] = None
        return result

    # a) 뜻+스펠링힌트: "두배의: d______", "축제: f_______", "영화 m_____"
    m = SPELLING_HINT_RE.match(cell)
    if m and re.search(r'[A-Za-z]_', m.group(2)) or (m and set(m.group(2)) <= set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_ ')
                                                        and '_' in m.group(2)):
        prompt = m.group(1).strip()
        hint = m.group(2).strip()
        result['kind'] = 'spelling'
        result['prompt_ko'] = prompt
        result['hint'] = hint
        result['target_headword'] = same_row_headword
        result['note'] = f'스펠링힌트 - 힌트={hint}, 알파벳위치 prev={prev_head!r} next={next_head!r}'
        if not same_row_headword:
            # §2.3/§2.5 결정: 알파벳 위치 추론은 힌트일 뿐 확정 근거가 아니므로
            # word_id를 자동 생성하지 않는다(guessed_word는 review CSV 힌트로만 제공).
            result['guessed_word'] = f'{hint} (prev={prev_head}, next={next_head} 사이 알파벳 추정)'
        return result

    # e) 서술형/용법 메모: "문장에서 often의 위치는?", "one 의 쓰임에 대해 (숫자말고)", "일주일에 3시간", "매주 수요일"
    usage_target_match = re.search(r'([A-Za-z]+)', cell)
    if '?' in cell or '위치' in cell or '쓰임' in cell or '용법' in cell:
        result['kind'] = 'usage'
        result['prompt_ko'] = cell
        if usage_target_match:
            candidate = usage_target_match.group(1)
            result['target_headword'] = candidate
            result['note'] = f'서술형/용법 메모, 대상어 추정={candidate}'
        else:
            result['note'] = '서술형/용법 메모, 대상어 불명 - 드롭 or 수동보정'
        return result

    # c) 한국어 뜻만 (표제어 없음, 위 어느 것에도 안 걸림): "가위", "무거운", "털, 머리카락", "햄버거" 등
    if is_hangul_polluted(cell) and not same_row_headword:
        result['kind'] = 'spelling'
        result['prompt_ko'] = cell
        result['note'] = f'한글뜻만 - 알파벳위치 prev={prev_head!r} next={next_head!r} 사이에서 검수자 확정 필요'
        return result

    # 그 외(방어적): 순수 한글 + 표제어 있음 -> 표제어 보강 노트로 흡수(usage)
    if same_row_headword:
        result['kind'] = 'usage'
        result['prompt_ko'] = cell
        result['target_headword'] = same_row_headword
        result['note'] = '분류 미매칭 - 표제어 보강 노트로 흡수'
        return result

    # 완전 미분류 -> 수동보정 큐
    result['kind'] = 'usage'
    result['prompt_ko'] = cell
    result['note'] = '분류 미매칭 - 수동보정 필요'
    return result


# ---------------------------------------------------------------------------
# 메인 파이프라인
# ---------------------------------------------------------------------------
def main():
    if not INPUT_XLSX.exists():
        print(f"ERROR: 입력 파일 없음: {INPUT_XLSX}", file=sys.stderr)
        sys.exit(1)

    df_original = pd.read_excel(INPUT_XLSX, sheet_name='Sheet1')
    df_original.columns = ['no', 'head', 'deriv', 'write']

    # §2.2 완전 빈 행 삭제
    empty_mask = df_original['head'].isna() & df_original['deriv'].isna() & df_original['write'].isna()
    empty_idx = df_original.index[empty_mask].tolist()
    df = df_original[~empty_mask].copy()

    # 표제어 시리즈는 반드시 "필터링 전" 원본을 그대로 쓴다(df_original 기준, 위치==라벨 보장).
    # empty_mask로 걸러진 df에서 시리즈를 뽑으면 라벨(원본 인덱스)은 보존되지만 위치가 밀려,
    # find_neighbor_heads 내부의 .iloc[row_idx +- 1] 같은 위치 접근이 엉뚱한 행을 가리키는
    # 버그가 생긴다(실제로 재현됨: 'fall의 동사변형' 행의 next_head가 'False'로 나왔었음).
    # 완전빈행도 표제어가 NaN이므로 표제어 처리 루프(pd.isna 체크)에서 자연히 스킵되니
    # 필터링 전 시리즈를 그대로 써도 결과는 동일하고 위치=라벨 불일치 문제가 원천 차단된다.
    raw_head_series = df_original['head']

    id_map = IdMap(ID_MAP_JSON)

    # 사람 검수 반영 파일(선택, 하위호환) - 파일 없으면 둘 다 빈 dict
    word_resolutions = load_word_review_resolutions(WORD_REVIEW_RESOLVED_CSV)
    writing_resolutions = load_writing_manual_resolutions(WRITING_MANUAL_RESOLVED_CSV)

    words = OrderedDict()      # headword -> word dict (최종)
    lemma_groups = OrderedDict()  # group_label -> group id (임시, 최종 id는 뒤에서 부여)
    word_review_rows = []      # word_review.csv용

    # row_idx -> resolved headword(정규화 후 확정된 첫 candidate의 headword).
    # 파생어가 여러 개면 첫 번째를 대표로 삼되, 쓰기 파싱에서는 표제어 컬럼만 참조하므로
    # 파생어 쪽 resolved는 별도 처리 불필요.
    row_to_head_resolved = {}

    def register_candidate(cand: WordCandidate):
        """WordCandidate를 words dict에 등록(중복시 §2.4 병합규칙: headword origin 우선)."""
        hw = cand.headword
        if hw in words:
            existing = words[hw]
            # 병합: origin은 'headword' 우선
            if cand.origin == 'headword' and existing['origin'] == 'derivative':
                existing['origin'] = 'headword'
                existing['source_row'] = cand.source_row
            # pos_hint는 비어있으면 채움
            if not existing.get('pos_hint') and cand.pos_hint:
                existing['pos_hint'] = cand.pos_hint
            # needs_review는 OR
            if cand.needs_review:
                existing['needs_review'] = 1
                if cand.review_reason:
                    existing.setdefault('_review_reasons', []).append(cand.review_reason)
            return existing
        else:
            entry = {
                'headword': hw,
                'origin': cand.origin,
                'source_row': int(cand.source_row),
                'pos_hint': cand.pos_hint,
                'needs_review': cand.needs_review,
                'lemma_group_label': cand.lemma_group_label,
            }
            if cand.review_reason:
                entry['_review_reasons'] = [cand.review_reason]
            words[hw] = entry
            return entry

    # ---- 1) 표제어 처리 ----
    for row_idx, raw_head in raw_head_series.items():
        if pd.isna(raw_head):
            continue
        candidates = classify_headword(raw_head, row_idx)
        resolved_hw = None
        for cand in candidates:
            entry = register_candidate(cand)
            if resolved_hw is None:
                resolved_hw = entry['headword']
        if resolved_hw:
            row_to_head_resolved[row_idx] = resolved_hw

    # ---- 2) 파생어 처리 ----
    deriv_series = df['deriv']
    for row_idx, raw_deriv in deriv_series.items():
        if pd.isna(raw_deriv):
            continue
        same_row_head_resolved = row_to_head_resolved.get(row_idx)
        group_label = same_row_head_resolved or f"__row{row_idx}"
        candidates = split_derivative_cell(raw_deriv, row_idx, group_label)
        for cand in candidates:
            register_candidate(cand)

    # ---- 3) lemma_group 배정 ----
    # group_label(원 표제어 or 파생어 자기그룹) 별로 묶는다.
    # 표제어가 있는 행의 파생어는 표제어의 lemma_group_label(=표제어 자신의 headword)을 공유.
    label_to_members = OrderedDict()
    for hw, entry in words.items():
        label = entry.get('lemma_group_label') or hw
        label_to_members.setdefault(label, []).append(hw)

    lemma_group_id_of_label = OrderedDict()
    next_group_id = 1
    for label in label_to_members:
        lemma_group_id_of_label[label] = next_group_id
        next_group_id += 1

    lemma_group_records = []
    for label, gid in lemma_group_id_of_label.items():
        lemma_group_records.append({'id': gid, 'head_lemma': label})

    # ---- 4) stable_id 부여 (§3.4, idempotent) ----
    for hw in words:
        words[hw]['id'] = id_map.get_or_create(hw)

    # ---- 4.5) 사람 검수 결과 반영 (review/word_review_resolved.csv, 선택) ----
    # word_resolutions가 비어있으면(파일 없음) 아래는 전부 스킵 - 기존과 동일 동작.
    #
    # id 매칭 근거: 원본 xlsx는 수정하지 않으므로(가드레일), 헤드워드 처리(1)는 매 실행마다
    # 항상 같은 원본 텍스트("커플, 한쌍" 등)를 만들어낸다. 그 텍스트에 대해 id_map이 이미
    # 발급해둔 stable_id를 get_or_create가 그대로 반환하므로(§3.4 불변 계약), 이번 실행에서
    # 방금 조립한 id_to_hw 역매핑으로 stable_id -> 현재 words dict의 키를 안정적으로 찾을 수
    # 있다(위치/행 인덱스가 아니라 이미 배정된 id 자체를 근거로 삼음 - 재실행 안전).
    if word_resolutions:
        id_to_hw = {entry['id']: hw for hw, entry in words.items()}
        for sid, res in word_resolutions.items():
            hw_old = id_to_hw.get(sid)
            if hw_old is None:
                # 과거 실행에서 이미 처리돼 words dict에 더는 없는 stable_id(예: 이전에 absorb된 항목) - 스킵
                continue
            decision = res['decision']
            value = res['value']

            if decision == 'phrase':
                # phrase headword로 채택 확정: needs_review만 해제. pos_hint('phrase')는
                # classify_headword가 이미 동일 관례로 채워뒀으므로 그대로 둔다.
                entry = words[hw_old]
                entry['needs_review'] = 0
                entry.pop('_review_reasons', None)

            elif decision == 'headword':
                # headword 텍스트 교체. stable_id는 유지(엔트리를 in-place로 옮길 뿐 id 불변).
                entry = words.pop(hw_old)
                new_hw = normalize_text(value)
                old_label = entry.get('lemma_group_label') or hw_old
                entry['headword'] = new_hw
                entry['lemma_group_label'] = new_hw
                entry['needs_review'] = 0
                entry.pop('_review_reasons', None)
                words[new_hw] = entry

                # id_map에 새 headword 키도 같은 stable_id를 가리키도록 추가 등록.
                # 기존 키(원본 오염 텍스트)는 §3.4 "이미 발급된 매핑은 삭제/재배정 금지" 원칙에
                # 따라 그대로 둔다 - 다음 실행에서도 원본 텍스트로 같은 id를 재확인할 수 있어야 한다.
                if new_hw not in id_map.map:
                    id_map.map[new_hw] = sid

                # 같은 행에 파생어가 있었다면(이번 3건은 없음, 방어적 처리) 그룹 라벨 참조도 갱신
                src_row = entry['source_row']
                if row_to_head_resolved.get(src_row) == hw_old:
                    row_to_head_resolved[src_row] = new_hw

                # lemma_group 라벨 전이 (단독 그룹인 경우 head_lemma도 새 headword로 갱신)
                if old_label in lemma_group_id_of_label and old_label != new_hw:
                    gid = lemma_group_id_of_label.pop(old_label)
                    lemma_group_id_of_label[new_hw] = gid
                    for rec_g in lemma_group_records:
                        if rec_g['id'] == gid:
                            rec_g['head_lemma'] = new_hw
                            break

            elif decision == 'absorb':
                # 독립 word 항목에서 제거하고, value로 지정된 기존 word에 원문을 보존.
                # stable_id는 id_map에 이미 등록돼 있으므로(과거 실행분) 삭제 없이 그대로 두면
                # IdMap.save()의 retired_headwords 메커니즘이 자동으로 "결번 처리(재사용 금지)"를
                # 보장한다 - 이 항목만을 위한 별도 코드가 필요 없다.
                entry = words.pop(hw_old, None)
                if entry is None:
                    continue
                target_hw = next((cand for cand in words if cand.lower() == value.lower()), None)
                if target_hw is None:
                    print(
                        f"WARNING: word_review_resolved.csv stable_id={sid} absorb 대상 "
                        f"word({value!r})를 찾을 수 없음 - absorbed_phrases 미기록",
                        file=sys.stderr,
                    )
                else:
                    words[target_hw].setdefault('absorbed_phrases', []).append(hw_old)

            else:
                print(
                    f"WARNING: word_review_resolved.csv stable_id={sid} 알 수 없는 "
                    f"decision={decision!r} - 무시",
                    file=sys.stderr,
                )

        # absorb 등으로 구성원이 0이 된 lemma_group은 출력에서 제거(일관성 유지)
        referenced_gids = {
            lemma_group_id_of_label[entry.get('lemma_group_label') or hw]
            for hw, entry in words.items()
            if (entry.get('lemma_group_label') or hw) in lemma_group_id_of_label
        }
        lemma_group_records = [g for g in lemma_group_records if g['id'] in referenced_gids]

    # 최종 word 레코드 조립 (dict -> list, id 순 정렬)
    word_records = []
    for hw, entry in words.items():
        label = entry.get('lemma_group_label') or hw
        review_reasons = entry.pop('_review_reasons', [])
        rec = {
            'id': entry['id'],
            'headword': hw,
            'lemma_group_id': lemma_group_id_of_label[label],
            'origin': entry['origin'],
            'source_row': entry['source_row'],
            'pos_hint': entry.get('pos_hint'),
            'needs_review': entry.get('needs_review', 0),
        }
        if entry.get('absorbed_phrases'):
            rec['absorbed_phrases'] = entry['absorbed_phrases']
        word_records.append(rec)
        if rec['needs_review']:
            word_review_rows.append({
                'stable_id': rec['id'],
                'headword': hw,
                'origin': rec['origin'],
                'source_row': rec['source_row'],
                'reasons': ' | '.join(review_reasons) if review_reasons else '',
            })
    word_records.sort(key=lambda r: r['id'])

    # ---- 5) 쓰기 컬럼 파싱 (§2.5) ----
    write_series = df['write']
    writing_items = []
    writing_manual_rows = []
    next_writing_id = 1

    # headword -> stable_id 조회용
    headword_to_id = {hw: words[hw]['id'] for hw in words}
    headword_to_id_ci = {hw.lower(): wid for hw, wid in headword_to_id.items()}

    for row_idx, raw_write in write_series.items():
        if pd.isna(raw_write):
            continue
        same_row_headword = row_to_head_resolved.get(row_idx)
        parsed = parse_writing_cell(raw_write, row_idx, same_row_headword, raw_head_series)

        target_hw = parsed['target_headword']
        word_id = headword_to_id.get(target_hw) if target_hw else None
        target_word_entry = words.get(target_hw) if target_hw else None

        # §2.5 파싱 파이프라인 산출 1~3번: needs_review는 오직 "목표단어(word_id) 확정 여부"만 반영.
        #   - word_id 확정(1번: 형식b 전부 + 표제어있는 a/c/d) -> needs_review=0
        #   - word_id 미확정(target_headword가 words 테이블에 없거나 애초에 추정 안 됨,
        #     2번 표제어없는 스펠링힌트/3번 수동보정 큐 전부 포함) -> needs_review=1
        #   - 방어적 예외: 목표단어로 잡은 word 레코드 자체가 이미 needs_review=1(예: phrase/
        #     문장형 후보)이면 writing_item도 함께 검수 큐로 전파.
        if word_id is not None and not parsed['force_manual']:
            needs_review = 1 if (target_word_entry and target_word_entry.get('needs_review')) else 0
        else:
            needs_review = 1

        # review/writing_manual_resolved.csv 반영 (raw 문자열 매칭, 선택/하위호환)
        wres = writing_resolutions.get(parsed['raw'])
        if wres:
            resolved_word = wres['resolved_word']
            answer_override = wres['answer_override']
            if answer_override is None:
                # 'answer' 컬럼이 없는 구버전 CSV - 기존 동작 그대로(하위호환)
                parsed['answer'] = resolved_word
            elif answer_override == '':
                # 컬럼은 있지만 값이 빈 문자열 - word_id만 연결하고 answer는 null 유지
                # (예: inflection 원형 확정 - 정답 문자열은 gen_content 배치가 채움)
                parsed['answer'] = None
            else:
                # 컬럼에 값이 있음 - 그 값을 answer로 그대로 사용(verbatim, LLM 생성 대상 아님)
                parsed['answer'] = answer_override
            needs_review = 0
            # 기존 word headword와 대소문자 무시 일치하면 연결, 아니면 NULL 유지(신규 word 생성 안 함)
            word_id = headword_to_id_ci.get(resolved_word.lower())
        elif parsed['raw'] in WRITING_USAGE_FORCE_RESOLVED_TEXTS:
            # usage 항목(대상어가 word 목록에 없음) - 드롭하지 않고 needs_review만 확정.
            # word_id는 대상어가 없으므로 NULL 유지, answer도 NULL 유지(참고 프롬프트만, §2.5 형식e).
            needs_review = 0

        manual_queue = needs_review == 1

        item = {
            'id': next_writing_id,
            'word_id': word_id,
            'kind': parsed['kind'],
            'prompt_ko': parsed['prompt_ko'],
            'hint': parsed['hint'],
            'answer': parsed['answer'],
            'answer_alt': parsed['answer_alt'],
            'needs_review': needs_review,
            'raw': parsed['raw'],
            'source_row': int(row_idx),
        }
        writing_items.append(item)
        next_writing_id += 1

        if manual_queue:
            prev_head, next_head = find_neighbor_heads(raw_head_series, row_idx)
            writing_manual_rows.append({
                'raw': parsed['raw'],
                'guessed_word': parsed['guessed_word'] or (target_hw or ''),
                'prev_head': prev_head if prev_head is not None else '',
                'next_head': next_head if next_head is not None else '',
                'kind': parsed['kind'],
                'note': parsed['note'] or '',
            })

    # ---- 6) 산출물 기록 ----
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)

    try:
        source_file_display = str(INPUT_XLSX.relative_to(ROOT))
    except ValueError:
        source_file_display = str(INPUT_XLSX)

    words_payload = {
        'meta': {
            'source_file': source_file_display,
            'total_source_rows': int(len(raw_head_series)),
            'empty_rows_removed': empty_idx,
            'word_count': len(word_records),
            'lemma_group_count': len(lemma_group_records),
            'writing_item_count': len(writing_items),
        },
        'lemma_groups': lemma_group_records,
        'words': word_records,
        'writing_items': writing_items,
    }
    with open(WORDS_JSON, 'w', encoding='utf-8') as f:
        json.dump(words_payload, f, ensure_ascii=False, indent=2)

    # §3.1 2단계 산출물: word 레벨 검수(review/word_review_resolved.csv)가 적용되어
    # needs_review=1 word가 하나도 남지 않으면 words.final.json도 함께 출력한다.
    # (주의: writing_item 레벨은 별개 축 - 대상어 자체가 word 목록에 없는 inflection
    # 11건은 이 조건과 무관하게 needs_review=1로 남을 수 있다. 완료 보고 참고.)
    word_review_fully_resolved = bool(word_resolutions) and all(
        r['needs_review'] == 0 for r in word_records
    )
    if word_review_fully_resolved:
        with open(WORDS_FINAL_JSON, 'w', encoding='utf-8') as f:
            json.dump(words_payload, f, ensure_ascii=False, indent=2)

    id_map.save(active_headwords=list(words.keys()))

    with open(WORD_REVIEW_CSV, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=['stable_id', 'headword', 'origin', 'source_row', 'reasons'])
        writer.writeheader()
        for row in word_review_rows:
            writer.writerow(row)

    with open(WRITING_MANUAL_CSV, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=['raw', 'guessed_word', 'prev_head', 'next_head', 'kind', 'note'])
        writer.writeheader()
        for row in writing_manual_rows:
            writer.writerow(row)

    # ---- 7) 통계 출력 ----
    print("=" * 70)
    print("clean.py 실행 완료")
    print("=" * 70)
    print(f"원본 총 행수(빈행 제거 전): {len(df) + len(empty_idx)}")
    print(f"완전빈행 삭제: {len(empty_idx)}개 {empty_idx}")
    print()
    print(f"총 word 수: {len(word_records)}")
    origin_counts = {}
    for r in word_records:
        origin_counts[r['origin']] = origin_counts.get(r['origin'], 0) + 1
    for k, v in sorted(origin_counts.items()):
        print(f"  origin={k}: {v}")
    print()
    print(f"lemma_group 수: {len(lemma_group_records)}")
    print()
    print(f"needs_review=1 word 수: {sum(1 for r in word_records if r['needs_review'])}")
    print()
    print(f"writing_item 총 수: {len(writing_items)}")
    kind_counts = {}
    for it in writing_items:
        kind_counts[it['kind']] = kind_counts.get(it['kind'], 0) + 1
    for k, v in sorted(kind_counts.items()):
        print(f"  kind={k}: {v}")
    print(f"  needs_review=1: {sum(1 for it in writing_items if it['needs_review'])}")
    print(f"  word_id 미확정(NULL): {sum(1 for it in writing_items if it['word_id'] is None)}")
    print(f"  answer 채워짐: {sum(1 for it in writing_items if it['answer'])}")
    print()
    print(f"writing_manual.csv 행 수(수동보정 큐): {len(writing_manual_rows)}")
    print(f"word_review.csv 행 수: {len(word_review_rows)}")
    print()
    if word_resolutions:
        print(f"word_review_resolved.csv 적용: {len(word_resolutions)}건")
    else:
        print("word_review_resolved.csv 없음(스킵)")
    if writing_resolutions:
        print(f"writing_manual_resolved.csv 적용: {len(writing_resolutions)}건")
    else:
        print("writing_manual_resolved.csv 없음(스킵)")
    print()
    print(f"산출물:")
    print(f"  {WORDS_JSON}")
    if word_review_fully_resolved:
        print(f"  {WORDS_FINAL_JSON}  (word 레벨 검수 전량 해소)")
    print(f"  {ID_MAP_JSON}")
    print(f"  {WRITING_MANUAL_CSV}")
    print(f"  {WORD_REVIEW_CSV}")


if __name__ == '__main__':
    main()
