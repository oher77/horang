# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 오케스트레이션 규칙

**적용 범위(중요): 이 섹션은 메인 대화의 오케스트레이터에게만 적용된다. 당신이 서브에이전트(Task/Agent로 스폰된 deep-reasoner/default-worker/task-worker 등)라면 이 섹션 전체를 무시하고 받은 작업을 자신이 직접 수행하라. 서브에이전트가 Agent 도구로 작업을 재위임하는 것은 금지한다 — 재위임 연쇄는 산출물 없이 토큰만 소모한다 (2026-07-07 실제 발생).**

메인 모델(Fable)은 오케스트레이터다. 직접 코드를 수정하지 않는다.
작업을 계획하고, 쪼개고, 서브에이전트에 배분하고, 결과를 종합하는 역할만 한다.

## 작업 배분

- **deep-reasoner** (Opus): 아키텍처 설계, 복잡한 디버깅, 알고리즘 판단 등 무거운 추론
- **default-worker** (Sonnet): 기능 구현, 보일러플레이트, 테스트, 리팩터링 등 일반 코드 작업
- **task-worker** (Haiku): 오타 수정, 파일 정리, 단순 반복 작업 등 가벼운 잡무

## 원칙

- 비싼 모델은 판단에만, 싼 모델은 실행에 쓴다.
- 오케스트레이터의 컨텍스트는 가볍게 유지한다. 긴 파일 읽기와 탐색은 서브에이전트에 위임한다.
- worker 스폰 시 프롬프트 첫 줄에 "직접 수행, Agent 재위임 금지"를 명시하고, 스폰 후 1~2분 내 실제 산출물이 나오는지 확인한다.
- 중요한 판단은 `codex exec`(설치돼 있는 경우)와 deep-reasoner에 병렬로 독립 검토시키고, 서로의 답을 보여주지 않은 채 두 답을 받아 종합한다.
- 예외: 한 줄 수정처럼 위임 오버헤드가 작업 자체보다 큰 경우는 직접 처리해도 된다.
- 앱 품질이 비용 절감보다 우선한다. 품질/신뢰성 확보에 필요한 지출(예: Apple 개발자 계정 $99/년)은 미루지 말고 필요 시점에 바로 제안할 것.

# 프로젝트: 호랑이 잉글리시 (Horang English)

고등학생 대상 영단어 학습 앱 (React Native + Expo). 약 2400개 단어를 하루 단위 단어장(Day1, Day2...)으로 생성해 암기·복습·테스트하고, 점수를 용돈(Income) 장부와 연결한다.

## 필독 문서

- `설계.md` — **구현의 유일한 지침.** SQLite DDL 전문, 원본 정제·파싱 규칙, 콘텐츠 생성 파이프라인, 화면 구조·라우팅·상태관리, 핵심 쿼리, 미결 목록(§6). 코드 작업 전 반드시 해당 섹션을 읽을 것.
- `기술방향.md` — 스택 확정 근거(PWA 반려 사유), 개발 환경 제약, 비용 전략, 가드레일
- `단어장 앱 만들기.md` — 기획서 원문 (화면별 요구사항). **수정 금지 — 사용자의 원본 문서.**

## 명령어

```bash
npx expo start          # Metro 개발 서버 (Expo Go로 iPhone 실기기 테스트, QR 연결)
python3 scripts/clean.py  # 원본 정제 파이프라인: data/voca_data.xlsx → build/ + review/ (인자 없음, 멱등)
```

- 테스트·린트는 아직 미설정 (스캐폴드 직후 상태).
- Expo SDK 57 / RN 0.86 / React 19.2 / TypeScript 6. 로컬 Node v22.
- iOS 네이티브 빌드는 로컬 불가(iMac 2015, Xcode 14.2 한계) — EAS 클라우드 빌드 사용. 개발 반복은 Expo Go로 무료.

## 아키텍처

**2-DB 구조** (설계.md §1): 읽기 전용 `content.db`(단어·뜻·예문, 사전 빌드해 에셋 번들) + `user.db`(학습 진행·점수·설정, 첫 실행 시 생성). 날짜는 INTEGER epoch day(UTC 자정 기준 일수)로 저장 — 복습 -N일 조회가 정수 비교로 인덱스를 탄다.

**콘텐츠 데이터 흐름** (설계.md §2–3):
```
data/voca_data.xlsx (원본, 수정 금지)
  → scripts/clean.py (정제·파생어 분해·쓰기 파싱·stable_id 발급)
    → build/words.json (words 2417 / lemma_groups 2171 / writing_items 43)
    → build/id_map.json (stable_id 영속 맵 — 재실행 멱등성의 핵심, §3.4)
    → review/*.csv (사람 검수 큐: 목표 영단어 미확정 항목)
  → [검수 승인 후] LLM 뜻·예문 일괄 생성 → content.db 빌드
```

**앱 코드**: expo-router 파일 기반 라우팅(`app/`), 상태관리는 Zustand + 화면 로컬(React Query 등 미도입). 현재 `app/_layout.tsx` + `app/index.tsx` 빈 스캐폴드만 있음. 화면 트리·화면별 쿼리 매핑은 설계.md §4.

## 가드레일

- **Expo Go에 포함되지 않은 서드파티 네이티브 모듈 도입 금지.** 도입하는 순간 dev build(= 유료 Apple 계정)가 강제됨. FlashList도 이 이유로 금지 — 100+행 테이블은 RN 내장 FlatList 윈도잉(보이는 15~20행) + stagger 애니메이션으로 처리 (설계.md §4.5).
- 허용된 네이티브 의존성: expo-sqlite, expo-speech, react-native-reanimated, react-native-gesture-handler (+ expo-router 동반 패키지).
- `data/voca_data.xlsx`·`build/id_map.json`을 임의 수정/삭제하지 말 것 — id_map이 깨지면 앱 업데이트 시 사용자 진행 데이터 참조가 전부 무효화된다.
- TTS 연속 탭 중복 재생 방지: `Speech.stop()` 후 `speak()` 패턴.

## 핵심 도메인 규칙

- 단어장은 하루 1개만 생성, 전체 Day 간 단어 중복 절대 금지 (미사용 풀에서 랜덤 추출)
- 파생어는 표제어와 동등한 독립 단어 항목 (노출·출제 동일 취급, 쌍 관계는 lemma_group 메타데이터)
- 복습 스케줄: 학습일 기준 -1/-3/-7/-14/-30/-60/-120일 전 단어장
- 테스트는 자기채점(학생이 직접 오답·발음헷갈림 체크), 혼합 출제(단어→뜻/뜻→단어/쓰기 문제)
- 발음 기능은 TTS 출력 + 체크 장부만 (녹음 없음)
- 기억 인출 실패 5단계: 우스와이프 증가/좌스와이프 감소
- Income: 점수별 금액을 표시하고 부모 지급 여부만 체크하는 장부 (결제 연동 없음)

## 현재 상태 & 다음 단계 (2026-07-07)

1. **(사용자 대기) review/word_review.csv 9건 + review/writing_manual.csv 29건 검수** — 목표 영단어 확정 필요
2. 검수 반영 → LLM 뜻·예문 일괄 생성(검수 표본 포함) → content.db 빌드 (설계.md §3)
3. 화면 구현 시작 (설계.md §4 순서: 단어장 테이블 → 가리기 애니메이션 → 복습/테스트)
4. 잔여 미결은 설계.md §6 참고 (stable_id 규약은 clean.py에 구현 완료)
