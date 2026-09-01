# 여행지 소거전

**https://soyellll.github.io/trip-vote/**

친구들끼리 여행지를 정하는 모바일 웹앱. 가고 싶은 곳을 모으고 → 한 명당 2표로 익명 투표 →
과반이 나오면 확정, 아니면 상위 3곳을 두고 재투표 또는 돌림판.

코멘트는 **본인 말투로 쓰고 AI 말투로 변환한 뒤** 제출됩니다. 원문은 어디에도 저장되지 않습니다.

- 정적 페이지 (GitHub Pages)
- 실시간 동기화 + 저장 (Supabase)
- AI 말투 변환 (Supabase Edge Function → Gemini API, 무료 티어)

설정 전에도 그냥 열면 **한 기기에서 폰을 돌려가며 쓰는 모드**로 동작합니다 (AI 변환 제외).

---

## 1. Supabase 설정

### 1-1. 프로젝트 만들고 스키마 넣기

새 프로젝트를 만든 뒤, **SQL Editor** 에 `supabase/schema.sql` 을 통째로 붙여넣고 실행합니다.

### 1-2. 익명 로그인 켜기

**Authentication → Sign In / Providers → Anonymous sign-ins** 를 켭니다.
이걸 안 켜면 앱이 단말 모드로 떨어집니다.

### 1-3. 접속 정보 넣기

**Project Settings → API** 에서 URL 과 anon key 를 복사해 `config.js` 에 넣습니다.

```js
window.TRIP_VOTE_CONFIG = {
  SUPABASE_URL: "https://xxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi..."
};
```

이 두 값은 **공개되어도 되는 값**입니다. anon key 는 브라우저에서 쓰라고 만든 키이고,
실제 권한은 `schema.sql` 의 RLS 정책이 정합니다. 커밋해도 됩니다.

### 1-4. Edge Function 배포

Gemini API 키는 [Google AI Studio](https://aistudio.google.com/apikey) 에서 **Create API key** 로
발급받습니다. 결제 수단 없이 무료 티어로 바로 씁니다.

프로젝트 폴더에서 터미널을 열고 (전역 npm 설치는 Supabase 가 막아뒀으므로 `npx` 를 씁니다):

```bash
npx supabase@latest login
npx supabase@latest link --project-ref <프로젝트 ref>
npx supabase@latest secrets set GEMINI_API_KEY=... ALLOWED_ORIGIN=https://soyellll.github.io
npx supabase@latest functions deploy tone
```

프로젝트 ref 는 대시보드 주소의 `/project/<ref>` 부분이고, 로그인 후
`npx supabase@latest projects list` 로도 확인할 수 있습니다.

> **GEMINI_API_KEY 는 이 secret 안에만 존재합니다.** `config.js` 에도, 프론트 코드 어디에도
> 넣지 마세요. 정적 사이트에 넣은 키는 개발자도구에서 그대로 보이고, 퍼블릭 레포면
> 커밋 히스토리에서도 털립니다.

## 2. GitHub Pages 배포

설정 완료 상태입니다. `main` 에 push 하면 `.github/workflows/pages.yml` 이 자동 배포합니다.

```bash
git add -A && git commit -m "설정" && git push
```

## 3. 사용

1. 배포된 주소를 열고 **새 방 만들기**
2. **링크 복사** 를 눌러 단톡방에 뿌리기
3. 각자 링크를 열고 이름 입력 → 여행지 추가 → 투표

---

## AI 변환 프록시가 막고 있는 것

`supabase/functions/tone` 은 그냥 열린 API 가 아닙니다. 안 잠그면 그 엔드포인트가 곧
누구나 쓰는 무료 AI API 가 됩니다. 네 겹으로 막습니다.

| 방어 | 내용 |
|---|---|
| 신원 | 익명이라도 실제 Supabase 세션이 있어야 함. anon key 만으로는 통과 못 함 |
| 방 코드 | 존재하는 방의 코드를 같이 보내야 함. 링크를 모르면 못 씀 |
| 레이트 리밋 | 사용자당 시간당 40회 (`HOURLY_LIMIT`) |
| 길이 상한 | 원문·변환문 모두 100자, `maxOutputTokens` 400 |

CORS 도 `ALLOWED_ORIGIN` 으로 좁힐 수 있습니다 (기본 `*`).

## 비용과 한도

`gemini-3.5-flash` 무료 티어라 **비용 $0** 입니다. 대신 상한이 있습니다.

- 무료 API 키: **분당 10회, 하루 250회** — 앱 전체(모든 사용자) 합산 기준입니다
- 5명이 두 라운드 도는 한 번의 여행지 결정에 20회 안팎이라 넉넉합니다
- 한도를 넘기면 429 가 오고, 화면에는 "AI 변환 한도에 걸렸어요" 가 뜨며
  사용자는 "원문 그대로 쓰기" 로 넘어갈 수 있습니다 — 앱이 멈추지는 않습니다

> **무료 티어는 입력·출력이 Google 제품 개선에 사용됩니다.** 유료(빌링 연결) 티어여야
> 사용되지 않습니다. 코멘트 원문이 여기 해당하므로, 신경 쓰인다면 빌링을 연결하거나
> Edge Function 배포를 건너뛰고 "기호·말버릇만 지우기" 폴백만 쓰세요.

## 다른 모델로 바꾸려면

`supabase/functions/tone/index.ts` 한 파일만 고치면 됩니다. 프론트는 `/functions/v1/tone` 에
POST 하고 `{text}` 를 받을 뿐이라 뒤에 어떤 모델이 있는지 모릅니다. 스키마, RLS, 레이트 리밋,
100자 상한, 익명성 설계는 전부 그대로입니다.

## 익명성을 위해 일부러 한 것들

- **`ballots` 에 타임스탬프가 없습니다.** 시각이 남으면 투표 순서와 대조해
  "세 번째로 투표한 사람이 어디에 표를 줬는지"가 그대로 드러납니다. `id` 도 `gen_random_uuid()` 라
  시간순 정보가 없습니다.
- **표는 Realtime 으로 흘려보내지 않습니다.** publication 에서 `ballots` 를 뺐습니다.
  실시간으로 나가면 개발자도구를 켜 둔 사람이 "표 INSERT" 와 "누가 방금 투표 완료로 바뀌었는지"를
  나란히 보고 짝지을 수 있습니다. 표는 결과를 열 때 한 번에 가져옵니다.
- **한 표에 담긴 여러 코멘트의 순서를 섞어서 저장합니다.**
- **원문은 서버로 갔다가 버려집니다.** DB 에 저장되지 않고, Edge Function 로그에도 찍지 않습니다.
- 화면에 뜨는 코멘트는 가나다순으로 정렬해 보여줍니다.

## 알려진 트레이드오프

**읽기는 방 코드로 막지 않았습니다.** Supabase Realtime 구독은 REST 헤더를 전달하지 않아서,
읽기까지 방 코드로 막으면 실시간 동기화가 통째로 죽습니다. 그래서:

- **쓰기**는 `x-room-code` 헤더로 방을 증명해야 합니다 — 남이 내 방을 망칠 수 없습니다.
- **읽기**는 이 프로젝트에 세션이 있는 사람이면 다른 방 데이터도 조회할 수 있습니다.

친구들 여행지 정하는 용도로는 충분하지만, 민감한 내용을 담을 앱은 아닙니다.
꼭 막아야 한다면 Supabase 의 Custom Access Token Hook 으로 방 코드를 JWT 클레임에 넣고
RLS 를 `auth.jwt() ->> 'room'` 기준으로 다시 쓰면 됩니다.

## 파일

```
index.html                     화면 + 스타일
app.js                         전부 (상태, 저장소, 뷰)
config.js                      Supabase URL / anon key
supabase/schema.sql            테이블 + RLS + Realtime + 쿼터 함수
supabase/functions/tone/       AI 말투 변환 프록시 (API 키는 여기 secret 에만)
.github/workflows/pages.yml    GitHub Pages 자동 배포
```
