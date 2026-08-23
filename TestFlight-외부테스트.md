# TestFlight 외부 테스트 (2단계) 진행 문서

작성 2026-08-21. 1단계(내부 TestFlight, 가족 설치·사용) 완료 후 시작.
**이 문서의 문구는 App Store Connect에 그대로 붙여넣는 용도다.** 절차는 위에서 아래 순서대로.

---

## 0. 사전 확인

| 항목 | 상태 |
| --- | --- |
| 번들 ID `com.heruse.horang` | 확정 (변경 불가) |
| `ITSAppUsesNonExemptEncryption: false` | `app.json`에 설정됨 → 빌드마다 수출규정 질문 안 뜸 |
| EAS 빌드 채널 | `eas.json`의 `production`은 App Store 배포용 → 외부 승격 가능 (Xcode의 "Internal Only" 업로드가 아님) |
| 내부 테스트용 빌드 | **같은 빌드를 외부로 그대로 승격 가능. 재빌드 불필요.** |
| TestFlight 빌드 만료 | 업로드일로부터 **90일**. 만료가 가까우면 새로 빌드해서 시작할 것 |

> 주의: 내부 테스터가 쓰던 그 빌드를 외부 그룹에 추가하는 것이므로 버전을 올릴 필요가 없다.
> 단, 코드에 고칠 게 남았다면 **지금 고쳐서 새 빌드를 올리고** 그 빌드로 외부 심사를 받는 게 낫다
> (외부 심사는 빌드 단위라, 심사 통과 후 새 빌드를 올리면 다시 심사를 받는다).

---

## 1. 개인정보처리방침 · 지원 URL 게시 (GitHub Pages)

`docs/` 폴더에 페이지 2장을 만들어 뒀다.

- `docs/index.html` — 지원 페이지 (앱 소개·FAQ·문의)
- `docs/privacy.html` — 개인정보처리방침 (한국어 + 영어 병기)

### 게시 절차

1. 커밋·푸시 (아래 2번의 명령 참조)
2. GitHub 저장소 → **Settings → Pages**
3. **Source: Deploy from a branch** / **Branch: `main`** / **Folder: `/docs`** → Save
4. 1~2분 뒤 아래 주소가 열리는지 확인

```
지원      https://oher77.github.io/horang/
방침      https://oher77.github.io/horang/privacy.html
```

> 두 주소는 **3단계(공개 출시)에서도 그대로 쓴다** — Support URL / Privacy Policy URL 필수 항목.

### 방침 내용의 근거 (심사에서 물어보면)

앱 코드 전체를 검색한 결과 `fetch`·`axios`·URL 접근이 **0건**이다. 분석/추적/광고 SDK 없음.
`expo-notifications`는 로컬 알림만 사용(원격 푸시 토큰 발급 코드 없음),
`expo-speech`는 iOS 내장 TTS(마이크 미사용), 공유는 사용자가 버튼을 눌렀을 때만 동작.
→ **App Privacy 설문에서 "Data Not Collected"로 답하는 것이 사실과 일치한다.**

---

## 2. 커밋·푸시

```bash
git add docs/ TestFlight-외부테스트.md
git commit -m "외부 TestFlight 준비: 개인정보처리방침·지원 페이지 추가 (GitHub Pages)"
git push
```

---

## 3. App Privacy 설문 (App Store Connect)

외부 배포 전에 **한 번은 반드시** 채워야 하는 항목이다.

App Store Connect → 앱 선택 → 좌측 **App Privacy** → Data Collection

- **"No, we do not collect data from this app"** 선택 → Publish

이후 앱 페이지에 "데이터가 수집되지 않음"으로 표시된다.

---

## 4. TestFlight → Test Information (아래 문구 그대로 붙여넣기)

TestFlight 탭 → 좌측 **Test Information**

### Beta App Description (외부 테스터에게 보이는 설명)

```
호랑잉글리시는 교육부 지정 중학교 영단어 2,416개를 하루 20개씩 6개월에 완주하도록 만든 단어장 앱입니다.

- 단어장: 뜻을 가리고 떠올리기, 스와이프로 기억 정도 표시, 단어를 누르면 발음 재생
- 복습: 학습한 날로부터 1·3·7·14·30·60·120일 뒤 자동으로 복습 대상이 됩니다
- 테스트: 하루 한 번, 단어→뜻 / 뜻→단어 / 쓰기 문제를 섞어 출제하고 직접 채점합니다
- 용돈 장부: 점수에 해당하는 금액을 기록하고 부모님이 지급 여부를 체크합니다 (앱 내 결제 없음)

인터넷 연결 없이 동작하며, 학습 기록은 기기 안에만 저장됩니다. 회원가입·광고·인앱 결제가 없습니다.
```

### Feedback Email

```
heruse@gmail.com
```

### Privacy Policy URL

```
https://oher77.github.io/horang/privacy.html
```

### Marketing URL (선택)

```
https://oher77.github.io/horang/
```

---

## 5. Beta App Review Information

같은 화면 아래쪽. **Apple 심사자가 읽는 칸이므로 영어로 적는다.**

- **Sign-in required**: 체크 해제 (로그인 없음)
- **First Name / Last Name / Phone / Email**: 본인 정보 (심사자가 연락할 수 있어야 함)
- **Review Notes**:

```
This app is a fully offline English vocabulary study app for Korean middle school students.

- No account or sign-in is required. Tap anywhere on the home screen to start.
- The app makes no network requests. All vocabulary data is bundled in the app.
- No analytics, tracking, or advertising SDKs are included.
- The "allowance ledger" screen only records an amount that a parent marks as paid.
  There is no payment processing or in-app purchase of any kind.
- Notifications are local reminders only, disabled by default, and can be enabled in Settings.
- The app UI is in Korean.

How to try the main flow:
1. Tap the speech bubble on the home screen to open today's word list.
2. Tap a word to hear its pronunciation; swipe a row to mark how well you remember it.
3. Go back and use the Test button to take the daily test and grade yourself.
```

---

## 6. What to Test (빌드별 테스트 안내문)

TestFlight → Builds → 해당 빌드 선택 → **What to Test**

```
처음 써 보는 상태에서 홈 화면만 보고 무엇을 해야 할지 알 수 있는지가 이번 테스트의 핵심입니다.
설명 없이 자유롭게 만져 보시고, 아래를 알려주세요.

1. 홈 화면에서 가장 먼저 누른 곳은 어디였나요? 그게 기대한 화면이었나요?
2. "오늘 공부를 시작하는 입구"를 찾는 데 얼마나 걸렸나요?
3. 호랑이를 눌렀을 때 무슨 일이 일어나는지 알아차렸나요?
4. 단어장 → 테스트까지 한 번 해 보셨다면, 중간에 막히거나 헷갈린 지점이 있었나요?
5. 글자 크기·버튼 위치가 손에 잘 맞았나요? (기기 종류도 함께 알려주시면 좋습니다)

버그를 만나면 TestFlight 앱에서 스크린샷을 찍어 바로 피드백을 보낼 수 있습니다.
문의: heruse@gmail.com
```

> 이 문구의 1~3번은 **딸로는 검증이 불가능한 항목**(제작 과정을 봐서 앱을 이미 안다)이라
> 외부 테스트를 하는 진짜 이유다. 결과에 따라 홈 화면 진입점 설계를 고칠 수 있다.

---

## 7. 외부 그룹 만들기 → 테스터 초대 → 심사 제출

1. TestFlight 탭 → 좌측 **External Testing** 옆의 **+** → 그룹 생성 (예: `학부모 베타`)
2. 그룹에 **빌드 추가** (Builds → + → 내부에서 쓰던 그 빌드 선택)
3. 빌드를 추가하면 **자동으로 Beta App Review 제출**된다 (상태: Waiting for Review)
4. 테스터 추가 — 이메일로 초대하거나 **Public Link**를 켜서 링크를 배포 (최대 10,000명)
5. 심사 통과(보통 1~2일, 첫 제출은 더 걸릴 수 있음) 후 테스터에게 초대 메일 발송

> **Public Link**를 쓰면 이메일을 모아둘 필요 없이 카톡으로 링크만 보내면 된다.
> 소수 학부모 대상이면 이쪽이 훨씬 편하다. 인원 상한도 링크마다 따로 걸 수 있다.

### 심사에서 자주 걸리는 것 (미리 점검)

- **개인정보처리방침 URL이 안 열림** → Pages 게시 확인 후 제출할 것 (1번)
- **로그인 정보 누락** → 이 앱은 로그인이 없으므로 Sign-in required 체크 해제로 충분
- **기능이 미완성으로 보임** → 눌렀을 때 아무 반응이 없거나 "준비 중" 화면이 뜨는 버튼이 있으면 지적된다.
  - 홈의 **리본(획득물)**: 2026-08-21 **장식으로 변경 완료** — 라우팅을 떼어 탭이 안 되게 했다.
    딸 시안의 하단 구성은 그대로 유지된다. (`components/home/HomeMenuButtons.tsx`의 collection 항목)
  - 딸 에셋 대기 중인 **하품 얼굴·발톱·호랑이 사운드는 리스크가 아니다** — 소리가 없어도
    머리 모션이라는 시각 피드백이 나오므로 "반응 없는 버튼"이 아니다.

---

## 8. 이번 단계의 완료 조건

- [x] GitHub Pages 두 주소가 열린다
- [x] App Privacy = Data Not Collected 게시됨
- [x] Test Information 4칸 입력됨 (설명·이메일·방침 URL·마케팅 URL)
- [x] Beta App Review Information 입력됨
- [x] 외부 그룹 생성 + 빌드 할당 + 심사 통과 — 빌드 4, Public Link, 테스터 2명 (2026-08-23)
- [ ] **빌드 5 업로드** — 빌드 4에는 iOS 접근성 설정 결함이 남아 있다(동작 줄이기 켜면 호랑이
      반응·로켓 축포가 안 보이고, 텍스트 크기를 바꾸면 홈 글자가 어긋남. 커밋 `9ddc856`에서 수정).
      **이 빌드가 올라가기 전에는 테스터에게 피드백을 요청하지 않는다.**
- [ ] 외부 테스터 최소 3~5명이 실제로 설치해서 홈 화면 첫인상 피드백을 보내옴
      ⚠️ **첫인상은 사람당 1회뿐이다** — 한꺼번에 다 부르지 말고 몇 명 남겨둘 것
- [ ] 피드백을 반영할지 판단 → 반영하면 새 빌드, 아니면 3단계(공개 출시)로

---

## 다음 단계 (3단계 공개 출시)에서 추가로 필요한 것

이번에 만든 URL 2개는 재사용된다. 추가로 준비할 것:

- 스크린샷 (6.7"·6.5" 필수 사이즈)
- 앱 이름 "호랑잉글리시"로 **App Store 중복 검색 재확인** (옛 이름 기준 확인은 무효)
- 메타데이터: 부제·설명·키워드 100자·카테고리(교육)·연령등급
- 판매자 실명 공개 여부 결론 (개인 계정이면 실명이 노출됨)
- 학습 데이터 백업 방식 결론 — 외부 테스트에서 데이터 소실 클레임이 실제로 나오는지 보고 결정
