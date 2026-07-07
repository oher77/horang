---
name: horang-worker-guide
description: 호랑이 잉글리시 프로젝트에서 코드를 작성·수정하는 모든 작업의 필수 규약. 앱 코드(app/, lib/, components/)나 파이프라인 스크립트(scripts/)를 만들거나 고치기 전에 반드시 숙지할 것.
---

# 호랑이 잉글리시 — 구현 규약 (워커 필수 숙지)

## 스택 (고정 — 임의 변경 금지)

- **Expo SDK 54 고정** (expo ~54.0.35 / RN 0.81.5 / React 19.1.0 / expo-router ~6.0 / TypeScript ~5.9). App Store의 Expo Go가 SDK 54까지만 지원하므로 **어떤 패키지도 SDK 55+ 계열로 올리지 말 것.**
- 파이프라인 스크립트는 시스템 Python 3.9 — match문 등 3.10+ 문법 금지.

## Expo Go 가드레일 (위반 시 유료 dev build 강제됨)

- Expo Go에 포함되지 않은 서드파티 네이티브 모듈 도입 금지. 새 npm 패키지 추가는 원칙적으로 금지 — 필요하면 중단하고 보고.
- 허용된 네이티브 의존성: expo-sqlite, expo-speech, react-native-reanimated, react-native-gesture-handler, expo-asset, expo-file-system (+ expo-router 동반 패키지).
- FlashList 금지 — 100+행 테이블은 RN 내장 FlatList 윈도잉 (고정 ROW_HEIGHT + getItemLayout, 설계.md §4.5). 이 최적화를 깨는 가변 행높이 도입 금지.

## 코드 규약

- **설계.md가 구현의 유일한 지침.** DDL·화면 구조·쿼리는 해당 섹션을 먼저 읽고 그대로 따를 것. `단어장 앱 만들기.md`(기획 원문)와 `data/`, `build/id_map.json`은 수정 금지 (permissions로 차단돼 있음).
- 날짜는 epoch day INTEGER — 반드시 `lib/dates.ts` 유틸 사용. 직접 Date 연산 금지.
- DB 접근은 `lib/db.ts`의 기존 export 재사용 — openDatabaseAsync 이중 초기화 금지.
- TTS는 반드시 `Speech.stop()` 후 `speak()` (연속 탭 중복 재생 방지).
- stable_id 계약: word.id 등을 재배정·재사용하지 말 것 (설계.md §3.4).
- 기존 코드 스타일·주석 밀도를 따를 것.

## 검증 (완료 선언 전 필수 실행)

- `npx tsc --noEmit` 통과
- 앱 코드 변경 시: `npx expo export --platform ios --output-dir <스크래치 경로>` 번들 성공
- 파이프라인 스크립트 변경 시: `python3 -m py_compile <파일>` + 가능하면 실제 실행

## 완료 보고 형식 (필수)

1. 작성/수정 파일 목록
2. **스펙과 다르게 판단한 것** — 사소해 보여도 전부 명시 (조용한 임의 판단 금지)
3. 실행한 검증과 결과
4. 실기기 확인이 필요한 항목

## 금지

- Agent 도구로 재위임 금지 (직접 수행)
- git 커밋 금지 (오케스트레이터가 사용자 승인 후 수행)
- 모호하면 임의 해석하지 말고 중단 후 선택지를 보고
