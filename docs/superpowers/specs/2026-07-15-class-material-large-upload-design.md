# 교사 자료 대용량 업로드 설계 (D77·D78)

- 날짜: 2026-07-15 / 작성: Manager
- 요구(사용자 결정, 2026-07-15): **교사가 워크스페이스에 올리는 RAG 자료
  (class_material)는 500MB까지, 학생 업로드는 50MB.**
- 선행: TASK 2 (D73~D76, dev 커밋 691e63b..81efadb). 마무리 E2E는 이 변경과
  통합해 1회 수행(사용자 결정).

## 1. 현황 (2026-07-15 실측)

- 용량 상한은 `file_max_bytes` 단일(기본 25MB, admin 오버레이, clamp 상한
  100MB) — **kind 무구분**으로 교사·학생 동일 적용. `routers/files.py:71`
  (사전 거절) + `services/files.py:127`(재검증), 초과 413.
- **Upstage Document Parse 요청당 50MB 하드 리밋**(공식 문서). 페이지 수는
  기해결 — sync 100p 초과 시 async 제출+폴링(1,000p, `upstage.py:203`).
  → 우리 상한만 올려도 50MB 초과 PDF는 파싱 단계에서 실패한다.
- 라우터는 파일 전량을 메모리로 읽는다(`files.py:78`). pypdf는 이미 의존성.

## 2. 설계 결정

### D77 — kind별 업로드 용량 상한

- 신규 튜너블 `class_material_max_bytes` 기본 **500MB**(= 524,288,000B),
  clamp 1MB~512MB. `file_max_bytes` 기본 **25→50MB** 상향(clamp 1KB~100MB
  유지). D62 규약: config 기본값 + `as_int` 오버레이 + 시드 마이그레이션
  `0030_app_settings_upload_limits.sql`(**파일만 — 원격 적용은 배포 시**).
  0030은 신규 키 insert + `file_max_bytes`는 **admin이 손대지 않은
  시드값(26214400)일 때만** 52428800으로 조건부 update(커스텀 보존).
- 해석 지점 단일화: `files.resolve_upload_max_bytes(overlay, kind)` —
  `kind=='class_material'`이면 class 노브, 그 외 `file_max_bytes`.
  라우터 사전 거절과 서비스 재검증이 공용한다.
- **이미지 예외**: 이미지는 페이지 분할이 불가능해 D78로 우회할 수 없다 →
  class_material이어도 이미지 확장자(png/jpg/jpeg/webp/gif)는 50MB 초과 시
  422(한국어 사유). txt/md는 Upstage를 거치지 않으므로 상한만 적용.

### D78 — 50MB 초과 PDF 분할 파싱

- `upstage.parse_document`가 디스패처가 된다: PDF이고
  `len(data) > UPSTAGE_PARSE_MAX_BYTES(50MB)`면 분할 경로, 그 외 기존
  단일 요청 경로(`_parse_single`로 추출 — sync→async 폴백 로직 그대로).
- 분할: pypdf로 페이지-range 조각 직렬화. 페이지당 평균 바이트로 1차 그룹
  (타깃 48MB — 직렬화 오버헤드 마진)을 잡고, 직렬화가 50MB를 넘는 그룹은
  **이분 재시도**(pypdf가 공유 리소스를 조각마다 복사해 조각 합이 원본보다
  커질 수 있음). 단일 페이지가 50MB를 넘으면 분할 불가 — raise(워커가 파일
  failed 처리, 사유 전달). CPU 바운드 분할은 `asyncio.to_thread`.
- 조각별 파싱은 세마포어 3 동시 실행, **페이지 순으로** `"\n\n"` 연결.

### 대안 비교

(a) admin 값만 상향 — 학생 상한도 같이 커지고 50MB 초과 PDF는 어차피 파싱
실패. (b) 스트리밍 업로드 + 외부 파서 교체 — 과대 공사(YAGNI). **(c) 채택:
kind별 상한 + PDF 분할** — 기존 파이프라인 무변경으로 하드 리밋 우회.

## 3. 알려진 트레이드오프 (비범위)

- 500MB 업로드 시 라우터 read() + Storage 업로드 본문으로 메모리 ~2× 스파이크
  — 스트리밍 업로드는 비범위.
- 대용량 파싱 동안 워커 poll 락 점유로 다른 인제스트 잡이 지연될 수 있음
  (조각당 async 폴링 상한 900s는 기존값 유지).
- txt/md 대용량은 분할 불필요(청킹이 처리) — 임베딩 잡 수만 증가.
- **배포 노트**: Supabase Storage의 프로젝트 전역 파일 크기 상한을 500MB
  이상으로 올려야 실효(대시보드 설정 — 코드 밖 ops).

## 4. admin 콘솔 (폴리시)

미등록 키도 일반 위젯으로 렌더되지만(뒤 정렬), 신규 노브의 메타를
`SettingsTab.tsx`에 등록한다: `class_material_max_bytes`(number) +
`file_max_bytes` 설명 갱신(50MB 기본) + TASK 2의 `class_material_rag_enabled`
(toggle)·`class_material_rag_max_distance`(slider) 메타 소급 등록.

## 5. 검증 기준

1. 유닛: ① kind별 상한 해석(user_upload=50MB·class_material=500MB 기본),
   ② user_upload 상한 초과 413, ③ class_material은 file_max_bytes 초과해도
   자기 상한 이내면 통과, ④ class_material 자기 상한 초과 413, ⑤ 이미지
   50MB 초과 422, ⑥ PDF 분할이 전 페이지를 순서대로 커버 + 조각 각각 하드
   리밋 이하, ⑦ 50MB 초과 PDF가 분할 경로로 디스패치·조각 결과가 순서대로
   연결, ⑧ 소형 PDF는 단일 경로. 전체 스위트 GREEN.
2. E2E: TASK 2 마무리 E2E와 통합 1회(대용량 실파일 업로드는 유닛으로 갈음 —
   Storage 전역 상한이 ops 설정이라 로컬 E2E로 500MB를 실증하지 않는다).
