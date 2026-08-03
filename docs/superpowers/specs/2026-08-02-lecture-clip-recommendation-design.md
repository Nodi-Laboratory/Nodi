# 강의 클립(숏폼) 추천 설계 — EBS 타임라인 기반

- 날짜: 2026-08-02
- 상태: 승인 대기(스펙 리뷰)

## 문제

학생이 워크스페이스에서 개념을 질문할 때, 그 개념을 다루는 **강의 영상의 해당
지점**을 함께 추천하고 싶다. 지금은 교과서 도판(`textbook_figures`)만 캔버스에
추천되고, 영상은 없다. 선생님이 매번 "이건 EBS 몇 강 몇 분을 봐라"를 붙일 수는
없으므로, **관리자가 한 번 만든 강의 추천 패키지**를 선생님이 워크스페이스에서
켜면, 학생 질의에 맞춰 시스템이 자동으로 영상 클립을 추천해야 한다.

과거 이 저장소에는 admin 전역 영상 카탈로그(EBS 추천)가 있었으나 D94(2026-07-18,
사용자 결정)로 제거됐다. 이번 기능은 그 모델을 **의도적으로 다시 들이되**, 대상을
EBS 강의의 **챕터(타임라인) 단위 숏폼**으로 좁힌다.

## 핵심 기술 검증 (2026-08-02, Playwright 실측)

설계 전제가 되는 사실을 실제로 확인했다. 스펙의 방향은 전부 이 실측에 근거한다.

- **EBS 플레이어 페이지의 챕터(목차)가 초기 HTML에 서버렌더된다.** 예시 강의
  (`retrieveLmsPlayerHtml5.ebs?...sbjtId=S20250000698&lessonId=LS100030075209...`)
  의 raw HTML에 `player.Command.seek(365) … seek(2914)` 16개가 그대로 있고, 각
  항목에 `[MM:SS]` 표시와 챕터 제목(`03_고려의 토지 제도와 경제 생활`)이 붙어
  있다. 챕터 리스트 항목은 seek 초를 `data-index-time`/`onclick`으로 가진다.
  → **단순 HTTP GET + 파싱으로 (시작초, 제목) 추출 가능. 헤드리스 브라우저 불필요.**
- **플레이어 페이지 URL로는 특정 시각으로 이동할 수 없다(확정).** `startTime·
  playTime·t·seekTime·time·position·seek·sec·currentTime` 파라미터와 `#t=`·`#초`
  프래그먼트 11종을 전부 테스트했으나 하나도 seek되지 않았다. 플레이어의
  `option.startTime`은 서버(로그인 이어보기 기록)로만 채워지고 URL로는 못 넣는다.
- 직접 MP4 URL + `#t=초`는 seek이 동작하지만(실측: `#t=896`→900초), **비공식·
  약관 회색지대·취약**이라 채택하지 않는다(사용자 결정 2026-08-02, 아래 비목표).

**결론**: 딥링크 seek은 포기한다. 대신 **공식 플레이어 페이지 링크를 그대로**
열고, 추천 카드에 **챕터 제목 + 타임라인 시각을 텍스트로** 보여 학생이 그 지점으로
직접 이동하게 한다. 타임라인이 정리돼 있으니 학생이 보고 찾아간다.

## 목표

1. **관리자**가 `/admin`에서 **(학년·과목) 강의 추천 패키지**를 만들고, 거기에
   **EBSi 플레이어 링크**를 추가하면, 시스템이 그 페이지를 파싱해 챕터마다
   **(시작초, 타임라인 라벨, 제목)** 클립을 저장하고 **제목을 임베딩**한다.
2. **선생님**이 워크스페이스(학급)에서 관리자가 만든 패키지를 **켜고 끈다**.
3. **학생**이 그 워크스페이스에서 채팅하다가 개념을 물으면, **ReAct 스킬**이
   켜진 패키지의 클립 중 질의와 맞는 것을 검색해 **캔버스에 클립 카드**로
   추천한다(제목 + 타임라인 + "EBS에서 보기" 링크, 새 탭).

## 비목표 (YAGNI)

- **직접 MP4 `#t=` 딥링크 / 인라인 임베드 플레이어** — 아니다(약관·안정성).
  공식 페이지 링크를 새 탭으로 여는 것만 한다.
- **자막 업로드·자동 청킹·LLM 요약 폴백** — 아니다(사용자 결정 2026-08-02:
  "폴백하지 말고 EBS부터"). 클립 경계·제목은 **EBS 챕터에서만** 온다. 챕터가
  없는 영상은 파싱 실패로 처리하고 추측하지 않는다.
- **EBS 외 소스(유튜브·메가스터디)** — v1 대상 아님. `source='ebs'`만. 데이터
  모델에 `source` 컬럼은 두되 파서는 EBS 하나만 구현한다.
- **헤드리스 브라우저 인제스트** — 불필요(챕터가 raw HTML에 있음). MP4를 안 쓰므로
  `<video src>` 캡처가 필요 없다.
- **영상 파일 저장·트랜스코딩·썸네일 추출** — 아니다. 우리는 링크만 다룬다.

## 데이터 모델

전역 카탈로그 3층 + 워크스페이스 선택 1층. 명명·상태·격리는 `textbook_figures`
골격을 그대로 본뜬다(부모 조인 파생, status 3단, 실패 격리).

- **`lecture_packages`** (admin 전역) — `id, grade text, subject text, title text,
  created_by uuid, created_at`. "클립셋"의 실체. 예: `고1 · 통합과학 · 2028 수능개념`.
- **`lecture_videos`** (패키지 자식) — `id, package_id FK(ON DELETE CASCADE),
  source text DEFAULT 'ebs', page_url text, title text, status text
  DEFAULT 'pending' CHECK(pending|parsing|parsed|failed), error text, created_at`.
  admin이 링크 하나 추가 = 1행.
- **`lecture_clips`** (영상 자식) — `id, video_id FK(ON DELETE CASCADE), seq int,
  start_sec int, title text, status text DEFAULT 'pending'
  CHECK(pending|embedded|failed), created_at`. `UNIQUE(video_id, seq)`.
  **타임라인 라벨(`MM:SS`)은 저장하지 않고 `start_sec`에서 파생**한다.
  **임베딩 텍스트 = `title`**(자막 요약 없음). 임베딩은 Qdrant에만.
- **`class_lecture_packages`** (선생님 선택) — `class_id FK, package_id FK,
  PK(class_id, package_id)`. 워크스페이스별로 켠 패키지.

### Qdrant 컬렉션 `lecture_clips`

`file_chunks`와 동형(1024d/Cosine). **페이로드는 식별자·스코프키만**:
`{clip_id, video_id, package_id}`. **제목·URL·시각은 페이로드에 넣지 않는다** —
히트 후 Postgres에서 행을 재조회해 표시값을 얻는다(불변식 유지). 스코프 필터는
`package_id` KEYWORD 인덱스로 `MatchAny(켠 패키지들)`.

## 신뢰 경계 (D94 전역 카탈로그 처리 재적용)

`lecture_*` 카탈로그는 **특정 사용자/학급의 비밀 데이터가 아니라 admin이 만든
전역 콘텐츠**다(제목·타임라인·공개 강의 링크뿐). 그래서:

- Qdrant 스코핑은 `file_id`(유저 파일)가 아니라 **`package_id` 필터**로 한다 —
  선생님이 그 워크스페이스에 켠 패키지의 클립만 검색된다.
- 다만 규율 일관성을 위해 **페이로드에는 식별자만** 넣고 표시값은 Postgres
  재조회로 얻는다(D94 EBS는 제목을 페이로드에 넣었으나, 여기서는 더 엄격하게
  간다 — 재조회 비용이 작고 규약이 단순해진다).

### RLS

- `lecture_packages/videos/clips`: **SELECT는 인증 사용자 전체 허용**(전역 카탈로그).
  INSERT/UPDATE/DELETE는 **admin만**(admin RLS/RPC, service-role 우회 안 함 — D104).
- `class_lecture_packages`: 해당 학급 **선생님이 쓰기**(`my_taught_class_ids()`),
  학급 **구성원이 읽기**(`my_class_ids()`). 검색은 학생 요청 컨텍스트에서 이
  테이블을 읽어 켠 패키지를 안다.

## 인제스트 파이프라인 (EBS 전용)

admin이 패키지에 EBS 링크를 추가 → `lecture_parse` 잡:

1. `page_url`을 **HTTP GET(브라우저 UA)**. 응답 HTML에서 챕터를 파싱한다 —
   챕터 항목마다 **시작초**(`data-index-time` 속성 또는 `onclick`의
   `player.Command.seek(N)`)와 **제목** 텍스트. 강의 제목도 파싱(없으면 admin
   입력값). → `lecture_videos.status='parsing'→'parsed'`, 챕터 수만큼
   `lecture_clips`(status='pending') insert.
2. `lecture_embed` 잡 팬아웃(배치) → 각 클립 `title`을 `embedding-passage`로
   임베딩 → Qdrant `lecture_clips` upsert(payload=식별자만) → 행 `status='embedded'`.
3. 실패 격리: 파싱 실패(챕터 0개 등)는 `lecture_videos.status='failed'`+`error`,
   임베딩 실패는 클립 `status='failed'` — figure 패턴 동형. 한 영상·한 클립의
   실패가 다른 것을 막지 않는다.

파서는 `services/lecture_parse.py` 한 곳에 격리한다(EBS HTML 구조 변화에 대비 —
이런 취약점은 한 파일에 가두고 테스트로 지킨다). 파싱은 `player.Command.seek(N)`
정규식(raw HTML에서 16개 확인)과 `data-index-time`을 함께 시도한다.

## 검색 + ReAct 스킬

- **`services/lecture_search.py`** `search_class_clips(client, space_ref, query)`
  (figure_search 미러):
  1. `class_lecture_packages`에서 그 학급의 켠 `package_id`들을 읽는다. 없으면 `[]`.
  2. `embed_query(query)` → Qdrant `lecture_clips` 검색, 필터 `package_id
     MatchAny(켠 것들)`, `score_threshold = 1 - lecture_retrieve_max_distance`.
  3. 히트 id로 `lecture_clips` 행 재조회(+ 부모 `lecture_videos.page_url`).
  4. `top_k`개 반환: `{clip_id, title, start_sec, timeline_label(파생), page_url,
     video_title, score}`. **어떤 실패든 `[]`**(검색은 채팅을 막지 않는다).
- **`ai/skills/search_lecture_clip.py`** (`search_textbook_figure` 미러): class
  스코프 가드(개인 세션 거부) → `lecture_search` 위임 → 모델엔 제목만, 캔버스
  배치용 전체는 `data.clips`로 오케스트레이터가 소비. 카탈로그 노출은 `(space_kind,
  role)`로 좁히는 catalog.py 규칙을 따른다(개인 세션엔 안 뜬다).

## 프론트엔드

- **학생 추천 카드(캔버스)**: `FigureItem`을 본뜬 `ClipItem`(kind='clip'). 이미지가
  없으므로 카드에 **제목 · 타임라인 라벨(예: `14:56`) · "▶ EBS에서 보기"**(→
  `page_url` 새 탭). 스트림 `done` 이벤트에 `clips` 배열로 실어 도판과 같은 방식
  으로 캔버스에 배치·세션 내 중복 제거(figure의 `useCanvasStream`/`ItemLayer`
  분기 재사용).
- **선생님 UI**: `MaterialsTab`에 "강의 추천 패키지" 섹션 — admin이 만든 (학년·
  과목·제목) 패키지 목록에서 이 워크스페이스에 켜기/끄기.
- **admin 콘솔**: `/admin`에 "강의 패키지" 화면 — 패키지 CRUD(학년·과목·제목),
  패키지에 EBS 링크 추가·파싱 상태·클립 목록 보기·재파싱·삭제.

## 튜너블 (3곳 동기, D62)

`config.py` 기본값 + `db/03_app_settings.sql` INSERT + `services/admin_console.py`
위젯 스펙을 함께 추가한다:

- `lecture_pipeline_enabled` (bool, 기본 true) — 인제스트 킬 스위치.
- `lecture_retrieve_max_distance` (float, 기본 0.55, clamp 0.1~0.9) — 추천 거리 게이트.
- `lecture_retrieve_top_k` (int, 기본 3) — 추천 개수.

## 유지할 불변식

- RAG는 채팅을 막지 않는다 — 검색·파싱 실패는 빈 목록/격리, 채팅 계속.
- 임베딩 비대칭(query/passage), 거리 `1 - score`.
- Qdrant 페이로드는 식별자만.
- 권한은 DB(RLS)가 강제, admin은 본인 JWT로 admin 정책을 탄다(service-role 우회 금지).
- 원격 DB 마이그레이션은 **별도 승인** 후 적용(신규 테이블·컬렉션 추가 마이그레이션).

## 테스트

- **파서 단위 테스트**(`services/lecture_parse.py`): 저장해 둔 EBS 플레이어 HTML
  픽스처로 (시작초, 제목) 추출, 챕터 0개→실패 처리, 라벨 파생(`896`→`14:56`).
- **검색**: 켠 패키지 없음→`[]`, package_id 필터가 안 켠 패키지를 배제, 거리 게이트.
- **스킬**: 개인 세션 스코프 가드 거부, 실패 시 `SkillResult(ok=False)`로 턴 안 죽음.
- **프론트**(vitest): 스트림 `clips` 파싱 → ClipItem 매핑, 세션 내 중복 제거.

## 미해결 결정 / 리스크

- **프로덕션 서버 IP의 WAF 차단**: 로컬 IP는 GET 통과했으나 데이터센터 IP(WebFetch)는
  차단됐다. 프로덕션 인제스트 GET이 막힐 수 있다 → **구현 첫 단계에서 프로덕션
  경유 GET을 검증**하고, 막히면 대비(브라우저 헤더 보강, 재시도, 최악의 경우
  헤드리스)를 정한다. 파싱 실패는 admin에게 명확한 사유로 노출.
- **EBS 페이지 스크래핑 / 약관**: 우리는 MP4·콘텐츠를 재배포하지 않고 **공식
  페이지 링크로 보내며 공개 챕터 메타데이터(제목·시각)만 파싱**한다 — MP4 핫링크
  보다 위험이 낮으나, 스크래핑 자체의 약관은 제품 정책으로 재확인 대상.
- **EBS HTML 구조 변화**: 파서를 한 파일에 격리 + 픽스처 테스트로 방어. 구조가
  바뀌면 파싱 실패로 떨어지고(추측 금지) admin이 재파싱한다.
- **임베딩 텍스트가 제목뿐**: 짧은 제목(`04_조선`)은 검색 신호가 약할 수 있다.
  v1은 제목만, 필요 시 `{과목} · {제목}` 프리픽스나 자막 요약을 후속으로.
