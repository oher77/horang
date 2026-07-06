#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
clean.py — 호랑이 잉글리시 원본 정제 스크립트

설계.md §2 (원본 정제 + 쓰기 컬럼 파싱 규칙) §3.1 (파이프라인 흐름) §3.4 (stable_id 규약)의
유일한 구현체. 이 파일만으로 정제 단계를 재현할 수 있어야 한다.

입력:  data/voca_data.xlsx (Sheet1, 컬럼: [번호, 표제어, 파생어, 쓰기])
출력:
  build/words.json           - 정제된 word / lemma_group / writing_item (stable_id 부여됨)
  build/id_map.json          - headword -> stable_id 영속 매핑 (재실행 멱등성의 핵심)
  review/writing_manual.csv  - 쓰기 컬럼 수동보정 큐
  review/word_review.csv     - needs_review=1 word 목록 (한글뜻 오염 표제어 등)

재실행 시 idempotent: 같은 headword는 항상 같은 stable_id를 받는다. 신규 headword만
기존 max_id + 1부터 순차 배정된다. 삭제된(더 이상 원본에 없는) headword의 id는
id_map에 남겨두되(결번 처리, 재사용 금지) words.json에는 포함하지 않는다.
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
ID_MAP_JSON = BUILD_DIR / "id_map.json"
WRITING_MANUAL_CSV = REVIEW_DIR / "writing_manual.csv"
WORD_REVIEW_CSV = REVIEW_DIR / "word_review.csv"

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
    print()
    print(f"writing_manual.csv 행 수(수동보정 큐): {len(writing_manual_rows)}")
    print(f"word_review.csv 행 수: {len(word_review_rows)}")
    print()
    print(f"산출물:")
    print(f"  {WORDS_JSON}")
    print(f"  {ID_MAP_JSON}")
    print(f"  {WRITING_MANUAL_CSV}")
    print(f"  {WORD_REVIEW_CSV}")


if __name__ == '__main__':
    main()
